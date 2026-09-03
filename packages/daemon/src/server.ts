// UDS + HTTP/WS server + wire protocol dispatch + delivery (DR-0003, DR-0004).
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import {
  ADMIN_ID,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_HTTP_ALLOW,
  DEFAULT_HTTP_BIND,
  DEFAULT_JOIN_BACKLOG,
  ErrorCode,
  LLM_STATS_DAYS_MAX,
  LLM_STATS_DAYS_MIN,
  VERSION,
  PROTOCOL_VERSION,
  UNANNOUNCED_PROTOCOL_VERSION,
  resolvePaths,
  type ArchiveEvent,
  type ErrorResponse,
  type Identity,
  type KindEvent,
  type LastLiveSession,
  type LeaveEvent,
  type LlmStatsResponse,
  type LlmStatusReport,
  type LlmStatusResponse,
  type LlmUsageResponse,
  type MemberEvent,
  type MsgEvent,
  type PingResponse,
  type NotifyFrom,
  type Paths,
  type PeerInfo,
  type Request,
  type RoomKind,
  type SayEvent,
  type SayReadEvent,
  type SessionIdentity,
  type StaleClientInfo,
  type SessionEnvResponse,
  type SessionKillResponse,
  type SessionRenameResponse,
  type SessionLaunchResponse,
  type SessionSearchResponse,
  type ForkOriginResponse,
  type SessionDumpFileResponse,
  type StorageEvent,
  type TitleEvent,
  type TranslateResponse,
  migrateLegacyConfigFiles,
} from "@ccmsg/protocol";
import { Logger } from "./log.ts";
import { TraceWriter } from "./trace.ts";
import { loadConfig, writeConfigTypesFile, type ResolvedCcmsgConfig } from "./config.ts";
import { dirTree } from "./dir-tree.ts";
import {
  fsList,
  fsListWorkspace,
  fsCreate,
  fsDelete,
  fsEdit,
  fsRead,
  fsReadExternal,
  fsReadWorkspace,
  fsStatBatch,
  fsWrite,
  realpathOrSelf,
  validateRepoRoot,
} from "./fs-access.ts";
import { fsFind } from "./fs-find.ts";
import { executeSessionLaunch, validateSessionLaunch } from "./session-launch.ts";
import {
  readLastLiveSessions,
  withLaunchContext,
  writeLastLiveSessions,
} from "./last-live-sessions.ts";
import { createForkOriginCache } from "./fork-origin.ts";
import { productionKillDeps, sessionKill } from "./session-kill.ts";
import { productionRenameDeps, sessionRename, validateRenameTitle } from "./session-rename.ts";
import { productionEnvDeps, sessionEnv } from "./session-env.ts";
import { sessionSearch } from "./session-search.ts";
import { dumpSession, writeSessionDumpFile } from "./session-dump.ts";
import { fetchLlmUsage } from "./llm-usage.ts";
import { fetchLlmStats, isValidDays } from "./llm-stats.ts";
import { fetchLlmStatus, LlmStatusRefresher } from "./llm-status.ts";
import {
  createSessionErrorsStore,
  sessionErrorEntries,
  stopAllSessionErrors,
  sessionErrorsReady,
  syncSessionErrorWatches,
  type SessionErrorsStore,
} from "./session-errors.ts";
import {
  createSessionUserInputStore,
  lastUserInputAt,
  sessionUserInputsReady,
  stopAllUserInputs,
  syncUserInputWatches,
  userInputEntries,
  type SessionUserInputStore,
} from "./session-user-input.ts";
import { createNetworkWatch, fileNetworkSource, type NetworkWatch } from "./network-watch.ts";
import {
  createSessionWakeState,
  recordWoken,
  wakesForOnline,
  type SessionWakeState,
} from "./session-wake.ts";
import {
  createSessionStatusStore,
  getSessionStatus,
  sessionStatusUnsubscribeAll,
  stopAllSessionStatus,
  subscribeSessionStatus,
  unsubscribeSessionStatus,
  type SessionStatusStore,
} from "./session-status.ts";
import { deriveRepoWs } from "./repo-derive.ts";
import { canNativeSendMessage, normalizeConfigDir } from "./native-messaging.ts";
import {
  adoptTranscriptPath,
  createTranscriptTailStore,
  resolveTranscript,
  stopAllTailWatches,
  transcriptRead,
  transcriptSubscribe,
  transcriptUnsubscribe,
  transcriptUnsubscribeAll,
  type TranscriptTailStore,
} from "./transcript.ts";
import {
  createAgentsPoller,
  maybeStartAgentsPoller,
  maybeStopAgentsPoller,
  stopAgentsPoller,
  type AgentsPoller,
} from "./agents.ts";
import { LlmRequestCache, parseLlmRequestEvent } from "./llm-events.ts";
import { type WebhookSource } from "./webhook.ts";
import { tryAcquireLock, type LockHandle } from "./flock.ts";
import { startHttpListener, type HttpFallback, type HttpListener } from "./http.ts";
import {
  compileSandboxOrigin,
  createSandboxGrants,
  mintSandboxGrant,
  revokeSandboxGrant,
  type SandboxGrants,
  type SandboxOrigin,
} from "./sandbox.ts";
import { parseAllowList, type Cidr } from "./ip-allowlist.ts";
import { createOriginsFile } from "./origins-file.ts";
import { fetchTailscaleServeOrigins } from "./tailscale-origin.ts";
import { createTranslateService, type TranslateService } from "./translate-helper.ts";
import {
  appendEvent,
  closeRoom,
  compareIds,
  lastTs,
  memberIdBySid,
  nextAgentMemberId,
  parseMidSelector,
  presentMembers,
  readMsgs,
  sayUnreadSeqs,
  scanRooms,
  type Room,
} from "./storage.ts";

/**
 * A connection abstracted over its transport. UDS and HTTP/WS conns both boil down
 * to "can accept a line of wire protocol"; dispatch/delivery/subscribe never touch
 * the transport directly (DR-0004 §2 seam).
 */
export interface Conn {
  write(line: string): void;
  identity: Identity | null;
  subscribed: boolean;
}

interface SessionEntry {
  meta: {
    sid: string;
    repo: string;
    ws: string;
    cwd: string;
    /** present iff hello announced a transcript_path that validated (DR-0009). */
    transcript_path?: string;
    /** present iff hello announced a repo_root that validated (DR-0008 addendum). */
    repo_root?: string;
    /** present iff hello announced a non-empty branch/bookmark name. */
    branch?: string;
  };
  /** Normalized CLAUDE_CONFIG_DIR this session runs under, when a hello
   * announced one. Deliberately outside `meta`: it exists only to answer
   * `PeerInfo.send_message` for a session asking about its peers, and `meta`
   * is copied verbatim onto the wire (peers, ev:"peers", the last-live
   * snapshot) where a bare config dir path would be noise nobody reads. */
  configDir?: string;
  /** ccmsg build / wire generation the latest hello for this sid announced
   * (PeerInfo.client_version / .protocol). Outside `meta` for the same reason
   * configDir is: `meta` is also the last-live snapshot's payload, and which
   * build was running when a daemon died says nothing about the session that
   * has to be resumed. */
  clientVersion?: string;
  clientProtocol?: number;
  conns: Set<Conn>;
  /** ISO time this entry was first created in this daemon process; a later
   * hello for the same sid reuses the existing entry and never touches this
   * (DR: webui session-list ordering wants a stable "connected since", not a
   * value that jumps on every reconnect). Only a full sid removal (conns
   * drops to zero, see removeConn) followed by a fresh hello resets it. */
  connectedAt: string;
  /** ISO time of this sid's most recent request on any of its connections;
   * unset until the first request after hello. Updated from the single
   * choke point in handleRequest so subscribe-stream pushes (which aren't
   * requests) correctly leave a session looking idle. */
  lastActivityAt?: string;
}

interface Listener {
  stop(closeActiveConnections?: boolean): void;
}

export interface Daemon {
  paths: Paths;
  /** User configuration is parsed once at daemon startup (DR-0018 LN-Q4). */
  config: ResolvedCcmsgConfig;
  version: string;
  startTime: number;
  rooms: Map<string, Room>;
  /** dedupKey -> room id (dedup-eligible rooms only, latest createdAt wins). */
  dedupIndex: Map<string, string>;
  connections: Set<Conn>;
  sessions: Map<string, SessionEntry>;
  subscribers: Set<Conn>;
  log: Logger;
  lock: LockHandle;
  server: Listener | null;
  httpListeners: HttpListener[];
  /** raw CCMSG_HTTP_ALLOW entries currently in effect, for status/ping display. */
  httpAllow: string[];
  dedupWindowMs: number;
  shuttingDown: boolean;
  /** `claude agents --json` merged poll state (DR-0009-agents addendum). */
  agentsPoller: AgentsPoller;
  /** live-tail Watch state per sid (DR-0009 live-tail addendum). */
  transcriptTail: TranscriptTailStore;
  /** component-boundary timestamps for transcript latency diagnosis, from the
   * daemon's own file check through the browser points posted via
   * `client_trace`. See docs/runbooks/transcript-latency-trace.md. */
  trace: TraceWriter;
  /** folded transcript status subscriptions per sid (DR-0020 Phase 1). */
  sessionStatus: SessionStatusStore;
  /** api_error fold across every connected peer, for the sidebar's error
   * section. Independent of `sessionStatus`, which only follows the sids a
   * client explicitly subscribed to. */
  sessionErrors: SessionErrorsStore;
  sessionUserInputs: SessionUserInputStore;
  /** sessionErrorEntries() as of the last `ev:"session_errors"` broadcast —
   * same "don't push an unchanged list" guard as peersSnapshot. */
  sessionErrorsSnapshot: string;
  /** Host network online/offline transitions, the trigger for waking sessions
   * stalled on an API error. Null where no monitor could be started. */
  networkWatch: NetworkWatch | null;
  /** Which stalls have already been woken, so a flapping link pokes each
   * stopped session at most once per stall. */
  sessionWake: SessionWakeState;
  /** Live capability grants for the sandbox origin (DR-0030 §4.1). Memory
   * only — a restart is the intended way to invalidate every outstanding
   * preview URL. */
  sandboxGrants: SandboxGrants;
  /** `config.sandbox_origin_template` compiled into a host matcher, or null
   * when unconfigured/malformed — which is also what turns the whole sandbox
   * surface off (no hello capability, no mint, no Host branch). */
  sandboxOrigin: SandboxOrigin | null;
  /** Memoized fork-seam resolutions (fork-origin.ts), keyed by transcript
   * identity so a live session's appends don't re-trigger the sweep. */
  forkOrigins: ReturnType<typeof createForkOriginCache>;
  /** Persistent macOS Translation.framework helper (DR-0023). */
  translator: TranslateService;
  /** peersCompareKey() as of the last `ev:"peers"` broadcast (issue 2026-07-12-
   * peers-live-update-protocol) — lets maybeBroadcastPeers skip a push when a
   * hello re-send (or any other registerSession/removeConn call) didn't actually
   * change the peers list. "" before the first push. */
  peersSnapshot: string;
  /** Out-of-date ccmsg clients seen per sid (PeerInfo.stale_client), including
   * the ones whose hello was refused — those never reach `sessions`, so this
   * is the only record that they tried. Keyed by the sid the refused hello
   * claimed; a hello speaking the current generation deletes its own entry. */
  staleClients: Map<string, StaleClientInfo>;
  /** Sessions a previous daemon last saw connected and that have not
   * registered again (last-live-sessions.ts), keyed by sid. Loaded once at
   * startup and only ever shrinks while this daemon runs — the one thing that
   * removes an entry is that sid coming back. */
  lastLive: Map<string, LastLiveSession>;
  /** Latest LLM gateway request per conversation series, for the webui's
   * prompt-cache ring (llm-events.ts). Filled by the gateway posting to
   * `/webhook/llm-gateway`; with no such webhook configured it stays empty and
   * no ev:"llm_requests" is ever sent. */
  llmRequests: LlmRequestCache;
  /** Re-reads the gateway's status endpoint after one of its request events
   * reports a 529 (llm-status.ts), and pushes the result to user-role
   * subscribers. Null when no `llm_status_url` is configured — there is then
   * nothing to read, and the events are still folded into llmRequests. */
  llmStatusRefresher: LlmStatusRefresher | null;
  /** Producers allowed to POST to `/webhook/<source>`, keyed by that path
   * segment (webhook.ts). Built at startup from config + token files, so a
   * source whose token could not be read simply isn't here — and its route
   * 404s. */
  webhooks: Map<string, WebhookSource>;
}

const nowIso = (): string => new Date().toISOString();

/** The request `dispatch` is currently answering, for the connection it came
 * in on. Async-local rather than a parameter because every reply already flows
 * through `send`/`sendErr`, and threading an id through all ~55 dispatch cases
 * (plus the helpers they call, which reply on their own) would put the same
 * value in every signature in this file.
 *
 * Design rationale: the alternative to a request-scoped store is a field on
 * Conn, which the FIFO removal below rules out — several requests of one
 * connection are now in flight at once, so "the id this connection is
 * answering" is not a property of the connection. */
const activeRequest = new AsyncLocalStorage<{ conn: Conn; requestId: string }>();

/** True for the frames that answer a request: replies carry `ok`, pushes carry
 * `ev`. The 2-phase result events carry both and are classified as pushes,
 * exactly as client authors are told to classify them (see
 * TranslateResultEvent's doc comment). */
function isReplyFrame(obj: unknown): obj is Record<string, unknown> {
  return (
    typeof obj === "object" &&
    obj !== null &&
    Object.hasOwn(obj, "ok") &&
    !Object.hasOwn(obj, "ev") &&
    !Object.hasOwn(obj, "request_id")
  );
}

export function send(conn: Conn, obj: unknown): void {
  // Stamp the correlation id on the way out, so no dispatch case has to
  // remember to. Only the reply going back to the connection that asked gets
  // one: a broadcast reaching other connections while this request runs is
  // nobody's answer.
  const active = activeRequest.getStore();
  const frame =
    active && active.conn === conn && isReplyFrame(obj)
      ? { ...obj, request_id: active.requestId }
      : obj;
  try {
    conn.write(`${JSON.stringify(frame)}\n`);
  } catch {
    // transport may be closing; delivery is best-effort
  }
}

function sendErr(conn: Conn, code: string, msg: string): void {
  send(conn, { ok: false, error: { code, msg } });
}

function sendReplyViaTlError(conn: Conn, room: Room | null): void {
  // `room=null` は create_room/next_room の pre-check 経路 (RL-Q1、kawaz r26
  // mid=103) — 対象 room がまだ存在しないので room id を含めず「session 発の
  // 初期 --msg 自体を諦めろ」と誘導する。room 指定時は既存 post/reply ガードの
  // 文言 (room id 込み) を維持する。
  const suffix = room
    ? `do not post/reply into ${room.id}`
    : `do not attach --msg on a session-initiated 1on1 create_room/next_room`;
  sendErr(
    conn,
    ErrorCode.reply_via_tl,
    `this 1on1 room is routed "tl": respond via your normal assistant output ` +
      `(transcript) — ${suffix}`,
  );
}

/** id the connection acts as inside `room`, for delivery-time bookkeeping like
 * reply_via. Returns ADMIN_ID for the user role, the member id for a member
 * session, or null when the subscriber isn't a member (u1 always resolves;
 * a non-member session subscriber never reaches writeDelivered because
 * subscriberSeesRoom would have filtered them out first). */
function recipientId(conn: Conn, room: Room): string | null {
  const id = conn.identity;
  if (!id) return null;
  if (id.role === "user") return ADMIN_ID;
  return memberIdBySid(room).get(id.sid) ?? null;
}

/** DR-0017 addendum: per-recipient instruction telling the receiver exactly
 * how to respond. The daemon computes it at delivery time because archive and
 * 1on1 routing are room-state dependent. */
function computeReplyVia(room: Room, ev: MsgEvent): string {
  if (room.archived) return "No reply needed";
  if (room.kind === "1on1" && ev.from === ADMIN_ID) {
    return "Reply in your normal assistant response";
  }
  return `Use \`ccmsg reply ${room.id}m${ev.mid} <msg>\``;
}

/** Empirical harness truncation cap on Monitor stdout lines wrapped into a
 * `<task-notification>` block: measured across ~140 real truncation samples
 * from `~/.claude-personal/projects/**` (docs/findings/2026-07-19-task-
 * notification-truncation.md). Two clusters appeared, ~500 chars of `<event>`
 * body and ~3000 chars. We conservatively assume the smaller cap since kawaz
 * r34 mid=18 is a recent hit; going below it guarantees no wire truncation
 * regardless of which mode the harness is in.
 *
 * `WIRE_MSG_SAFE_BYTES` is the max serialized-JSON length we will emit for a
 * `msg` frame on the subscribe wire. When the naturally-built frame exceeds
 * it, we omit `msg` and end the frame with a `msg_via` fetch instruction.
 * Storage (`rooms/*.jsonl`) always keeps the full body. Override via env for
 * tuning: `CCMSG_WIRE_MSG_SAFE_BYTES=<positive integer>`. Default = 400 bytes
 * ≈ 80% of the 500-char empirical cap (kawaz spec: 8-9 割で予測遮断). */
function readWireMsgSafeBytesEnv(): number {
  const raw = process.env.CCMSG_WIRE_MSG_SAFE_BYTES;
  if (raw === undefined || raw === "") return 400;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n <= 0) return 400;
  return n;
}
const WIRE_MSG_SAFE_BYTES = readWireMsgSafeBytesEnv();

/** Recent-replay window for the bare-default subscribe path (kawaz r46 mid=35).
 * A subscriber that didn't set a `since_seq`/`backlog` cursor for a room still
 * receives msgs posted within the last N ms that would have been live-delivered
 * had they been present — with `replay: true` marking them as catch-up. Fixes
 * the "post → target hasn't wired their subscribe yet → msg silently dropped"
 * failure mode for freshly-spawned peer AI sessions. 3 min default; env override
 * exists purely for tests (production keeps the default). */
function readRecentReplayMsEnv(): number {
  const raw = process.env.CCMSG_RECENT_REPLAY_MS;
  if (raw === undefined || raw === "") return 3 * 60 * 1000;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return 3 * 60 * 1000;
  return n;
}
const RECENT_REPLAY_WINDOW_MS = readRecentReplayMsEnv();

