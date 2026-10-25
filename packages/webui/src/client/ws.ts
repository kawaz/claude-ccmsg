// Effect layer for the wire protocol over `/ws` (DR-0003, DR-0004 §2/§4,
// DR-0005 §1: "副作用...は store の外 (effect 層) に隔離"). Owns the
// WebSocket lifecycle (connect/reconnect/hello/subscribe handshake) and
// translates everything it observes into store actions; the reducer never
// touches the network. HTTP/WS connections are pinned to role "user" (u1)
// server-side regardless of what we send, so we always hello as user.
//
// Responses vs. pushed events share one socket. Every request carries a
// `request_id` this client generates and the daemon echoes on the reply, so
// replies pair by id and may arrive in any order — the daemon runs our
// requests concurrently, and a slow one no longer delays the rest. Slow ops
// (translate / session_launch / session_search) are ordinary requests whose
// reply simply takes seconds to come back.
// Every frame is read once, by the wire's frame schema (readDaemonFrame): a
// push, a reply (read as the answer to the op of the request it names), or a
// line no schema reads, which is dropped.
import type {
  DaemonFrame,
  ErrorResponse,
  ParseFailure,
  ReplyOf,
  RequestInput,
  SessionDumpFileRequest,
  SessionLaunchRequest,
  SessionSearchRequest,
  StreamEvent,
} from "@ccmsg/protocol";
import { PROTOCOL_VERSION, readDaemonFrame, VERSION } from "@ccmsg/protocol";
import type { Action } from "./store.ts";
import { mismatchOf, reactToHandshakeVersion } from "./version-guard.ts";
import { summarizeUserAgent } from "./utils.ts";
import { activeTraceCollector, createTraceCollector, setActiveTraceCollector } from "./trace.ts";

/** How long after an unexpected close each reconnect attempt waits, by
 * attempt; attempts past the end keep the last. */
export const RECONNECT_DELAYS_MS: readonly number[] = [
  250, 500, 1000, 2000, 4000, 8000, 15000, 30000,
];
/** How long an open socket may go without a frame before it is pinged. */
export const KEEPALIVE_IDLE_MS = 30_000;
/** How long that ping may go unanswered before the socket is replaced. */
export const KEEPALIVE_TIMEOUT_MS = 10_000;
/** How often an open socket is checked for having gone idle. */
export const KEEPALIVE_CHECK_MS = 5_000;

/** How long userPrompt waits for its reply. The daemon always answers a
 * user_prompt within its own 12 s deadline (`unconfirmed` at worst,
 * USER_PROMPT_DEADLINE_MS in the daemon), so this only fires when that
 * answer is lost on a socket that still looks alive. The 3 s on top covers
 * the daemon's event loop running late and the transport (a phone over the
 * tailnet) without making a lost answer hold the input panel much longer. */
export const USER_PROMPT_REPLY_TIMEOUT_MS = 15_000;
/** How long userMessage waits for its reply: the daemon's USER_MESSAGE_DEADLINE_MS
 * (5 s) and the same margin as USER_PROMPT_REPLY_TIMEOUT_MS. */
export const USER_MESSAGE_REPLY_TIMEOUT_MS = 8_000;

/** The time the client reads and the waits it sets: how long a socket has
 * been idle, when to reconnect, when a reply is overdue. The same seam as the
 * hooks module's `Engine.clock`, read synchronously here because the client
 * sits directly on the page's own timers. */
export interface WsClock {
  now(): number;
  after(ms: number, fn: () => void): WsWait;
}

/** A wait set with `WsClock.after`; `cancel` keeps it from running. */
export interface WsWait {
  cancel(): void;
}

/** The page's own clock and timers. */
export const realClock: WsClock = {
  now: () => Date.now(),
  after: (ms, fn) => {
    const timer = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(timer) };
  },
};

export interface WsClientOptions {
  /** Where time comes from; the page's own clock unless given. */
  clock?: WsClock;
}

/** How this page was arrived at, for the daemon log's hello line: `navigate` /
 * `reload` / `back_forward` / `prerender`, or undefined where the browser
 * keeps no navigation entry (and under the test runner, which has none). */
function navigationType(): string | undefined {
  const entry = performance.getEntriesByType?.("navigation")?.[0];
  if (entry === undefined || !("type" in entry)) return undefined;
  return typeof entry.type === "string" && entry.type !== "" ? entry.type : undefined;
}

type ReplyFrame = Extract<DaemonFrame, { kind: "reply" }>;

/** A request waiting for its reply: `reply` reads the reply's frame as the
 * answer to the request's op, `fail` settles it with an error the client made
 * up instead. */
interface PendingReply {
  reply(frame: ReplyFrame): void;
  fail(error: ErrorResponse): void;
}

/** What a request is answered with when its reply is not its op's answer: the
 * reply cannot be used, and the caller handles it like any error. */
function invalidReply(op: string, failure: ParseFailure): ErrorResponse {
  return {
    ok: false,
    error: {
      code: "invalid_reply",
      msg: `the reply to ${op} is not its answer: ${failure.summary}`,
    },
  };
}

