// Effect layer for the wire protocol over `/ws` (DR-0003, DR-0004 §2/§4,
// DR-0005 §1: "副作用...は store の外 (effect 層) に隔離"). Owns the
// WebSocket lifecycle (connect/reconnect/hello/subscribe handshake) and
// translates everything it observes into store actions; the reducer never
// touches the network. HTTP/WS connections are pinned to role "user" (u1)
// server-side regardless of what we send, so we always hello as user.
//
// Responses vs. pushed events share one socket. Ordinary ops carry no request
// id: the daemon processes each line synchronously in receipt order, so their
// replies arrive in the same order we sent them and pair by position. Slow ops
// (translate / session_launch / session_search) are 2-phase: the positional
// reply is an immediate ack (RequestAcceptedResponse) and the outcome arrives
// later as an `ev:"*_result"` push correlated by our client-generated
// request_id — so a running translation can no longer hold back every other
// reply on this single connection. Classification rule: a frame with `ev` is
// a push (result events DO carry `ok`, so `ev` must be checked first); a
// frame with `ok` and no `ev` is a positional reply; anything else is a
// persisted subscribe delivery.
import type {
  AgentsResponse,
  AgentsStreamEvent,
  ArchiveRoomResponse,
  CreateRoomResponse,
  DeliveredEvent,
  DirTreeResponse,
  ErrorResponse,
  FsCreateResponse,
  FsDeleteResponse,
  FsListResponse,
  FsEditResponse,
  FsReadResponse,
  FsWriteResponse,
  HelloResponse,
  InviteResponse,
  KickResponse,
  PeersResponse,
  PeersStreamEvent,
  PingResponse,
  PostResponse,
  ReadResponse,
  Request,
  Response,
  RoomsResponse,
  SessionKillResponse,
  SessionLaunchRequest,
  SessionLaunchResponse,
  SessionLauncherConfigResponse,
  SessionSearchRequest,
  SessionSearchResponse,
  SessionStatusResponse,
  SessionStatusStreamEvent,
  SessionStatusSubscribeResponse,
  SessionStatusUnsubscribeResponse,
  SetTitleResponse,
  StreamEvent,
  TranslateResponse,
  TranscriptReadResponse,
  TranscriptSubscribeResponse,
  TranscriptUnsubscribeResponse,
} from "@ccmsg/protocol";
import type { Action, AppState } from "./store.ts";
import { readStorage, writeStorage } from "./storage.ts";

const SINCE_KEY = "ccmsg.since_seq";
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000, 30000];