/** subscribe wire order for `msg` events: `msg` (the body) is placed last,
 * after every other field (docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md).
 * The harness's task-notification truncation cuts from the block's tail, so
 * with the old field order (msg mid-way, `seq`/response metadata after it) a
 * long `msg` silently ate the trailing fields (kawaz r26 mid=110). Putting
 * `msg` last means truncation always lands inside the body — visibly incomplete —
 * instead of silently dropping `reply_via`/`seq`. `JSON.stringify` key order
 * follows insertion order, so this rebuilds the object explicitly rather than
 * spreading `ev`. Storage (`rooms/*.jsonl`, the `MsgEvent` type) keeps its own
 * field order — this only reshapes the live subscribe wire frame.
 *
 * Additionally, when `redirectOversize` is set (session-role subscribers —
 * the ones whose frames pass through a Monitor's task-notification wrapper)
 * and the naturally-built frame's serialized length would exceed
 * `WIRE_MSG_SAFE_BYTES` (empirical safe-fraction of the harness's
 * `task-notification` truncation cap, see the const's docstring), omit `msg`
 * and place `msg_via: "Use `ccmsg read r<N>m<M>`"` last. The instruction
 * is directly executable and its presence is the oversize signal; no preview
 * or separate truncated flag is needed. The stored event and `ccmsg read`
 * result still carry the full body — only the subscribe wire frame is
 * reshaped.
 *
 * `echo` (DR-0003 §5 Addendum) reshapes the frame the same way for a
 * different reason: the subscriber authored this msg, so the body is already
 * in their context and only the *fact* of the post needs to reach their
 * stream. It reuses `msg_via` (a reference that stays fetchable) and adds
 * `echo: true` so a receiver can tell "this is my own post, nothing to open"
 * from "this is a peer's oversize msg, fetch it". */
function orderedMsgFrame(
  ev: MsgEvent,
  roomId: string,
  replyVia: string | undefined,
  redirectOversize: boolean,
  replay: boolean = false,
  echo: boolean = false,
): Record<string, unknown> {
  // Field order is scope/importance order (kawaz r38 mid=23):
  // type,r,seq,mid,from[,to,reply_to],msg|msg_via,reply_via,replay,ts.
  // `msg`/`msg_via` sits before the fixed-size tail so an inline body is as
  // late as possible while the trailing fields stay in a predictable place.
  // `replay` is a boolean marker for the recent-replay path (see subscribe
  // handler) — placed alongside reply_via so a receiver sees the framing
  // flags before ts.
  const out: Record<string, unknown> = { type: ev.type, r: roomId, mid: ev.mid, from: ev.from };
  if (ev.seq !== undefined) out.seq = ev.seq;
  if (ev.to !== undefined) out.to = ev.to;
  if (ev.reply_to !== undefined) out.reply_to = ev.reply_to;
  if (echo) {
    // Local echo of the subscriber's own post: the body is already in the
    // author's own context, so it is replaced by the same `msg_via` fetch
    // instruction an oversize frame uses, and `echo: true` marks the frame as
    // "nothing to act on". No `reply_via` — there is nobody to reply to.
    out.msg_via = `Use \`ccmsg read ${roomId}m${ev.mid}\``;
    out.echo = true;
    if (replay) out.replay = true;
    out.ts = ev.ts;
    return out;
  }
  out.msg = ev.msg;
  if (replyVia !== undefined) out.reply_via = replyVia;
  if (replay) out.replay = true;
  out.ts = ev.ts;
  // Predict truncation from the natural frame, then replace the body entirely
  // with the fetch instruction in the same slot.
  if (redirectOversize && JSON.stringify(out).length > WIRE_MSG_SAFE_BYTES) {
    const rebuilt: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(out)) {
      if (k === "msg") rebuilt.msg_via = `Use \`ccmsg read ${roomId}m${ev.mid}\``;
      else rebuilt[k] = v;
    }
    return rebuilt;
  }
  return out;
}

/** `replay` marks a recent-replay catch-up frame, `echo` marks the author's own
 * post coming back to them as a bodyless local echo (see `orderedMsgFrame`). */
interface DeliverOpts {
  replay?: boolean;
  echo?: boolean;
}

function writeDelivered(conn: Conn, room: Room, ev: StorageEvent, opts: DeliverOpts = {}): void {
  if (ev.type === "msg") {
    const echo = opts.echo === true;
    const rid = recipientId(conn, room);
    // reply_via is a delivery-time wire instruction, never stored in the room's
    // jsonl — the route depends on live room state (archived changes it for later
    // replays), so persisting a snapshot at post time would go stale. Only
    // computed for actual recipients; non-recipient subscribers get no instruction.
    // An echo has no recipient role at all — the author is not replying to itself.
    const replyVia = rid !== null && !echo ? computeReplyVia(room, ev) : undefined;
    // Oversize redirection targets the harness truncation between a `ccmsg
    // subscribe` Monitor and its session AI — a session-role subscriber. The
    // webui (user role) renders frames directly with no Monitor in between,
    // so it always gets the full body.
    const redirectOversize = conn.identity?.role === "session";
    send(
      conn,
      orderedMsgFrame(ev, room.id, replyVia, redirectOversize, opts.replay === true, echo),
    );
    return;
  }
  send(conn, { ...ev, r: room.id });
}

// --- identity / registry ---------------------------------------------------

/**
 * DR-0013 §2.2 auto-populate: append a MemberEvent to every broadcast room
 * this sid is not already a member of. Called from the "new session entry
 * appeared" side of registerSession — a re-hello that only updates metadata
 * (repo/ws/branch) must not append duplicate member rows, and never for the
 * admin User (u1 is implicit in every room, DR-0006 §2). The auto-populate
 * event is DELIBERATELY not deliver()-ed to subscribers (§2.3 asks for the
 * append-to-jsonl side but skips the stream); appendEvent alone gives us that.
 */
function joinAllBroadcasts(daemon: Daemon, sid: string): void {
  const entry = daemon.sessions.get(sid);
  if (!entry) return;
  for (const room of daemon.rooms.values()) {
    if (room.kind !== "broadcast") continue;
    if (memberIdBySid(room).has(sid)) continue;
    const ev: MemberEvent = {
      type: "member",
      id: nextAgentMemberId(room),
      sid,
      repo: entry.meta.repo,
      ws: entry.meta.ws,
      cwd: entry.meta.cwd,
      joined_at: nowIso(),
    };
    appendEvent(room, ev);
  }
}

/**
 * DR-0013 §2.2 auto-populate: append a LeaveEvent to every broadcast room
 * this sid was a member of. Called from the "session entry fully removed"
 * side of detachSession — a partial detach (this conn moved to a different sid
 * but the sid still has other conns open, e.g. the user opened a second webui
 * tab as an observer of the same session) must NOT leave the room, so we key
 * off "did the sessions map entry disappear?" rather than "did this conn go
 * away?". Same "storage only, not delivered" treatment as the join side
 * (§2.3).
 */
function leaveAllBroadcasts(daemon: Daemon, sid: string): void {
  for (const room of daemon.rooms.values()) {
    if (room.kind !== "broadcast") continue;
    const memberId = memberIdBySid(room).get(sid);
    if (memberId === undefined) continue;
    const ev: LeaveEvent = { type: "leave", id: memberId, ts: nowIso() };
    appendEvent(room, ev);
  }
}

/** What the hello announced about the ccmsg build behind it. Passed alongside
 * the identity rather than folded into it: it describes the *client process*,
 * not the session, and two connections of one session can legitimately run
 * different builds (a subscribe started before an upgrade, plus a fresh hook
 * invocation after it) — the latest hello is simply what the peer reports. */
interface ClientBuild {
  version?: string;
  protocol?: number;
}

function registerSession(
  daemon: Daemon,
  conn: Conn,
  id: SessionIdentity,
  client: ClientBuild,
): void {
  // This sid is back, so it is no longer "前回稼働中" — whether it came back
  // via the launcher's resume or was simply started again by hand, the row
  // has done its job. maybeBroadcastPeers at the end of this function pushes
  // the shortened list and rewrites the snapshot.
  daemon.lastLive.delete(id.sid);
  let entry = daemon.sessions.get(id.sid);
  // latest hello wins for repo/ws/cwd metadata. transcript_path is the one
  // exception (DR-0009 addendum): unlike repo/ws/cwd, it arrives via the
  // hook-supplied session state file (session-start.ts / user-prompt-submit.ts)
  // or, when that never got written, adoptTranscriptPath's disk lookup — and a
  // re-subscribe after the stream died is a
  // common, legitimate path that omits it (e.g. a UserPromptSubmit-suggested
  // `CCMSG_SID=<sid> ccmsg subscribe` typed without the transcript prefix). A
  // hello that omits transcript_path preserves whatever was already adopted
  // instead of clearing it — otherwise every such re-subscribe would silently
  // kill the webui's Timeline view for a session that never stopped having a
  // transcript.
  //
  // repo_root (DR-0008 addendum) follows the repo/ws/cwd rule instead
  // (latest-hello-wins, no preserve-on-omit): unlike transcript_path's
  // historical env-prefix-only sourcing, repo_root rides in the very same
  // per-hello session-state-file payload the CLI's resolveIdentity already
  // reads fresh for repo/ws on every hello (see hooks/session-start.ts's
  // SessionFileData) — so it's just as reliably present on every re-hello.
  // If a later hello genuinely omits/rejects it (e.g. cwd moved to a plain
  // checkout with no workspace layer), that reflects the session's *current*
  // state; silently keeping a stale, wider containment root across such a
  // change would be a fs-access scoping regression, not a UX nicety worth
  // preserving. branch rides the same per-hello payload, so it follows the
  // same latest-hello-wins, no-preserve-on-omit rule.
  const transcriptPath = id.transcript_path ?? entry?.meta.transcript_path;
  const meta = {
    sid: id.sid,
    repo: id.repo,
    ws: id.ws,
    cwd: id.cwd,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    ...(id.repo_root ? { repo_root: id.repo_root } : {}),
    ...(id.branch ? { branch: id.branch } : {}),
  };
  // A process's CLAUDE_CONFIG_DIR cannot change while it runs, so a hello that
  // omits it is telling us nothing new — an older CLI, or one invoked from a
  // subprocess whose environment lost the variable. Preserve what an earlier
  // hello for this sid established (transcript_path's rule, for the same
  // reason: silently dropping it would take a genuinely reachable peer's
  // `send_message` flag away mid-session).
  const configDir = id.config_dir ?? entry?.configDir;
  const isNewEntry = !entry;
  const previousTranscriptPath = entry?.meta.transcript_path;
  if (
    previousTranscriptPath !== undefined &&
    transcriptPath !== undefined &&
    previousTranscriptPath !== transcriptPath
  ) {
    daemon.log.info(
      `session hello: transcript_path changed sid=${id.sid} from=${previousTranscriptPath} to=${transcriptPath}`,
    );
  }
  if (!entry) {
    entry = { meta, ...(configDir ? { configDir } : {}), conns: new Set(), connectedAt: nowIso() };
    daemon.sessions.set(id.sid, entry);
  } else {
    entry.meta = meta;
    entry.configDir = configDir;
  }
  // Latest hello wins outright, with no preserve-on-omit: an omitted field is
  // itself the report — a client from before this session's hello carried
  // either one — and the peer row says so rather than showing the last
  // connection's answer as if it were this one's.
  entry.clientVersion = client.version;
  entry.clientProtocol = client.protocol;
  entry.conns.add(conn);
  // DR-0013 §2.2 auto-populate: first hello for this sid → add it to every
  // broadcast room. A re-hello (isNewEntry === false) is deliberately a no-op:
  // this sid is already a member of every broadcast room from its earlier
  // registration, and the auto-populate contract talks about session lifecycle
  // ("hello 到達 = 新規 session"), not per-connection re-hellos.
  if (isNewEntry) joinAllBroadcasts(daemon, id.sid);
  // Push ev:"peers" on: new sid registration (entry was just created above) or a
  // hello that actually changed repo/ws/branch/transcript_path/repo_root (entry.meta
  // reassigned above). maybeBroadcastPeers itself no-ops a same-content re-hello via
  // its JSON snapshot compare (issue 2026-07-12-peers-live-update-protocol) — this
  // call site doesn't need to distinguish "new" from "updated" from "unchanged".
  maybeBroadcastPeers(daemon);
}

/** Stop counting `conn` under `sid`'s session entry — the shared tail end of both
 *  a full disconnect (removeConn) and a re-hello that moves this conn to a
 *  different sid or away from session role entirely (dispatch's "hello" case).
 *  Without this second caller, a conn that re-hellos under a new identity stayed
 *  in its *previous* sid's `conns` Set forever (that sid's entry.conns.size never
 *  dropped to 0 on its own), so the stale sid lingered in `peers`/ev:"peers" as a
 *  ghost peer until the conn closed entirely — adversarial review finding,
 *  2026-07-12, made externally visible by ev:"peers" push + the webui's live peer
 *  list (the underlying registry gap predates that push). */
function detachSession(daemon: Daemon, conn: Conn, sid: string): void {
  const entry = daemon.sessions.get(sid);
  if (!entry) return;
  entry.conns.delete(conn);
  if (entry.conns.size === 0) {
    daemon.sessions.delete(sid);
    // DR-0013 §2.2 auto-populate: session fully gone → append LeaveEvent to
    // every broadcast room it was in. A partial detach (this conn is closing
    // but the sid still has other conns) must NOT leave, hence the size===0
    // gate — the sid is still "connected" as far as the broadcast contract is
    // concerned. Same "not delivered to subscribers" treatment as the join
    // side (see leaveAllBroadcasts's doc comment / §2.3).
    leaveAllBroadcasts(daemon, sid);
  }
  // Deliberately does NOT call maybeBroadcastPeers itself: both callers (removeConn,
  // dispatch's "hello" case) may follow this with a registerSession/further mutation
  // of their own in the same turn, and pushing here too would mean two ev:"peers"
  // frames (one showing the stale mid-transition state) for what's semantically one
  // registry change. Each caller pushes once, after every mutation it's going to make
  // is done.
}

export function removeConn(daemon: Daemon, conn: Conn): void {
  daemon.connections.delete(conn);
  daemon.subscribers.delete(conn);
  maybeStopAgentsPoller(daemon.agentsPoller, daemon.subscribers);
  // The departing conn may have been the last user-role subscriber, in which
  // case syncSessionErrors drops every watch (see its doc comment).
  syncSessionErrors(daemon);
  syncSessionUserInputs(daemon);
  sessionStatusUnsubscribeAll(daemon.sessionStatus, daemon.transcriptTail, conn);
  transcriptUnsubscribeAll(daemon.transcriptTail, conn);
  const id = conn.identity;
  if (id && id.role === "session") {
    detachSession(daemon, conn, id.sid);
    // full disconnect (last conn for this sid gone, not just one of several)
    // (issue 2026-07-12-peers-live-update-protocol) — a session with another
    // still-open conn stays in the peers list, so maybeBroadcastPeers itself
    // no-ops via its snapshot compare when detachSession didn't actually remove
    // the sessions entry.
    maybeBroadcastPeers(daemon);
  }
}

/** File the "this sid has an out-of-date ccmsg client" record the session list
 * renders. Called from the two places a hello is refused: no correlation
 * envelope, and a generation this daemon does not speak.
 *
 * A client that simply predates the `protocol` field is NOT stale — it speaks
 * `UNANNOUNCED_PROTOCOL_VERSION`, gets served, and never reaches here. Every
 * subscribe running right now is such a client, so flagging them would ask
 * kawaz to restart every session on the machine over nothing.
 *
 * The record is overwritten rather than accumulated — a refused subscribe
 * retries every few seconds, and "still trying as of `last_seen`" is the whole
 * signal; a counter would only turn one stale process into a number that keeps
 * moving. Pushing `ev:"peers"` is the caller's job: both callers refuse the
 * hello, so neither reaches the registerSession that normally pushes. */
function markStaleClient(daemon: Daemon, sid: string, client: ClientBuild): void {
  daemon.staleClients.set(sid, {
    last_seen: nowIso(),
    ...(client.version ? { version: client.version } : {}),
    ...(client.protocol !== undefined ? { protocol: client.protocol } : {}),
  });
}

/** The generation a hello speaks: what it announced, or — for a client from
 * before the field existed — the generation that field was introduced in. */
function protocolOf(client: ClientBuild): number {
  return client.protocol ?? UNANNOUNCED_PROTOCOL_VERSION;
}

/** What a hello line claims about its own build, read defensively: this also
 * runs on requests rejected before they were ever typed as a `HelloRequest`,
 * so a field of the wrong type is treated as absent rather than trusted. */
function readClientBuild(req: { client_version?: unknown; protocol?: unknown }): ClientBuild {
  return {
    ...(typeof req.client_version === "string" && req.client_version !== ""
      ? { version: req.client_version }
      : {}),
    ...(typeof req.protocol === "number" ? { protocol: req.protocol } : {}),
  };
}

/** `last_user_input_at` for one sid, as a spreadable fragment so an unknown
 * value omits the field rather than sending null (PeerInfo's contract: absent
 * means "the daemon has not folded one", which clients sort last). */
function withUserInput(daemon: Daemon, sid: string): { last_user_input_at?: string } {
  const at = lastUserInputAt(daemon.sessionUserInputs, sid);
  return at ? { last_user_input_at: at } : {};
}

/** Compute the peers list exactly as the `peers` op returns it (only sessions
 * with at least one live connection) — shared by that op and the ev:"peers"
 * push below so the two never drift apart. */
function currentPeers(daemon: Daemon): PeerInfo[] {
  return [...daemon.sessions.values()]
    .filter((s) => s.conns.size > 0)
    .map((s) => ({
      ...s.meta,
      connected_at: s.connectedAt,
      ...(s.lastActivityAt ? { last_activity_at: s.lastActivityAt } : {}),
      ...withUserInput(daemon, s.meta.sid),
      ...clientBuildFields(daemon, s),
    }));
}

/** The build half of a peer row: what its latest hello announced, plus the
 * stale-client warning when some client of this sid is out of date. Shared by
 * `currentPeers` and `peersCompareKey` so a stale record appearing (or being
 * cleared) is always a change worth pushing. */
function clientBuildFields(
  daemon: Daemon,
  s: SessionEntry,
): Pick<PeerInfo, "client_version" | "protocol" | "stale_client"> {
  const stale = daemon.staleClients.get(s.meta.sid);
  return {
    ...(s.clientVersion ? { client_version: s.clientVersion } : {}),
    ...(s.clientProtocol !== undefined ? { protocol: s.clientProtocol } : {}),
    ...(stale ? { stale_client: stale } : {}),
  };
}

/** currentPeers() as one session sees it: every peer running under the same
 * CLAUDE_CONFIG_DIR gets `send_message: true`, marking it reachable with
 * Claude Code's own SendMessage tool instead of a ccmsg post (see
 * PeerInfo.send_message). The asker's own row is left alone, and an asker
 * whose own config dir is unknown flags nothing at all. */
function peersFor(daemon: Daemon, asker: Identity | null): PeerInfo[] {
  const peers = currentPeers(daemon);
  if (asker?.role !== "session") return peers;
  const askerConfigDir = daemon.sessions.get(asker.sid)?.configDir;
  return peers.map((p) =>
    p.sid !== asker.sid &&
    canNativeSendMessage(askerConfigDir, daemon.sessions.get(p.sid)?.configDir)
      ? { ...p, send_message: true as const }
      : p,
  );
}

/** The subset of currentPeers() compared to decide whether anything worth a push
 * actually changed. Deliberately excludes `last_activity_at`: that field is
 * re-stamped on literally every request (handleRequest's post-dispatch choke
 * point), including the very hello call that runs registerSession/removeConn's
 * maybeBroadcastPeers itself — comparing it would make an identical hello
 * re-send look "changed" purely from its own request landing between the two
 * snapshots, defeating the "no push on unchanged re-hello" requirement (issue
 * 2026-07-12-peers-live-update-protocol). `connected_at` stays in: it's stable
 * across re-hellos for the same still-open sid (registerSession never touches
 * it) and only differs across a genuine full-disconnect-then-rejoin. */