export interface WsHandle {
  connect(): void;
  close(): void;
  /** Ack say records as read (kawaz r244 m5-m6): the 既読 button on a
   * 📣 bubble. `ids` are the SayRecords' ids. Non-optimistic — the daemon
   * pushes the updated `ev:"says"` set to every tab and the store takes it
   * from there, so every open tab converges on the same badge. */
  sayRead(ids: readonly string[]): Promise<ReplyOf<"say_read">>;
  /** Mark requests for permission read (DR-0040): the bubble's 許可する.
   * Non-optimistic, like sayRead — the daemon pushes each record it changed
   * as ev:"permit_request". */
  permitRequestRead(ids: readonly string[]): Promise<ReplyOf<"permit_request_read">>;
  /** Read one attachment of a request for permission as it is now
   * (DR-0040 §3): the bubble's opening it. */
  permitAttachmentRead(id: string, path: string): Promise<ReplyOf<"permit_attachment_read">>;
  peers(): Promise<ReplyOf<"peers">>;
  /** The msgs of a room log by mid (`read`): the Timeline's full text of a
   * room message a past transcript shows. */
  read(room: string, mids: string | number[]): Promise<ReplyOf<"read">>;
  /** A summary of every room log (`rooms`), for the sidebar's room list. */
  rooms(): Promise<ReplyOf<"rooms">>;
  /** Every event of one room log (`room_history`), for the room view. */
  roomHistory(room: string): Promise<ReplyOf<"room_history">>;
  /** List a directory under a connected session's cwd (DR-0008 fs_list, "" / absent = root). */
  fsList(sid: string, path?: string): Promise<ReplyOf<"fs_list">>;
  /** Read a file under a connected session's cwd (DR-0008 fs_read). */
  fsRead(sid: string, path: string): Promise<ReplyOf<"fs_read">>;
  /** Read one exact absolute path from the session's transcript-derived
   * external_files allowlist (DR-0024 fs_read_external). */
  fsReadExternal(sid: string, path: string): Promise<ReplyOf<"fs_read_external">>;
  /** DR-0026: list a directory under one of the session's workspace_folders
   * (from session_status). Path is absolute; the daemon requires realpath to
   * be inside an allowlisted folder root or a descendant. */
  fsListWorkspace(sid: string, path: string): Promise<ReplyOf<"fs_list_workspace">>;
  /** DR-0026: read a file under one of the session's workspace_folders. Same
   * directory-prefix allowlist as fsListWorkspace. */
  fsReadWorkspace(sid: string, path: string): Promise<ReplyOf<"fs_read_workspace">>;
  /** Batch existence probe for the message-body path linkifier (kawaz r46
   * m55-m58). `paths` must be absolute; the daemon returns a parallel array
   * of `FsStatEntry | null` — non-null when a real regular file is reachable
   * under one of the three read-op authorization surfaces. See
   * `FsStatBatchRequest` in @ccmsg/protocol for the full contract. */
  fsStatBatch(sid: string, paths: string[]): Promise<ReplyOf<"fs_stat_batch">>;
  /** Recursive file-name search under one browsable root (Files pane's search
   * box). `query` is whitespace-separated words ANDed against each path with
   * `-word` excluding, case-insensitively (parseFileSearchQuery's grammar);
   * `respectGitignore` skips and prunes paths a `.gitignore` hides. Hits come
   * back in breadth-first order with the same path shape the tree uses
   * (root-relative for "contained", absolute for "workspace"). See
   * `FsFindRequest` in @ccmsg/protocol. */
  fsFind(
    sid: string,
    kind: "contained" | "workspace",
    root: string | undefined,
    query: string,
    respectGitignore: boolean,
  ): Promise<ReplyOf<"fs_find">>;
  /** Create a new UTF-8 text file under docs/inbox/ relative to a connected
   * session's cwd (DR-0019 fs_write), while remaining inside its containment
   * root. Never overwrites — an existing path replies `file_exists`, a path
   * outside cwd/docs/inbox/ replies `path_not_writable`. */
  fsWrite(sid: string, path: string, content: string): Promise<ReplyOf<"fs_write">>;
  /** Create a new empty (or short-content) text file at `path` under fs_edit's
   * authorization surfaces (kind ∈ {contained, workspace}). Symmetric partner
   * of fsEdit — used by the FileTree "+" affordance to create a file in the
   * currently-shown directory. Existing paths reply `file_exists`. */
  fsCreate(
    sid: string,
    path: string,
    kind: "contained" | "workspace",
    content: string,
  ): Promise<ReplyOf<"fs_create">>;
  /** Delete a regular file (viewer trash action, kawaz r46 m25). File-only,
   * never recursive; refuses directories/symlinks. The caller is expected to
   * confirm() before invoking — the daemon has no confirmation surface. */
  fsDelete(
    sid: string,
    path: string,
    kind: "contained" | "workspace",
  ): Promise<ReplyOf<"fs_delete">>;
  /** Overwrite an existing text file (viewer edit action). `kind` picks the
   * authorization surface — the same three the read ops use. `expectedMtime`
   * and `expectedSize` come from the FsReadResponse the viewer opened with;
   * a mismatch replies `file_conflict` so a concurrent external edit isn't
   * silently clobbered. */
  fsEdit(
    sid: string,
    path: string,
    kind: "contained" | "external" | "workspace",
    content: string,
    expectedMtime: string,
    expectedSize: number,
  ): Promise<ReplyOf<"fs_edit">>;
  /** Mint a capability URL on the sandbox origin (DR-0030) for one file, so it
   * can be opened with its real MIME type — `text/html` renders, binaries
   * download — which the same-origin `/fs-serve` refuses to serve. The reply's
   * `url` is preview mode; append `?dl=1` for the download mode. Only worth
   * calling when hello reported `sandbox_available`; otherwise the daemon
   * answers `sandbox_not_configured`. */
  sandboxGrant(
    sid: string,
    path: string,
    kind: "contained" | "external" | "workspace",
  ): Promise<ReplyOf<"sandbox_grant">>;
  /** Drop a grant early. Best-effort — the grant's 30-minute expiry is what
   * actually bounds its life, so a failure here needs no handling. */
  sandboxRevoke(gid: string): Promise<ReplyOf<"sandbox_revoke">>;
  /** Read a slice of a connected session's transcript jsonl (DR-0009
   * transcript_read). `before` omitted = tail of the file; pass the previous
   * reply's `start` to page older, or its `end` as `after` to read what was
   * appended since. */
  transcriptRead(
    sid: string,
    opts?: {
      before?: number;
      after?: number;
      max_bytes?: number;
      /** DR-0025 Phase 2: read a subagent / workflow-agent transcript. Static
       * read only — subscribe is not offered on agent transcripts (DR-0025
       * §2.2, no live push of agent progress). */
      agent_id?: string;
      run_id?: string;
      teammate?: string;
    },
  ): Promise<ReplyOf<"transcript_read">>;
  /** Follow a connected session's transcript live (DR-0009 live-tail
   * addendum): appended complete lines arrive as `ev:"transcript"` pushes
   * (handled in onMessage below, folded into store as `timeline/tail`) until
   * transcriptUnsubscribe or disconnect. */
  transcriptSubscribe(sid: string): Promise<ReplyOf<"transcript_subscribe">>;
  transcriptUnsubscribe(sid: string): Promise<ReplyOf<"transcript_unsubscribe">>;
  /** One-shot fetch of a connected session's folded status snapshot (DR-0020
   * Phase 1 session_status) — todos/workflows/background as currently folded
   * by the daemon from its transcript jsonl. Not called by any component
   * today (subscribe's own response already carries the initial snapshot,
   * see below); kept for parity with the protocol's non-live op and any
   * future one-shot refresh need. */
  sessionStatus(sid: string): Promise<ReplyOf<"session_status">>;
  /** Follow a connected session's folded status live (DR-0020 Phase 1
   * session_status_subscribe): the response itself carries the current
   * snapshot (unlike transcriptSubscribe, which only returns a size) —
   * callers dispatch `session-status/loaded` from the resolved response,
   * then again for every subsequent `ev:"session_status"` push (handled in
   * onMessage below) until sessionStatusUnsubscribe or disconnect. */
  sessionStatusSubscribe(sid: string): Promise<ReplyOf<"session_status_subscribe">>;
  sessionStatusUnsubscribe(sid: string): Promise<ReplyOf<"session_status_unsubscribe">>;
  /** One-shot fetch of the latest agents rows (U1).
   * Called once in onOpen's handshake for the initial paint; subsequent
   * changes arrive unprompted as `ev:"agents"` pushes (see onMessage below). */
  agents(): Promise<ReplyOf<"agents">>;
  /** One-shot fetch of every connected session currently stopped on a harness
   * API error. Called once in onOpen's handshake for the initial paint;
   * subsequent changes arrive unprompted as `ev:"session_errors"` pushes (see
   * onMessage below) — same one-shot + push pairing as `agents` above. Not
   * per-sid: the sidebar has to colour *other* sessions' rows, which a status
   * subscription per visible peer would cost far more to answer. */
  sessionErrors(): Promise<ReplyOf<"session_errors">>;
  /** Search historical Claude Code session transcripts under daemon-detected
   * config dirs (DR-0021 Phase 1 op, Phase 2 client wiring; user role only).
   * `params` excludes `op` and `request_id` — the wire shape (including the
   * correlation id) is assembled here, same convention as
   * fsList/transcriptRead's option-object callers. */
  sessionSearch(
    params: Omit<SessionSearchRequest, "op" | "request_id">,
  ): Promise<ReplyOf<"session_search">>;
  /** Ask where `sid`'s copied fork history ends (user role only). Slow for
   * the same reason as sessionSearch: the first ask for a session reads whole
   * sibling transcripts. `origin: null` means there is no seam to draw. */
  forkOrigin(sid: string): Promise<ReplyOf<"fork_origin">>;
  /** Write `sid`'s dump to a file on the daemon host and answer where it
   * landed (user role only). Slow for the same reason as sessionSearch:
   * dumping reads the whole transcript plus its agent transcripts. `params`
   * excludes `op`/`request_id`, same convention as sessionSearch. */
  sessionDumpFile(
    params: Omit<SessionDumpFileRequest, "op" | "request_id">,
  ): Promise<ReplyOf<"session_dump_file">>;
  /** Round trip to the daemon, carrying provenance (exe/script/version, U1
   * footer) alongside the existing liveness fields. Called once in onOpen's
   * handshake, not polled — provenance only changes across a daemon restart,
   * which already re-runs the whole handshake. */
  ping(): Promise<ReplyOf<"ping">>;
  /** Translate complete texts through the daemon host. Unlike browser
   * translation, callers must not split or skip Japanese-containing segments.
   * The reply takes seconds; concurrent daemon dispatch means it never blocks
   * other ops' replies. */
  translate(texts: string[]): Promise<ReplyOf<"translate">>;
  /** Session-launcher directory-only cwd tree (DR-0018 §3.2, user role only).
   * `depth` omitted uses the daemon's configured `dir_tree_depth`; CwdTree's
   * lazy-expansion re-fetch of a boundary node passes 1. */
  dirTree(
    roots: readonly string[],
    opts?: { depth?: number; filter?: string },
  ): Promise<ReplyOf<"dir_tree">>;
  /** Launch a session through the configured launch command (DR-0018 §3.4).
   * The daemon awaits the whole run (bounded by `launch_timeout_seconds`, the kill
   * grace and the wait for its output, §3.5) before replying, so this call is
   * naturally slow — SessionCreator shows its own loading state while it's in
   * flight rather than relying on a generic pending indicator. */
  sessionLaunch(
    req: Omit<SessionLaunchRequest, "op" | "request_id">,
  ): Promise<ReplyOf<"session_launch">>;
  /** Session-launcher config projection (DR-0018 §3.4, user role only):
   * `root_dirs`, CwdTree's initial fetch roots. `error.code === "launcher_not_configured"`
   * is the signal SessionCreator uses to show setup guidance instead of the
   * form (§2.1 "launcher 未設定時"). */
  sessionLauncherConfig(): Promise<ReplyOf<"session_launcher_config">>;
  /** Terminate the OS process behind a session (DR-0028, user role only —
   * StatusPanel's danger-zone button). The daemon resolves the pid fresh and
   * runs the two-shot SIGTERM sequence, so this is naturally slow (up to
   * ~4s), like sessionLaunch. `terminated: false` in a successful response
   * means "signals sent, termination unconfirmed". */
  sessionKill(sessionId: string, opts?: { force?: boolean }): Promise<ReplyOf<"session_kill">>;
  /** Stop a session's process and resume the same id through the launch
   * command (DR-0028 「restart」, user role only — StatusPanel's 再起動). Slow:
   * the kill grace and the launch command's wait. */
  sessionRestart(sessionId: string): Promise<ReplyOf<"session_restart">>;
  /** Retitle a session by having the daemon type `/rename <title>` into that
   * session's own terminal (user role only, kawaz r135m16 — the Sessions
   * list's pencil button). Best-effort: a successful response means the
   * keystrokes were delivered, not that the session is now called that, so
   * callers should report "sent" rather than showing the new title as fact —
   * the real one arrives with the next agents poll. `error.code ===
   * "terminal_unavailable"` means no run of the session named a hyoui
   * terminal (started outside hyoui, or without the hooks module) and it can
   * only be renamed by hand. Slow like sessionKill. */
  sessionRename(sessionId: string, title: string): Promise<ReplyOf<"session_rename">>;
  /** Put what the person wrote into a session as their own prompt (DR-0035
   * §1, user role only — SessionView's input panel). The daemon has the
   * session's hooks module fill its composer and press Enter, then replies
   * with the module's answer, or `unconfirmed` once its own wait runs out, so
   * this call can take several seconds. An `error.code` of `connection_closed`
   * or `request_timeout` (no answer within USER_PROMPT_REPLY_TIMEOUT_MS)
   * means the request was written but its answer was lost: the text may be in
   * the session. */
  userPrompt(sessionId: string, text: string): Promise<ReplyOf<"user_prompt">>;
  userMessage(sessionId: string, agentId: string, text: string): Promise<ReplyOf<"user_message">>;
  /** Read a session process's environment variables (user role only). The
   * daemon resolves sid→pid fresh and runs the same ps verification as
   * sessionKill, so this is slow. */
  sessionEnv(sessionId: string): Promise<ReplyOf<"session_env">>;
  /** Per-credential LLM quota, proxied by the daemon from its configured
   * gateway (user role only). Slow, because the upstream fetch is.
   * `error.code === "llm_usage_not_configured"`
   * means the daemon has no gateway URL — the same signal hello's
   * `llm_usage_available` carries, seen here when the config changed under a
   * live connection. `refresh` makes the gateway probe upstream instead of
   * answering from its cache — the only response that carries `limits` and
   * `probe_error`, and the only one that can spend upstream rate limit, so it
   * belongs to an explicit user action and never to polling. */
  llmUsage(opts?: { refresh?: boolean }): Promise<ReplyOf<"llm_usage">>;
  /** Per-day LLM spend over the last `days` days, proxied by the daemon from
   * its configured stats gateway (user role only). Slow like llmUsage; `days`
   * omitted leaves the gateway's own default window. `error.code === "llm_stats_not_configured"` is the
   * hello capability seen after a config change under a live connection. */
  llmStats(days?: number): Promise<ReplyOf<"llm_stats">>;
  /** Upstream service health as the gateway sees it, proxied by the daemon
   * (user role only). Slow like llmUsage.
   * `refresh` makes the gateway re-read the providers' status pages
   * first, which is the screen's own button and never an automatic read.
   * `error.code === "llm_status_not_configured"` is the hello capability seen
   * after a config change under a live connection. The daemon also pushes the
   * same report unsolicited (ev:"llm_status") after a 529, so a client that
   * has asked once stays current without asking again. */
  llmStatus(opts?: { refresh?: boolean }): Promise<ReplyOf<"llm_status">>;
  /** Stop session `sid`'s prompt-cache keepalive at the gateway (user role
   * only). The daemon then pushes the session's request events marked
   * `cache_paused` until the session's next request starts it again. */
  llmKeepalivePause(sid: string): Promise<ReplyOf<"llm_keepalive_pause">>;
}