function loadSince(): Record<string, number> {
  const raw = readStorage(SINCE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSince(since: Record<string, number>): void {
  // storage unavailable (private mode, quota) — since-tracking degrades to
  // full resync on reconnect, which is still correct, just more backlog.
  writeStorage(SINCE_KEY, JSON.stringify(since));
}

export interface WsHandle {
  connect(): void;
  close(): void;
  post(room: string, msg: string, to?: string[]): Promise<PostResponse | ErrorResponse>;
  /** Rename a room (set_title); the new title reaches all clients (incl. this
   * one) via the broadcast title event on the subscribe stream, not this
   * response — callers don't need to dispatch anything themselves. */
  setTitle(room: string, title: string): Promise<SetTitleResponse | ErrorResponse>;
  /** Toggle a room's archived flag (DR-0012 archive_room). The new flag
   * reaches all clients (incl. this one) via the broadcast archive event on
   * the subscribe stream, not this response — same non-optimistic-update
   * convention as setTitle above. */
  archiveRoom(room: string, archived: boolean): Promise<ArchiveRoomResponse | ErrorResponse>;
  /** Force-remove a member from a room (DR-0012 kick, admin User only). The
   * removal reaches all clients via the broadcast leave event on the
   * subscribe stream (same LeaveEvent shape a voluntary leave produces), not
   * this response. */
  kick(room: string, id: string): Promise<KickResponse | ErrorResponse>;
  /** Create a room whose initial members (besides the always-implicit
   * User/u1) are `members` (U3: SessionView's "+ 新規 Room" passes a single
   * sid; the sidebar ROOMS "+ 新規" (RoomCreator.tsx) passes an explicit
   * multi-select since it has no session context to imply one from). `title`
   * omitted lets the daemon default it, same as any other create_room call. */
  createRoom(
    members: string[],
    title?: string,
    kind?: "broadcast",
  ): Promise<CreateRoomResponse | ErrorResponse>;
  /** Create a `kind:"1on1"` priv room for `memberSid` (DR-0014 §2.2 auto-
   * create, called by SessionView's floating composer when no existing 1on1
   * exists for this session). The daemon enforces exactly one member (empty
   * or multiple returns `one_on_one_requires_single_member`) and the returned
   * room carries `kind:"1on1"` in its rooms-response entry, so subsequent
   * lookups can dedupe by that field rather than trusting the title string. */
  createOneOnOneRoom(
    memberSid: string,
    title?: string,
  ): Promise<CreateRoomResponse | ErrorResponse>;
  peers(): Promise<PeersResponse | ErrorResponse>;
  read(room: string, mids: string | number[]): Promise<ReadResponse | ErrorResponse>;
  /** Add a connected session to an existing room (DR-0011 §1-4: SessionList's
   * drag-a-session-row-onto-the-chat gesture, handled in RoomView's drop
   * zone). Success reaches this room's member list via the broadcast member
   * event on the subscribe stream (same as any other member join), not this
   * response — the caller only needs `already` to decide whether to show a
   * soft "already a member" notice. */
  invite(room: string, sid: string): Promise<InviteResponse | ErrorResponse>;
  /** List a directory under a connected session's cwd (DR-0008 fs_list, "" / absent = root). */
  fsList(sid: string, path?: string): Promise<FsListResponse | ErrorResponse>;
  /** Read a file under a connected session's cwd (DR-0008 fs_read). */
  fsRead(sid: string, path: string): Promise<FsReadResponse | ErrorResponse>;
  /** Read one exact absolute path from the session's transcript-derived
   * external_files allowlist (DR-0024 fs_read_external). */
  fsReadExternal(sid: string, path: string): Promise<FsReadResponse | ErrorResponse>;
  /** DR-0026: list a directory under one of the session's workspace_folders
   * (from session_status). Path is absolute; the daemon requires realpath to
   * be inside an allowlisted folder root or a descendant. */
  fsListWorkspace(sid: string, path: string): Promise<FsListResponse | ErrorResponse>;
  /** DR-0026: read a file under one of the session's workspace_folders. Same
   * directory-prefix allowlist as fsListWorkspace. */
  fsReadWorkspace(sid: string, path: string): Promise<FsReadResponse | ErrorResponse>;
  /** Create a new UTF-8 text file under docs/inbox/ relative to a connected
   * session's cwd (DR-0019 fs_write), while remaining inside its containment
   * root. Never overwrites — an existing path replies `file_exists`, a path
   * outside cwd/docs/inbox/ replies `path_not_writable`. */
  fsWrite(sid: string, path: string, content: string): Promise<FsWriteResponse | ErrorResponse>;
  /** Create a new empty (or short-content) text file at `path` under fs_edit's
   * authorization surfaces (kind ∈ {contained, workspace}). Symmetric partner
   * of fsEdit — used by the FileTree "+" affordance to create a file in the
   * currently-shown directory. Existing paths reply `file_exists`. */
  fsCreate(
    sid: string,
    path: string,
    kind: "contained" | "workspace",
    content: string,
  ): Promise<FsCreateResponse | ErrorResponse>;
  /** Delete a regular file (viewer trash action, kawaz r46 m25). File-only,
   * never recursive; refuses directories/symlinks. The caller is expected to
   * confirm() before invoking — the daemon has no confirmation surface. */
  fsDelete(
    sid: string,
    path: string,
    kind: "contained" | "workspace",
  ): Promise<FsDeleteResponse | ErrorResponse>;
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
  ): Promise<FsEditResponse | ErrorResponse>;
  /** Read a slice of a connected session's transcript jsonl (DR-0009
   * transcript_read). `before` omitted = tail of the file; pass the previous
   * reply's `start` to page older. */
  transcriptRead(
    sid: string,
    opts?: {
      before?: number;
      max_bytes?: number;
      /** DR-0025 Phase 2: read a subagent / workflow-agent transcript. Static
       * read only — subscribe is not offered on agent transcripts (DR-0025
       * §2.2, no live push of agent progress). */
      agent_id?: string;
      run_id?: string;
      teammate?: string;
    },
  ): Promise<TranscriptReadResponse | ErrorResponse>;
  /** Follow a connected session's transcript live (DR-0009 live-tail
   * addendum): appended complete lines arrive as `ev:"transcript"` pushes
   * (handled in onMessage below, folded into store as `timeline/tail`) until
   * transcriptUnsubscribe or disconnect. */
  transcriptSubscribe(sid: string): Promise<TranscriptSubscribeResponse | ErrorResponse>;
  transcriptUnsubscribe(sid: string): Promise<TranscriptUnsubscribeResponse | ErrorResponse>;
  /** One-shot fetch of a connected session's folded status snapshot (DR-0020
   * Phase 1 session_status) — todos/workflows/background as currently folded
   * by the daemon from its transcript jsonl. Not called by any component
   * today (subscribe's own response already carries the initial snapshot,
   * see below); kept for parity with the protocol's non-live op and any
   * future one-shot refresh need. */
  sessionStatus(sid: string): Promise<SessionStatusResponse | ErrorResponse>;
  /** Follow a connected session's folded status live (DR-0020 Phase 1
   * session_status_subscribe): the response itself carries the current
   * snapshot (unlike transcriptSubscribe, which only returns a size) —
   * callers dispatch `session-status/loaded` from the resolved response,
   * then again for every subsequent `ev:"session_status"` push (handled in
   * onMessage below) until sessionStatusUnsubscribe or disconnect. */
  sessionStatusSubscribe(sid: string): Promise<SessionStatusSubscribeResponse | ErrorResponse>;
  sessionStatusUnsubscribe(sid: string): Promise<SessionStatusUnsubscribeResponse | ErrorResponse>;
  /** One-shot fetch of the latest `claude agents --json` poll result (U1).
   * Called once in onOpen's handshake for the initial paint; subsequent
   * changes arrive unprompted as `ev:"agents"` pushes (see onMessage below). */
  agents(): Promise<AgentsResponse | ErrorResponse>;
  /** Search historical Claude Code session transcripts under daemon-detected
   * config dirs (DR-0021 Phase 1 op, Phase 2 client wiring; user role only).
   * `params` excludes `op` and `request_id` — the wire shape (including the
   * 2-phase correlation id) is assembled here, same convention as
   * fsList/transcriptRead's option-object callers. */
  sessionSearch(
    params: Omit<SessionSearchRequest, "op" | "request_id">,
  ): Promise<SessionSearchResponse | ErrorResponse>;
  /** Round trip to the daemon, carrying provenance (exe/script/version, U1
   * footer) alongside the existing liveness fields. Called once in onOpen's
   * handshake, not polled — provenance only changes across a daemon restart,
   * which already re-runs the whole handshake. */
  ping(): Promise<PingResponse | ErrorResponse>;
  /** Translate complete texts through the daemon host. Unlike browser
   * translation, callers must not split or skip Japanese-containing segments.
   * 2-phase on the wire (ack + ev:"translate_result") so concurrent
   * translations never block other ops' replies; the returned Promise still
   * settles with the final outcome. */
  translate(texts: string[]): Promise<TranslateResponse | ErrorResponse>;
  /** Session-launcher directory-only cwd tree (DR-0018 §3.2, user role only).
   * `depth` omitted uses the daemon's configured `dir_tree_depth`; CwdTree's
   * lazy-expansion re-fetch of a boundary node passes 1. */
  dirTree(
    roots: string[],
    opts?: { depth?: number; filter?: string },
  ): Promise<DirTreeResponse | ErrorResponse>;
  /** Launch a new session via the configured command template (DR-0018 §3.2,
   * user role only). The daemon awaits the whole run (bounded by
   * `timeout_seconds` + kill x2, §3.3) before the result event arrives, so
   * this call is naturally slow — SessionCreator shows its own loading state
   * while it's in flight rather than relying on a generic pending indicator.
   * The 2-phase wire exchange (ack + result event) is hidden here: the
   * returned Promise settles with the final outcome, same as before. */
  sessionLaunch(
    req: Omit<SessionLaunchRequest, "op" | "request_id">,
  ): Promise<SessionLaunchResponse | ErrorResponse>;
  /** Session-launcher config projection (DR-0018 §3.4 addendum, user role
   * only): `root_dirs` (CwdTree's initial fetch roots) and `default_prompt`
   * (SessionCreator's "default" button). `error.code === "launcher_not_configured"`
   * is the signal SessionCreator uses to show setup guidance instead of the
   * form (§2.1 "launcher 未設定時"). */
  sessionLauncherConfig(): Promise<SessionLauncherConfigResponse | ErrorResponse>;
  /** Terminate the OS process behind a session (DR-0028, user role only —
   * StatusPanel's danger-zone button). The daemon resolves the pid fresh and
   * runs the two-shot SIGTERM sequence, so this is naturally slow (up to
   * ~4s); 2-phase on the wire (ack + ev:"session_kill_result") like
   * sessionLaunch, hidden behind one Promise. `terminated: false` in a
   * successful response means "signals sent, termination unconfirmed". */
  sessionKill(
    sessionId: string,
    opts?: { force?: boolean },
  ): Promise<SessionKillResponse | ErrorResponse>;
}

/** Every final outcome a 2-phase op can settle with (the result event's
 * payload minus its ev/request_id envelope, or a synchronous validation
 * error / connection_closed flush). */
type TwoPhaseOutcome =
  | TranslateResponse
  | SessionKillResponse
  | SessionLaunchResponse
  | SessionSearchResponse
  | ErrorResponse;

export function createWsClient(
  dispatch: (action: Action) => void,
  getState: () => AppState,
): WsHandle {
  let ws: WebSocket | null = null;
  let pending: Array<(v: Response) => void> = [];
  /** 2-phase ops' outstanding result-event resolvers, keyed by request_id
   * (see the header comment's classification rule). Entries live from the
   * request being written until the `ev:"*_result"` push, a validation-error
   * positional reply, or a disconnect flush — whichever comes first. */
  const inflight = new Map<string, (v: TwoPhaseOutcome) => void>();
  /** request_ids only need to be unique among this client's in-flight
   * requests (protocol doc), so a monotonic counter suffices — no UUID. */
  let nextRequestId = 0;
  let reconnectAttempt = 0;
  let closedByUs = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const since = loadSince();

  function send<T extends Response>(req: Request): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      pending.push(resolve as (v: Response) => void);
      ws.send(JSON.stringify(req));
    });
  }

  /** Send a 2-phase op (translate / session_launch / session_search): the
   * positional reply slot only consumes the immediate ack (or a synchronous
   * validation error, which settles the Promise right away), and the final
   * outcome arrives as the correlated result event — resolved through
   * `inflight` in onMessage. Callers get one Promise for the final outcome,
   * exactly like plain send(), so no component needed changing. */
  function sendTwoPhase<T extends TwoPhaseOutcome>(
    req: Request & { request_id: string },
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      const rid = req.request_id;
      const settle = resolve as (v: TwoPhaseOutcome) => void;
      inflight.set(rid, settle);
      pending.push((ack) => {
        // ok ack = accepted; the result event will settle via `inflight`.
        // An ok:false positional reply means the op failed synchronous
        // validation and no event will ever come — settle now. The identity
        // guard keeps this a no-op if a disconnect flush already settled us
        // (flushPending clears `inflight` before flushing `pending`).
        if (!ack.ok && inflight.get(rid) === settle) {
          inflight.delete(rid);
          settle(ack);
        }
      });
      ws.send(JSON.stringify(req));
    });
  }

  async function onOpen(): Promise<void> {
    reconnectAttempt = 0;
    dispatch({ type: "conn/status", status: "connected" });
    // Capability belongs to the current daemon process. Clear a previous
    // connection's answer before probing this hello so stale host tabs cannot
    // survive a reconnect to a different/non-macOS daemon.
    dispatch({ type: "translator/availability", host: false });
    // Snapshot store emptiness BEFORE the handshake runs — the `op:"rooms"`
    // reply below dispatches rooms/loaded, which repopulates state.rooms from
    // whatever the daemon knows, and any getState() read after that point
    // sees a non-empty map even on a fresh page reload. Reload has to be
    // distinguished from in-page reconnect right here, at t0.
    //
    // Page reload starts from a fresh empty store — the localStorage-carried
    // `since_seq` cursor is stale in the sense that "we've seen up to seq N" no
    // longer holds against an empty scrollback. Omit `since_seq` so the daemon
    // replays the full backlog (u1 role is uncapped, see server.ts's
    // sendBacklog non-since branch) and RoomView paints with real history
    // instead of only msgs newer than the pre-reload cursor (kawaz 2026-07-14:
    // "ROOMを選択した時に過去ログが空になる… ユーザ向けには全ログを再送信して復元されるように").
    // In-page reconnects still send `since_seq` — the store retained its state
    // across the disconnect, so BBS delta replay is the correct/cheap thing
    // (packages/cli's reconnect.test.ts contract for daemon-restart transparency).
    //
    // `backlog: true` on both branches (issue 2026-07-17-subscribe-no-backlog-default):
    // the daemon's subscribe default became "no replay, just a room_cursors summary"
    // for any room without a `since_seq` cursor — a CLI-sidecar-shaped default that
    // would leave RoomView with no history for a room this connection has no cursor
    // for yet (a fresh reload, or a room created entirely during a dropped in-page
    // reconnect). The webui always wants the old unconditional snapshot for those,
    // so it opts back in explicitly; rooms already covered by `since_seq` still take
    // the cheaper delta-replay path regardless of this flag.
    const spaHasState = getState().rooms.size > 0;
    try {
      const hello = await send<HelloResponse>({ op: "hello", role: "user" });
      // Terminal タブの gateway URL (issue 2026-07-21) — daemon config.json 未設定
      // なら省略されるので null に落とす。値が来ていれば AppState に反映し、
      // SessionView は「hyoui_session_id 解決済み かつ この URL 有り」の
      // 両条件でのみ Terminal タブを出す。
      if (hello.ok) {
        dispatch({
          type: "terminal-gateway/loaded",
          url: hello.terminal_gateway_url ?? null,
        });
      }
      const rooms = await send<RoomsResponse>({ op: "rooms" });
      if (rooms.ok) dispatch({ type: "rooms/loaded", rooms: rooms.rooms });
      await send(
        spaHasState
          ? { op: "subscribe", since_seq: since, backlog: true }
          : { op: "subscribe", backlog: true },
      );
      const peers = await send<PeersResponse>({ op: "peers" });
      if (peers.ok) dispatch({ type: "peers/loaded", peers: peers.peers });
      // U1: initial `claude agents --json` paint + daemon provenance for the
      // footer. Neither failure here should abort the handshake above (both
      // already landed) — a rejection just falls through to the catch below
      // and skips these two dispatches, same as any other mid-handshake drop.
      const agentsRes = await send<AgentsResponse>({ op: "agents" });
      if (agentsRes.ok) dispatch({ type: "agents/loaded", agents: agentsRes.agents });
      const ping = await send<PingResponse>({ op: "ping" });
      if (ping.ok)
        dispatch({
          type: "daemon-info/loaded",
          version: ping.version,
          exe: ping.exe,
          script: ping.script,
        });
      // DR-0023 host capability probe. An empty batch verifies the daemon can
      // find/build its helper without starting TranslationSession or translating
      // dummy content; a later per-item model error hides the tab at first use.
      // Goes through the 2-phase path like any other translate — the probe's
      // outcome arrives on its result event and this await resumes then.
      const translate = await sendTwoPhase<TranslateResponse>({
        op: "translate",
        request_id: `q${++nextRequestId}`,
        texts: [],
      });
      dispatch({ type: "translator/availability", host: translate.ok });
    } catch {
      // socket dropped mid-handshake; onClose already schedules the reconnect.
    }
  }

  function onMessage(data: string): void {
    let obj: StreamEvent | Response;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    // `ev` must be classified BEFORE `ok`: 2-phase result events carry both
    // (see the header comment). Shifting `pending` for one of these would
    // steal a later op's positional reply slot and desynchronize every reply
    // after it.
    if (Object.hasOwn(obj, "ev")) {
      const streamEv = obj as StreamEvent;
      if (
        "ev" in streamEv &&
        (streamEv.ev === "translate_result" ||
          streamEv.ev === "session_launch_result" ||
          streamEv.ev === "session_kill_result" ||
          streamEv.ev === "session_search_result")
      ) {
        const settle = inflight.get(streamEv.request_id);
        if (settle) {
          inflight.delete(streamEv.request_id);
          const { ev: _ev, request_id: _rid, ...result } = streamEv;
          settle(result as TwoPhaseOutcome);
        }
        return;
      }
      onStreamEvent(streamEv);
      return;
    }
    if (Object.hasOwn(obj, "ok")) {
      const settle = pending.shift();
      settle?.(obj as Response);
      return;
    }
    onStreamEvent(obj as StreamEvent);
  }

  function onStreamEvent(streamEv: StreamEvent): void {
    if ("ev" in streamEv && streamEv.ev === "restarting") {
      dispatch({ type: "conn/status", status: "restarting" });
      return;
    }
    if ("ev" in streamEv && streamEv.ev === "notify") return; // not surfaced in the UI (yet)
    // Never actually emitted to this client — the webui always subscribes with
    // `backlog: true` (see onOpen) so every visible room gets a real replay
    // instead. Guarded here anyway so a protocol drift can't fall through to
    // the DeliveredEvent cast below and get dispatched as a bogus room event.
    if ("ev" in streamEv && streamEv.ev === "room_cursors") return;
    // U1: live push whenever the daemon's merged `claude agents --json` poll
    // result changes (only emitted while >=1 user-role subscriber is
    // connected) — folds straight into the same agents/loaded action the
    // one-shot op:"agents" reply in onOpen uses, so the reducer has exactly
    // one code path for "replace the agents list".
    if ("ev" in streamEv && streamEv.ev === "agents") {
      dispatch({ type: "agents/loaded", agents: (streamEv as AgentsStreamEvent).agents });
      return;
    }
    // U1: live push whenever the connected-session list changes (registers,
    // fully disconnects, or updates hello metadata) — folds straight into the
    // same peers/loaded action the one-shot op:"peers" reply in onOpen uses,
    // so the reducer has exactly one code path for "replace the peers list"
    // (same pattern as ev:"agents" above; issue
    // 2026-07-12-peers-live-update-protocol).
    if ("ev" in streamEv && streamEv.ev === "peers") {
      dispatch({ type: "peers/loaded", peers: (streamEv as PeersStreamEvent).peers });
      return;
    }
    // Live-tail push for a session's transcript (DR-0009 addendum,
    // transcript_subscribe): folded into the sid's TimelineState by the
    // reducer's applyTimelineTail, which is the one place that decides
    // whether this batch is contiguous with what's cached (see its doc
    // comment) — this layer just relays the wire shape verbatim.
    if ("ev" in streamEv && streamEv.ev === "transcript") {
      dispatch({
        type: "timeline/tail",
        sid: streamEv.sid,
        lines: streamEv.lines,
        start: streamEv.start,
        end: streamEv.end,
        size: streamEv.size,
      });
      return;
    }
    // Live-tail push for a session's folded status (DR-0020 Phase 1/2
    // session_status_subscribe): folds straight into `session-status/loaded`,
    // the same action sessionStatusSubscribe's own resolved response
    // dispatches for the initial snapshot — the reducer has exactly one
    // "replace this sid's snapshot" code path (same pattern as
    // ev:"transcript" above, minus contiguity bookkeeping since this is
    // always a full recomputed snapshot, not an append).
    if ("ev" in streamEv && streamEv.ev === "session_status") {
      const ev = streamEv as SessionStatusStreamEvent;
      dispatch({
        type: "session-status/loaded",
        sid: ev.sid,
        snapshot: {
          todos: ev.todos,
          workflows: ev.workflows,
          background: ev.background,
          ...(ev.context ? { context: ev.context } : {}),
          teammates: ev.teammates ?? [],
          external_files: ev.external_files ?? [],
          ...(ev.workspace_folders ? { workspace_folders: ev.workspace_folders } : {}),
          ...(ev.agent_tree ? { agent_tree: ev.agent_tree } : {}),
        },
      });
      return;
    }
    const delivered = streamEv as DeliveredEvent;
    // Cursor advances on every StorageEvent delivery that carries a seq
    // (DR-0016 §2.4: all event types, not just msg) — ephemeral stream events
    // (notify/restarting/agents/peers/transcript) are handled above and never
    // reach here.
    if (typeof delivered.seq === "number") {
      since[delivered.r] = Math.max(since[delivered.r] ?? 0, delivered.seq);
      saveSince(since);
    }
    dispatch({ type: "protocol-event", event: delivered });
  }

  // Settles every in-flight send()/sendTwoPhase() with a synthetic error
  // response instead of leaving its Promise pending forever, and empties both
  // registries so a stale resolver can never be mis-matched (via onMessage's
  // pending.shift() or an `inflight` request_id reused after reconnect) to a
  // reply/event that arrives on a later, reconnected socket. `inflight` is
  // flushed FIRST: sendTwoPhase's positional ack callback guards on
  // `inflight.get(rid) === settle`, so clearing the map here turns those
  // still-queued ack callbacks into no-ops instead of double-settles.
  function flushPending(): void {
    const closed: ErrorResponse = {
      ok: false,
      error: { code: "connection_closed", msg: "ws connection closed" },
    };
    const staleInflight = [...inflight.values()];
    inflight.clear();
    for (const settle of staleInflight) settle(closed);
    const stale = pending;
    pending = [];
    for (const settle of stale) settle(closed);
  }

  function onClose(): void {
    dispatch({ type: "conn/status", status: "disconnected" });
    flushPending();
    if (closedByUs) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    closedByUs = false;
    // A manual connect() supersedes any scheduled auto-reconnect; without this,
    // the pending timer would fire later and knock down the fresh socket.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Belt-and-suspenders: also flush on connect() itself, in case it's ever
    // invoked (e.g. a manual reconnect) without onClose having run first.
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
      void onOpen();
    });
    socket.addEventListener("message", (e) => {
      if (socket !== ws) return;
      onMessage(e.data as string);
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
      // Cancel a scheduled auto-reconnect too: close() means "stop", including
      // the reconnect already queued by a close event that preceded this call.
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    },
    post: (room, msg, to) => send({ op: "post", room, msg, ...(to && to.length ? { to } : {}) }),
    setTitle: (room, title) => send({ op: "set_title", room, title }),
    archiveRoom: (room, archived) => send({ op: "archive_room", room, archived }),
    kick: (room, id) => send({ op: "kick", room, id }),
    createRoom: (members, title, kind) =>
      send({
        op: "create_room",
        members,
        ...(title ? { title } : {}),
        ...(kind ? { kind } : {}),
      }),
    createOneOnOneRoom: (memberSid, title) =>
      send({
        op: "create_room",
        members: [memberSid],
        kind: "1on1",
        ...(title ? { title } : {}),
      }),
    peers: () => send({ op: "peers" }),
    read: (room, mids) => send({ op: "read", room, mids }),
    invite: (room, sid) => send({ op: "invite", room, sid }),
    fsList: (sid, path) => send({ op: "fs_list", sid, ...(path !== undefined ? { path } : {}) }),
    fsRead: (sid, path) => send({ op: "fs_read", sid, path }),
    fsReadExternal: (sid, path) => send({ op: "fs_read_external", sid, path }),
    fsListWorkspace: (sid, path) => send({ op: "fs_list_workspace", sid, path }),
    fsReadWorkspace: (sid, path) => send({ op: "fs_read_workspace", sid, path }),
    fsWrite: (sid, path, content) => send({ op: "fs_write", sid, path, content }),
    fsCreate: (sid, path, kind, content) => send({ op: "fs_create", sid, path, kind, content }),
    fsDelete: (sid, path, kind) => send({ op: "fs_delete", sid, path, kind }),
    fsEdit: (sid, path, kind, content, expected_mtime, expected_size) =>
      send({ op: "fs_edit", sid, path, kind, content, expected_mtime, expected_size }),
    transcriptRead: (sid, opts) =>
      send({
        op: "transcript_read",
        sid,
        ...(opts?.before !== undefined ? { before: opts.before } : {}),
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
    sessionSearch: (params) =>
      sendTwoPhase({ op: "session_search", request_id: `q${++nextRequestId}`, ...params }),
    ping: () => send({ op: "ping" }),
    translate: (texts) =>
      sendTwoPhase({ op: "translate", request_id: `q${++nextRequestId}`, texts }),
    dirTree: (roots, opts) =>
      send({
        op: "dir_tree",
        roots,
        ...(opts?.depth !== undefined ? { depth: opts.depth } : {}),
        ...(opts?.filter !== undefined ? { filter: opts.filter } : {}),
      }),
    sessionLaunch: (req) =>
      sendTwoPhase({ op: "session_launch", request_id: `q${++nextRequestId}`, ...req }),
    sessionLauncherConfig: () => send({ op: "session_launcher_config" }),
    sessionKill: (sessionId, opts) =>
      sendTwoPhase({
        op: "session_kill",
        request_id: `q${++nextRequestId}`,
        session_id: sessionId,
        ...(opts?.force ? { force: true } : {}),
      }),
  };
}