function peersCompareKey(daemon: Daemon): string {
  return JSON.stringify([
    [...daemon.sessions.values()]
      .filter((s) => s.conns.size > 0)
      .map((s) => {
        // `stale_client.last_seen` is deliberately dropped here for the same
        // reason `last_activity_at` is: a refused client retries every few
        // seconds, and comparing its timestamp would turn one stale process
        // into an endless push loop. Whether a warning is showing, and what it
        // says, is what a client re-renders on — the exact instant of the last
        // attempt only has to be right in a `peers` reply, which reads it live.
        const { stale_client: stale, ...build } = clientBuildFields(daemon, s);
        return {
          ...s.meta,
          connected_at: s.connectedAt,
          ...build,
          ...(stale ? { stale_client: { version: stale.version, protocol: stale.protocol } } : {}),
        };
      }),
    // Tail-derived, so it changes without any registry mutation — the fold's
    // own onChange is what re-enters maybeBroadcastPeers for it, and this entry
    // is what stops that re-entry from being a no-op push.
    userInputEntries(daemon.sessionUserInputs),
    // The "前回稼働中" half travels in the same frame, so a change confined to
    // it (a sid recovering, or the startup launch-context fill landing) has to
    // be able to trigger the push on its own.
    currentLastLive(daemon),
  ]);
}

/** The `last_live` list on the wire: sessions a previous daemon saw connected
 * that have not registered again. Newest sighting first — after a reboot the
 * reader is looking for what they were in the middle of — with sid as the
 * tiebreak so the order is stable enough to compare. */
function currentLastLive(daemon: Daemon): LastLiveSession[] {
  return [...daemon.lastLive.values()].sort(
    (a, b) => b.last_seen_at.localeCompare(a.last_seen_at) || a.sid.localeCompare(b.sid),
  );
}

/** The body both the `peers` op reply and the ev:"peers" push carry, so the
 * two can never disagree about the pair. `last_live` is omitted rather than
 * sent as `[]` when nothing is pending (protocol contract: a client that never
 * reads it is unaffected, and a fully recovered machine looks the same as an
 * older daemon). */
function peersPayload(daemon: Daemon): { peers: PeerInfo[]; last_live?: LastLiveSession[] } {
  const lastLive = currentLastLive(daemon);
  return {
    peers: currentPeers(daemon),
    ...(lastLive.length > 0 ? { last_live: lastLive } : {}),
  };
}

/** The session's own title as the agents poll currently reports it, if at all.
 * That poll only runs while a webui is watching (DR-0009-agents), so this is
 * genuinely best-effort — a snapshot written with no webui connected simply
 * carries no title, and the row falls back to its cwd leaf like any untitled
 * session row does. */
function agentTitle(daemon: Daemon, sid: string): string | undefined {
  for (const agent of daemon.agentsPoller.cache.agents) {
    if (agent.sessionId === sid && agent.name) return agent.name;
  }
  return undefined;
}

/** Rewrite the on-disk record of who was alive: every session connected right
 * now, plus the entries still waiting to be recovered.
 *
 * Carrying the unrecovered entries forward is what lets the list survive a
 * second restart before the user got round to resuming anything — dropping
 * them would mean a reboot loop quietly erasing exactly the sessions it
 * exists to remember. `last_seen_at` is stamped now for the live half: this
 * write is the moment those sessions are known to be alive. */
function persistLastLive(daemon: Daemon): void {
  const now = nowIso();
  const live = [...daemon.sessions.values()]
    .filter((s) => s.conns.size > 0)
    .map((s) => {
      const title = agentTitle(daemon, s.meta.sid);
      return {
        ...s.meta,
        ...(title ? { title } : {}),
        connected_at: s.connectedAt,
        last_seen_at: now,
      };
    });
  writeLastLiveSessions(
    daemon.paths.lastLiveSessions,
    [...live, ...daemon.lastLive.values()],
    daemon.log,
  );
}

/** Push the current prompt-cache snapshot to one connection. Sent as the full
 * per-sid set (not just the request that arrived) so this same call serves
 * both the live update and a fresh subscriber's catch-up — see
 * LlmRequestsStreamEvent for why the catch-up matters. */
function sendLlmRequests(daemon: Daemon, conn: Conn): void {
  send(conn, { ev: "llm_requests", requests: daemon.llmRequests.snapshot() });
}

/** Relay one gateway request event to every user-role subscriber (webui-only,
 * same posture as ev:"peers"). Unconditional: unlike peers, each event moves a
 * countdown's start instant, so there is no "unchanged" case to suppress. */
function broadcastLlmRequests(daemon: Daemon): void {
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") sendLlmRequests(daemon, sub);
  }
}

/** Push one status report to every user-role subscriber. Unsolicited, like
 * ev:"llm_requests": the report only ever changes because the daemon just
 * re-read it, and the screens that draw it (the header badge, the service
 * strip) are host-wide rather than tied to whoever asked. */
export function broadcastLlmStatus(daemon: Daemon, report: LlmStatusReport): void {
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "llm_status", report });
  }
}

/** Wire the webhook-driven re-read to the configured endpoint, or leave it
 * off when there is none. Not a refresh: the gateway refreshes its own
 * sources on the same 529 it reported (gateway DR-0021 §5), so asking it to
 * refresh again would only make this read wait on status pages that are
 * already being fetched. */
export function createStatusRefresher(daemon: Daemon): LlmStatusRefresher | null {
  const statusUrl = daemon.config.llm_status_url;
  if (!statusUrl) return null;
  return new LlmStatusRefresher({
    fetch: () => fetchLlmStatus(statusUrl),
    onReport: (report) => broadcastLlmStatus(daemon, report),
    onError: (msg) => daemon.log.info(`llm status re-read after upstream failure failed: ${msg}`),
  });
}

/** True for an event reporting the one upstream failure that means "this
 * provider is refusing traffic right now" (gateway DR-0021 §2: 401/403/429 are
 * credential problems and general 5xx can be synthesized by a relay). Read off
 * the raw item rather than the parsed one: an event whose client sent no
 * session id is dropped by the parser but is just as good a signal that the
 * upstream is failing. */
function reportsUpstreamOverload(item: unknown): boolean {
  return typeof item === "object" && item !== null && (item as { status?: unknown }).status === 529;
}

/** Fold a posted batch of gateway request events into the cache and push the
 * result. Called from the webhook handler; exported for the tests that drive
 * the fold without an HTTP layer.
 *
 * Out-of-order and duplicate deliveries need no special handling here: two
 * gateway processes (stable and unstable) may both report the same call, and
 * the cache already ignores an event that is not newer than what that series
 * holds. One broadcast per batch, not per event — a batch is one observation
 * of the world as far as a subscriber is concerned. */
export function recordLlmRequests(daemon: Daemon, items: unknown[], log: Logger): void {
  let accepted = 0;
  let dropped = 0;
  // Independent of whether the events parse: an outage is exactly the moment
  // the status report changes, and it is the one change no client can
  // anticipate. The refresher collapses the burst.
  if (items.some(reportsUpstreamOverload)) daemon.llmStatusRefresher?.trigger();
  for (const item of items) {
    const info = parseLlmRequestEvent(item);
    if (!info) {
      dropped += 1;
      continue;
    }
    daemon.llmRequests.record(info);
    accepted += 1;
  }
  if (dropped > 0) {
    // Not an error for the sender to retry — an event with no usable session
    // id or timestamp is one ccmsg can never place, however many times it
    // arrives. Logged so a gateway change that breaks the schema is visible.
    log.info(`webhook llm-gateway: dropped ${dropped} unusable event(s)`);
  }
  if (accepted > 0) broadcastLlmRequests(daemon);
}

/** Read each configured webhook's token and pair it with its handler. A source
 * whose token file cannot be read is left out entirely rather than registered
 * with an empty token — an unreadable secret must fail closed (404), never
 * open. */
function buildWebhookSources(daemon: Daemon, log: Logger): Map<string, WebhookSource> {
  const sources = new Map<string, WebhookSource>();
  const configured = daemon.config.webhooks;
  if (!configured) return sources;
  for (const [source, entry] of Object.entries(configured)) {
    let token: string;
    try {
      token = fs.readFileSync(entry.token_file, "utf-8").trim();
    } catch (e) {
      log.error(`webhook ${source}: token file unreadable (${String(e)}); endpoint disabled`);
      continue;
    }
    if (token === "") {
      log.error(`webhook ${source}: token file is empty; endpoint disabled`);
      continue;
    }
    if (source !== "llm-gateway") {
      // Configured but nothing here knows what to do with its payloads.
      log.error(`webhook ${source}: no handler for this source; endpoint disabled`);
      continue;
    }
    sources.set(source, {
      token,
      handle: (items) => recordLlmRequests(daemon, items, log),
    });
    log.info(`webhook ${source}: enabled`);
  }
  return sources;
}

/** Push ev:"peers" (user-role subscribers only, DR-0009-agents' precedent for
 * webui-only push events) to every subscriber, but only when peersCompareKey
 * actually differs from the last broadcast — a hello re-send with unchanged
 * repo/ws/branch/transcript_path/repo_root must not spam a push (issue
 * 2026-07-12-peers-live-update-protocol). No polling: called only from the two
 * registry mutation points (registerSession, removeConn) that can change the
 * result, plus the user-input fold's onChange when a transcript tail moves
 * `last_user_input_at` — all three are events, so this stays purely
 * event-driven, unlike the agents poller. Re-entry through that third caller
 * terminates: the snapshot is stamped before the syncs below run, and a sync
 * that changes nothing fires no onChange. */
function maybeBroadcastPeers(daemon: Daemon): void {
  const key = peersCompareKey(daemon);
  if (key === daemon.peersSnapshot) return;
  daemon.peersSnapshot = key;
  // Who is alive just changed, which is the whole content of the snapshot
  // file — write it here rather than at each mutation point, so the disk
  // record and the pushed list are produced from one observation of the
  // registry (and an unchanged re-hello writes nothing at all).
  persistLastLive(daemon);
  const payload = peersPayload(daemon);
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "peers", ...payload });
  }
  // The connected set just changed, so the set of transcripts worth folding
  // for api_error — and for last_user_input_at — did too.
  syncSessionErrors(daemon);
  syncSessionUserInputs(daemon);
}

function hasUserSubscriber(daemon: Daemon): boolean {
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") return true;
  }
  return false;
}

/** Push ev:"session_errors" when the list actually differs from the last one
 * sent — a transcript event that leaves the error state alone (the common
 * case, since every appended line is examined) must not produce a push. */
function broadcastSessionErrors(daemon: Daemon): void {
  const errors = sessionErrorEntries(daemon.sessionErrors);
  const key = JSON.stringify(errors);
  if (key === daemon.sessionErrorsSnapshot) return;
  daemon.sessionErrorsSnapshot = key;
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "session_errors", errors });
  }
}

/** Follow every connected session's transcript for api_error — but only while
 * a user-role subscriber is connected, the same "webui-only work costs nothing
 * when no webui is watching" rule the agents poller follows (DR-0009-agents
 * addendum). With no such subscriber the wanted set is empty, which tears every
 * watch down. Called from the three places that can change either input: peers
 * changing (maybeBroadcastPeers), a user subscribing, and a subscriber leaving. */
function syncSessionErrors(daemon: Daemon): void {
  // The network watch is a second consumer of the same fold: it needs to know
  // which sessions are stopped at the moment the link returns, and a stall
  // that happened while no webui was open is exactly the one worth waking.
  const wanted = hasUserSubscriber(daemon) || daemon.networkWatch?.enabled === true;
  const sids = wanted
    ? [...daemon.sessions.values()].filter((s) => s.conns.size > 0).map((s) => s.meta.sid)
    : [];
  syncSessionErrorWatches(
    daemon.sessionErrors,
    daemon.transcriptTail,
    daemon.sessions,
    sids,
    daemon.log,
    () => broadcastSessionErrors(daemon),
  );
}

/** Watch exactly the connected sessions, and only while a webui is open to
 * read the result — the same gate the agents poller uses, for the same reason
 * (DR-0009-agents: no work on behalf of nobody). Unlike syncSessionErrors this
 * has no second consumer: nothing but the sidebar's ordering reads it, so it
 * stops folding the moment the last tab closes. */
function syncSessionUserInputs(daemon: Daemon): void {
  const sids = hasUserSubscriber(daemon)
    ? [...daemon.sessions.values()].filter((s) => s.conns.size > 0).map((s) => s.meta.sid)
    : [];
  syncUserInputWatches(
    daemon.sessionUserInputs,
    daemon.transcriptTail,
    daemon.sessions,
    sids,
    daemon.log,
    () => maybeBroadcastPeers(daemon),
  );
}

/** The link state `ping` reports: whether a recovery could wake anything, and
 * what the daemon currently believes about the host's connectivity. */
function networkState(daemon: Daemon): PingResponse["network"] {
  const watch = daemon.networkWatch;
  if (!watch?.enabled) return "off";
  if (watch.online === undefined) return "unknown";
  return watch.online ? "online" : "offline";
}

/** Poke every session that is stopped on an API error, once per stall, after
 * the host comes back online. Delivery is the session's own subscribe stream,
 * so a session with no live subscribe simply is not woken — there is nothing
 * to deliver to, and no other channel reaches an idle CLI. */
export function wakeStalledSessions(daemon: Daemon): void {
  const wakes = wakesForOnline(daemon.sessionWake, sessionErrorEntries(daemon.sessionErrors));
  if (wakes.length === 0) return;
  let delivered = 0;
  for (const wake of wakes) {
    let sent = false;
    for (const sub of daemon.subscribers) {
      const id = sub.identity;
      if (id?.role !== "session" || id.sid !== wake.sid) continue;
      send(sub, wake.event);
      sent = true;
      delivered++;
    }
    if (sent) recordWoken(daemon.sessionWake, wake);
  }
  if (delivered > 0) {
    daemon.log.info(`network online: woke ${delivered} stalled session subscriber(s)`);
  }
}

/** id the connection posts as in this room: "u1" for the admin user, member id for a session, null if a session that isn't a member. */
function resolveFrom(conn: Conn, room: Room): string | null {
  const id = conn.identity;
  if (!id) return null;
  if (id.role === "user") return ADMIN_ID;
  return memberIdBySid(room).get(id.sid) ?? null;
}

function subscriberSeesRoom(conn: Conn, room: Room): boolean {
  const id = conn.identity;
  if (!id) return false;
  if (id.role === "user") return true; // admin (u1) sees every room (DR-0003 §5)
  return memberIdBySid(room).has(id.sid);
}

/**
 * DR-0011 §1: `to`-delivery filter for a single msg event, applied to both live
 * `deliver` and since-replay/backlog. A `to`-less msg is visible to anyone who
 * already passed `subscriberSeesRoom` (unchanged, full-room behavior). A
 * `to`-bearing msg additionally requires the subscriber to be: the admin User
 * (u1, exempt — the webui is an observation surface, no agent-style context
 * cost), the msg's own sender (resolved to their member id), or a member id
 * listed in `to`. This does NOT gate storage/`read`/`rooms` — those stay
 * unfiltered so a skipped mid is a deliberate pull signal, not a hidden one.
 */
function msgVisibleTo(sub: Conn, room: Room, ev: MsgEvent): boolean {
  if (!ev.to) return true;
  const id = sub.identity;
  if (!id) return false;
  if (id.role === "user") return true; // admin exempt
  const memberId = memberIdBySid(room).get(id.sid);
  if (memberId === undefined) return false;
  if (memberId === ev.from) return true; // sender always counts as a recipient of their own msg
  return ev.to.includes(memberId);
}

/** The member id this connection posts as inside `room`, but only for
 * session-role (agent) connections — the ones the echo rule applies to.
 * Returns undefined for the admin User: u1 is an observation surface whose own
 * messages must stay in every history/replay it asks for (a webui reconnect
 * must not open a gap where kawaz's own messages were). */
function selfMemberId(conn: Conn, room: Room): string | undefined {
  const id = conn.identity;
  if (id?.role !== "session") return undefined;
  return memberIdBySid(room).get(id.sid);
}

function normalizeTo(to: string | string[] | undefined): string[] | undefined {
  if (to === undefined) return undefined;
  const arr = Array.isArray(to) ? to : [to];
  const ids = arr.filter((s): s is string => typeof s === "string" && s.length > 0);
  return ids.length > 0 ? ids : undefined;
}

// --- delivery --------------------------------------------------------------

interface Author {
  role: "user" | "session";
  sid?: string;
}

function authorOf(conn: Conn): Author {
  const id = conn.identity;
  if (id && id.role === "session") return { role: "session", sid: id.sid };
  return { role: "user" };
}

function isAuthorSub(sub: Conn, author: Author): boolean {
  const id = sub.identity;
  if (!id) return false;
  if (author.role === "user") return id.role === "user";
  return id.role === "session" && id.sid === author.sid;
}

/** DR-0013 §2.3: broadcast room の member / leave イベントは jsonl には残るが
 * subscribe stream には配信しない (通常 room は現状通り配信)。auto-populate で
 * session が increments/decrements するたびに他 broadcast member の agent
 * コンテキストが「A が join した / A が leave した」で埋まるのを避けるため。
 * kind / title / archive / msg / next / prev はいずれも通常 room と同じく配信。 */
function isSuppressedForBroadcastStream(room: Room, ev: StorageEvent): boolean {
  return room.kind === "broadcast" && (ev.type === "member" || ev.type === "leave");
}

/** `say` / `say_read` are観測用 events for the webui only (kawaz r244 m6:
 * 「webui とかが知りたいだけなのでセッションへの echo は不要、コンテキストの
 * 無駄」). A session's own speech is something it already knows about, and the
 * read-ack is a User-side gesture — delivering either into a session-role
 * subscribe stream would spend agent context to tell an agent what it did.
 * Applied on every delivery path (live deliver, since/backlog replay,
 * room_history) so a reconnecting agent doesn't collect them retroactively. */
function isSuppressedForSubscriber(conn: Conn, room: Room, ev: StorageEvent): boolean {
  if (isSuppressedForBroadcastStream(room, ev)) return true;
  return (ev.type === "say" || ev.type === "say_read") && conn.identity?.role !== "user";
}

/**
 * Live-deliver a single event to all subscribers that see the room.
 * The echo rule (DR-0003 §5) applies to `msg` only: the author's own post never
 * comes back to them with its body. A session-role author instead gets the
 * bodyless echo frame (§5 Addendum) so the post is recorded in their subscribe
 * stream; a user-role author (the webui, which renders its own send optimistically)
 * gets nothing, as before. Membership/link/title events go to everyone incl. the actor
 * (DR-0011 §1: the `to`-delivery filter below is msg-only too, same reasoning).
 */
function deliver(daemon: Daemon, room: Room, ev: StorageEvent, author: Author): void {
  for (const sub of daemon.subscribers) {
    if (!subscriberSeesRoom(sub, room)) continue;
    if (isSuppressedForSubscriber(sub, room, ev)) continue;
    if (ev.type === "msg") {
      if (isAuthorSub(sub, author)) {
        // The `to` filter is not applied: it decides who *else* receives the
        // msg, and the author is never excluded from their own post.
        if (sub.identity?.role === "session") writeDelivered(sub, room, ev, { echo: true });
        continue;
      }
      if (!msgVisibleTo(sub, room, ev)) continue;
    }
    writeDelivered(sub, room, ev);
  }
}