export function createWsClient(
  dispatch: (action: Action) => void,
  options: WsClientOptions = {},
): WsHandle {
  const clock = options.clock ?? realClock;
  let ws: WebSocket | null = null;
  /** Outstanding replies, keyed by the request_id we stamped on the way out.
   * An entry lives from the request being written until its reply arrives or
   * a disconnect flush settles it. */
  /** In-flight requests by request_id: each reads its reply's frame as the
   * answer to its own op, or settles with an error the client made up (the
   * connection closed, the reply did not come in time). */
  let pending = new Map<string, PendingReply>();
  /** Requests made while the current socket is still connecting. They have no
   * request_id until they are written, so replies enter `pending` only when
   * the opened socket sends them. */
  let connecting: Array<{
    write(socket: WebSocket): void;
    reject(reason: Error): void;
  }> = [];
  /** request_ids only need to be unique among this client's in-flight
   * requests (protocol doc), so a monotonic counter suffices — no UUID. */
  let nextRequestId = 0;
  let reconnectAttempt = 0;
  /** Cleared by the first hello of this page. The navigation type describes the
   * page load, not the socket, so repeating it on every reconnect would report
   * a reload that happened minutes ago — and its absence is what lets the
   * daemon log tell a reconnect apart from a genuine re-load. */
  let firstHello = true;
  let closedByUs = false;
  let reconnectTimer: WsWait | null = null;
  let keepaliveTimer: WsWait | null = null;
  let keepaliveTimeout: WsWait | null = null;
  let lastReceivedAt = clock.now();

  function write(socket: WebSocket, req: RequestInput, settle: PendingReply): string {
    const rid = `q${++nextRequestId}`;
    pending.set(rid, settle);
    socket.send(JSON.stringify({ ...req, request_id: rid }));
    return rid;
  }

  /** Send one request and resolve with its reply, read as the answer to its
   * op: the op's success reply or an error.
   *
   * `timeoutMs` bounds the wait for this one request. A request already
   * written then settles with `request_timeout` (it may have been acted on,
   * and a late reply is dropped like any unknown request_id); one still queued
   * behind a connecting socket was never sent and is rejected instead. */
  function send<B extends RequestInput>(
    req: B,
    opts: { timeoutMs?: number } = {},
  ): Promise<ReplyOf<B["op"]>> {
    return new Promise((resolve, reject) => {
      let rid: string | null = null;
      let timer: WsWait | null = null;
      const finish = (value: ReplyOf<B["op"]>) => {
        timer?.cancel();
        resolve(value);
      };
      const settle: PendingReply = {
        reply: (frame) => {
          const read = frame.reply<B["op"]>(req.op);
          finish(read.ok ? read.value : invalidReply(req.op, read.failure));
        },
        fail: finish,
      };
      const writeNow = (socket: WebSocket) => {
        rid = write(socket, req, settle);
      };
      const socket = ws;
      if (!socket) {
        reject(new Error("ws not open"));
        return;
      }
      const queued = {
        write: writeNow,
        reject: (reason: Error) => {
          timer?.cancel();
          reject(reason);
        },
      };
      const expireAfter = (timeoutMs: number) => {
        timer = clock.after(timeoutMs, () => {
          timer = null;
          if (rid === null) {
            connecting = connecting.filter((q) => q !== queued);
            reject(new Error("ws not open"));
            return;
          }
          expire(rid, timeoutMs);
        });
      };
      if (socket.readyState === WebSocket.CONNECTING) {
        connecting.push(queued);
        if (opts.timeoutMs !== undefined) expireAfter(opts.timeoutMs);
        return;
      }
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      writeNow(socket);
      if (opts.timeoutMs !== undefined) expireAfter(opts.timeoutMs);
    });
  }

  function expire(rid: string, timeoutMs: number): void {
    const settle = pending.get(rid);
    if (!settle) return;
    pending.delete(rid);
    settle.fail({
      ok: false,
      error: { code: "request_timeout", msg: `no reply within ${timeoutMs} ms` },
    });
  }

  function flushConnecting(socket: WebSocket): void {
    const queued = connecting;
    connecting = [];
    for (const request of queued) request.write(socket);
  }

  function rejectConnecting(): void {
    const queued = connecting;
    connecting = [];
    for (const request of queued) request.reject(new Error("ws connection closed"));
  }

  // The Timeline supplies the DOM-commit end of the trace and has no handle on
  // this client, so the collector is published for it here. A trace report is
  // fire-and-forget: a rejected post (socket closing) drops that one sample.
  setActiveTraceCollector(
    createTraceCollector({
      post: (req) => {
        void send(req).catch(() => {});
      },
    }),
  );

  async function onOpen(): Promise<void> {
    reconnectAttempt = 0;
    dispatch({ type: "conn/status", status: "connected" });
    // Capability belongs to the current daemon process. Clear a previous
    // connection's answer before probing this hello so stale host tabs cannot
    // survive a reconnect to a different/non-macOS daemon.
    dispatch({ type: "translator/availability", host: false });
    const navType = firstHello ? navigationType() : undefined;
    const ua = globalThis.navigator?.userAgent;
    firstHello = false;
    try {
      const hello = await send({
        op: "hello",
        role: "user",
        client_version: VERSION,
        protocol: PROTOCOL_VERSION,
        ...(navType !== undefined ? { nav_type: navType } : {}),
        ...(ua ? { ua: summarizeUserAgent(ua, globalThis.navigator?.maxTouchPoints ?? 0) } : {}),
      });
      // bundle と daemon の version 照合は handshake の他の何よりも先。
      // 不一致のまま先へ進むと、wire protocol が動いた upgrade
      // (v0.136.0 の request_id 必須化) では以降の全 op が失敗して沈黙する。
      // 一致していれば dispatch は null で、前の接続で立った導線を畳む。
      //
      // hello が拒否された時ほどこの照合が要る (その拒否自体が protocol 変更の
      // 症状) ので、その場合は hello 不要の ping から version を取りに行く。
      // どちらも取れなければ判定材料が無いので、再接続の backoff に委ねる。
      const guard = await reactToHandshakeVersion(
        hello,
        async () => {
          const probe = await send({ op: "ping" }).catch(() => null);
          return probe?.ok ? probe.version : null;
        },
        VERSION,
      );
      if (guard) {
        dispatch({
          type: "version-mismatch/detected",
          mismatch: mismatchOf(guard.outcome, guard.daemonVersion),
        });
      }
      if (hello.ok) {
        // Terminal タブの gateway URL (issue 2026-07-21) — daemon config.json 未設定
        // なら省略されるので null に落とす。値が来ていれば AppState に反映し、
        // SessionView は「hyoui_session_id 解決済み かつ この URL 有り」の
        // 両条件でのみ Terminal タブを出す。
        dispatch({
          type: "terminal-gateway/loaded",
          url: hello.terminal_gateway_url ?? null,
        });
        // 同じく hello 由来の capability (llm_usage_url 設定済みか)。前の接続の
        // 答えを引き継がないよう、省略時は明示的に false へ落とす — daemon の
        // 設定が変わった後に再接続した時、古い capability のまま Usage ボタンが
        // 残ると押した先で必ずエラーになる。
        dispatch({
          type: "llm-usage/availability",
          available: hello.llm_usage_available === true,
        });
        // 使用量 endpoint の capability。usage とは独立に設定できるので別
        // dispatch — 片方だけ設定した daemon で、もう片方のセクションを
        // 出さないための判断材料になる。
        dispatch({
          type: "llm-stats/availability",
          available: hello.llm_stats_available === true,
        });
        // upstream service status も同じ扱い。加えて、capability が立って
        // いれば接続直後に 1 回だけ report を取りに行く: topbar の badge は
        // 表示中の画面に関係なく出るので、/usage を開くまで空という状態を
        // 作らない。以降は 529 を観測した daemon の push (ev:"llm_status")
        // と /usage 側の再取得が更新する — 定期 poll は張らない。
        dispatch({
          type: "llm-status/availability",
          available: hello.llm_status_available === true,
        });
        // keepalive の停止も同じく、省略時は false へ明示的に落とす。
        dispatch({
          type: "llm-keepalive-pause/availability",
          available: hello.llm_keepalive_pause_available === true,
        });
        if (hello.llm_status_available === true) {
          void send({
            op: "llm_status",
          }).then((res) => {
            // 取れなければ badge が出ないだけ。ここで画面にエラーを出すと、
            // gateway が落ちている間ずっと全画面に無関係な警告が出る。
            if (!res.ok) return;
            const { ok: _ok, ...report } = res;
            dispatch({ type: "llm-status/loaded", report });
          });
        }
        // sandbox origin (DR-0030) の capability。同じ理由で省略時は false へ
        // 明示的に落とす — daemon の設定が消えた後に古い capability が残ると、
        // FileViewer の「HTML として開く」が必ず失敗するボタンになる。
        dispatch({
          type: "sandbox/availability",
          available: hello.sandbox_available === true,
        });
        // 起動の capability も同じ扱い。daemon に launcher が無ければ起動の
        // 導線は押した先で行き止まりになるので、そこでは出さない。
        dispatch({
          type: "launch/availability",
          available: hello.launch_available === true,
          ...(hello.launch_config_dir !== undefined ? { configDir: hello.launch_config_dir } : {}),
        });
      }
      await send({ op: "subscribe" });
      const peers = await send({ op: "peers" });
      if (peers.ok) {
        dispatch({ type: "peers/loaded", peers: peers.peers });
      }
      // U1: initial the agents rows paint + daemon provenance for the
      // footer. Neither failure here should abort the handshake above (both
      // already landed) — a rejection just falls through to the catch below
      // and skips these two dispatches, same as any other mid-handshake drop.
      const agentsRes = await send({ op: "agents" });
      if (agentsRes.ok) dispatch({ type: "agents/loaded", agents: agentsRes.agents });
      // Initial paint of the "stopped on an API error" set for the sidebar;
      // later changes arrive as `ev:"session_errors"` pushes. Same
      // failure-tolerance as the agents fetch above.
      const errorsRes = await send({
        op: "session_errors",
      });
      if (errorsRes.ok) dispatch({ type: "session-errors/loaded", errors: errorsRes.errors });
      const ping = await send({ op: "ping" });
      if (ping.ok)
        dispatch({
          type: "daemon-info/loaded",
          version: ping.version,
          exe: ping.exe,
          home: ping.home,
        });
      // DR-0023 host capability probe. An empty batch verifies the daemon can
      // find/build its helper without starting TranslationSession or translating
      // dummy content; a later per-item model error hides the tab at first use.
      const translate = await send({
        op: "translate",
        texts: [],
      });
      dispatch({ type: "translator/availability", host: translate.ok });
    } catch {
      // socket dropped mid-handshake; onClose already schedules the reconnect.
    }
  }

  function onMessage(data: string): void {
    const frame = readDaemonFrame(data);
    if (frame.kind === "invalid") {
      console.warn(`ccmsg: dropped a frame outside the wire's schema: ${frame.failure.summary}`);
      return;
    }
    if (frame.kind === "event") {
      onStreamEvent(frame.event);
      return;
    }
    // A reply with no request_id answers no request we can name (the daemon
    // sends one only for a line it could not read as a request). Nothing to
    // settle, and guessing a caller would settle the wrong one — drop it.
    if (frame.requestId === undefined) return;
    const settle = pending.get(frame.requestId);
    pending.delete(frame.requestId);
    settle?.reply(frame);
  }

  function onStreamEvent(streamEv: StreamEvent): void {
    if (streamEv.ev === "restarting") {
      dispatch({ type: "conn/status", status: "restarting" });
      return;
    }
    if (streamEv.ev === "notify") return; // not surfaced in the UI (yet)
    // U1: live push whenever the daemon's merged agents rows
    // result changes (only emitted while >=1 user-role subscriber is
    // connected) — folds straight into the same agents/loaded action the
    // one-shot op:"agents" reply in onOpen uses, so the reducer has exactly
    // one code path for "replace the agents list".
    if (streamEv.ev === "agents") {
      dispatch({
        type: "agents/loaded",
        agents: streamEv.agents,
      });
      return;
    }
    // Live push whenever the set of sessions stopped on a harness API error
    // changes (a session hitting one, recovering, or disconnecting while
    // flagged). Always the full list, never a delta, so this folds into the
    // same session-errors/loaded action the one-shot op:"session_errors" reply
    // in onOpen uses — one reducer path for "replace the error set", same
    // pattern as ev:"agents" above.
    if (streamEv.ev === "session_errors") {
      dispatch({
        type: "session-errors/loaded",
        errors: streamEv.errors,
      });
      return;
    }
    // U1: live push whenever the connected-session list changes (registers,
    // fully disconnects, or updates hello metadata) — folds straight into the
    // same peers/loaded action the one-shot op:"peers" reply in onOpen uses,
    // so the reducer has exactly one code path for "replace the peers list"
    // (same pattern as ev:"agents" above; issue
    // 2026-07-12-peers-live-update-protocol).
    if (streamEv.ev === "peers") {
      dispatch({ type: "peers/loaded", peers: streamEv.peers });
      return;
    }
    // Every `ccmsg say` record the daemon holds (memory only, DR-0036 §3) —
    // the full set, both on connect and after every say or ack. Replacing
    // rather than merging is what drops the old daemon's says after a
    // restart. Same "replace the set" shape as ev:"peers" above.
    if (streamEv.ev === "says") {
      dispatch({ type: "says/loaded", says: streamEv.says });
      return;
    }
    // Requests for permission (DR-0040 §5): the full set on connect, which
    // replaces what the tab held (a restarted daemon starts with none), then
    // each one as it is recorded or marked read, in place of the one held.
    if (streamEv.ev === "permit_requests") {
      dispatch({ type: "permit-requests/loaded", requests: streamEv.requests });
      return;
    }
    if (streamEv.ev === "permit_request") {
      dispatch({ type: "permit-requests/updated", request: streamEv.request });
      return;
    }
    // Prompt-cache windows the daemon is tracking from the LLM gateway's
    // event stream — the full non-expired set, both on connect (catch-up for
    // windows that opened before this tab existed) and on every new request.
    // One reducer path for "replace the set", same shape as ev:"peers" above.
    if (streamEv.ev === "llm_requests") {
      dispatch({
        type: "llm-requests/loaded",
        requests: streamEv.requests,
      });
      return;
    }
    // Freshly re-read upstream service status, pushed after the gateway told
    // the daemon an upstream returned 529 (gateway DR-0021 §6). Same "replace
    // the whole thing" shape as ev:"llm_requests" above — the report always
    // covers every configured service.
    if (streamEv.ev === "llm_status") {
      dispatch({
        type: "llm-status/loaded",
        report: streamEv.report,
      });
      return;
    }
    // Live-tail push for a session's transcript (DR-0009 addendum,
    // transcript_subscribe): folded into the sid's TimelineState by the
    // reducer's applyTimelineTail, which is the one place that decides
    // whether this batch is contiguous with what's cached (see its doc
    // comment) — this layer just relays the wire shape verbatim.
    if (streamEv.ev === "transcript") {
      // trace: arrival, then the reducer's return — the pair isolates "the tab
      // got it late" from "the tab got it on time and the store was slow".
      const trace = activeTraceCollector();
      trace?.noteWsReceive(streamEv.sid, streamEv.start, streamEv.end, streamEv.size);
      dispatch({
        type: "timeline/tail",
        sid: streamEv.sid,
        lines: streamEv.lines,
        start: streamEv.start,
        end: streamEv.end,
        size: streamEv.size,
      });
      trace?.noteStoreDispatch(streamEv.sid, streamEv.end);
      return;
    }
    // Live-tail push for a session's folded status (DR-0020 Phase 1/2
    // session_status_subscribe): folds straight into `session-status/loaded`,
    // the same action sessionStatusSubscribe's own resolved response
    // dispatches for the initial snapshot — the reducer has exactly one
    // "replace this sid's snapshot" code path (same pattern as
    // ev:"transcript" above, minus contiguity bookkeeping since this is
    // always a full recomputed snapshot, not an append).
    if (streamEv.ev === "session_status") {
      // The push is the snapshot plus `ev` / `sid`: everything else goes to
      // the store as the schema read it, so a field added to the snapshot
      // reaches the store without a change here.
      const { ev: _ev, sid, ...snapshot } = streamEv;
      dispatch({ type: "session-status/loaded", sid, snapshot });
      return;
    }
  }

  // Settles every in-flight send() with a synthetic error response instead of
  // leaving its Promise pending forever, and empties the registry so a stale
  // resolver can never be mis-matched (a request_id reused after reconnect) to
  // a reply that arrives on a later, reconnected socket.
  function flushPending(): void {
    const closed: ErrorResponse = {
      ok: false,
      error: { code: "connection_closed", msg: "ws connection closed" },
    };
    const stale = [...pending.values()];
    pending = new Map();
    for (const settle of stale) settle.fail(closed);
  }

  function stopKeepalive(): void {
    keepaliveTimer?.cancel();
    keepaliveTimer = null;
    keepaliveTimeout?.cancel();
    keepaliveTimeout = null;
  }

  function startKeepalive(socket: WebSocket): void {
    stopKeepalive();
    lastReceivedAt = clock.now();
    const check = () => {
      // The next check is set before this one acts, so a check that replaces
      // the socket (connect() stops the keepalive) cancels it too.
      keepaliveTimer = clock.after(KEEPALIVE_CHECK_MS, check);
      if (socket !== ws || socket.readyState !== WebSocket.OPEN) return;
      if (keepaliveTimeout !== null || clock.now() - lastReceivedAt < KEEPALIVE_IDLE_MS) return;

      void send({ op: "ping" }).then(() => {
        if (socket !== ws || keepaliveTimeout === null) return;
        keepaliveTimeout.cancel();
        keepaliveTimeout = null;
      });
      keepaliveTimeout = clock.after(KEEPALIVE_TIMEOUT_MS, () => {
        if (socket !== ws) return;
        keepaliveTimeout = null;
        connect();
      });
    };
    keepaliveTimer = clock.after(KEEPALIVE_CHECK_MS, check);
  }

  function onClose(): void {
    stopKeepalive();
    dispatch({ type: "conn/status", status: "disconnected" });
    rejectConnecting();
    flushPending();
    if (closedByUs) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
    reconnectAttempt++;
    reconnectTimer = clock.after(delay, connect);
  }

  function connect(): void {
    closedByUs = false;
    stopKeepalive();
    // A manual connect() supersedes any scheduled auto-reconnect; without this,
    // the pending timer would fire later and knock down the fresh socket.
    reconnectTimer?.cancel();
    reconnectTimer = null;
    // Belt-and-suspenders: also flush on connect() itself, in case it's ever
    // invoked (e.g. a manual reconnect) without onClose having run first.
    rejectConnecting();
    flushPending();
    const previous = ws;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    ws = socket;
    // Every listener below is guarded with `socket !== ws`: once `connect()`
    // runs again, `ws` points at the newer socket but this `socket` const
    // still names the one this closure was created for. A stale socket's
    // events (a delayed reply, or its own close firing after we've already
    // moved on) must never touch `pending`/dispatch on behalf of the current
    // connection — that's the mis-delivery this whole file exists to avoid.
    socket.addEventListener("open", () => {
      if (socket !== ws) return;
      startKeepalive(socket);
      void onOpen();
      flushConnecting(socket);
    });
    socket.addEventListener("message", (e) => {
      if (socket !== ws) return;
      lastReceivedAt = clock.now();
      // The daemon writes text frames only.
      if (typeof e.data === "string") onMessage(e.data);
    });
    socket.addEventListener("close", () => {
      if (socket !== ws) return;
      onClose();
    });
    // Close the outgoing socket now that `ws` no longer references it, so it
    // stops holding a live connection open in the background. Its close
    // event (real or synthetic) is a no-op thanks to the guard above.
    if (previous) {
      try {
        previous.close();
      } catch {
        // best-effort; the socket is being discarded either way.
      }
    }
  }

  return {
    connect,
    close() {
      closedByUs = true;
      stopKeepalive();
      // Cancel a scheduled auto-reconnect too: close() means "stop", including
      // the reconnect already queued by a close event that preceded this call.
      reconnectTimer?.cancel();
      reconnectTimer = null;
      ws?.close();
    },
    sayRead: (ids) => send({ op: "say_read", ids: [...ids] }),
    permitRequestRead: (ids) => send({ op: "permit_request_read", ids: [...ids] }),
    permitAttachmentRead: (id, path) => send({ op: "permit_attachment_read", id, path }),
    peers: () => send({ op: "peers" }),
    read: (room, mids) => send({ op: "read", room, mids }),
    rooms: () => send({ op: "rooms" }),
    roomHistory: (room) => send({ op: "room_history", room }),
    fsList: (sid, path) => send({ op: "fs_list", sid, ...(path !== undefined ? { path } : {}) }),
    fsRead: (sid, path) => send({ op: "fs_read", sid, path }),
    fsReadExternal: (sid, path) => send({ op: "fs_read_external", sid, path }),
    fsListWorkspace: (sid, path) => send({ op: "fs_list_workspace", sid, path }),
    fsReadWorkspace: (sid, path) => send({ op: "fs_read_workspace", sid, path }),
    fsStatBatch: (sid, paths) => send({ op: "fs_stat_batch", sid, paths }),
    fsFind: (sid, kind, root, query, respectGitignore) =>
      send({
        op: "fs_find",
        sid,
        kind,
        ...(root !== undefined ? { root } : {}),
        query,
        respect_gitignore: respectGitignore,
      }),
    fsWrite: (sid, path, content) => send({ op: "fs_write", sid, path, content }),
    fsCreate: (sid, path, kind, content) => send({ op: "fs_create", sid, path, kind, content }),
    fsDelete: (sid, path, kind) => send({ op: "fs_delete", sid, path, kind }),
    fsEdit: (sid, path, kind, content, expected_mtime, expected_size) =>
      send({
        op: "fs_edit",
        sid,
        path,
        kind,
        content,
        expected_mtime,
        expected_size,
      }),
    sandboxGrant: (sid, path, kind) => send({ op: "sandbox_grant", sid, path, kind }),
    sandboxRevoke: (gid) => send({ op: "sandbox_revoke", gid }),
    transcriptRead: (sid, opts) =>
      send({
        op: "transcript_read",
        sid,
        ...(opts?.before !== undefined ? { before: opts.before } : {}),
        ...(opts?.after !== undefined ? { after: opts.after } : {}),
        ...(opts?.max_bytes !== undefined ? { max_bytes: opts.max_bytes } : {}),
        ...(opts?.agent_id !== undefined ? { agent_id: opts.agent_id } : {}),
        ...(opts?.run_id !== undefined ? { run_id: opts.run_id } : {}),
        ...(opts?.teammate !== undefined ? { teammate: opts.teammate } : {}),
      }),
    transcriptSubscribe: (sid) => send({ op: "transcript_subscribe", sid }),
    transcriptUnsubscribe: (sid) => send({ op: "transcript_unsubscribe", sid }),
    sessionStatus: (sid) => send({ op: "session_status", sid }),
    sessionStatusSubscribe: (sid) => send({ op: "session_status_subscribe", sid }),
    sessionStatusUnsubscribe: (sid) => send({ op: "session_status_unsubscribe", sid }),
    agents: () => send({ op: "agents" }),
    sessionErrors: () => send({ op: "session_errors" }),
    sessionSearch: (params) => send({ op: "session_search", ...params }),
    forkOrigin: (sid) => send({ op: "fork_origin", sid }),
    sessionDumpFile: (params) => send({ op: "session_dump_file", ...params }),
    ping: () => send({ op: "ping" }),
    translate: (texts) => send({ op: "translate", texts }),
    dirTree: (roots, opts) =>
      send({
        op: "dir_tree",
        roots,
        ...(opts?.depth !== undefined ? { depth: opts.depth } : {}),
        ...(opts?.filter !== undefined ? { filter: opts.filter } : {}),
      }),
    sessionLaunch: (req) => send({ op: "session_launch", ...req }),
    sessionLauncherConfig: () => send({ op: "session_launcher_config" }),
    sessionKill: (sessionId, opts) =>
      send({
        op: "session_kill",
        session_id: sessionId,
        ...(opts?.force ? { force: true } : {}),
      }),
    sessionRestart: (sessionId) => send({ op: "session_restart", session_id: sessionId }),
    sessionRename: (sessionId, title) =>
      send({
        op: "session_rename",
        session_id: sessionId,
        title,
      }),
    userPrompt: (sessionId, text) =>
      send(
        {
          op: "user_prompt",
          session_id: sessionId,
          text,
        },
        { timeoutMs: USER_PROMPT_REPLY_TIMEOUT_MS },
      ),
    userMessage: (sessionId, agentId, text) =>
      send(
        { op: "user_message", session_id: sessionId, agent_id: agentId, text },
        { timeoutMs: USER_MESSAGE_REPLY_TIMEOUT_MS },
      ),
    sessionEnv: (sessionId) =>
      send({
        op: "session_env",
        session_id: sessionId,
      }),
    llmUsage: (opts) =>
      send({
        op: "llm_usage",
        ...(opts?.refresh ? { refresh: true } : {}),
      }),
    llmStats: (days) =>
      send({
        op: "llm_stats",
        ...(days !== undefined ? { days } : {}),
      }),
    llmStatus: (opts) =>
      send({
        op: "llm_status",
        ...(opts?.refresh ? { refresh: true } : {}),
      }),
    llmKeepalivePause: (sid) => send({ op: "llm_keepalive_pause", sid }),
  };
}