/**
 * `since_seq` value validity (DR-0016 §2.5): must be a finite non-negative
 * number. A room's `since_seq` entry reaches here straight from
 * `JSON.parse(line) as Request` with no schema validation upstream, so a
 * malformed/malicious value (string, negative, NaN, Infinity) is a real
 * possibility, not just a type-checker formality. An invalid value is treated
 * as "no cursor for this room" — safe side is full backlog replay (duplicate
 * delivery), never an out-of-range array/loop hazard.
 */
function isValidSeqCursor(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Initial/backlog delivery of a room to one subscriber.
 * - with sinceSeq (valid per isValidSeqCursor): positional delta anchored on
 *   `seq`, which spans EVERY event type (DR-0016) — takes priority over
 *   sinceMid when both are supplied.
 * - else with sinceMid: positional delta — everything after the msg with that mid
 *   (BBS replay, msg-only cursor, old-client compat).
 * - without either: present member state + title/link events + the last N=50 msgs
 *   (join snapshot); a user-role subscriber's conn gets every msg instead of just
 *   the last 50 (issue 2026-07-12-peers-live-update-protocol's sibling change —
 *   the cap only protects an agent session's context budget).
 * suppressAuthorId strips the body from the author's own just-posted msg in their
 * snapshot (echo rule; a session-role author still gets the bodyless echo frame).
 * All paths apply the same `to`-delivery filter as live `deliver` (DR-0011 §1-2): an
 * offline member reconnecting via since-replay must not see a `to` msg that excluded
 * them any more than a live subscriber would.
 *
 * The two cursor branches additionally apply the echo rule (DR-0003 §5) for
 * session-role subscribers: a cursor replay is the delivery continuation of the
 * live stream — "what I would have received had I stayed connected" — so it must
 * reshape exactly as live `deliver` does, or the CLI's reconnect path feeds an
 * agent its own post bodies a second time. The webui is
 * unaffected: it subscribes with `since_seq` too, but as the admin User, which
 * `selfMemberId` exempts. The no-cursor
 * snapshot branch below is deliberately NOT changed — `backlog: true` is an
 * explicit "paint me this room's history" request, not a delivery continuation,
 * and history legitimately includes one's own messages.
 */
function sendBacklog(
  conn: Conn,
  room: Room,
  sinceMid?: number,
  suppressAuthorId?: string,
  sinceSeq?: number,
): void {
  const selfId = selfMemberId(conn, room);
  if (isValidSeqCursor(sinceSeq)) {
    // Anchoring on "last event with seq <= sinceSeq" is correct at both ends:
    // a caught-up client (sinceSeq >= room.lastSeq) gets nothing, a client
    // whose cursor predates the room's start gets everything. Every event in
    // room.events carries a seq by this point (loadRoom backfills legacy rows,
    // appendEvent stamps new ones — DR-0016 §2.1/§2.2), so this is a plain
    // positional scan, not a search over possibly-undefined values.
    let start = 0;
    for (let i = 0; i < room.events.length; i++) {
      const ev = room.events[i]!;
      if (ev.seq !== undefined && ev.seq <= sinceSeq) start = i + 1;
    }
    for (let i = start; i < room.events.length; i++) {
      const ev = room.events[i]!;
      // DR-0013 §2.3 (see the sinceMid branch below for the same rule).
      if (isSuppressedForSubscriber(conn, room, ev)) continue;
      if (ev.type === "msg") {
        if (ev.from === selfId) {
          // echo rule (see docstring): own post replayed bodyless
          writeDelivered(conn, room, ev, { echo: true });
          continue;
        }
        if (!msgVisibleTo(conn, room, ev)) continue;
      }
      writeDelivered(conn, room, ev);
    }
    return;
  }
  if (sinceMid !== undefined) {
    // resume just after the last msg the client has already seen. Anchoring on
    // "last msg with mid <= sinceMid" is correct at both ends: a caught-up client
    // (sinceMid >= lastMid) gets nothing, a client missing the start (sinceMid <
    // firstMid) gets everything. Non-msg events after that anchor are included.
    let start = 0;
    for (let i = 0; i < room.events.length; i++) {
      const ev = room.events[i]!;
      if (ev.type === "msg" && ev.mid <= sinceMid) start = i + 1;
    }
    for (let i = start; i < room.events.length; i++) {
      const ev = room.events[i]!;
      // DR-0013 §2.3: broadcast room の member/leave は since replay でも配信しない。
      // live deliver と since replay の両輪でスキップして、遅れて再接続した member
      // の subscribe stream にも noise を復元させない。
      if (isSuppressedForSubscriber(conn, room, ev)) continue;
      if (ev.type === "msg") {
        if (ev.from === selfId) {
          // echo rule (see docstring): own post replayed bodyless
          writeDelivered(conn, room, ev, { echo: true });
          continue;
        }
        if (!msgVisibleTo(conn, room, ev)) continue;
      }
      writeDelivered(conn, room, ev);
    }
    return;
  }

  const presentIds = new Set(presentMembers(room).map((m) => m.id));
  const msgEvents = room.events.filter((e): e is MsgEvent => e.type === "msg");
  // user role has no context budget to protect (kawaz 2026-07-12: "ユーザ向けは
  // コンテキストとか気にする必要ないのでないなら全部流し直して") — only session
  // (agent) subscribers keep the DEFAULT_JOIN_BACKLOG=50 cap that exists to bound
  // an agent's context cost. subscribe requires hello (IDENTITY_OPS), so
  // conn.identity is always set here.
  const capped =
    conn.identity?.role === "user" ? msgEvents : msgEvents.slice(-DEFAULT_JOIN_BACKLOG);
  const recent = new Set(capped);
  for (const ev of room.events) {
    if (ev.type === "leave") continue;
    if (ev.type === "member" && !presentIds.has(ev.id)) continue;
    // DR-0013 §2.3: broadcast room の member は snapshot 経路でも配信しない
    // (webui は rooms 応答で member 一覧を取得する契約)。leave は上の一律 continue
    // で既に落ちているので追加の broadcast チェック不要。
    if (room.kind === "broadcast" && ev.type === "member") continue;
    // say / say_read はこの snapshot 経路 (room_history / backlog:true) でも
    // session role には出さない — 遡って渡しても agent には使い道がない。
    if (isSuppressedForSubscriber(conn, room, ev)) continue;
    if (ev.type === "msg") {
      if (!recent.has(ev)) continue;
      if (suppressAuthorId !== undefined && ev.from === suppressAuthorId) {
        // echo rule: a session-role author sees the fact of their own post
        // without its body; the webui (user role) keeps getting nothing here.
        if (conn.identity?.role === "session") writeDelivered(conn, room, ev, { echo: true });
        continue;
      }
      if (!msgVisibleTo(conn, room, ev)) continue;
    }
    writeDelivered(conn, room, ev);
  }
}

/** A session may only have one live subscribe stream: two of them turn every
 * delivery into a duplicate notification for the same AI. The newest subscribe
 * is the deliberate one, so any older session-role subscriber on the same sid is
 * told to exit and is dropped from delivery here (the notice may be the last
 * thing that conn ever reads, and delivery must stop either way). User-role
 * subscribers are untouched — several webui tabs are normal. */
function supersedeOlderSessionSubscribers(daemon: Daemon, conn: Conn): void {
  const id = conn.identity;
  if (id?.role !== "session") return;
  for (const sub of daemon.subscribers) {
    if (sub === conn) continue;
    if (sub.identity?.role !== "session" || sub.identity.sid !== id.sid) continue;
    send(sub, { ev: "subscribe_superseded", sid: id.sid });
    sub.subscribed = false;
    daemon.subscribers.delete(sub);
    daemon.log.info(`subscribe superseded for sid=${id.sid}: dropped an older subscribe stream`);
  }
}

/** Deliver a brand-new room's snapshot to every subscriber that sees it. */
function deliverNewRoom(daemon: Daemon, room: Room, author: Author, authorId: string | null): void {
  for (const sub of daemon.subscribers) {
    if (!subscriberSeesRoom(sub, room)) continue;
    const suppress = isAuthorSub(sub, author) && authorId !== null ? authorId : undefined;
    sendBacklog(sub, room, undefined, suppress);
  }
}

/** Append a LeaveEvent for `memberId` and broadcast it to every subscriber that sees
 *  the room. Recipients are captured before membership shrinks so a leaving/kicked
 *  member's own subscribed connection still gets the confirmation. Shared by
 *  voluntary `leave` and admin-only `kick` (DR-0012) — both produce the identical
 *  storage event, only the actor/authorization differs. */
function appendLeaveAndBroadcast(daemon: Daemon, room: Room, memberId: string): void {
  const ev: LeaveEvent = { type: "leave", id: memberId, ts: nowIso() };
  const recipients = [...daemon.subscribers].filter((s) => subscriberSeesRoom(s, room));
  appendEvent(room, ev);
  // membership shrank below the sid set that seeded room.dedupKey (invite's
  // mirror image, see the identical comment on the `invite` case below): a
  // same-sid create_room within the dedup window must no longer fold into
  // this room, otherwise the fold's resolveFrom(leaver, room) comes back
  // null, the msg silently fails to append, and the caller still gets back
  // `{ok:true, reused:true}` with no mid — a swallowed post disguised as
  // success.
  room.dedupEligible = false;
  for (const r of recipients) writeDelivered(r, room, ev);
}

// --- room creation ---------------------------------------------------------

// Room ids are opaque, daemon-issued, unique strings — the `rN` shape here is a free
// generation choice (DR-0006 §3), NOT a wire contract. Clients (and the daemon's own
// lookup / filename mapping) treat ids as opaque. Never parse structure out of a room
// id. The next number is derived from the highest `rN` already on disk/in-memory, so
// numbering survives a daemon restart without colliding with existing rooms.
//
// The webui's locator (packages/webui/src/client/locator.ts) splits hash-fragment
// routing between room and session views on the leading literal "r" vs "s" — that
// disambiguation relies on room ids always starting with "r". If this id format ever
// changes, check that invariant test too.
/** The 1on1 room whose single present member is `sid`, or null. Identified by
 * `kind === "1on1"` alone — the same rule the webui's `findExistingOneOnOne`
 * follows (DR-0014 §2.1「判別は kind フィールドで行う」; title strings are
 * display-only and typo-prone). u1 is implicit and has no member row, so a
 * well-formed 1on1 has exactly one present member. Oldest match wins when
 * several exist (rooms are inserted in creation order): `ccmsg say` should
 * keep landing in the room the User already has open rather than drifting to
 * a newer duplicate. */
function findOneOnOneRoomForSid(daemon: Daemon, sid: string): Room | null {
  for (const room of daemon.rooms.values()) {
    if (room.kind !== "1on1") continue;
    const present = presentMembers(room).filter((m) => m.id !== ADMIN_ID);
    if (present.length !== 1) continue;
    if (present[0]!.sid === sid) return room;
  }
  return null;
}

function generateRoomId(daemon: Daemon): string {
  let n = 1;
  for (const id of daemon.rooms.keys()) {
    const m = /^r(\d+)$/.exec(id);
    if (m) {
      const v = Number(m[1]);
      if (v >= n) n = v + 1;
    }
  }
  let id = `r${n}`;
  while (daemon.rooms.has(id)) id = `r${++n}`;
  return id;
}

function createRoom(
  daemon: Daemon,
  orderedSids: string[],
  dedupEligible: boolean,
  kind: RoomKind = "normal",
): Room {
  const id = generateRoomId(daemon);
  const room: Room = {
    id,
    file: `${daemon.paths.roomsDir}/${id}.jsonl`,
    events: [],
    lastMid: 0,
    lastSeq: 0,
    createdAt: Date.now(),
    // broadcast rooms are always dedup-exempt regardless of the caller's request
    // — multiple broadcasts with the same member set (dev / debug / ...) are
    // explicitly allowed (DR-0013 §2.1, r12 mid=3「一個限定である必要無し」)
    // and would otherwise fold into the same room.
    dedupEligible: kind === "broadcast" ? false : dedupEligible,
    dedupKey: [...new Set(orderedSids)].sort().join(","),
    archived: false,
    kind,
    next: [],
    prev: [],
    fd: null,
    fsyncTimer: null,
  };
  daemon.rooms.set(id, room);
  return room;
}

function writeMembers(daemon: Daemon, room: Room, orderedSids: string[]): void {
  let seq = 1;
  for (const sid of orderedSids) {
    const meta = daemon.sessions.get(sid)?.meta;
    const ev: MemberEvent = {
      type: "member",
      id: `a${seq++}`,
      sid,
      repo: meta?.repo ?? "",
      ws: meta?.ws ?? "",
      cwd: meta?.cwd ?? "",
      joined_at: nowIso(),
    };
    appendEvent(room, ev);
  }
}

// --- request dispatch ------------------------------------------------------

// fs_list/fs_read/fs_read_external/fs_write/transcript_read require hello too
// (DR-0008 / DR-0024 / DR-0019 / DR-0009): the
// containment/lookup check itself doesn't depend on the *caller's* identity —
// it only cares about the target sid's registered state. Requiring hello here
// is defense in depth: it keeps every op that touches session state on one
// uniform "must identify first" rule rather than special-casing these as the
// sole unauthenticated readers of another session's filesystem/transcript.
const IDENTITY_OPS = new Set([
  "post",
  "say",
  "say_read",
  "create_room",
  "next_room",
  "set_title",
  "archive_room",
  "kick",
  "subscribe",
  "room_history",
  "notify",
  "dir_tree",
  "session_launch",
  "session_kill",
  "session_rename",
  "session_launcher_config",
  "leave",
  "invite",
  "fs_list",
  "fs_read",
  "fs_read_external",
  "fs_list_workspace",
  "fs_read_workspace",
  "fs_write",
  "fs_create",
  "fs_delete",
  "fs_edit",
  "fs_stat_batch",
  "fs_find",
  "transcript_read",
  "session_search",
  "fork_origin",
  "session_dump_file",
  "agents",
  "transcript_subscribe",
  "transcript_unsubscribe",
  "client_trace",
  "session_status",
  "session_status_subscribe",
  "session_status_unsubscribe",
  "session_errors",
  "translate",
]);

/** One `client_trace` batch covers one tail delivery, which has three boundaries.
 * The margin absorbs future points without letting a client append unbounded
 * lines to trace.jsonl. */
const CLIENT_TRACE_MAX_POINTS = 8;

/** set_title clamp: keep room titles reasonably short in room lists / tab titles. */
const SET_TITLE_MAX_LEN = 200;

/** Slow ops (translate / session_launch / session_search) answer in two
 * phases (see RequestAcceptedResponse in the protocol): an immediate ack as
 * the reply, and the outcome pushed later as an `ev:"*_result"` stream event
 * carrying the same request_id. This helper sends the ack and returns a
 * completion callback that pushes the result event — or silently drops it when
 * the connection is already gone (the daemon keeps no per-request state, so a
 * disconnect leaves nothing to clean up beyond the op's own promise chain,
 * which settles into this no-op). Events are pushed only to the requesting
 * conn, not to subscribers.
 *
 * With correlated replies this split is no longer needed to keep a slow op
 * from delaying others; it stays because clients settle on the result event,
 * and each op can move to a single correlated reply on its own schedule. */
/** Final outcome payload of a 2-phase op — exactly what the matching
 * `ev:"*_result"` event carries beside its ev/request_id envelope. */
type TwoPhaseResult =
  | SessionKillResponse
  | SessionRenameResponse
  | SessionEnvResponse
  | SessionLaunchResponse
  | SessionSearchResponse
  | ForkOriginResponse
  | SessionDumpFileResponse
  | TranslateResponse
  | LlmUsageResponse
  | LlmStatsResponse
  | LlmStatusResponse
  | ErrorResponse;

function acceptTwoPhase(
  daemon: Daemon,
  conn: Conn,
  ev: string,
  requestId: string,
): (result: TwoPhaseResult) => void {
  send(conn, { ok: true, accepted: true });
  return (result) => {
    // A conn that disconnected while the op ran is no longer in
    // daemon.connections; its transport write would be a silent no-op anyway
    // (see send()), but skipping explicitly documents the discard contract.
    if (!daemon.connections.has(conn)) return;
    send(conn, { ev, request_id: requestId, ...result });
  };
}

/** Start handling one request. Requests of the same connection run
 * concurrently: a reply carries the `request_id` of the request it answers
 * (see RequestEnvelope), so a client settles it by id and an op that awaits IO
 * no longer holds back the cheap ops queued behind it. Each request swallows
 * its own failure so one rejected op cannot take down the connection. */
export function handleRequest(daemon: Daemon, conn: Conn, line: string): void {
  void handleOneRequest(daemon, conn, line).catch((e: unknown) => {
    daemon.log.error(`request handling failed: ${String(e)}`);
  });
}

async function handleOneRequest(daemon: Daemon, conn: Conn, line: string): Promise<void> {
  // Bytes that arrived before the disconnect but are read after it. Their
  // replies would be discarded (send() no-ops), but their registry writes
  // would not: hello would resurrect a session entry for a socket nobody
  // holds, and the subscribe ops would install watches with no reader.
  // Dropping the request is the same outcome as the bytes never arriving. A
  // request already running when the disconnect lands is cleaned up after
  // dispatch instead (see the end of this function).
  if (!daemon.connections.has(conn)) return;
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    sendErr(conn, ErrorCode.bad_request, "invalid JSON");
    return;
  }
  if (typeof req !== "object" || req === null || typeof (req as { op?: unknown }).op !== "string") {
    sendErr(conn, ErrorCode.bad_request, "missing op");
    return;
  }
  // Everything from here on is answered with a correlated reply, so the id has
  // to be known first. A request without one cannot be answered in a way its
  // sender could pair up: report it as bad_request (uncorrelated, like the two
  // parse failures above) rather than dispatching into a reply nobody claims.
  // No compatibility path for the pre-correlation clients that omit it — that
  // is a deliberate break (DR-0029 追補 / DR-0002 §4 設計意図); a subscribe from
  // before this envelope is resolved by restarting it, not by serving it here.
  if (typeof req.request_id !== "string" || req.request_id === "") {
    // The refusal stands, but a client this old is otherwise invisible: it
    // never registers, so nothing in the session list ever mentions it. File
    // it against the sid its hello claimed, which is the only thing here that
    // ties the failing process back to a session kawaz can act on.
    if (req.op === "hello" && typeof req.sid === "string" && req.sid !== "") {
      markStaleClient(daemon, req.sid, readClientBuild(req));
      maybeBroadcastPeers(daemon);
    }
    sendErr(conn, ErrorCode.bad_request, `op '${req.op}' requires a non-empty string request_id`);
    return;
  }
  await activeRequest.run({ conn, requestId: req.request_id }, async () => {
    if (IDENTITY_OPS.has(req.op) && conn.identity === null) {
      sendErr(conn, ErrorCode.hello_required, `op '${req.op}' requires hello first`);
      return;
    }
    try {
      await dispatch(daemon, conn, req);
    } catch (e) {
      daemon.log.error(`op '${req.op}' failed: ${String(e)}`);
      sendErr(conn, "internal", String(e));
    }
  });
  // A request that started before the disconnect but finished after it can
  // still have written to the registries (hello registering a session,
  // subscribe installing a watch) — the entry guard above only sees requests
  // that arrived late. Repeat the teardown: it is idempotent, and this is the
  // only place that knows the op is now done touching them.
  if (!daemon.connections.has(conn)) removeConn(daemon, conn);
  // single choke point for "this sid did something" (checked post-dispatch so
  // a session's very first request, hello itself, also counts — conn.identity
  // is null until dispatch's "hello" case sets it).
  const id = conn.identity;
  if (id && id.role === "session") {
    const entry = daemon.sessions.get(id.sid);
    if (entry) entry.lastActivityAt = nowIso();
  }
}

async function dispatch(daemon: Daemon, conn: Conn, req: Request): Promise<void> {
  switch (req.op) {
    case "hello": {
      const prevId = conn.identity;
      const client = readClientBuild(req);
      // A client speaking another generation is refused, not adapted to: ccmsg
      // evolves per host, all at once (DR-0002 §4). Announcing no generation is
      // not a way out of this check — it means generation
      // UNANNOUNCED_PROTOCOL_VERSION and is compared like any other value —
      // it just happens to be the current one while that constant and
      // PROTOCOL_VERSION agree.
      const generation = protocolOf(client);
      if (generation !== PROTOCOL_VERSION) {
        if (req.role === "session" && req.sid) {
          markStaleClient(daemon, req.sid, client);
          maybeBroadcastPeers(daemon);
        }
        sendErr(
          conn,
          ErrorCode.bad_request,
          `client speaks protocol ${generation}, this daemon speaks ${PROTOCOL_VERSION}`,
        );
        return;
      }
      // Served, so whatever this sid was flagged for is over. registerSession's
      // own push below carries the cleared warning out.
      if (req.role === "session" && req.sid) daemon.staleClients.delete(req.sid);
      let newId: Identity;
      if (req.role === "user") {
        newId = { role: "user" };
      } else {
        if (!req.sid) {
          sendErr(conn, ErrorCode.invalid_args, "session hello requires sid");
          return;
        }
        // Announced-and-validated path, else the session's own
        // projects/<sid>.jsonl found on disk — a fork/resume launch never gets
        // a state file written under its new sid, so its hello announces
        // nothing (see adoptTranscriptPath).
        const transcriptPath = await adoptTranscriptPath(req.sid, req.transcript_path);
        // A session names its own cwd, so the spelling is whatever its shell
        // had (`/tmp/x` where the real directory is `/private/tmp/x`).
        // `repo_root` is realpath'd by validateRepoRoot before adoption, and
        // every containment check downstream compares against realpath'd
        // roots — so canonicalize cwd at adoption too, and the two halves of
        // `repo_root ?? cwd` stop disagreeing about how a path is spelled.
        // This matters most for sessions that never announce a repo_root:
        // there the raw cwd *is* the containment root the webui hands back to
        // the daemon. Unresolvable cwd keeps its literal spelling (fail-open,
        // same as before) and resolveRoot rejects it later as it always did.
        const cwd = await realpathOrSelf(req.cwd ?? "");
        const repoRoot = await validateRepoRoot(cwd, req.repo_root);
        // Announced repo/ws always win; the cwd derivation only fills what the
        // session could not tell us. A fork/resume launch gets no hook-written
        // state file (same hole adoptTranscriptPath covers), so it announces
        // neither and used to show blank columns in the webui's session list.
        // Fail-open: unresolvable stays "" and hello proceeds regardless.
        // Not validated beyond "absolute path, canonically spelled": the value
        // is only ever compared with another session's announcement, never
        // opened, and a session that lies about it can at most mislabel its
        // own view of who is natively reachable.
        const configDir = normalizeConfigDir(req.config_dir);
        const announcedRepo = req.repo ?? "";
        const announcedWs = req.ws ?? "";
        const derived =
          announcedRepo === "" || announcedWs === ""
            ? await deriveRepoWs(cwd)
            : { repo: "", ws: "" };
        newId = {
          role: "session",
          sid: req.sid,
          repo: announcedRepo !== "" ? announcedRepo : derived.repo,
          ws: announcedWs !== "" ? announcedWs : derived.ws,
          cwd,
          ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
          ...(repoRoot ? { repo_root: repoRoot } : {}),
          ...(req.branch ? { branch: req.branch } : {}),
          ...(configDir ? { config_dir: configDir } : {}),
        };
      }
      // A re-hello that moves this conn away from its previous sid (a different
      // sid, or role no longer "session") must stop counting it there first, or
      // the old sid's entry never reaches conns.size===0 on its own and lingers
      // as a ghost peer (see detachSession's doc comment).
      const movedAwayFromSession =
        prevId?.role === "session" && (newId.role !== "session" || newId.sid !== prevId.sid);
      if (movedAwayFromSession) detachSession(daemon, conn, prevId.sid);
      conn.identity = newId;
      if (newId.role === "session") {
        // pushes ev:"peers" itself, covering both the detach above and this
        // registration as one combined change (see detachSession's doc comment).
        registerSession(daemon, conn, newId, client);
      } else if (movedAwayFromSession) {
        // detach-only change (session -> user role): still need the push detachSession
        // deliberately didn't make.
        maybeBroadcastPeers(daemon);
      }
      // user role の hello にだけ terminal_gateway_url を返す (issue
      // 2026-07-21): session role は Terminal タブを持たないので不要。
      // config.json 未設定なら省略 → webui は Terminal タブを出さない。
      const terminalGatewayUrl =
        newId.role === "user" ? daemon.config.terminal_gateway_url : undefined;
      // 同じ理由で llm_usage_url の「設定済みか」だけを user role に返す。URL
      // 自体を渡さないのは fetch するのが daemon 側だから (CORS 無しの
      // endpoint を browser から読めない) — webui は Usage メニューを出すか
      // 否かの判断にしか使わない。
      const llmUsageAvailable = newId.role === "user" && !!daemon.config.llm_usage_url;
      // 使用量 (llm_stats_url) も同じ扱い。usage とは独立に設定できるので
      // capability も独立に返す — 片方だけ設定した環境で、設定していない方の
      // セクションが「押せば必ずエラー」の状態で出るのを防ぐ。
      const llmStatsAvailable = newId.role === "user" && !!daemon.config.llm_stats_url;
      // upstream service status (gateway 側 DR-0021) も同じ扱い。status を返せる
      // gateway かどうかは usage を返せるかと独立 (古い gateway は usage だけ)
      // なので capability も独立に返す。
      const llmStatusAvailable = newId.role === "user" && !!daemon.config.llm_status_url;
      // sandbox origin (DR-0030 §7.1) も同じ流儀。template 自体は返さない —
      // client が触るのは sandbox_grant が組み立てた完成 URL だけなので、
      // 「導線を出してよいか」だけ渡せば足りる。未設定 (= canddy の sandbox
      // ドメインが前段に無い環境) では webui が導線を一切出さない。
      const sandboxAvailable = newId.role === "user" && daemon.sandboxOrigin !== null;
      // fork も同じ流儀の capability。fork は launcher テンプレを起動する操作
      // なので、launcher が設定されていなければ導線を出す意味がない (押した先
      // の起動フォームが launcher_not_configured しか返せない)。
      const forkAvailable = newId.role === "user" && !!daemon.config.session_launcher;
      send(conn, {
        ok: true,
        version: daemon.version,
        protocol: PROTOCOL_VERSION,
        ...(terminalGatewayUrl ? { terminal_gateway_url: terminalGatewayUrl } : {}),
        ...(llmUsageAvailable ? { llm_usage_available: true } : {}),
        ...(llmStatsAvailable ? { llm_stats_available: true } : {}),
        ...(llmStatusAvailable ? { llm_status_available: true } : {}),
        ...(sandboxAvailable ? { sandbox_available: true } : {}),
        ...(forkAvailable ? { fork_available: true } : {}),
      });
      return;
    }

    case "ping": {
      send(conn, {
        ok: true,
        pong: true,
        version: daemon.version,
        uptime: (Date.now() - daemon.startTime) / 1000,
        pid: process.pid,
        rooms: daemon.rooms.size,
        clients: daemon.connections.size,
        // provenance (DR-0009-agents addendum): which bun executable and entry
        // script this running daemon actually is, so version skew across faces
        // (e.g. ~/.claude-personal vs a work overlay) is observable.
        exe: process.execPath,
        script: Bun.main,
        http: daemon.httpListeners.map((l) => l.address),
        httpAllow: daemon.httpAllow,
        network: networkState(daemon),
      });
      return;
    }

    case "post": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const from = resolveFrom(conn, room);
      if (from === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      // A session's response to u1 in a 1on1 room belongs in its normal
      // assistant transcript, which the webui SessionView already follows.
      // Reject every session-authored 1on1 post at the room boundary rather
      // than trying to infer which prior msg it answers or track pending state.
      // u1/webui posts remain the legitimate incoming-message path.
      if (room.kind === "1on1" && conn.identity?.role === "session") {
        sendReplyViaTlError(conn, room);
        return;
      }
      const to = normalizeTo(req.to);
      // DR-0013 §2.4: broadcast room では role:"session" (agent) からの post は
      // `to` に "u1" (ADMIN_ID) を含めることが必須。「u1 に届かない agent の
      // broadcast 発話」を意味論として封じる (broadcast の目的は kawaz への
      // 集約通信なので、u1 抜きの agent 発話は broadcast context の外側)。
      // u1 (User) 発の post は制約なし — 既存の to semantics (省略=全員 /
      // 単一 / 複数 mention) がそのまま働く (§2.5)。u1 の実装位置は
      // conn.identity.role === "user"、ADMIN_ID 決定は resolveFrom を経由。
      if (room.kind === "broadcast" && conn.identity?.role === "session") {
        if (!to || !to.includes(ADMIN_ID)) {
          sendErr(
            conn,
            ErrorCode.broadcast_agent_target_required,
            `broadcast room post from an agent must include '${ADMIN_ID}' in to`,
          );
          return;
        }
      }
      if (to) {
        // `to` is a delivery filter now (DR-0011 §1): an unresolvable id silently
        // drops the msg into a black hole (delivered to nobody but the sender/u1),
        // with no error and no observable signal to the poster. Reject typos/stale
        // ids up front instead — present member ids (memberIdBySid) plus the
        // always-exempt admin (ADMIN_ID) are the only valid delivery targets.
        const known = new Set(memberIdBySid(room).values());
        known.add(ADMIN_ID);
        const unknown = to.filter((t) => !known.has(t));
        if (unknown.length > 0) {
          sendErr(conn, ErrorCode.invalid_args, `to: unknown member id(s): ${unknown.join(", ")}`);
          return;
        }
      }
      const mid = room.lastMid + 1;
      const ev: MsgEvent = {
        type: "msg",
        mid,
        from,
        ...(to ? { to } : {}),
        ts: nowIso(),
        msg: req.msg,
      };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, mid });
      return;
    }

    case "reply": {
      // DR-0017 §2.2: reply to an existing msg — the daemon computes the
      // delivery targets so the replier never assembles a `to` list itself
      // (the misassembled-to failure mode is the whole reason this op exists).
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const from = resolveFrom(conn, room);
      if (from === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const target = room.events.find((e): e is MsgEvent => e.type === "msg" && e.mid === req.mid);
      if (!target) {
        sendErr(conn, ErrorCode.msg_not_found, `no msg m${req.mid} in ${req.room}`);
        return;
      }
      if (target.from === from) {
        sendErr(
          conn,
          ErrorCode.self_reply,
          `m${req.mid} is your own msg — reply targets someone else's`,
        );
        return;
      }
      // §2.5: a "tl"-routed msg (1on1, u1-authored) is answered on the
      // replier's own transcript, not in the room. Rejecting with guidance
      // corrects the wrong-channel choice the moment it happens, instead of
      // silently rerouting to a room post kawaz would then read in the wrong
      // surface.
      if (room.kind === "1on1" && target.from === ADMIN_ID) {
        sendReplyViaTlError(conn, room);
        return;
      }
      // Targets = original author + everyone the original msg addressed,
      // minus the replier. u1 is intentionally NOT force-added here: the User
      // is an always-exempt delivery target (see deliver()'s admin fanout),
      // and this reply op runs *between agents* on kawaz's screen — surfacing
      // u1 in every agent-to-agent reply's `to` list is noise on a channel
      // where "u1 sees everything" is already the invariant. The broadcast
      // room's agent-post u1-target constraint (§2.4) is enforced in `post`,
      // not here, and is still satisfied by construction for the cases reply
      // covers: replies to a u1-authored msg have target.from == u1, and
      // replies to an agent post in a broadcast room inherit u1 from
      // target.to (§2.4 required it there). Sorted for a stable wire shape.
      const parts = new Set<string>([target.from, ...(target.to ?? [])]);
      parts.delete(from);
      const to = [...parts].sort(compareIds);
      const mid = room.lastMid + 1;
      const ev: MsgEvent = {
        type: "msg",
        mid,
        from,
        to,
        ts: nowIso(),
        msg: req.msg,
        reply_to: `${room.id}m${req.mid}`,
      };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, mid, to });
      return;
    }

    case "create_room": {
      const explicitMembers = Array.isArray(req.members) ? req.members : [];
      const kind: RoomKind =
        req.kind === "broadcast" ? "broadcast" : req.kind === "1on1" ? "1on1" : "normal";

      if (kind === "1on1") {
        // DR-0014 §2.1 1on1 room = "u1 + 単一 session の 2 者 room".
        // members must be exactly one non-empty sid string. Empty / multiple /
        // non-string entries all fail with one_on_one_requires_single_member so
        // the caller can't accidentally open a 3-party or 0-party priv room —
        // 1on1's whole point is "2 者確定なので配信対象は必然的に絞られる".
        const targetSids = explicitMembers.filter(
          (s): s is string => typeof s === "string" && s !== "",
        );
        if (targetSids.length !== 1) {
          sendErr(
            conn,
            ErrorCode.one_on_one_requires_single_member,
            "create_room --kind 1on1 requires exactly one member sid",
          );
          return;
        }
        const targetSid = targetSids[0]!;
        // RL-Q1 (kawaz r26 mid=103, 「混ぜない」裁定): session 発の初期 --msg は
        // 1on1 room に対して post ガード (§2.5 reply_via_tl) と同じ理由で拒否
        // する — 1on1 の返信レールは TL (transcript) で、room msg 経路ではない。
        // 副作用 (KindEvent/member 書き込み) を残さないため、room 作成前に落とす。
        // broadcast の初期 msg 例外 (§2.10) は unchanged: 1on1 のみに適用。
        if (req.msg !== undefined && conn.identity?.role === "session") {
          sendReplyViaTlError(conn, null);
          return;
        }
        // include_self is deliberately NOT honored for 1on1 (§2.1: session-role
        // caller does NOT auto-prepend). If a session creates a 1on1 with its
        // OWN sid, the resulting room has member.sid == self.sid, member.id = a1,
        // and u1 stays implicit — the same 2-party shape as a webui-created one.
        const room = createRoom(daemon, [targetSid], false, "1on1");
        // Kind marker first (same rationale as broadcast: mid-creation crash
        // recovery must not resurface a 1on1 as "normal" and then start
        // dedup-folding future creates into it).
        appendEvent(room, { type: "kind", kind: "1on1", ts: nowIso() } satisfies KindEvent);
        if (req.title)
          appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
        writeMembers(daemon, room, [targetSid]);
        let mid: number | undefined;
        let authorId: string | null = null;
        if (req.msg) {
          authorId = resolveFrom(conn, room);
          if (authorId !== null) {
            mid = room.lastMid + 1;
            appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
          }
        }
        // 1on1 rooms are dedup-exempt (createRoom seeded dedupEligible=false,
        // storage.ts's computeDerived enforces the same on restart) — the
        // webui's "reuse existing 1on1 with this sid, else create" auto-create
        // (§2.2) does its own lookup by kind==="1on1" instead of relying on
        // the dedup index. So we deliberately do NOT populate dedupIndex here.
        deliverNewRoom(daemon, room, authorOf(conn), authorId);
        send(conn, {
          ok: true,
          room: room.id,
          reused: false,
          ...(mid !== undefined ? { mid } : {}),
        });
        return;
      }

      if (kind === "broadcast") {
        // DR-0013 §2.2 broadcast rooms auto-populate from the live session
        // registry; the caller's `members` list is irrelevant and (§2.9) folded
        // to a non-fatal warning rather than an error. The warning is echoed
        // by the CLI to stderr (index.ts) so a habitual `--members` on a
        // broadcast create still visibly nags. `include_self` is likewise
        // ignored — the caller's own sid enters through the normal
        // auto-populate scan just like every other active session.
        const warning =
          explicitMembers.length > 0
            ? "--members is ignored for broadcast rooms (members are auto-populated)"
            : undefined;
        const room = createRoom(daemon, [], false, "broadcast");
        // KindEvent is written FIRST so a mid-creation crash between here and
        // the member snapshot below still recovers the room as broadcast on
        // daemon restart (storage.ts computeDerived reads events in order).
        // If it came last, a partial file could resurface as "normal" and
        // then start dedup-folding future broadcast creates into it.
        appendEvent(room, { type: "kind", kind: "broadcast", ts: nowIso() } satisfies KindEvent);
        if (req.title)
          appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
        // Snapshot every currently-connected session as initial members (§2.2
        // 「broadcast room 作成時に既に active な session も同一契機で自動 join」).
        // Sorting by sid keeps the a1/a2/... assignment deterministic across
        // daemon restarts / test runs so a downstream that reads member.id
        // sees a stable order.
        const activeSids = [...daemon.sessions.values()]
          .filter((s) => s.conns.size > 0)
          .map((s) => s.meta.sid)
          .sort();
        let seq = 1;
        for (const sid of activeSids) {
          const meta = daemon.sessions.get(sid)!.meta;
          appendEvent(room, {
            type: "member",
            id: `a${seq++}`,
            sid,
            repo: meta.repo,
            ws: meta.ws,
            cwd: meta.cwd,
            joined_at: nowIso(),
          } satisfies MemberEvent);
        }
        // Initial msg is treated as a normal post from the caller (§2.10:
        // the §2.4 agent-must-target-u1 rule DELIBERATELY does not apply to
        // create_room's own initial msg — u1's own opening line has no
        // "must be addressed to u1" self-reference to enforce, and forbidding
        // a session caller's opener would just push kawaz to a two-step
        // create + post workflow with no meaningful gain).
        let mid: number | undefined;
        let authorId: string | null = null;
        if (req.msg) {
          authorId = resolveFrom(conn, room);
          if (authorId !== null) {
            mid = room.lastMid + 1;
            appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
          }
        }
        // Broadcast rooms are dedup-exempt (see createRoom's kind === broadcast
        // branch); we deliberately do NOT populate dedupIndex.
        deliverNewRoom(daemon, room, authorOf(conn), authorId);
        send(conn, {
          ok: true,
          room: room.id,
          reused: false,
          ...(mid !== undefined ? { mid } : {}),
          ...(warning ? { warning } : {}),
        });
        return;
      }

      const ordered: string[] = [];
      const id = conn.identity!;
      // Auto-prepend caller sid unless include_self=false (CLI --exclude-self,
      // for an observer session that watches a room without participating).
      // User-role callers (webui backend) never auto-include either way — u1 is
      // implicit in every room already (DR-0006 §2).
      const includeSelf = req.include_self !== false;
      if (id.role === "session" && includeSelf) ordered.push(id.sid);
      for (const sid of explicitMembers)
        if (typeof sid === "string" && !ordered.includes(sid)) ordered.push(sid);
      if (ordered.length === 0) {
        sendErr(conn, ErrorCode.invalid_args, "create_room needs at least one member");
        return;
      }
      const key = [...new Set(ordered)].sort().join(",");
      const existingId = daemon.dedupIndex.get(key);
      const existing = existingId ? daemon.rooms.get(existingId) : undefined;
      if (
        existing &&
        existing.dedupEligible &&
        Date.now() - existing.createdAt < daemon.dedupWindowMs
      ) {
        // dedup: fold the late create's initial msg into the existing room (DR-0003 §4)
        let mid: number | undefined;
        if (req.msg) {
          const from = resolveFrom(conn, existing);
          if (from !== null) {
            mid = existing.lastMid + 1;
            const ev: MsgEvent = { type: "msg", mid, from, ts: nowIso(), msg: req.msg };
            appendEvent(existing, ev);
            deliver(daemon, existing, ev, authorOf(conn));
          }
        }
        send(conn, {
          ok: true,
          room: existing.id,
          reused: true,
          ...(mid !== undefined ? { mid } : {}),
        });
        return;
      }

      const room = createRoom(daemon, ordered, true);
      writeMembers(daemon, room, ordered);
      if (req.title)
        appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
      let mid: number | undefined;
      let authorId: string | null = null;
      if (req.msg) {
        authorId = resolveFrom(conn, room);
        if (authorId !== null) {
          mid = room.lastMid + 1;
          appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
        }
      }
      daemon.dedupIndex.set(room.dedupKey, room.id);
      deliverNewRoom(daemon, room, authorOf(conn), authorId);
      send(conn, { ok: true, room: room.id, reused: false, ...(mid !== undefined ? { mid } : {}) });
      return;
    }

    case "next_room": {
      const old = daemon.rooms.get(req.room);
      if (!old) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      if (resolveFrom(conn, old) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      // RL-Q1 (kawaz r26 mid=103): 1on1 の次スレも 1on1 (§2 kind inheritance)
      // なので、create_room 側と同じく session 発の初期 --msg は "tl" 経路に
      // 誘導する (post ガード §2.5 と同じ理由)。next_room 自体 (msg なし) は
      // 正当な操作なので通す。broadcast の初期 msg 例外 (§2.10) は unchanged。
      if (req.msg !== undefined && old.kind === "1on1" && conn.identity?.role === "session") {
        sendReplyViaTlError(conn, old);
        return;
      }
      const inherited = presentMembers(old);
      const room = createRoom(
        daemon,
        inherited.map((m) => m.sid),
        false,
        // DR-0013 §2.8 / DR-0014 §2 next_room inherits kind: broadcast の
        // 次スレは broadcast (auto-populate と §2.4 post 制約もそのまま新 room に
        // 適用され、以降の hello/disconnect が新 room も拾う)、1on1 の次スレは
        // 1on1 の assistant-response routing も維持。normal はそのまま normal。
        old.kind,
      );
      // KindEvent must be written BEFORE members / prev so a mid-creation crash
      // still recovers the next-room's kind on daemon restart (same rationale
      // as create_room's non-`"normal"` branches above).
      if (old.kind !== "normal")
        appendEvent(room, { type: "kind", kind: old.kind, ts: nowIso() } satisfies KindEvent);
      // Renumber per namespace, preserving each member's u/a namespace and relative
      // join order. Guests (u2+) stay guests; agents (a-namespace) stay agents.
      let aSeq = 1;
      let uSeq = 2; // u1 is the implicit admin, never present in `inherited`
      for (const m of inherited) {
        const isGuest = m.id.startsWith("u");
        appendEvent(room, {
          type: "member",
          id: isGuest ? `u${uSeq++}` : `a${aSeq++}`,
          sid: m.sid,
          repo: m.repo,
          ws: m.ws,
          cwd: m.cwd,
          joined_at: nowIso(),
          ...(isGuest ? { role: "guest" as const } : {}),
        } satisfies MemberEvent);
      }
      appendEvent(room, { type: "prev", room: old.id, ts: nowIso() });
      const nextEv: StorageEvent = { type: "next", room: room.id, ts: nowIso() };
      appendEvent(old, nextEv);
      if (req.title)
        appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
      let mid: number | undefined;
      let authorId: string | null = null;
      if (req.msg) {
        authorId = resolveFrom(conn, room);
        if (authorId !== null) {
          mid = room.lastMid + 1;
          appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
        }
      }
      // old room subscribers see the `next` link live; new room subscribers get its snapshot
      deliver(daemon, old, nextEv, authorOf(conn));
      deliverNewRoom(daemon, room, authorOf(conn), authorId);
      send(conn, { ok: true, room: room.id, ...(mid !== undefined ? { mid } : {}) });
      return;
    }

    case "say": {
      // kawaz r244 m5-m6: `ccmsg say` は say の実行そのものは CLI が必ず行う。
      // ここは「どのセッションが喋ったか」を webui が答えられるようにするため
      // の記録だけを担う。session role 限定 — 「自分の 1on1 room」が宛先の
      // 全てなので、caller が room を名指しする余地はない。
      if (conn.identity?.role !== "session") {
        sendErr(conn, ErrorCode.bad_request, "op 'say' requires session role");
        return;
      }
      if (typeof req.text !== "string") {
        sendErr(conn, ErrorCode.invalid_args, "say requires a text string");
        return;
      }
      const sid = conn.identity.sid;
      let room = findOneOnOneRoomForSid(daemon, sid);
      const created = room === null;
      if (room === null) {
        // 同じ形の room を webui の §2.2 auto-create と揃える (kind marker を
        // 先に書く理由は create_room の 1on1 分岐と同一: 作成途中でクラッシュ
        // しても restart 後に "normal" として復活させない)。title も webui と
        // 同じ `<repo> 1on1 <sid8>` にして、どちらが先に作っても見た目が同じに
        // なるようにする。
        room = createRoom(daemon, [sid], false, "1on1");
        appendEvent(room, { type: "kind", kind: "1on1", ts: nowIso() } satisfies KindEvent);
        const repo = daemon.sessions.get(sid)?.meta.repo || "(unknown)";
        appendEvent(room, {
          type: "title",
          title: `${repo} 1on1 ${sid.slice(0, 8)}`,
          ts: nowIso(),
        } satisfies TitleEvent);
        writeMembers(daemon, room, [sid]);
      }
      const ev: SayEvent = { type: "say", sid, text: req.text, ts: nowIso() };
      appendEvent(room, ev);
      if (created) {
        // 新規 room は snapshot ごと配信する (create_room と同じ経路)。say
        // 自体もその snapshot に含まれるので、ここで個別 deliver はしない。
        deliverNewRoom(daemon, room, authorOf(conn), null);
      } else {
        deliver(daemon, room, ev, authorOf(conn));
      }
      send(conn, { ok: true, room: room.id, seq: ev.seq!, created });
      return;
    }

    case "say_read": {
      // 既読は webui の 📣 バブル上のボタンからだけ立つ (user role 限定):
      // 未読数は「kawaz がまだ見ていない say」の数であって、喋った session が
      // 自分で消せる意味の数ではない。
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'say_read' requires user role");
        return;
      }
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const target = room.events.find((e): e is SayEvent => e.type === "say" && e.seq === req.seq);
      if (!target) {
        // 存在しない seq を黙って ack すると、未読数が減らないまま "既読にした"
        // と見える (typo / 別 room の seq を渡した時の典型)。落として気づかせる。
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `no say event with seq ${String(req.seq)} in ${room.id}`,
        );
        return;
      }
      const ev: SayReadEvent = { type: "say_read", ref: req.seq, ts: nowIso() };
      appendEvent(room, ev);
      // 他タブの webui にも既読を伝える (session role には届かない —
      // isSuppressedForSubscriber)。
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, ref: req.seq });
      return;
    }

    case "set_title": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      // same authorization as post: admin User (implicit member of every room) or a
      // resolvable member session. Non-member sessions are refused.
      if (resolveFrom(conn, room) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const title = typeof req.title === "string" ? req.title.trim() : "";
      if (title === "") {
        sendErr(conn, ErrorCode.invalid_args, "set_title requires a non-empty title");
        return;
      }
      if (title.length > SET_TITLE_MAX_LEN) {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `title must be ${SET_TITLE_MAX_LEN} characters or fewer`,
        );
        return;
      }
      const ev: TitleEvent = { type: "title", title, ts: nowIso() };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, title });
      return;
    }

    case "archive_room": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      // same authorization as set_title: admin User (implicit member of every room)
      // or a resolvable member session.
      if (resolveFrom(conn, room) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      if (typeof req.archived !== "boolean") {
        sendErr(conn, ErrorCode.invalid_args, "archive_room requires a boolean archived");
        return;
      }
      const archived = req.archived;
      if (room.archived === archived) {
        // toggle already at the requested value: skip the redundant append/broadcast
        // (DR-0012 — archive is a display flag, re-asserting the same state is a no-op).
        send(conn, { ok: true, room: room.id, archived });
        return;
      }
      const ev: ArchiveEvent = { type: "archive", archived, ts: nowIso() };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, archived });
      return;
    }

    case "kick": {
      // admin User only (DR-0012): a room's agents must not be able to evict each
      // other. Unlike member-scoped ops (post/set_title/leave), a session caller here
      // gets a straight permission rejection rather than not_a_member — same pattern
      // as the other user-role-only ops below (agents/transcript_subscribe).
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'kick' requires user role");
        return;
      }
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const targetId = typeof req.id === "string" ? req.id : "";
      // ADMIN_ID (u1) has no member row (implicit member, DR-0006) so it's never in
      // presentIds — self-kick is naturally invalid_args, no separate guard needed.
      const presentIds = new Set(presentMembers(room).map((m) => m.id));
      if (targetId === "" || !presentIds.has(targetId)) {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `not a member of ${req.room}: ${targetId || "(missing id)"}`,
        );
        return;
      }
      appendLeaveAndBroadcast(daemon, room, targetId);
      send(conn, { ok: true, room: room.id, id: targetId });
      return;
    }

    case "subscribe": {
      conn.subscribed = true;
      daemon.subscribers.add(conn);
      send(conn, { ok: true, subscribed: true });
      supersedeOlderSessionSubscribers(daemon, conn);
      // handler runs to completion synchronously, so no live event interleaves the snapshot.
      // Default (no `since`/`since_seq` entry for a room, and no `backlog: true`) is
      // NO backlog at all — a fresh sidecar connect doesn't want its context flooded
      // with history it can't act on (issue 2026-07-17-subscribe-no-backlog-default).
      // Rooms without a replay instead go into `cursors` below and surface on the wire
      // as one `room_cursors` summary event. The CLI drops that connection snapshot
      // from stdout; other protocol consumers may use it. `backlog: true` (the webui's
      // every subscribe call, since it paints room history from the backlog) restores
      // the old unconditional snapshot for rooms `since`/`since_seq` doesn't cover.
      const cursors: Array<{ room: string; last_mid: number }> = [];
      for (const room of daemon.rooms.values()) {
        if (!subscriberSeesRoom(conn, room)) continue;
        const sinceMid = req.since?.[room.id];
        const sinceSeq = req.since_seq?.[room.id];
        // Presence, not validity, decides opt-in: a room the caller named in
        // since/since_seq at all (even with a malformed value) means "I have a
        // cursor concept for this room" — sendBacklog's own isValidSeqCursor
        // check below still resolves a bad value to the full join snapshot
        // (DR-0016 §2.5's "duplicates over silent loss"), it just doesn't fall
        // all the way to the new no-cursor-named default.
        const hasCursor = sinceMid !== undefined || sinceSeq !== undefined;
        if (!hasCursor && req.backlog !== true) {
          // Recent-replay: for this room the subscriber gets no history via
          // sendBacklog, but msgs from the last RECENT_REPLAY_WINDOW_MS that
          // pass the same live-delivery filter (msgVisibleTo, author-echo
          // suppression, broadcast-stream suppression) are surfaced with a
          // `replay: true` marker. This closes the "post → peer session
          // hadn't wired subscribe yet → msg silently missed" gap without
          // reverting the no-backlog default that keeps context clean on
          // reconnects. CLI's sinceMap update path is unchanged (r+seq drives
          // it), so a follow-up reconnect's since_seq excludes these msgs
          // from a duplicate replay.
          if (RECENT_REPLAY_WINDOW_MS > 0) {
            const cutoff = Date.now() - RECENT_REPLAY_WINDOW_MS;
            const selfId = selfMemberId(conn, room);
            for (const ev of room.events) {
              if (ev.type !== "msg") continue;
              if (isSuppressedForBroadcastStream(room, ev)) continue;
              if (Date.parse(ev.ts) < cutoff) continue;
              // Msgs the subscriber themselves authored come back bodyless — a
              // session that just posted and then subscribed needs the post on
              // record, not its body re-read (parity with live-deliver's echo).
              if (ev.from === selfId) {
                writeDelivered(conn, room, ev, { replay: true, echo: true });
                continue;
              }
              if (!msgVisibleTo(conn, room, ev)) continue;
              writeDelivered(conn, room, ev, { replay: true });
            }
          }
          cursors.push({ room: room.id, last_mid: room.lastMid });
          continue;
        }
        sendBacklog(conn, room, sinceMid, undefined, sinceSeq);
      }
      if (cursors.length > 0) send(conn, { ev: "room_cursors", rooms: cursors });
      // agents polling (DR-0009-agents addendum) only ever runs while a user-role
      // subscriber is connected — a session subscribing never starts it.
      if (conn.identity?.role === "user") {
        maybeStartAgentsPoller(
          daemon.agentsPoller,
          daemon.subscribers,
          daemon.log,
          (agents, polledAt) => {
            for (const sub of daemon.subscribers) {
              if (sub.identity?.role === "user") {
                send(sub, { ev: "agents", agents, polled_at: polledAt });
              }
            }
          },
        );
        // Same "only while a webui is watching" gate as the agents poller:
        // this conn may be the first user subscriber, which is what makes the
        // per-peer api_error and user-input watches worth holding.
        syncSessionErrors(daemon);
        syncSessionUserInputs(daemon);
        // Catch-up for the windows that opened before this tab connected. Sent
        // only when something is live: an empty push would make a daemon with
        // no gateway configured look like one whose sessions all went cold.
        if (daemon.llmRequests.snapshot().length > 0) sendLlmRequests(daemon, conn);
      }
      return;
    }

    case "read": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const msgs = readMsgs(room, parseMidSelector(req.mids));
      send(conn, { ok: true, room: room.id, msgs });
      return;
    }

    case "room_history": {
      const room = daemon.rooms.get(req.room);
      // A room the caller can't see is reported as absent rather than as a
      // permission failure: room ids are opaque, and "exists but not yours"
      // would leak that an id is live.
      if (!room || !subscriberSeesRoom(conn, room)) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      // Same no-cursor join snapshot the `backlog: true` subscribe path builds,
      // for this one room. The reply goes last so the client can treat it as
      // the "snapshot complete" sentinel (frames on one connection keep order).
      sendBacklog(conn, room);
      send(conn, { ok: true, room: room.id });
      return;
    }

    case "rooms": {
      // Sids with at least one open connection — the same liveness the `peers`
      // op reports, computed once here instead of per room. Clients used to
      // have to fetch `peers` separately and intersect it with each room's
      // member list to tell an inhabited room from a dormant one; `live_members`
      // (see RoomSummary) hands them that count directly.
      const liveSids = new Set(
        [...daemon.sessions.values()].filter((s) => s.conns.size > 0).map((s) => s.meta.sid),
      );
      const rooms = [...daemon.rooms.values()].map((r) => {
        const members = presentMembers(r);
        const sayUnread = sayUnreadSeqs(r);
        return {
          id: r.id,
          ...(r.title ? { title: r.title } : {}),
          members,
          live_members: members.filter((m) => m.id !== ADMIN_ID && liveSids.has(m.sid)).length,
          last_mid: r.lastMid,
          last_ts: lastTs(r),
          ...(r.archived ? { archived: true } : {}),
          // DR-0013 broadcast / DR-0014 1on1: surface non-`"normal"` kind so
          // CLI can badge and webui can pick the right Composer variant (or
          // reuse an existing 1on1 room, §2.2 auto-create). "normal" is the
          // absence of the field.
          ...(r.kind !== "normal" ? { kind: r.kind } : {}),
          // 📣 marker seed (kawaz r244 m5-m6): only 1on1 rooms ever carry say
          // events, but the scan runs uniformly — a room's kind is not a reason
          // to special-case a walk that finds nothing on rooms without them.
          // Omitted when empty, per the field's contract.
          ...(sayUnread.length > 0 ? { say_unread_seqs: sayUnread } : {}),
        };
      });
      send(conn, { ok: true, rooms });
      return;
    }

    case "peers": {
      // `last_live` rides along for the webui only, the same posture its push
      // event has: a session-role client gets no ev:"peers" updates, so handing
      // it a list that would silently go stale is worse than not answering.
      const forUser = conn.identity?.role === "user";
      // Same settled-answer contract as `session_errors`: a watch started when
      // this tab subscribed moments ago may still be folding, and a peers list
      // whose ordering key fills in afterwards would sort wrong on first paint.
      if (forUser) await sessionUserInputsReady(daemon.sessionUserInputs);
      send(conn, {
        ok: true,
        ...(forUser ? peersPayload(daemon) : { peers: peersFor(daemon, conn.identity) }),
      });
      return;
    }

    case "notify": {
      const id = conn.identity!;
      const targetSid = req.sid ?? (id.role === "session" ? id.sid : undefined);
      const targetUser = req.sid === undefined && id.role === "user";
      let delivered = 0;
      // Stamp the sender from the connection identity (never the client's self-claim),
      // so the receiver can distinguish self-notify from peer-notify and refuse to
      // auto-execute a peer's command-shaped text (DR-0003 §7).
      const from: NotifyFrom =
        id.role === "user" ? { role: "user" } : { role: "session", sid: id.sid };
      const ephem = { ev: "notify", text: req.text, from };
      for (const sub of daemon.subscribers) {
        const sid = sub.identity;
        if (!sid) continue;
        if (targetUser && sid.role === "user") {
          send(sub, ephem);
          delivered++;
        } else if (targetSid && sid.role === "session" && sid.sid === targetSid) {
          send(sub, ephem);
          delivered++;
        }
      }
      send(conn, { ok: true, delivered });
      return;
    }

    case "session_launcher_config": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_launcher_config' requires user role");
        return;
      }
      const launcher = daemon.config.session_launcher;
      if (!launcher) {
        sendErr(conn, ErrorCode.launcher_not_configured, "session launcher is not configured");
        return;
      }
      send(conn, {
        ok: true,
        root_dirs: launcher.root_dirs,
        // `shell` は daemon 側の実行詳細なので落とす — form が使うのは名前・
        // command テンプレ・params 宣言の 3 つだけ。
        templates: launcher.templates.map(({ name, command, params }) => ({
          name,
          command,
          params,
        })),
      });
      return;
    }

    case "dir_tree": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'dir_tree' requires user role");
        return;
      }
      const result = await dirTree(
        daemon.config.session_launcher,
        req.roots,
        req.depth,
        req.filter,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "session_launch": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_launch' requires user role");
        return;
      }
      const launcher = daemon.config.session_launcher;
      const validation = validateSessionLaunch(launcher, req);
      if (!validation.ok) {
        sendErr(conn, validation.code, validation.msg);
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "session_launch_result", req.request_id);
      // The validation success branch proves launcher exists: an absent config
      // returns launcher_not_configured before process execution is reachable.
      void executeSessionLaunch(validation, launcher!.timeout_seconds).then(
        (result) => complete(result),
        (e) => {
          daemon.log.error(`op 'session_launch' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "session_kill": {
      // DR-0028: user role only — session-role agents must never be able to
      // kill each other. Same gate wording/pattern as session_launch.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_kill' requires user role");
        return;
      }
      if (typeof req.session_id !== "string" || req.session_id === "") {
        sendErr(conn, ErrorCode.invalid_args, "session_kill requires a non-empty session_id");
        return;
      }
      // 2-phase like session_launch: the fresh `claude agents` run plus up to
      // 3s of kill grace is long to hold a reply open, so the ack goes back
      // immediately and the outcome travels on its own event (DR-0028
      // addendum).
      const complete = acceptTwoPhase(daemon, conn, "session_kill_result", req.request_id);
      // DR-0028 addendum (r38 mid=6): forward force through to session-kill.ts
      // for the SIGKILL escalation path. Everything else in this dispatch
      // stays the same (2-phase ack, error mapping, request_id echo).
      void sessionKill(req.session_id, productionKillDeps, {
        force: req.force === true,
      }).then(
        (result) => {
          if (!result.found) {
            // Unresolvable sid and a pid that failed the ps verification are
            // the same outcome for the caller: the session's process is not
            // there (anymore) — DR-0028 maps both to not_found.
            complete({
              ok: false,
              error: { code: ErrorCode.not_found, msg: `no process for session ${req.session_id}` },
            });
            return;
          }
          complete({ ok: true, terminated: result.terminated });
        },
        (e) => {
          daemon.log.error(`op 'session_kill' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "session_rename": {
      // user role only, same posture as session_kill: typing into another
      // session's terminal is at least as strong an action as signalling it,
      // and a session-role agent must not be able to drive its peers' TUIs.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_rename' requires user role");
        return;
      }
      if (typeof req.session_id !== "string" || req.session_id === "") {
        sendErr(conn, ErrorCode.invalid_args, "session_rename requires a non-empty session_id");
        return;
      }
      // Title validation happens before the ack so a malformed title costs
      // nothing and reports synchronously — only the delivery attempt (which
      // spawns hyoui) is worth the 2-phase machinery.
      const titleCheck = validateRenameTitle(req.title);
      if (!titleCheck.ok) {
        sendErr(conn, ErrorCode.invalid_args, titleCheck.msg);
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "session_rename_result", req.request_id);
      void sessionRename(
        req.session_id,
        titleCheck.title,
        productionRenameDeps(
          (sid) => {
            const agent = daemon.agentsPoller.cache.agents.find((a) => a.sessionId === sid);
            return agent?.hyoui_session_id ?? null;
          },
          (sid) => {
            const agent = daemon.agentsPoller.cache.agents.find((a) => a.sessionId === sid);
            return agent?.hyoui_namespace ?? null;
          },
        ),
      ).then(
        (result) => {
          if (result.ok) {
            complete({
              ok: true,
              hyoui_session_id: result.hyoui_session_id,
              title: result.title,
            });
            return;
          }
          if (result.reason === "terminal_unavailable") {
            complete({
              ok: false,
              error: {
                code: ErrorCode.terminal_unavailable,
                msg: `session ${req.session_id} has no known terminal (no HYOUI_SESSION_ID); rename it from the session's own terminal instead`,
              },
            });
            return;
          }
          // The browser shows this once and moves on; the log line is what a
          // later "why did rename fail" investigation has to go on.
          daemon.log.warn(`op 'session_rename' send failed for ${req.session_id}: ${result.msg}`);
          complete({
            ok: false,
            error: {
              code: "internal",
              msg: `sending /rename to the session's terminal failed: ${result.msg}`,
            },
          });
        },
        (e) => {
          daemon.log.error(`op 'session_rename' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "session_env": {
      // user role only, same posture as session_kill and the fs ops: a
      // session-role agent must not be able to read another session's
      // environment (which routinely holds that session's credentials).
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_env' requires user role");
        return;
      }
      if (typeof req.session_id !== "string" || req.session_id === "") {
        sendErr(conn, ErrorCode.invalid_args, "session_env requires a non-empty session_id");
        return;
      }
      // 2-phase for session_kill's reason: the fresh `claude agents`
      // resolution is slow.
      const complete = acceptTwoPhase(daemon, conn, "session_env_result", req.request_id);
      void sessionEnv(req.session_id, productionEnvDeps(productionKillDeps)).then(
        (result) => {
          if (!result.found) {
            // Unresolvable sid and a pid that failed ps verification are the
            // same outcome for the caller, exactly as in session_kill.
            complete({
              ok: false,
              error: { code: ErrorCode.not_found, msg: `no process for session ${req.session_id}` },
            });
            return;
          }
          complete({ ok: true, pid: result.pid, env: result.env });
        },
        (e) => {
          daemon.log.error(`op 'session_env' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "session_search": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_search' requires user role");
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "session_search_result", req.request_id);
      // The bounded filesystem scan is read-only but slow enough that its
      // outcome travels on the result event rather than a deferred reply.
      void sessionSearch(req, daemon.log).then(
        (result) => {
          if (!result.ok) complete({ ok: false, error: { code: result.code, msg: result.msg } });
          else complete(result.data);
        },
        (e) => {
          daemon.log.error(`op 'session_search' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "fork_origin": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fork_origin' requires user role");
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "fork_origin_result", req.request_id);
      // Same resolver transcript_read uses, so a historical sid is answerable
      // and no path ever comes from the client.
      const resolved = await resolveTranscript(daemon.sessions, req.sid, {
        allowVirtual: true,
      });
      if (!resolved.ok) {
        complete({ ok: false, error: { code: resolved.code, msg: resolved.msg } });
        return;
      }
      // Reading whole sibling transcripts is slow on the first ask for a
      // session, so the outcome travels on the result event; later asks are
      // served from the memo.
      void daemon.forkOrigins.resolve(resolved.file, daemon.log).then(
        (origin) => {
          complete({ ok: true, origin });
        },
        (e) => {
          daemon.log.error(`op 'fork_origin' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "session_dump_file": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_dump_file' requires user role");
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "session_dump_file_result", req.request_id);
      // Same resolver transcript_read and fork_origin use, so a connected or a
      // historical sid is answerable and no path ever comes from the client.
      const dumpTarget = await resolveTranscript(daemon.sessions, req.sid, {
        allowVirtual: true,
      });
      if (!dumpTarget.ok) {
        complete({ ok: false, error: { code: dumpTarget.code, msg: dumpTarget.msg } });
        return;
      }
      // Dumping reads the whole transcript plus every agent transcript beside
      // it, so the outcome travels on the result event. The destination is the
      // daemon's own dumps/ — nothing here is client-named.
      void dumpSession(req.sid, {
        dataDir: daemon.paths.dataDir,
        transcriptFile: dumpTarget.file,
        ...(req.since !== undefined ? { since: req.since } : {}),
        ...(req.until !== undefined ? { until: req.until } : {}),
        ...(req.no_thinking === true ? { noThinking: true } : {}),
        ...(req.no_agent === true ? { noAgent: true } : {}),
      })
        .then((dump) => {
          // Written as text, not jsonl: this file is meant to be picked up and
          // read directly by whatever session inherits it, not parsed as
          // structured data (kawaz: jsonl invites over-clever reads that burn
          // context or half-read the handoff).
          const file = writeSessionDumpFile(dump, { dir: daemon.paths.dumps }, "text");
          complete({
            ok: true,
            path: file,
            entries: dump.entries.length,
            bytes: fs.statSync(file).size,
          });
        })
        .catch((e: unknown) => {
          daemon.log.error(`op 'session_dump_file' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        });
      return;
    }

    case "fs_list": {
      const result = await fsList(daemon.sessions, req.sid, req.path, {
        allowVirtual: conn.identity?.role === "user",
      });
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_read": {
      const result = await fsRead(daemon.sessions, req.sid, req.path, {
        allowVirtual: conn.identity?.role === "user",
      });
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_read_external": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_read_external' requires user role");
        return;
      }
      const result = await fsReadExternal(daemon.sessions, daemon.sessionStatus, req.sid, req.path);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_list_workspace": {
      // DR-0026: workspace-folder browsing is a viewer feature (kawaz opens
      // sibling repos from the ワークスペース section). A session AI has no
      // reason to reach outside its containment root through this op, so it's
      // user-role only — same posture as fs_read_external.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_list_workspace' requires user role");
        return;
      }
      const result = await fsListWorkspace(
        daemon.sessions,
        daemon.sessionStatus,
        req.sid,
        req.path,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_read_workspace": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_read_workspace' requires user role");
        return;
      }
      const result = await fsReadWorkspace(
        daemon.sessions,
        daemon.sessionStatus,
        req.sid,
        req.path,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_stat_batch": {
      // user-role only: fs_stat_batch is a viewer feature (the message-body
      // path linkifier, kawaz r46 m55-m58). It reuses fs_read /
      // fs_read_external / fs_read_workspace's authorization surfaces through
      // fsResolveForServe, so no new trust boundary is introduced — sessions
      // (AI) have no reason to probe file existence via the daemon, they read
      // the filesystem directly through their own tool loop.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_stat_batch' requires user role");
        return;
      }
      const result = await fsStatBatch(daemon.sessions, daemon.sessionStatus, req.sid, req.paths);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_find": {
      // user-role only, same posture as fs_list_workspace / fs_stat_batch:
      // searching the tree is a viewer affordance. A session AI enumerates its
      // own filesystem through its own tool loop and has no reason to walk
      // another session's tree through the daemon.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_find' requires user role");
        return;
      }
      const result = await fsFind(
        daemon.sessions,
        daemon.sessionStatus,
        req.sid,
        req.kind,
        req.root,
        req.query,
        req.respect_gitignore,
        // Matches fs_list's own allowVirtual: a historical (disconnected)
        // session's tree is browsable for user-role readers (DR-0021 §3.1), so
        // searching it must be too, or the search box would go dead exactly on
        // the sessions whose layout the user is least likely to remember.
        { allowVirtual: true },
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_write": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_write' requires user role");
        return;
      }
      const result = await fsWrite(daemon.sessions, req.sid, req.path, req.content);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_create": {
      // user-role only: fs_create is the symmetric partner of fs_edit under
      // the same authorization surfaces (contained | workspace). A session
      // (AI) creates files via its own tool loop, not through the daemon.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_create' requires user role");
        return;
      }
      const result = await fsCreate(
        daemon.sessions,
        daemon.sessionStatus,
        req.sid,
        req.path,
        req.kind,
        req.content,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_delete": {
      // user-role only: file deletion is a viewer feature (kawaz r46 m25),
      // gated behind an explicit confirm() dialog on the client side. A
      // session (AI) does not delete files via the daemon.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_delete' requires user role");
        return;
      }
      const result = await fsDelete(
        daemon.sessions,
        daemon.sessionStatus,
        req.sid,
        req.path,
        req.kind,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_edit": {
      // user-role only: fs_edit is a viewer feature that overwrites arbitrary
      // text files under the same authorization surfaces the read ops use.
      // A session-role connection has no reason to overwrite files this way
      // (fs_write's inbox-only create is its mutation channel), so the role
      // gate is identical to fs_read_external / fs_read_workspace / fs_write.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_edit' requires user role");
        return;
      }
      const result = await fsEdit(
        daemon.sessions,
        daemon.sessionStatus,
        req.sid,
        req.path,
        req.kind,
        req.content,
        req.expected_mtime,
        req.expected_size,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "sandbox_grant": {
      // user-role only (DR-0030 §4.1), for the same reason every absolute-path
      // fs op is: this is a viewer affordance. A session (AI) reads files
      // through fs_read and has no browser to open a preview in.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'sandbox_grant' requires user role");
        return;
      }
      const result = await mintSandboxGrant(
        daemon.sandboxGrants,
        daemon.sandboxOrigin,
        daemon.sessions,
        daemon.sessionStatus,
        req.sid,
        req.path,
        req.kind,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, {
        ok: true,
        gid: result.grant.gid,
        token: result.grant.token,
        url: result.url,
        exp: result.grant.exp,
      });
      return;
    }

    case "sandbox_revoke": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'sandbox_revoke' requires user role");
        return;
      }
      // Unconditionally ok: see SandboxRevokeRequest's doc comment — an
      // unknown gid is indistinguishable from one that just expired, and
      // neither is something the caller can act on.
      revokeSandboxGrant(daemon.sandboxGrants, req.gid);
      send(conn, { ok: true });
      return;
    }

    case "transcript_read": {
      const wantsAgent =
        req.agent_id !== undefined || req.run_id !== undefined || req.teammate !== undefined;
      // DR-0025 Phase 1: agent / teammate transcripts are a webui viewer
      // feature (drilldown UI, TL of subagents). A session (AI) does not
      // read its own subagents' transcripts, so refuse the extended shape
      // outside the user role — mirrors the role gate on `agents` /
      // `transcript_subscribe`.
      if (wantsAgent && conn.identity?.role !== "user") {
        sendErr(
          conn,
          ErrorCode.bad_request,
          "transcript_read agent_id/run_id/teammate require user role",
        );
        return;
      }
      const result = await transcriptRead(daemon.sessions, req.sid, req.before, req.max_bytes, {
        allowVirtual: conn.identity?.role === "user",
        agentId: req.agent_id,
        runId: req.run_id,
        teammate: req.teammate,
      });
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    // user role only (webui-only op): the merged `claude agents --json` poll
    // result is not something a session (AI) needs to see.
    case "agents": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'agents' requires user role");
        return;
      }
      send(conn, {
        ok: true,
        agents: daemon.agentsPoller.cache.agents,
        polled_at: daemon.agentsPoller.cache.polledAt,
      });
      return;
    }

    // user role only, same rationale as "agents": which sessions are stopped
    // on an API error is a webui display concern.
    case "session_errors": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_errors' requires user role");
        return;
      }
      // A watch started moments ago may still be folding; the op contract is a
      // settled list, so wait for the scans already under way.
      await sessionErrorsReady(daemon.sessionErrors);
      send(conn, { ok: true, errors: sessionErrorEntries(daemon.sessionErrors) });
      return;
    }

    // user role only, same posture as "agents"/"session_errors": the host's
    // credential quota is an operator's view, and a session-role agent has no
    // use for the standing of credentials it does not choose between.
    case "llm_usage": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'llm_usage' requires user role");
        return;
      }
      const usageUrl = daemon.config.llm_usage_url;
      if (!usageUrl) {
        sendErr(conn, ErrorCode.llm_usage_not_configured, "llm usage endpoint is not configured");
        return;
      }
      // 2-phase for session_search's reason: the upstream fetch can take
      // seconds.
      const complete = acceptTwoPhase(daemon, conn, "llm_usage_result", req.request_id);
      // `refresh` reaches upstream as a real probe and can spend rate limit,
      // so it is passed through only when the client asked for it explicitly
      // (the webui's manual button, never its polling).
      void fetchLlmUsage(usageUrl, req.refresh === true).then(
        (result) => {
          if (!result.ok) complete({ ok: false, error: { code: result.code, msg: result.msg } });
          else complete(result.data);
        },
        (e) => {
          daemon.log.error(`op 'llm_usage' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    // Same role rationale as "llm_usage": what the host's credentials cost is
    // an operator's view, not something a session's agent has a use for.
    case "llm_stats": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'llm_stats' requires user role");
        return;
      }
      const statsUrl = daemon.config.llm_stats_url;
      if (!statsUrl) {
        sendErr(conn, ErrorCode.llm_stats_not_configured, "llm stats endpoint is not configured");
        return;
      }
      // Validated before the ack rather than passed through: an out-of-range
      // window is the client's bug, and answering it as a 2-phase failure
      // would hide that behind an error that looks like the gateway's.
      if (req.days !== undefined && !isValidDays(req.days)) {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `op 'llm_stats' days must be an integer in ${LLM_STATS_DAYS_MIN}..${LLM_STATS_DAYS_MAX}`,
        );
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "llm_stats_result", req.request_id);
      void fetchLlmStats(statsUrl, req.days).then(
        (result) => {
          if (!result.ok) complete({ ok: false, error: { code: result.code, msg: result.msg } });
          else complete(result.data);
        },
        (e) => {
          daemon.log.error(`op 'llm_stats' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    // Same role rationale again: which upstream providers are up is a property
    // of the host's gateway, and a session's agent neither chooses routes nor
    // has anywhere to show this.
    case "llm_status": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'llm_status' requires user role");
        return;
      }
      const statusUrl = daemon.config.llm_status_url;
      if (!statusUrl) {
        sendErr(conn, ErrorCode.llm_status_not_configured, "llm status endpoint is not configured");
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "llm_status_result", req.request_id);
      // `refresh` makes the gateway re-read every configured status page, so
      // it is passed through only for the screen's own button — never for the
      // fetch a connecting client makes, and never for the webhook-driven
      // re-read (the gateway refreshes its sources on that trigger itself).
      void fetchLlmStatus(statusUrl, req.refresh === true).then(
        (result) => {
          if (!result.ok) complete({ ok: false, error: { code: result.code, msg: result.msg } });
          else complete({ ok: true, ...result.data });
        },
        (e) => {
          daemon.log.error(`op 'llm_status' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "translate": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'translate' requires user role");
        return;
      }
      if (!Array.isArray(req.texts) || req.texts.some((text) => typeof text !== "string")) {
        sendErr(conn, ErrorCode.invalid_args, "translate requires a string[] texts");
        return;
      }
      const complete = acceptTwoPhase(daemon, conn, "translate_result", req.request_id);
      // Translation.framework and helper process I/O are async; the outcome
      // (including capability failures like translate_unavailable) travels on
      // the result event rather than a deferred reply.
      void daemon.translator.translate(req.texts).then(
        (result) => {
          if (result.ok) complete({ ok: true, results: result.results });
          else complete({ ok: false, error: { code: result.code, msg: result.msg } });
        },
        (error) => {
          daemon.log.error(`op 'translate' failed: ${String(error)}`);
          complete({
            ok: false,
            error: { code: ErrorCode.translate_helper_failed, msg: String(error) },
          });
        },
      );
      return;
    }

    // user role only, same rationale as "agents": live-tailing a transcript is a
    // webui viewer feature, not something a session needs from the wire protocol.
    case "transcript_subscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'transcript_subscribe' requires user role");
        return;
      }
      const result = transcriptSubscribe(
        daemon.transcriptTail,
        daemon.sessions,
        req.sid,
        conn,
        daemon.log,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "transcript_unsubscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'transcript_unsubscribe' requires user role");
        return;
      }
      const result = transcriptUnsubscribe(daemon.transcriptTail, req.sid, conn);
      send(conn, { ok: true, ...result.data });
      return;
    }

    // The browser half of the transcript trace. The daemon can time everything up
    // to the wire write; ws_receive/store_dispatch/dom_commit only exist in the
    // tab, so the tab posts them back and they land in the same trace.jsonl,
    // correlated by (sid, start, end). User role only, like the tail ops it
    // annotates. Points are timestamped in the browser: a skewed client clock
    // shifts its own three points together, so browser-to-browser deltas stay
    // usable even when they don't line up with the daemon's clock.
    case "client_trace": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'client_trace' requires user role");
        return;
      }
      const points = Array.isArray(req.points) ? req.points.slice(0, CLIENT_TRACE_MAX_POINTS) : [];
      // Every point of a batch is queued in this turn, so they share one flush;
      // awaiting the last of them is awaiting the whole batch reaching disk,
      // which is what makes `written` an honest count rather than an intent.
      let written: Promise<void> | null = null;
      for (const point of points) {
        written = daemon.trace.write({
          ts: typeof point.ts === "string" ? point.ts : undefined,
          comp: "webui",
          edge: point.edge === "out" ? "out" : "in",
          kind: String(point.kind),
          sid: req.sid,
          start: req.start,
          end: req.end,
          size: req.size,
          elapsed_ms: req.elapsed_ms,
          sampled: req.sampled,
        });
      }
      if (written) await written;
      send(conn, { ok: true, sid: req.sid, written: points.length });
      return;
    }

    case "session_status": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_status' requires user role");
        return;
      }
      const result = await getSessionStatus(daemon.sessionStatus, daemon.sessions, req.sid);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, sid: req.sid, ...result.data });
      return;
    }

    case "session_status_subscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_status_subscribe' requires user role");
        return;
      }
      const result = await subscribeSessionStatus(
        daemon.sessionStatus,
        daemon.transcriptTail,
        daemon.sessions,
        req.sid,
        conn,
        daemon.log,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, sid: req.sid, ...result.data });
      return;
    }

    case "session_status_unsubscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_status_unsubscribe' requires user role");
        return;
      }
      unsubscribeSessionStatus(daemon.sessionStatus, daemon.transcriptTail, req.sid, conn);
      send(conn, { ok: true, sid: req.sid });
      return;
    }

    case "leave": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const memberId = resolveFrom(conn, room);
      if (memberId === null || memberId === ADMIN_ID) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      appendLeaveAndBroadcast(daemon, room, memberId);
      send(conn, { ok: true, room: room.id });
      return;
    }

    case "invite": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      // same authorization as set_title: admin User or a resolvable member session.
      if (resolveFrom(conn, room) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const targetSid = typeof req.sid === "string" ? req.sid : "";
      if (targetSid === "") {
        sendErr(conn, ErrorCode.invalid_args, "invite requires sid");
        return;
      }
      // the invite target must be a currently connected session — same live registry
      // create_room's `members` reads from, not an arbitrary historical sid.
      const targetEntry = daemon.sessions.get(targetSid);
      if (!targetEntry) {
        sendErr(conn, ErrorCode.session_not_found, `no connected session: ${targetSid}`);
        return;
      }
      const existingId = memberIdBySid(room).get(targetSid);
      if (existingId !== undefined) {
        send(conn, { ok: true, room: room.id, id: existingId, already: true });
        return;
      }
      const id = nextAgentMemberId(room);
      const ev: MemberEvent = {
        type: "member",
        id,
        sid: targetSid,
        repo: targetEntry.meta.repo,
        ws: targetEntry.meta.ws,
        cwd: targetEntry.meta.cwd,
        joined_at: nowIso(),
      };
      appendEvent(room, ev);
      // invite changes membership outside the create_room([...]) sid set that seeded
      // room.dedupKey, so a same-sid create_room within the dedup window (DR-0003 §4)
      // must no longer fold into this room — same treatment as next_room's `prev` link
      // (storage.ts appendEvent), applied here since a plain "member" event can't be
      // distinguished from an initial create_room member by type alone.
      room.dedupEligible = false;
      // the invited target, if already subscribed, gets a full room snapshot (title,
      // member list, recent history) just like a brand-new create_room/next_room member
      // (deliverNewRoom) — this is genuinely new context to them, not an incremental
      // update. Existing members only need the single MemberEvent line.
      const targetSub = [...daemon.subscribers].find(
        (s) => s.identity?.role === "session" && s.identity.sid === targetSid,
      );
      if (targetSub) sendBacklog(targetSub, room);
      for (const sub of daemon.subscribers) {
        if (sub === targetSub) continue; // already covered by their snapshot above
        if (!subscriberSeesRoom(sub, room)) continue;
        writeDelivered(sub, room, ev);
      }
      send(conn, { ok: true, room: room.id, id, already: false });
      return;
    }

    case "shutdown": {
      send(conn, { ok: true, stopping: true });
      gracefulShutdown(daemon, req.reason);
      return;
    }

    default: {
      sendErr(conn, ErrorCode.unknown_op, `unknown op: ${(req as { op: string }).op}`);
      return;
    }
  }
}

// --- lifecycle -------------------------------------------------------------

function buildDedupIndex(rooms: Map<string, Room>): Map<string, string> {
  const index = new Map<string, string>();
  for (const room of rooms.values()) {
    if (!room.dedupEligible || room.dedupKey === "") continue;
    const cur = index.get(room.dedupKey);
    if (!cur) {
      index.set(room.dedupKey, room.id);
    } else {
      const curRoom = rooms.get(cur)!;
      if (room.createdAt > curRoom.createdAt) index.set(room.dedupKey, room.id);
    }
  }
  return index;
}

function gracefulShutdown(daemon: Daemon, reason?: string): void {
  if (daemon.shuttingDown) return;
  daemon.shuttingDown = true;
  daemon.log.info(`graceful shutdown (${reason ?? ""})`);
  stopAgentsPoller(daemon.agentsPoller);
  daemon.translator.stop();
  stopAllSessionStatus(daemon.sessionStatus, daemon.transcriptTail);
  stopAllSessionErrors(daemon.sessionErrors, daemon.transcriptTail);
  stopAllUserInputs(daemon.sessionUserInputs, daemon.transcriptTail);
  daemon.networkWatch?.stop();
  daemon.llmStatusRefresher?.stop();
  stopAllTailWatches(daemon.transcriptTail);
  try {
    daemon.server?.stop();
  } catch {
    // ignore
  }
  // Notify every connection — UDS and WS alike, `send` doesn't care which — before
  // tearing down the HTTP listeners so the WS side actually gets the frame out.
  const ev = { ev: "restarting", ...(reason ? { reason } : {}) };
  for (const conn of daemon.connections) send(conn, ev);
  for (const listener of daemon.httpListeners) {
    try {
      listener.stop();
    } catch {
      // ignore
    }
  }
  for (const room of daemon.rooms.values()) closeRoom(room);
  try {
    fs.unlinkSync(daemon.paths.sock);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(daemon.paths.pid);
  } catch {
    // ignore
  }
  daemon.lock.release();
  process.exit(0);
}

export interface StartOptions {
  foreground?: boolean;
  /** Non-/ws HTTP requests are delegated here (e.g. webui static/app routes); 404 if absent. */
  fallback?: HttpFallback;
}

/** `CCMSG_HTTP_BIND`: comma-separated `host:port` list, `off` to disable, default DEFAULT_HTTP_BIND (DR-0004 §3). */
function resolveHttpBinds(): string[] {
  const raw = process.env.CCMSG_HTTP_BIND;
  if (raw === "off") return [];
  const spec = raw && raw.trim() !== "" ? raw : DEFAULT_HTTP_BIND;
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** `CCMSG_HTTP_ALLOW`: comma-separated CIDR/IP source allowlist, default
 *  DEFAULT_HTTP_ALLOW (DR-0004 §3 addendum). Empty/whitespace-only falls back to the
 *  default rather than "allow nothing" — an explicit empty allowlist isn't a supported
 *  way to lock the transport down; use CCMSG_HTTP_BIND=off for that. */
function resolveHttpAllowSpec(): string {
  const raw = process.env.CCMSG_HTTP_ALLOW;
  return raw && raw.trim() !== "" ? raw : DEFAULT_HTTP_ALLOW;
}

/** `CCMSG_HTTP_ALLOW_ORIGIN`: comma-separated extra allowed `Origin` values, on top of
 *  the request's own bind address (always implicitly allowed, see http.ts
 *  isAllowedOrigin). For a reverse proxy in front of this daemon (tailscale serve:
 *  `https://<machine>.<tailnet>.ts.net`) whose Origin doesn't match any bind literally
 *  (2026-07-10, DR-0004 trust-model addendum). Unset/empty = no extra origins. */
function resolveHttpAllowOrigin(): Set<string> {
  const raw = process.env.CCMSG_HTTP_ALLOW_ORIGIN;
  if (!raw || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
}

export async function startDaemon(opts: StartOptions = {}): Promise<void> {
  const paths = resolvePaths();
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.roomsDir, { recursive: true });
  const log = new Logger(paths.log, !!opts.foreground);

  const lock = tryAcquireLock(paths.lock);
  if (!lock) {
    log.info("another daemon holds the lock; exiting");
    if (opts.foreground) process.stderr.write("ccmsg: daemon already running\n");
    process.exit(0);
  }

  // stale socket left by a crashed predecessor: the lock holder is authoritative
  try {
    if (fs.existsSync(paths.sock)) fs.unlinkSync(paths.sock);
  } catch {
    // ignore
  }

  const httpAllowSpec = resolveHttpAllowSpec();
  let httpAllowCidrs: Cidr[];
  try {
    httpAllowCidrs = parseAllowList(httpAllowSpec);
  } catch (e) {
    const msg = `invalid CCMSG_HTTP_ALLOW: ${String(e)}`;
    log.error(msg);
    if (opts.foreground) process.stderr.write(`ccmsg: ${msg}\n`);
    lock.release();
    process.exit(1);
  }
  const httpAllow = httpAllowSpec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

  const rooms = scanRooms(paths.roomsDir, log);
  migrateLegacyConfigFiles(paths, log);
  writeConfigTypesFile(paths.configDir, VERSION, log);
  const config = await loadConfig(paths, log);
  const trace = new TraceWriter(paths.trace);
  const daemon: Daemon = {
    paths,
    config,
    version: VERSION,
    startTime: Date.now(),
    rooms,
    dedupIndex: buildDedupIndex(rooms),
    connections: new Set(),
    sessions: new Map(),
    subscribers: new Set(),
    log,
    lock,
    server: null,
    httpListeners: [],
    httpAllow,
    dedupWindowMs: resolveDedupWindow(),
    shuttingDown: false,
    agentsPoller: createAgentsPoller(),
    transcriptTail: createTranscriptTailStore(trace),
    trace,
    sessionStatus: createSessionStatusStore(),
    sessionErrors: createSessionErrorsStore(),
    sessionUserInputs: createSessionUserInputStore(),
    sessionErrorsSnapshot: "",
    networkWatch: null,
    sessionWake: createSessionWakeState(),
    sandboxGrants: createSandboxGrants(),
    sandboxOrigin: compileSandboxOrigin(config.sandbox_origin_template),
    forkOrigins: createForkOriginCache(),
    translator: createTranslateService(),
    peersSnapshot: "",
    staleClients: new Map(),
    lastLive: new Map(),
    llmRequests: new LlmRequestCache(),
    llmStatusRefresher: null,
    webhooks: new Map(),
  };

  daemon.webhooks = buildWebhookSources(daemon, log);
  daemon.llmStatusRefresher = createStatusRefresher(daemon);

  // "前回稼働中": what the previous daemon last saw connected (last-live-
  // sessions.ts). Loaded before anything can connect, so the first webui to
  // ask already has the list. Filling in each entry's model/effort means
  // reading transcripts, so it runs async and best-effort exactly like the
  // tailscale origin lookup below — the list is useful without it, just less
  // pre-filled.
  for (const entry of readLastLiveSessions(paths.lastLiveSessions, log)) {
    daemon.lastLive.set(entry.sid, entry);
  }
  if (daemon.lastLive.size > 0) {
    log.info(`last live sessions: ${daemon.lastLive.size} not recovered yet`);
    void withLaunchContext([...daemon.lastLive.values()]).then((enriched) => {
      for (const entry of enriched) {
        // A sid that registered while we were reading is already recovered;
        // putting it back would resurrect a row the client just dropped.
        if (daemon.lastLive.has(entry.sid)) daemon.lastLive.set(entry.sid, entry);
      }
      maybeBroadcastPeers(daemon);
    });
  }

  // `CCMSG_NETWORK_WATCH=off` turns the wake off — the switch exists for test
  // daemons, which would otherwise each carry a `route -n monitor` child and
  // hold api-error folds open with no user watching.
  if (process.env.CCMSG_NETWORK_WATCH !== "off") {
    const sourceFile = process.env.CCMSG_NETWORK_WATCH_FILE;
    daemon.networkWatch = createNetworkWatch({
      log,
      onOnline: () => wakeStalledSessions(daemon),
      ...(sourceFile ? fileNetworkSource(sourceFile) : {}),
      ...(process.env.CCMSG_NETWORK_WATCH_DEBOUNCE_MS
        ? { debounceMs: Number(process.env.CCMSG_NETWORK_WATCH_DEBOUNCE_MS) }
        : {}),
    });
    // Enabling the watch adds a consumer of the api-error fold, so the watched
    // set has to be recomputed with it in place.
    if (daemon.networkWatch.enabled) syncSessionErrors(daemon);
  }

  interface UdsConnState {
    conn: Conn;
    decoder: TextDecoder;
    buffer: string;
    /** Bytes not yet accepted by the kernel due to backpressure (DR-0008: fs_read
     *  responses can be hundreds of KB, well past the point tiny room/post replies
     *  ever hit). `socket.write()` uses sendto(2) directly and returns a short
     *  count instead of blocking/queueing when the socket buffer is full — unlike
     *  Bun's higher-level `ws.send()` on the HTTP/WS side, nothing retries the
     *  remainder for us. `flushPending` below is that retry, driven by both the
     *  writer and the socket's own `drain` event. */
    pending: Buffer[];
  }

  function flushPending(socket: Bun.Socket<UdsConnState>): void {
    const state = socket.data;
    while (state.pending.length > 0) {
      const chunk = state.pending[0]!;
      let n: number;
      try {
        n = socket.write(chunk);
      } catch {
        // socket closing mid-flush; drop the rest, delivery is best-effort
        state.pending.length = 0;
        return;
      }
      if (n < 0) {
        // socket closed/shutting down (Bun: write() returns -1)
        state.pending.length = 0;
        return;
      }
      if (n === chunk.length) {
        state.pending.shift();
        continue;
      }
      // partial write: keep the unsent remainder at the front of the queue and
      // wait for the next `drain` event rather than busy-retrying here.
      state.pending[0] = chunk.subarray(n);
      break;
    }
    try {
      socket.flush();
    } catch {
      // socket may be closing; delivery is best-effort
    }
  }

  // The pid file must exist by the time the socket accepts: a client that
  // connects and then reads the pid (the upgrade test does exactly this) would
  // otherwise race the write below listen().
  fs.writeFileSync(paths.pid, `${process.pid}\n`);
  const server = Bun.listen<UdsConnState>({
    unix: paths.sock,
    socket: {
      open(socket) {
        const conn: Conn = {
          write(line) {
            const state = socket.data;
            state.pending.push(Buffer.from(line, "utf-8"));
            flushPending(socket);
          },
          identity: null,
          subscribed: false,
        };
        socket.data = { conn, decoder: new TextDecoder(), buffer: "", pending: [] };
        daemon.connections.add(conn);
      },
      drain(socket) {
        flushPending(socket);
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += state.decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = state.buffer.indexOf("\n")) >= 0) {
          const rawLine = state.buffer.slice(0, idx);
          state.buffer = state.buffer.slice(idx + 1);
          if (rawLine.trim() !== "") handleRequest(daemon, state.conn, rawLine);
        }
      },
      close(socket) {
        const state = socket.data;
        if (state) removeConn(daemon, state.conn);
      },
      error(_socket, err) {
        daemon.log.error(`socket error: ${String(err)}`);
      },
    },
  });
  daemon.server = server;

  fs.chmodSync(paths.sock, 0o600);
  log.info(
    `listening on ${paths.sock} (v${VERSION}, ${rooms.size} rooms, dedup ${daemon.dedupWindowMs}ms)`,
  );

  const httpAllowOrigin = resolveHttpAllowOrigin();
  // Persisted extra origins (`ccmsg origins add`, origins-file.ts) — read
  // lazily by the listener on Origin-check misses, so additions apply to the
  // next request with no daemon restart and no env involved.
  const originsFile = createOriginsFile(paths.allowedOrigins, log);
  const httpListeners: HttpListener[] = [];
  for (const bindSpec of resolveHttpBinds()) {
    try {
      const listener = startHttpListener(
        daemon,
        bindSpec,
        httpAllowCidrs,
        httpAllowOrigin,
        opts.fallback,
        originsFile,
      );
      httpListeners.push(listener);
      log.info(`http listening on ${listener.address}`);
    } catch (e) {
      log.error(`failed to bind http ${bindSpec}: ${String(e)}`);
    }
  }
  daemon.httpListeners = httpListeners;

  // Zero-config tailscale serve origin auto-allow (docs/issue/2026-07-11-tailscale-
  // serve-origin-auto-allow.md, DR-0004 trust-model addendum): best-effort, async,
  // never delays or blocks startup. `extraOrigins`/`httpAllowOrigin` is the very Set
  // instance each HTTP listener's closure already holds (see isAllowedOrigin in
  // http.ts) — mutating it after the fact is enough for future requests to see the
  // added origins, no wiring needed back into the listeners themselves.
  if (httpListeners.length > 0) {
    const boundPorts = new Set(
      httpListeners
        .map((l) => Number(l.address.slice(l.address.lastIndexOf(":") + 1)))
        .filter((p) => Number.isInteger(p)),
    );
    const tailscaleBin = process.env.CCMSG_TAILSCALE_BIN;
    void fetchTailscaleServeOrigins(boundPorts, {
      ...(tailscaleBin && tailscaleBin !== "" ? { bin: tailscaleBin } : {}),
      log,
    }).then((origins) => {
      for (const origin of origins) httpAllowOrigin.add(origin);
    });
  }

  process.on("SIGTERM", () => gracefulShutdown(daemon, "signal"));
  process.on("SIGINT", () => gracefulShutdown(daemon, "signal"));
}

function resolveDedupWindow(): number {
  const raw = process.env.CCMSG_DEDUP_WINDOW_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_DEDUP_WINDOW_MS;
}
