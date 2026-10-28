// UDS + HTTP/WS server + wire protocol dispatch + delivery (DR-0003, DR-0004).
import { AsyncLocalStorage } from "node:async_hooks";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as v from "valibot";
import {
  DEFAULT_HTTP_ALLOW,
  DEFAULT_HTTP_BIND,
  ErrorCode,
  LLM_STATS_DAYS_MAX,
  LLM_STATS_DAYS_MIN,
  VERSION,
  PROTOCOL_VERSION,
  DIRECT_DELIVERY_DAEMON_SENDER,
  isOtherGenerationHello,
  isSessionIdShape,
  readRequest,
  resolvePaths,
  type AgentInfo,
  type ClaudeVersion,
  type Identity,
  type LlmStatusReport,
  type PingResponse,
  type Paths,
  type PeerInfo,
  type PermitRequestRecord,
  type HelloRequest,
  type OtherGenerationHelloRequest,
  type RequestOp,
  type ResponseBody,
  type RestartingStreamEvent,
  type ServedRequest,
  type StreamEvent,
  type SessionIdentity,
  type SessionFacts,
  type SessionInputReadiness,
  type StaleClientInfo,
  type JsonValue,
  errorText,
  parseWith,
  migrateLegacyConfigFiles,
} from "@ccmsg/protocol";
import { Logger } from "./log.ts";
import { wireLine } from "./wire-line.ts";
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
import { launchSession } from "./session-launch.ts";
import { pruneLaunchOutputs } from "./launch-output.ts";
import { defaultEfforts } from "./default-effort.ts";
import { createForkOriginCache } from "./fork-origin.ts";
import { productionKillDeps, sessionKill } from "./session-kill.ts";
import { productionRenameDeps, sessionRename, validateRenameTitle } from "./session-rename.ts";
import { productionEnvDeps, sessionEnv } from "./session-env.ts";
import { readSessionLaunchContext, sessionSearch } from "./session-search.ts";
import { launchConfigDir, restartSession } from "./session-restart.ts";
import { dumpSession, writeSessionDumpFile } from "./session-dump.ts";
import { fetchLlmUsage } from "./llm-usage.ts";
import { fetchLlmStats, isValidDays } from "./llm-stats.ts";
import { fetchLlmStatus, LlmStatusRefresher } from "./llm-status.ts";
import { pauseLlmKeepalive } from "./llm-keepalive-pause.ts";
import {
  createSessionErrorsStore,
  sessionErrorEntries,
  sessionErrorFold,
  type SessionErrorsStore,
} from "./session-errors.ts";
import {
  createSessionUserInputStore,
  lastUserInputAt,
  sessionUserInputFold,
  userInputEntries,
  type SessionUserInputStore,
} from "./session-user-input.ts";
import { createNetworkWatch, fileNetworkSource, type NetworkWatch } from "./network-watch.ts";
import { holdTestLifeline, type TestLifeline } from "./test-lifeline.ts";
import { createSerial, type Serial } from "./serial.ts";
import {
  createSessionWakeState,
  forgetWoken,
  recordWoken,
  wakesForOnline,
  type SessionWakeState,
} from "./session-wake.ts";
import {
  createSessionStatusStore,
  getSessionStatus,
  refreshInputReadiness,
  refreshSessionFacts,
  turnOf,
  sessionStatusFold,
  sessionStatusUnsubscribeAll,
  stopAllSessionStatus,
  subscribeSessionStatus,
  unsubscribeSessionStatus,
  type SessionStatusStore,
} from "./session-status.ts";
import { deriveRepoWs } from "./repo-derive.ts";
import { normalizeConfigDir } from "./config-dir.ts";
import { PeerInjector } from "./peer-inject.ts";
import { createMidIssuer } from "./mid-issuer.ts";
import {
  actOnPushedRows,
  createRowEffects,
  keepRowEffectsOf,
  type RowEffects,
} from "./row-effects.ts";
import { createSpeaker, type Speaker, SYSTEM_SAY } from "./say-speech.ts";
import {
  loadSayUnreadStore,
  markSaysRead,
  sayUnreadFold,
  type SayUnreadStore,
  unreadSays,
} from "./say-unread.ts";
import {
  createPermitRequestLog,
  permitRequestFields,
  readPermitAttachment,
  type PermitRequestLog,
} from "./permit-requests.ts";
import { liveRuns, realpathOrUndefined } from "./session-runs.ts";
import {
  listPeers,
  type NoticeDeps,
  type PeerDeps,
  sendNotice,
  sendToPeers,
} from "./send-message.ts";
import { USER_MESSAGE_DEADLINE_MS, userMessage } from "./user-message.ts";
import { abortTurn, productionTurnAbortDeps } from "./turn-abort.ts";
import { inputReadiness, productionInputDeps, userPrompt } from "./user-prompt.ts";
import {
  callSidecar,
  isProcessAlive,
  productionSidecarDeps,
  SidecarReplies,
} from "./sidecar-call.ts";
import { type AgentRow, type SidecarRun, SidecarRuns } from "./sidecar-runs.ts";
import { SessionFactsStore } from "./session-facts.ts";
import {
  namedFields,
  productionRequestOverrideDeps,
  RequestOverrideStates,
  SessionOverrides,
  sendRequestOverride,
} from "./request-override.ts";
import { adoptTranscriptPath, resolveTranscript, transcriptRead } from "./transcript.ts";
import {
  createTranscriptRelayStore,
  relayPushed,
  relayRefold,
  relayRetarget,
  relaySubscribe,
  relayUnsubscribe,
  relayUnsubscribeAll,
  relaysCaughtUp,
  stopAllRelays,
  relayHasRead,
  syncLiveRelays,
  type TranscriptRelayStore,
} from "./transcript-relay.ts";
import {
  agentsKey,
  agentsPollEnabled,
  createAgentsPoller,
  detectConfigDirs,
  servedConfigDirs,
  startAgentsPoller,
  stopAgentsPoller,
  type AgentsPoll,
  type AgentsPoller,
  type AgentsScope,
} from "./agents.ts";
import { isIgnoredGatewayItem, LlmRequestCache, parseLlmRequestEvent } from "./llm-events.ts";
import { type WebhookSource } from "./webhook.ts";
import { releaseDaemonResources } from "./daemon-shutdown.ts";
import { tryAcquireLock, type LockHandle } from "./flock.ts";
import {
  productionClaudeUpdateDeps,
  runClaudeUpdate,
  type ClaudeUpdateDeps,
} from "./claude-update.ts";
import { startHttpListener, webuiUrlsOf, type HttpFallback, type HttpListener } from "./http.ts";
import { listenOpHttp, type OpHttpListener } from "./op-http.ts";
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
import { createRoomReader, readMsgs, type RoomReader, roomSummary } from "./room-reader.ts";

/**
 * A connection abstracted over its transport. UDS and HTTP/WS conns both boil down
 * to "can accept a line of wire protocol"; dispatch/delivery/subscribe never touch
 * the transport directly (DR-0004 §2 seam).
 */
export interface Conn {
  write(line: string): void;
  identity: Identity | null;
  subscribed: boolean;
  /** Log-only label for one socket, unique within this daemon process (`c12`).
   * Present on WS connections, which are the ones the daemon log has to tell
   * apart: several browsers hold one each at a time, and without it a `hello`
   * line and the `ws closed` line that ends the same connection cannot be
   * paired. UDS conns carry no label — the session they hello as names them. */
  id?: string;
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
   * announced one. Deliberately outside `meta`: it exists to find the
   * session's harness state files (peer injection, the config dirs a
   * send_message reads), and `meta` is copied verbatim onto the wire (peers,
   * ev:"peers") where a bare config dir path would be noise nobody reads. */
  configDir?: string;
  /** ccmsg build / wire generation the latest hello for this sid announced
   * (PeerInfo.client_version / .protocol). Outside `meta` for the same reason
   * configDir is. */
  clientVersion?: string;
  clientProtocol?: number;
  /** ISO time this entry was first created in this daemon process; a later
   * hello for the same sid reuses the existing entry and never touches this
   * (DR: webui session-list ordering wants a stable "connected since", not a
   * value that jumps on every reconnect). Only forgetting the sid (see
   * forgetSession) followed by a fresh hello resets it. */
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
  /** The room logs left on disk, read on request (room-reader.ts,
   * DR-0036 §2). */
  rooms: RoomReader;
  connections: Set<Conn>;
  sessions: Map<string, SessionEntry>;
  subscribers: Set<Conn>;
  log: Logger;
  lock: LockHandle;
  server: Listener | null;
  httpListeners: HttpListener[];
  /** The hooks module's `POST /op` on `paths.httpSock` (op-http.ts, DR-0046). */
  opHttp: OpHttpListener | null;
  /** The origins the webui is opened at from elsewhere, the first being the
   * one links use (http.ts webuiUrlsOf), read when asked; empty while no HTTP
   * listener serves it. */
  webuiUrls: () => Promise<string[]>;
  /** raw CCMSG_HTTP_ALLOW entries currently in effect, for status/ping display. */
  httpAllow: string[];
  shuttingDown: boolean;
  /** DaemonHost.env. */
  env: Readonly<Record<string, string | undefined>>;
  /** The launch commands running now (DR-0018 §3.5): `launch_max_concurrency` bounds
   * them, and a shutdown waits for them, each ending by its own deadline. */
  launches: Set<Promise<unknown>>;
  /** The agents rows, read from Claude Code's state files (agents.ts). */
  agentsPoller: AgentsPoller;
  /** Sessions the agents poll has listed, keyed by sid, valued by the config
   * dir whose poll listed them (syncSessionsFromAgents): these are forgotten
   * once they vanish from that dir's answer. A session only a hello
   * registered is forgotten once a round begun after the hello does not list
   * it (forgetUnlistedHellos). */
  agentsSeen: Map<string, string>;
  /** The daemon's reading of each session's jsonl on its module's pushes,
   * for the Timelines the webui follows and the daemon's own folds
   * (transcript-relay.ts, DR-0045 §2 – §5). */
  transcriptRelay: TranscriptRelayStore;
  /** component-boundary timestamps for transcript latency diagnosis, from the
   * daemon's own file check through the browser points posted via
   * `client_trace`. See docs/runbooks/transcript-latency-trace.md. */
  trace: TraceWriter;
  /** folded transcript status subscriptions per sid (DR-0020 Phase 1). */
  sessionStatus: SessionStatusStore;
  /** api_error fold across every live session, for the sidebar's error
   * section. */
  sessionErrors: SessionErrorsStore;
  sessionUserInputs: SessionUserInputStore;
  /** sessionErrorEntries() as of the last `ev:"session_errors"` broadcast —
   * same "don't push an unchanged list" guard as peersSnapshot. */
  sessionErrorsSnapshot: string;
  /** Host network online/offline transitions, the trigger for waking sessions
   * stalled on an API error. Null where no monitor could be started. */
  networkWatch: NetworkWatch | null;
  /** The test run this daemon lives no longer than (test-lifeline.ts). Null
   * outside tests. */
  testLifeline: TestLifeline | null;
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
  /** agentsKey() of the rows the last `ev:"agents"` push carried, with what
   * the modules say of them (agentsWithModule) — lets maybeBroadcastAgents
   * skip a push when neither the rows nor a terminal or turn changed. Starts
   * as the key of no rows, as the poller's cache does. */
  agentsSnapshot: string;
  /** Out-of-date ccmsg clients seen per sid (PeerInfo.stale_client), including
   * the ones whose hello was refused — those never reach `sessions`, so this
   * is the only record that they tried. Keyed by the sid the refused hello
   * claimed; a hello speaking the current generation deletes its own entry. */
  staleClients: Map<string, StaleClientInfo>;
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
  /** Direct messages handed to a session through its peer messaging socket
   * (peer-inject.ts). */
  peerInjector: PeerInjector;
  /** The line send_message requests stand in until their deliveries are
   * asked for (send-message.ts sendToPeers). */
  sendOrder: Serial;
  /** Issues the mid of each message this daemon sends into a peer socket
   * (mid-issuer.ts). */
  issueDirectMid: () => string;
  /** The daemon's voice: the says and the requests for permission are
   * spoken one after another (say-speech.ts, DR-0045 §6). */
  speaker: Speaker;
  /** The tool calls acted on, from the rows the modules push (row-effects.ts,
   * DR-0045 §6). */
  rowEffects: RowEffects;
  /** The says of the live sessions and which the person has read
   * (say-unread.ts, DR-0045 §7). */
  sayUnread: SayUnreadStore;
  /** The last ev:"say_unread" sent, as its JSON: a push only when the set
   * moved. */
  sayUnreadSnapshot: string;
  /** Requests for the person's permission, memory only (permit-requests.ts,
   * DR-0040). */
  permitRequests: PermitRequestLog;
  /** Requests to a session's hooks module waiting for its sidecar_reply
   * (sidecar-call.ts, DR-0035 §3). */
  sidecarReplies: SidecarReplies;
  /** The live runs of each session, as their sidecars named them on
   * connections still open (sidecar-runs.ts, sidecar_hello): where
   * user_prompt writes, and what input readiness is judged from. */
  sidecarRuns: SidecarRuns;
  /** What each session's hooks module last said of its session
   * (session-facts.ts, session_facts). */
  sessionFacts: SessionFactsStore;
  /** The session override a person set for each session, memory only
   * (request-override.ts, request_override, DR-0041 §3). */
  sessionOverrides: SessionOverrides;
  /** What each session's hooks module last said its overrides put on the
   * main thread's requests (request-override.ts, DR-0041 §5). */
  requestOverrides: RequestOverrideStates;
  /** When the agents poll last finished a round: the next round began after
   * this, which is what lets it say a run named before it has no process. */
  agentsRoundAt: number;
  /** This host's Claude Code version as the last claude_update read it, and
   * when (DR-0043 §6, §8). Memory only: a restarted daemon has none, and the
   * webui falls back to the version of the session started last. */
  claudeVersion: ClaudeVersion | null;
  /** The claude_update running now, if any: a second one is refused rather
   * than started beside it. */
  claudeUpdateRunning: boolean;
  /** Where claude_update finds and runs `claude` (claude-update.ts). */
  claudeUpdateDeps: ClaudeUpdateDeps;
  /** Ends the host once a graceful shutdown (the `shutdown` op, a signal) has
   * released everything: the daemon process exits. */
  exit: () => void;
}

/** What the host of a daemon hands it: where it keeps its files, the
 * configuration read at startup, and the resources the host holds for it. */
export interface DaemonHost {
  paths: Paths;
  config: ResolvedCcmsgConfig;
  log: Logger;
  lock: LockHandle;
  /** raw CCMSG_HTTP_ALLOW entries in effect, for status/ping display. */
  httpAllow: string[];
  /** The daemon's environment: what a launch command inherits (cleaned), and
   * the CLAUDE_CONFIG_DIR whose settings give the form's default efforts. */
  env: Readonly<Record<string, string | undefined>>;
  exit: () => void;
}

/** A daemon's state before anything listens, polls or watches: what
 * startDaemon starts its transports and background work on. */
export function createDaemon(host: DaemonHost): Daemon {
  const { paths, config, log } = host;
  const trace = new TraceWriter(paths.trace);
  const daemon: Daemon = {
    paths,
    config,
    version: VERSION,
    startTime: Date.now(),
    rooms: createRoomReader(paths.roomsDir, (line) => log.warn(line)),
    connections: new Set(),
    sessions: new Map(),
    subscribers: new Set(),
    log,
    lock: host.lock,
    server: null,
    httpListeners: [],
    opHttp: null,
    webuiUrls: async () => [],
    httpAllow: host.httpAllow,
    shuttingDown: false,
    env: host.env,
    launches: new Set(),
    agentsPoller: createAgentsPoller(),
    agentsSeen: new Map(),
    transcriptRelay: createTranscriptRelayStore(log, {
      trace,
      folds: [
        (sid) => sessionStatusFold(daemon.sessionStatus, daemon.sessions, sid, log),
        (sid) => sessionErrorFold(daemon.sessionErrors, sid, () => broadcastSessionErrors(daemon)),
        (sid) =>
          sessionUserInputFold(daemon.sessionUserInputs, sid, () => maybeBroadcastPeers(daemon)),
        (sid) => sayUnreadFold(daemon.sayUnread, sid, () => broadcastSayUnread(daemon)),
      ],
    }),
    trace,
    sessionStatus: createSessionStatusStore({
      inputReadiness: (sid) => readinessOf(daemon, sid),
      facts: (sid) => daemon.sessionFacts.get(sid),
    }),
    sessionErrors: createSessionErrorsStore(),
    sessionUserInputs: createSessionUserInputStore(),
    sessionErrorsSnapshot: "",
    networkWatch: null,
    testLifeline: null,
    sessionWake: createSessionWakeState(),
    sandboxGrants: createSandboxGrants(),
    sandboxOrigin: compileSandboxOrigin(config.sandbox_origin_template),
    forkOrigins: createForkOriginCache(),
    translator: createTranslateService(),
    peersSnapshot: "",
    agentsSnapshot: agentsKey([]),
    staleClients: new Map(),
    llmRequests: new LlmRequestCache(),
    llmStatusRefresher: null,
    webhooks: new Map(),
    peerInjector: new PeerInjector(),
    sendOrder: createSerial(),
    issueDirectMid: createMidIssuer(),
    speaker: createSpeaker({
      bin: host.env.CCMSG_SAY_BIN || SYSTEM_SAY,
      dictionaryFile: paths.sayDictionary,
      log,
    }),
    rowEffects: createRowEffects(),
    sayUnread: loadSayUnreadStore(paths.sayRead, log, () => new Date()),
    sayUnreadSnapshot: "",
    permitRequests: createPermitRequestLog(createMidIssuer()),
    sidecarReplies: new SidecarReplies(),
    sessionFacts: new SessionFactsStore(),
    sessionOverrides: new SessionOverrides(),
    requestOverrides: new RequestOverrideStates(),
    sidecarRuns: new SidecarRuns({
      sidecarDir: paths.sidecars,
      isAlive: isProcessAlive,
      now: Date.now,
    }),
    agentsRoundAt: Date.now(),
    claudeVersion: null,
    claudeUpdateRunning: false,
    claudeUpdateDeps: productionClaudeUpdateDeps(host.env),
    exit: host.exit,
  };
  return daemon;
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

/** Whether a frame answers a request: a reply carries `ok`, and no push
 * does. */
function isReply(frame: ResponseBody | StreamEvent): frame is ResponseBody {
  return "ok" in frame;
}

/** Write one reply or push to `conn`. */
export function send(conn: Conn, frame: ResponseBody | StreamEvent): void {
  // Stamp the correlation id on the way out, so no dispatch case has to
  // remember to. Only the reply going back to the connection that asked gets
  // one: a broadcast reaching other connections while this request runs is
  // nobody's answer.
  const active = activeRequest.getStore();
  const line =
    active && active.conn === conn && isReply(frame)
      ? wireLine({ ...frame, request_id: active.requestId })
      : wireLine(frame);
  try {
    conn.write(line);
  } catch {
    // transport may be closing; delivery is best-effort
  }
}

function sendErr(conn: Conn, code: string, msg: string): void {
  send(conn, { ok: false, error: { code, msg } });
}

// --- identity / registry ---------------------------------------------------

/** What the hello announced about the ccmsg build behind it. Passed alongside
 * the identity rather than folded into it: it describes the *client process*,
 * not the session, and two connections of one session can legitimately run
 * different builds (a subscribe started before an upgrade, plus a fresh hook
 * invocation after it) — the latest hello is simply what the peer reports. */
interface ClientBuild {
  version?: string;
  protocol?: number;
}

function registerSession(daemon: Daemon, id: SessionIdentity, client: ClientBuild): void {
  let entry = daemon.sessions.get(id.sid);
  // latest hello wins for repo/ws/cwd metadata. transcript_path is the one
  // exception (DR-0009 addendum): unlike repo/ws/cwd, it is adoptTranscriptPath's
  // disk lookup (or the CCMSG_TRANSCRIPT_PATH override) — and most hellos
  // omit it (every CLI run but one given the override). A hello that omits
  // transcript_path preserves whatever was already adopted instead of
  // clearing it — otherwise every such hello would silently kill the webui's
  // Timeline view for a session that never stopped having a transcript.
  //
  // repo_root (DR-0008 addendum) and branch ride the same per-hello payload as
  // repo/ws/cwd (the session state file `sidecar begin` writes, read fresh by the CLI's
  // resolveIdentity), so all five move as one: a hello either states where the
  // session is or says nothing about it.
  //
  // Stating nothing is what a caller that cannot know does (DR-0003 §3
  // 「所在の正本」) — the location comes from fixed sources, and a `post` run
  // from a Bash tool that `cd`'d elsewhere has none of them — so an empty cwd
  // preserves the whole registered location rather than replacing it with
  // blanks. A hello that does state a location replaces all five at once, with
  // no preserve-on-omit within the group: a session that moved to a plain
  // checkout with no workspace layer must lose its repo_root, or fs-access
  // keeps scoping it to a stale, wider containment root.
  const transcriptPath = id.transcript_path ?? entry?.meta.transcript_path;
  const location =
    id.cwd !== ""
      ? {
          repo: id.repo,
          ws: id.ws,
          cwd: id.cwd,
          ...(id.repo_root ? { repo_root: id.repo_root } : {}),
          ...(id.branch ? { branch: id.branch } : {}),
        }
      : {
          repo: entry?.meta.repo ?? "",
          ws: entry?.meta.ws ?? "",
          cwd: entry?.meta.cwd ?? "",
          ...(entry?.meta.repo_root ? { repo_root: entry.meta.repo_root } : {}),
          ...(entry?.meta.branch ? { branch: entry.meta.branch } : {}),
        };
  const meta = {
    sid: id.sid,
    ...location,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
  };
  // A process's CLAUDE_CONFIG_DIR cannot change while it runs, so a hello that
  // omits it is telling us nothing new — an older CLI, or one invoked from a
  // subprocess whose environment lost the variable. Preserve what an earlier
  // hello for this sid established (transcript_path's rule, for the same
  // reason: silently dropping it would make the session unreachable by peer
  // injection mid-session).
  const configDir = id.config_dir ?? entry?.configDir;
  const isNewEntry = !entry;
  const previousLocation = { cwd: entry?.meta.cwd, repo_root: entry?.meta.repo_root };
  const previousTranscriptPath = entry?.meta.transcript_path;
  if (
    previousTranscriptPath !== undefined &&
    transcriptPath !== undefined &&
    previousTranscriptPath !== transcriptPath
  ) {
    daemon.log.info(
      `session hello: transcript_path changed sid=${id.sid} from=${previousTranscriptPath} to=${transcriptPath}`,
    );
    relayRetarget(daemon.transcriptRelay, id.sid, transcriptPath);
  }
  if (!entry) {
    entry = { meta, ...(configDir ? { configDir } : {}), connectedAt: nowIso() };
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
  if (
    !isNewEntry &&
    (location.cwd !== previousLocation.cwd || location.repo_root !== previousLocation.repo_root)
  ) {
    // What the Status fold classifies external files against moved.
    relayRefold(daemon.transcriptRelay, id.sid);
  }
  if (isNewEntry) refreshInputReadiness(daemon.sessionStatus, daemon.sessions, daemon.log);
  // Push ev:"peers" on: new sid registration (entry was just created above) or a
  // hello that actually changed repo/ws/branch/transcript_path/repo_root (entry.meta
  // reassigned above). maybeBroadcastPeers itself no-ops a same-content re-hello via
  // its JSON snapshot compare (issue 2026-07-12-peers-live-update-protocol) — this
  // call site doesn't need to distinguish "new" from "updated" from "unchanged".
  maybeBroadcastPeers(daemon);
}

/** Drop `sid` from the registry once its session is known to have ended.
 *
 * Design rationale: a session's connections say nothing about whether it is
 * alive — a Claude Code session talks to the daemon only for the moment a
 * `ccmsg` command runs, so an entry outlives every connection of its session.
 * The end signals are the harness's register no longer listing the session
 * (syncSessionsFromAgents), or not listing a session only a hello registered
 * (forgetUnlistedHellos), and `session_kill` terminating the process.
 * Callers push ev:"peers" themselves. */
function forgetSession(daemon: Daemon, sid: string): void {
  if (!daemon.sessions.delete(sid)) return;
  daemon.sessionFacts.forget(sid);
  daemon.requestOverrides.forget(sid);
  refreshReadiness(daemon);
}

/** How long the daemon waits for a module to answer `session.facts`: the
 * write, then the module's reply over `POST /op` (a few ms, DR-0046). */
const SESSION_FACTS_ASK_MS = 5_000;

/** Hold `facts` as `sid`'s unless they are older than the ones held, and push
 * the session's status for them. */
function takeSessionFacts(daemon: Daemon, sid: string, facts: SessionFacts): void {
  if (!daemon.sessionFacts.take(sid, facts)) return;
  takeRequestOverrides(daemon, sid, facts);
  refreshSessionFacts(daemon.sessionStatus, daemon.sessions, sid, daemon.log);
  const { agents, polledAt } = daemon.agentsPoller.cache;
  maybeBroadcastAgents(daemon, agents, polledAt);
}

/** Ask the module behind `run` for its facts (`session.facts`). A module
 * without the op (an older plugin) logs the request and answers nothing,
 * which leaves the session as it was. */
async function askSessionFacts(daemon: Daemon, run: SidecarRun): Promise<void> {
  const call = await callSidecar(
    run.socket,
    run.sid,
    "session.facts",
    {},
    SESSION_FACTS_ASK_MS,
    productionSidecarDeps(daemon.sidecarReplies),
  );
  if (call.write === "not_written" || call.reply === undefined) return;
  if (!call.reply.ok) {
    daemon.log.warn(
      `session.facts from ${run.sid}.${run.runId} not read: ${call.reply.failure.summary}`,
    );
    return;
  }
  if (call.reply.value.ok) takeSessionFacts(daemon, run.sid, call.reply.value.result);
}

/** Hand the session override held for `run`'s session to the run's module
 * (DR-0041 §3): a module started again, or one the daemon did not know of,
 * has none of it. A session without one sends nothing, and a module that
 * does not know the op answers nothing, which leaves the run as it was. */
async function resendSessionOverride(daemon: Daemon, run: SidecarRun): Promise<void> {
  if (!daemon.sessionOverrides.has(run.sid)) return;
  const sent = await sendRequestOverride(
    run.sid,
    daemon.sessionOverrides.get(run.sid),
    [run],
    productionRequestOverrideDeps(productionSidecarDeps(daemon.sidecarReplies)),
  );
  daemon.log.info(
    `request-override -> ${run.sid}.${run.runId} (named): ${sent.delivery}` +
      ` tries=[${sent.tries.map((t) => `${t.id} ${t.result}`).join(", ")}]`,
  );
}

/** Push the overrides of every session to one connection
 * (ev:"request_overrides"), a fresh subscriber's catch-up. */
function sendRequestOverrides(daemon: Daemon, conn: Conn): void {
  send(conn, { ev: "request_overrides", sessions: daemon.requestOverrides.snapshot() });
}

/** Take what `sid`'s module says its overrides put on the requests, and push
 * each override whose values changed to every user-role subscriber
 * (ev:"request_override"). Never to a session. */
function takeRequestOverrides(daemon: Daemon, sid: string, facts: SessionFacts): void {
  if (facts.request_override === undefined) return;
  for (const change of daemon.requestOverrides.take(sid, facts.request_override)) {
    for (const sub of daemon.subscribers) {
      if (sub.identity?.role !== "user") continue;
      send(sub, {
        ev: "request_override",
        session_id: change.sid,
        target: change.target,
        model: change.model,
        effort: change.effort,
      });
    }
  }
}

/** The sessions whose hooks module has a run named: those the daemon reads
 * the lines of (DR-0045 §3). */
function liveSids(daemon: Daemon): string[] {
  return [...daemon.sessions.keys()].filter((sid) => daemon.sidecarRuns.liveOf(sid).length > 0);
}

/** Push whether a person's input can reach each session, where it moved:
 * the peer rows and the session statuses being followed, and the terminals
 * the agents rows carry, which come from the same runs. Called when a run is
 * named or goes, and when a session is registered or forgotten. The same
 * moments make a session live or not (DR-0045 §3). */
function refreshReadiness(daemon: Daemon): void {
  const live = liveSids(daemon);
  syncLiveRelays(daemon.transcriptRelay, daemon.sessions, live);
  keepRowEffectsOf(daemon.rowEffects, live);
  maybeBroadcastPeers(daemon);
  refreshInputReadiness(daemon.sessionStatus, daemon.sessions, daemon.log);
  const { agents, polledAt } = daemon.agentsPoller.cache;
  maybeBroadcastAgents(daemon, agents, polledAt);
}

/** The agents poll's rows with what the session's hooks module says of them
 * (DR-0035 §3):
 * - the terminal (`hyoui_session_id`) the live run tied to the row's process
 *   named (sidecar_hello). The terminal is what the module names, read the
 *   same way the module reads it to press Enter, so a row whose process no
 *   run is tied to carries none: its session has no module (input_readiness
 *   `no_module`), or its module has not named the run yet.
 * - whether the session answers a turn (`turn`, session_facts). A session no
 *   module has said anything of carries none, and the sidebar says so rather
 *   than reading it off another source. */
function agentsWithModule(daemon: Daemon, agents: readonly AgentInfo[]): AgentInfo[] {
  return agents.map((agent) => {
    const terminal = daemon.sidecarRuns
      .liveOf(agent.sessionId)
      .find((run) => run.pid === agent.pid && run.hyouiSessionId !== undefined)?.hyouiSessionId;
    const turn = turnOf(daemon.sessionFacts.get(agent.sessionId));
    return {
      ...agent,
      ...(terminal !== undefined ? { hyoui_session_id: terminal } : {}),
      ...(turn !== undefined ? { turn } : {}),
    };
  });
}

/** Push the agents rows (agentsWithModule) to every user subscriber when
 * they differ from the last push: the poll's rows changed, a run was named,
 * tied to a process, or went, or a module said its session started or ended
 * a turn. Nothing before the first poll, as the
 * subscribe catch-up sends nothing then. */
function maybeBroadcastAgents(
  daemon: Daemon,
  agents: readonly AgentInfo[],
  polledAt: string | null,
): void {
  if (polledAt === null) return;
  const rows = agentsWithModule(daemon, agents);
  const key = agentsKey(rows);
  if (key === daemon.agentsSnapshot) return;
  daemon.agentsSnapshot = key;
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user")
      send(sub, { ev: "agents", agents: rows, polled_at: polledAt });
  }
}

/** `sid`'s input readiness (user-prompt.ts inputReadiness), judged from the
 * runs its sidecars named. */
function readinessOf(daemon: Daemon, sid: string): SessionInputReadiness {
  return inputReadiness(sid, {
    runs: daemon.sidecarRuns,
    isRunning: (running) => daemon.sessions.has(running),
  });
}

/** The agents poll's rows, as a run is tied to its process by them. */
function agentRows(agents: readonly AgentInfo[]): AgentRow[] {
  return agents.map((agent) => ({
    sessionId: agent.sessionId,
    pid: agent.pid,
    startedAt: agent.startedAt,
    configDir: normalizeConfigDir(agent.config_dir) ?? agent.config_dir,
  }));
}

/** Bring the session registry in line with the harness's register of live
 * sessions (DR-0034 「セッションの登録は harness の登録簿から導出する」).
 *
 * A listed sid the daemon does not know is registered from the row alone —
 * cwd canonicalized and repo/ws derived exactly as a hello that announced only
 * a cwd would be. A sid already registered keeps what its hello established:
 * a hello speaks for the session itself and knows more (branch, repo_root,
 * the announced transcript) than a row does.
 *
 * A sid that was listed and is no longer listed by a config dir that answered
 * this round has ended, and is forgotten. A dir that failed to answer says
 * nothing, so its sessions are left alone. */
async function syncSessionsFromAgents(daemon: Daemon, poll: AgentsPoll): Promise<void> {
  const answered = new Set(poll.answeredDirs);
  const listed = new Map<string, AgentInfo>();
  for (const agent of poll.agents) {
    if (!agent.sessionId) continue;
    listed.set(agent.sessionId, agent);
  }
  let changed = false;
  for (const [sid, configDir] of daemon.agentsSeen) {
    if (listed.has(sid) || !answered.has(configDir)) continue;
    daemon.agentsSeen.delete(sid);
    if (daemon.sessions.has(sid)) {
      forgetSession(daemon, sid);
      changed = true;
    }
  }
  for (const [sid, agent] of listed) {
    daemon.agentsSeen.set(sid, agent.config_dir);
    if (daemon.sessions.has(sid)) continue;
    const cwd = agent.cwd ? await realpathOrSelf(agent.cwd) : "";
    const derived = cwd !== "" ? await deriveRepoWs(cwd) : { repo: "", ws: "" };
    const transcriptPath = await adoptTranscriptPath(sid, undefined, [agent.config_dir]);
    const configDir = normalizeConfigDir(agent.config_dir);
    // A hello may have registered this sid while the lookups above yielded.
    if (daemon.sessions.has(sid) || !daemon.agentsSeen.has(sid)) continue;
    registerSession(
      daemon,
      {
        role: "session",
        sid,
        repo: derived.repo,
        ws: derived.ws,
        cwd,
        ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
        ...(configDir ? { config_dir: configDir } : {}),
      },
      {},
    );
  }
  if (changed) maybeBroadcastPeers(daemon);
}

/** Forget the sessions only a hello registered that one round of the agents
 * poll — begun at `begunAt` or later, answered by `answeredDirs` — should
 * have listed and did not (DR-0034 §5). A sid the poll has listed is forgotten by syncSessionsFromAgents once
 * it vanishes; one it never listed has only the poll's silence to go by.
 *
 * The round has to have begun after the hello: a session that started just
 * before saying hello may not be in a round already under way. And the
 * session's config dir has to have answered — any dir, for a hello that named
 * none: a dir that failed to answer says nothing. A sid forgotten here comes
 * back with its next hello. */
export function forgetUnlistedHellos(
  daemon: Daemon,
  answeredDirs: readonly string[],
  begunAt: number,
): void {
  const answered = new Set(answeredDirs);
  for (const [sid, entry] of daemon.sessions) {
    if (daemon.agentsSeen.has(sid) || Date.parse(entry.connectedAt) >= begunAt) continue;
    const dirAnswered =
      entry.configDir === undefined ? answered.size > 0 : answered.has(entry.configDir);
    if (dirAnswered) forgetSession(daemon, sid);
  }
}

/** Give a registry-derived session its transcript once the harness writes
 * one (DR-0034 §5). A session registered before anything was typed into it
 * has no `<sid>.jsonl` yet, and its agents row need not change when the first
 * prompt creates it, so this runs on every round rather than only when the
 * rows change. */
async function resolvePendingTranscripts(daemon: Daemon, poll: AgentsPoll): Promise<void> {
  let changed = false;
  for (const agent of poll.agents) {
    const entry = daemon.sessions.get(agent.sessionId);
    if (!entry || entry.meta.transcript_path) continue;
    const found = await adoptTranscriptPath(agent.sessionId, undefined, [agent.config_dir]);
    const current = daemon.sessions.get(agent.sessionId);
    if (found && current && !current.meta.transcript_path) {
      current.meta.transcript_path = found;
      changed = true;
    }
  }
  if (changed) maybeBroadcastPeers(daemon);
}

export function removeConn(daemon: Daemon, conn: Conn): void {
  daemon.connections.delete(conn);
  daemon.subscribers.delete(conn);
  // A sidecar's connection closing is its run going.
  if (daemon.sidecarRuns.leave(conn)) refreshReadiness(daemon);
  sessionStatusUnsubscribeAll(daemon.sessionStatus, conn);
  relayUnsubscribeAll(daemon.transcriptRelay, conn);
}

/** File the "this sid has an out-of-date ccmsg client" record the session list
 * renders. Called where a session's hello is refused for speaking a
 * generation this daemon does not speak (refuseGeneration).
 *
 * A client that simply predates the `protocol` field is NOT stale — it speaks
 * `UNANNOUNCED_PROTOCOL_VERSION`, gets served, and never reaches here. Every
 * subscribe running right now is such a client, so flagging them would ask
 * kawaz to restart every session on the machine over nothing.
 *
 * The record is overwritten rather than accumulated — a refused subscribe
 * retries every few seconds, and "still trying as of `last_seen`" is the whole
 * signal; a counter would only turn one stale process into a number that keeps
 * moving. Pushing `ev:"peers"` is the caller's job: the caller refuses the
 * hello, so it never reaches the registerSession that normally pushes. */
function markStaleClient(daemon: Daemon, sid: string, client: ClientBuild): void {
  // An id that is not a session id's shape names no session to warn about.
  if (!isSessionIdShape(sid)) return;
  daemon.staleClients.set(sid, {
    last_seen: nowIso(),
    ...(client.version ? { version: client.version } : {}),
    ...(client.protocol !== undefined ? { protocol: client.protocol } : {}),
  });
}

/** A hello's diagnostic string as it may appear in the log, or undefined when
 * it says nothing usable. These fields arrive verbatim from a browser, so they
 * are held to the shape the webui sends (a short word or two joined by `/`)
 * rather than trusted: anything else would let a caller write its own lines
 * into daemon.log. */
function logToken(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.slice(0, 40);
  return /^[A-Za-z0-9._/-]+$/.test(trimmed) ? trimmed : undefined;
}

/** A hello made of what a hello of another generation says about its client
 * (OtherGenerationHelloRequest), so the transport reads it as it reads a hello
 * it serves (the WebSocket pins it to the user role, dropping its sid). A
 * hello that names no role is taken at its sid alone. */
function claimedHello(claims: OtherGenerationHelloRequest): HelloRequest {
  return {
    op: "hello",
    role: claims.role ?? "session",
    ...(claims.sid !== undefined ? { sid: claims.sid } : {}),
    ...(claims.client_version !== undefined ? { client_version: claims.client_version } : {}),
  };
}

/** Refuse a hello of another generation. A client speaking another
 * generation is refused, not adapted to: ccmsg evolves per host, all at once
 * (DR-0002 §4). Announcing no generation is not a way out of this check — it
 * means generation UNANNOUNCED_PROTOCOL_VERSION and is compared like any
 * other value. The rest of the hello is not read: its shape is its
 * generation's, and the answer it needs is which generation to run. A
 * session's hello files the stale client against its sid. */
function refuseGeneration(
  daemon: Daemon,
  conn: Conn,
  hello: HelloRequest,
  generation: number,
): void {
  if (hello.role === "session" && hello.sid) {
    markStaleClient(daemon, hello.sid, { ...readClientBuild(hello), protocol: generation });
    maybeBroadcastPeers(daemon);
  }
  sendErr(
    conn,
    ErrorCode.bad_request,
    `client speaks protocol ${generation}, this daemon speaks ${PROTOCOL_VERSION}`,
  );
}

/** What a hello claims about its own build. An empty version names none. */
function readClientBuild(hello: HelloRequest): ClientBuild {
  return {
    ...(hello.client_version ? { version: hello.client_version } : {}),
    ...(hello.protocol !== undefined ? { protocol: hello.protocol } : {}),
  };
}

/** `last_user_input_at` for one sid, as a spreadable fragment so an unknown
 * value omits the field rather than sending null (PeerInfo's contract: absent
 * means "the daemon has not folded one", which clients sort last). */
function withUserInput(daemon: Daemon, sid: string): { last_user_input_at?: string } {
  const at = lastUserInputAt(daemon.sessionUserInputs, sid);
  return at ? { last_user_input_at: at } : {};
}

/** Compute the peers list exactly as the `peers` op returns it (every session
 * the daemon knows, see forgetSession) — shared by that op and the ev:"peers"
 * push below so the two never drift apart. */
function currentPeers(daemon: Daemon): PeerInfo[] {
  return [...daemon.sessions.values()].map((s) => ({
    ...s.meta,
    connected_at: s.connectedAt,
    ...(s.lastActivityAt ? { last_activity_at: s.lastActivityAt } : {}),
    ...withUserInput(daemon, s.meta.sid),
    ...clientBuildFields(daemon, s),
    ...withReadiness(daemon, s.meta.sid),
  }));
}

/** `input_readiness` for one sid. */
function withReadiness(daemon: Daemon, sid: string): Pick<PeerInfo, "input_readiness"> {
  return { input_readiness: readinessOf(daemon, sid) };
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

/** Where send_message and peer_list read the sessions they match from: the
 * live runs of the sessions the daemon reaches, read afresh. */
function peerDeps(daemon: Daemon): PeerDeps {
  return {
    runs: async () => {
      const scope = sessionScope(daemon);
      const runs = await liveRuns(scope.dirs, isProcessAlive);
      return runs.filter((run) => scope.has(run.configDir, run.sid));
    },
    realpath: realpathOrUndefined,
    hasModule: (sid) => daemon.sidecarRuns.liveOf(sid).length > 0,
  };
}

/** How a send's message or a notice reaches a session's conversation: the
 * session's runs as peerDeps reads them, and each run's peer socket in turn
 * behind what was sent to it before (DR-0034 §2). */
function noticeDeps(daemon: Daemon): NoticeDeps {
  return {
    ...peerDeps(daemon),
    readiness: (sid) => readinessOf(daemon, sid),
    issueMid: daemon.issueDirectMid,
    deliver: (run, frame) => daemon.peerInjector.deliver(run.configDir, run.sid, frame, run.pid),
    inOrder: daemon.sendOrder,
    log: (line) => daemon.log.info(line),
  };
}

/** The config dirs this daemon serves (servedConfigDirs), each as a realpath
 * as the registry keeps them. */
function servedDirs(daemon: Daemon): string[] {
  return servedConfigDirs(daemon.paths.stateDir).flatMap((dir) => {
    const normalized = normalizeConfigDir(dir);
    return normalized !== undefined ? [normalized] : [];
  });
}

/** The sessions this daemon reaches (DR-0034 §2): every session of each
 * config dir it serves, and each session that announced its config dir to it
 * (hello) in that dir, alone. A session announcing a dir the daemon does not
 * serve says it is one of this daemon's; the sessions beside it said nothing
 * of the kind, so a daemon started for a test reaches the test's session and
 * not the ones someone is working in. Each dir as a realpath, as the registry
 * keeps them, so one dir is read once. */
export function sessionScope(daemon: Daemon): AgentsScope {
  const every = new Set(servedDirs(daemon));
  const alone = new Map<string, Set<string>>();
  for (const { configDir, meta } of daemon.sessions.values()) {
    if (configDir === undefined || every.has(configDir)) continue;
    const sids = alone.get(configDir) ?? new Set<string>();
    sids.add(meta.sid);
    alone.set(configDir, sids);
  }
  return {
    dirs: [...every, ...alone.keys()],
    has: (configDir, sid) => every.has(configDir) || alone.get(configDir)?.has(sid) === true,
  };
}

/** The config dirs in which `sid` is one of the sessions this daemon reaches:
 * where session_kill and session_env look its process up. */
function scopeDirsOf(daemon: Daemon, sid: string): string[] {
  const scope = sessionScope(daemon);
  return scope.dirs.filter((dir) => scope.has(dir, sid));
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
    [...daemon.sessions.values()].map((s) => {
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
        ...withReadiness(daemon, s.meta.sid),
        ...build,
        ...(stale ? { stale_client: { version: stale.version, protocol: stale.protocol } } : {}),
      };
    }),
    // Tail-derived, so it changes without any registry mutation — the fold's
    // own onChange is what re-enters maybeBroadcastPeers for it, and this entry
    // is what stops that re-entry from being a no-op push.
    userInputEntries(daemon.sessionUserInputs),
  ]);
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

/** Push the unread says to one connection (ev:"say_unread"): the full set,
 * so the same call serves a fresh subscriber's catch-up and the live
 * update. */
function sendSayUnread(daemon: Daemon, conn: Conn): void {
  send(conn, { ev: "say_unread", says: unreadSays(daemon.sayUnread) });
}

/** Push the unread says to every user-role subscriber when they moved.
 * Never to a session: see SayUnreadStreamEvent. */
function broadcastSayUnread(daemon: Daemon): void {
  const says = unreadSays(daemon.sayUnread);
  const key = JSON.stringify(says);
  if (key === daemon.sayUnreadSnapshot) return;
  daemon.sayUnreadSnapshot = key;
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "say_unread", says });
  }
}

/** What the speakers say when a session asks for permission and wrote no
 * `voice`: that one is asking. The request itself (its commands, its files)
 * is for reading in the webui, not for hearing (DR-0040 §6). */
const PERMIT_SPEECH = "許可を求めています";

/** Push every request for permission the daemon holds to one connection
 * (ev:"permit_requests"), a fresh subscriber's catch-up. */
function sendPermitRequests(daemon: Daemon, conn: Conn): void {
  send(conn, { ev: "permit_requests", requests: daemon.permitRequests.snapshot() });
}

/** Push one request for permission just recorded or marked read to every
 * user-role subscriber (ev:"permit_request"). Never to a session: the asking
 * session knows it asked. */
function broadcastPermitRequest(daemon: Daemon, request: PermitRequestRecord): void {
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "permit_request", request });
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

/** Push the Claude Code version the daemon just read to every user-role
 * subscriber (DR-0043 §8): every tab shows it at once, not only the one that
 * asked for the update. Never to a session. */
function broadcastClaudeVersion(daemon: Daemon, observed: ClaudeVersion): void {
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "claude_version", ...observed });
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

/** An item of any kind whose `status` is 529, read alone. */
const UpstreamOverloadSchema = v.object({ status: v.literal(529) });

/** True for an event reporting the one upstream failure that means "this
 * provider is refusing traffic right now" (gateway DR-0021 §2: 401/403/429 are
 * credential problems and general 5xx can be synthesized by a relay). Read off
 * the raw item rather than the parsed one: an event whose client sent no
 * session id is dropped by the parser but is just as good a signal that the
 * upstream is failing. */
function reportsUpstreamOverload(item: JsonValue): boolean {
  return parseWith(UpstreamOverloadSchema, item).ok;
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
export function recordLlmRequests(daemon: Daemon, items: readonly JsonValue[], log: Logger): void {
  let accepted = 0;
  let dropped = 0;
  // Independent of whether the events parse: an outage is exactly the moment
  // the status report changes, and it is the one change no client can
  // anticipate. The refresher collapses the burst.
  if (items.some(reportsUpstreamOverload)) daemon.llmStatusRefresher?.trigger();
  for (const item of items) {
    // Event kinds ccmsg has no use for travel in the same batch (the gateway's
    // `response`, `keepalive_paused` and `cache_keepalive`, llm-events.ts
    // IgnoredGatewayItemSchema). Skipping them silently is the point:
    // they are well-formed events this daemon simply does not consume, and
    // counting them as dropped would log a line per batch about nothing.
    if (isIgnoredGatewayItem(item)) continue;
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
 * result, plus the user-input fold's onChange when a relay read moves
 * `last_user_input_at` — all three are events, so this stays purely
 * event-driven, unlike the agents poller. */
function maybeBroadcastPeers(daemon: Daemon): void {
  const key = peersCompareKey(daemon);
  if (key === daemon.peersSnapshot) return;
  daemon.peersSnapshot = key;
  const peers = currentPeers(daemon);
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "peers", peers });
  }
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

/** The link state `ping` reports: whether a recovery could wake anything, and
 * what the daemon currently believes about the host's connectivity. */
function networkState(daemon: Daemon): PingResponse["network"] {
  const watch = daemon.networkWatch;
  if (!watch?.enabled) return "off";
  if (watch.online === undefined) return "unknown";
  return watch.online ? "online" : "offline";
}

/** Poke every session that is stopped on an API error, once per stall, after
 * the host comes back online (DR-0039 §9): the wake goes into the session's
 * conversation the way a notice does, which starts the stalled session's next
 * turn. A stall is counted as woken from the moment its wake is asked for, so
 * a link that flaps while it is on its way does not send a second; a wake
 * that did not arrive is uncounted again, and a later recovery can still wake
 * that stall. Returns once every wake has come to its outcome. */
export async function wakeStalledSessions(daemon: Daemon): Promise<void> {
  const wakes = wakesForOnline(daemon.sessionWake, sessionErrorEntries(daemon.sessionErrors));
  const results = await Promise.all(
    wakes.map(async (wake) => {
      recordWoken(daemon.sessionWake, wake);
      const result = await sendNotice(
        { from: DIRECT_DELIVERY_DAEMON_SENDER, sid: wake.sid, text: wake.text },
        noticeDeps(daemon),
      );
      if (result.outcome === "not_delivered") forgetWoken(daemon.sessionWake, wake);
      return result;
    }),
  );
  for (const result of results) {
    daemon.log.info(
      `network online: wake ${result.sid}: ${result.outcome}` +
        (result.outcome === "not_delivered" ? ` (${result.reason})` : ""),
    );
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
const IDENTITY_OPS: ReadonlySet<RequestOp> = new Set<RequestOp>([
  "send_message",
  "peer_list",
  "user_message",
  "say_read",
  "permit_request",
  "permit_request_read",
  "permit_attachment_read",
  "subscribe",
  "rooms",
  "room_history",
  "read",
  "notify",
  "dir_tree",
  "session_launch",
  "session_kill",
  "session_restart",
  "session_rename",
  "user_prompt",
  "request_override",
  "turn_abort",
  "sidecar_reply",
  "sidecar_hello",
  "session_facts",
  "session_launcher_config",
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
  "transcript_push",
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

/** How a transport reads a hello: the hello as the client sent it, or what
 * the transport makes of it (the WebSocket pins every hello to the user role,
 * http.ts). */
export type HelloReading = (hello: HelloRequest) => HelloRequest;

/** Start handling one request line. Requests of the same connection run
 * concurrently: a reply carries the `request_id` of the request it answers
 * (see RequestEnvelope), so a client settles it by id and an op that awaits IO
 * does not hold back the cheap ops queued behind it. Each request swallows
 * its own failure so one rejected op cannot take down the connection. */
export function handleRequest(
  daemon: Daemon,
  conn: Conn,
  line: string,
  readHello: HelloReading = (hello) => hello,
): void {
  void handleOneRequest(daemon, conn, line, readHello).catch((e: unknown) => {
    daemon.log.error(`request handling failed: ${String(e)}`);
  });
}

/** Handle one request line and settle once its reply is written: handleRequest
 * awaited, for a transport that answers each request on its own
 * (op-http.ts). */
export function serveRequest(daemon: Daemon, conn: Conn, line: string): Promise<void> {
  return handleOneRequest(daemon, conn, line, (hello) => hello);
}

async function handleOneRequest(
  daemon: Daemon,
  conn: Conn,
  line: string,
  readHello: HelloReading,
): Promise<void> {
  // Bytes that arrived before the disconnect but are read after it. Their
  // replies would be discarded (send() no-ops), but their registry writes
  // would not: hello would resurrect a session entry for a socket nobody
  // holds, and the subscribe ops would install watches with no reader.
  // Dropping the request is the same outcome as the bytes never arriving. A
  // request already running when the disconnect lands is cleaned up after
  // dispatch instead (see the end of this function).
  if (!daemon.connections.has(conn)) return;
  // The line is read once per layer (DR-0038): its frame, then its request.
  // A line whose frame reads is answered under its request_id even when its
  // request does not read, so the asker is settled; a line whose frame does
  // not read names no request, and its reply carries no id.
  const read = readRequest(line);
  if (read.kind !== "request") {
    // The refusal goes to a client that may only log it somewhere nobody
    // looks (a session's hooks module, a browser console), so it is logged
    // here too, under the connection it came on.
    const why = clipRefusal(read.failure.summary);
    const id = conn.identity;
    const from = id === null ? "a connection without hello" : id.role === "user" ? "user" : id.sid;
    if (read.kind === "invalid_frame") {
      daemon.log.warn(`request from ${from} refused: ${why}`);
      sendErr(conn, ErrorCode.bad_request, why);
      return;
    }
    const { request_id: requestId, op } = read.frame;
    daemon.log.warn(`request ${logToken(op) ?? "?"} from ${from} refused: ${why}`);
    activeRequest.run({ conn, requestId }, () => sendErr(conn, ErrorCode.invalid_args, why));
    return;
  }
  const request = read.request;
  await activeRequest.run({ conn, requestId: request.request_id }, async () => {
    if (isOtherGenerationHello(request)) {
      refuseGeneration(daemon, conn, readHello(claimedHello(request)), request.protocol);
      return;
    }
    const req =
      request.op === "hello" ? { ...readHello(request), request_id: request.request_id } : request;
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

/** The longest account of a refused request's fields that goes into a reply
 * or the log. A failure quotes the value it refused, and that value is the
 * sender's: as large as the sender likes. */
const REFUSAL_MAX_CHARS = 400;

function clipRefusal(summary: string): string {
  return summary.length <= REFUSAL_MAX_CHARS
    ? summary
    : `${summary.slice(0, REFUSAL_MAX_CHARS)}… (${summary.length - REFUSAL_MAX_CHARS} more characters)`;
}

async function dispatch(daemon: Daemon, conn: Conn, req: ServedRequest): Promise<void> {
  switch (req.op) {
    case "hello": {
      // A hello of another generation never reaches here: it is answered
      // before its fields are read (refuseGeneration).
      const client = readClientBuild(req);
      // Served, so whatever this sid was flagged for is over. registerSession's
      // own push below carries the cleared warning out.
      if (req.role === "session" && req.sid) daemon.staleClients.delete(req.sid);
      let newId: Identity;
      if (req.role === "user") {
        newId = { role: "user" };
        const nav = logToken(req.nav_type);
        const ua = logToken(req.ua);
        daemon.log.info(
          `webui ${conn.id ?? "c?"} hello client_version=${client.version ?? "?"}` +
            (nav ? ` nav=${nav}` : "") +
            (ua ? ` ua=${ua}` : ""),
        );
      } else {
        // A session is named by its Claude Code session id (a UUID). The sid
        // ends up in places other programs read — the name of its sidecar's
        // socket, the `from` of the envelope a recipient answers by — so
        // nothing else is taken as one.
        if (!req.sid || !isSessionIdShape(req.sid)) {
          sendErr(
            conn,
            ErrorCode.invalid_args,
            "session hello requires sid: a Claude Code session id (lowercase UUID)",
          );
          return;
        }
        // The config dir is not validated beyond "absolute path, canonically
        // spelled": the value is compared with another session's announcement
        // and searched for this sid's own `projects/<project>/<sid>.jsonl`, the
        // shape an announced transcript_path is pinned to as well, and a
        // session that lies about it can at most mislabel its own view of who
        // is natively reachable.
        const configDir = normalizeConfigDir(req.config_dir);
        // Announced-and-validated path, else the session's own
        // projects/<sid>.jsonl found on disk, under the config dir the session
        // names as well as the detected ones: a session's hello names no
        // transcript (nothing tells the hooks module its path, DR-0039
        // Consequences), and its config dir need not be one of `~/.claude*`.
        //
        // Design rationale: a hello that announces none keeps the path already
        // adopted for this sid (registerSession keeps it too) without searching
        // again. The search reads the `projects/` of every config dir, about
        // 30 ms with a real home's, and a hooks module hellos with every
        // request it makes (DR-0046), each change of its facts among them.
        const adopted =
          req.transcript_path === undefined
            ? daemon.sessions.get(req.sid)?.meta.transcript_path
            : undefined;
        const transcriptPath =
          adopted ??
          (await adoptTranscriptPath(
            req.sid,
            req.transcript_path,
            configDir !== undefined ? [configDir, ...detectConfigDirs()] : undefined,
          ));
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
        // Empty stays empty — that is the hello saying it cannot name the
        // session's location (DR-0003 §3 「所在の正本」), and realpath would
        // answer it with this daemon process's own working directory.
        const cwd = req.cwd ? await realpathOrSelf(req.cwd) : "";
        const repoRoot = await validateRepoRoot(cwd, req.repo_root);
        // Announced repo/ws always win; the cwd derivation only fills what the
        // session could not tell us. A session whose state file was never
        // written announces neither; without the derivation its session-list
        // columns stay blank.
        // Fail-open: unresolvable stays "" and hello proceeds regardless.
        const announcedRepo = req.repo ?? "";
        const announcedWs = req.ws ?? "";
        const derived =
          cwd !== "" && (announcedRepo === "" || announcedWs === "")
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
      conn.identity = newId;
      // pushes ev:"peers" itself.
      if (newId.role === "session") registerSession(daemon, newId, client);
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
      // keepalive の停止 endpoint も同じ扱い。他の 3 つとは独立に設定できる。
      const llmKeepalivePauseAvailable =
        newId.role === "user" && !!daemon.config.llm_keepalive_pause_url;
      // sandbox origin (DR-0030 §7.1) も同じ流儀。template 自体は返さない —
      // client が触るのは sandbox_grant が組み立てた完成 URL だけなので、
      // 「導線を出してよいか」だけ渡せば足りる。未設定 (= canddy の sandbox
      // ドメインが前段に無い環境) では webui が導線を一切出さない。
      const sandboxAvailable = newId.role === "user" && daemon.sandboxOrigin !== null;
      // 起動 (DR-0018 §3.4) も同じ流儀の capability。launcher が設定されて
      // いなければ、新規フォームも Timeline の fork も launcher_not_configured
      // しか返せない。
      const launchAvailable = newId.role === "user" && !!daemon.config.session_launcher;
      // Where the launch command starts claude, for the webui to offer a
      // restart only to the sessions it can resume (DR-0028 「restart」).
      const launcherForDir = newId.role === "user" ? daemon.config.session_launcher : undefined;
      const launchDir =
        launcherForDir !== undefined ? launchConfigDir(launcherForDir, daemon.env) : undefined;
      send(conn, {
        ok: true,
        version: daemon.version,
        protocol: PROTOCOL_VERSION,
        ...(terminalGatewayUrl ? { terminal_gateway_url: terminalGatewayUrl } : {}),
        ...(llmUsageAvailable ? { llm_usage_available: true } : {}),
        ...(llmStatsAvailable ? { llm_stats_available: true } : {}),
        ...(llmStatusAvailable ? { llm_status_available: true } : {}),
        ...(llmKeepalivePauseAvailable ? { llm_keepalive_pause_available: true } : {}),
        ...(sandboxAvailable ? { sandbox_available: true } : {}),
        ...(launchAvailable ? { launch_available: true } : {}),
        ...(launchDir !== undefined ? { launch_config_dir: launchDir } : {}),
      });
      return;
    }

    case "ping": {
      const webuiUrls = await daemon.webuiUrls();
      const webuiUrl = webuiUrls[0];
      send(conn, {
        ok: true,
        pong: true,
        version: daemon.version,
        uptime: (Date.now() - daemon.startTime) / 1000,
        pid: process.pid,
        clients: daemon.connections.size,
        // provenance (DR-0009-agents addendum): which bun executable and entry
        // script this running daemon actually is, so version skew across faces
        // (e.g. ~/.claude-personal vs a work overlay) is observable.
        exe: process.execPath,
        script: Bun.main,
        home: os.homedir(),
        http: daemon.httpListeners.map((l) => l.address),
        httpAllow: daemon.httpAllow,
        ...(webuiUrl !== undefined ? { webui_url: webuiUrl } : {}),
        webui_urls: webuiUrls,
        ...(daemon.claudeVersion !== null ? { claude_version: daemon.claudeVersion } : {}),
        network: networkState(daemon),
      });
      return;
    }

    case "send_message": {
      // Session role only: the sender is the session whose `send` tool was
      // called (DR-0039 §3), and becomes the envelope's from.
      const id = conn.identity;
      if (id?.role !== "session") {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          "send_message is sent by a session; a person's input reaches a session through user_prompt",
        );
        return;
      }
      // Waits for every run's write and refusal window (DR-0034 §2), the
      // sessions in parallel and each session's runs one at a time behind
      // what was sent to it before; other requests on this connection run on
      // meanwhile.
      // With an agent id the text goes to that subagent through the session's
      // module, as user_message's does (DR-0039 §3).
      const results = await sendToPeers(
        {
          from: id.sid,
          to: req.to,
          ...(req.agent_id !== undefined ? { agentId: req.agent_id } : {}),
          text: req.text,
        },
        {
          ...noticeDeps(daemon),
          appendToAgent: async (sid, agentId, text, from) => {
            const { tries: _tries, ...outcome } = await userMessage(
              { sid, agentId, text, from },
              {
                ...productionSidecarDeps(daemon.sidecarReplies),
                deadlineMs: USER_MESSAGE_DEADLINE_MS,
                runs: daemon.sidecarRuns,
                isRunning: (running) => daemon.sessions.has(running),
              },
            );
            return outcome;
          },
        },
      );
      send(conn, { ok: true, results });
      return;
    }

    case "peer_list": {
      const id = conn.identity;
      if (id?.role !== "session") {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          "peer_list is asked by a session; a person reads peers",
        );
        return;
      }
      const filter = {
        ...(req.cwd_prefix !== undefined ? { cwd_prefix: req.cwd_prefix } : {}),
        ...(req.name !== undefined ? { name: req.name } : {}),
      };
      send(conn, { ok: true, peers: await listPeers(id.sid, filter, peerDeps(daemon)) });
      return;
    }

    case "permit_request": {
      // 許可依頼は止められたエージェント自身が出す (session role 限定)。
      // 依頼は caller 自身のものなので、caller がセッションを名指す余地はない。
      // attachments はパスだけを記録し、人が開いた時に読む (DR-0040 §3)。
      if (conn.identity?.role !== "session") {
        sendErr(conn, ErrorCode.bad_request, "op 'permit_request' requires session role");
        return;
      }
      const record = daemon.permitRequests.add(
        permitRequestFields(conn.identity.sid, req.permit, nowIso()),
      );
      broadcastPermitRequest(daemon, record);
      daemon.speaker.speak(record.voice ?? PERMIT_SPEECH);
      daemon.log.info(
        `permit_request: by=${record.sid} id=${record.id} attachments=${String(record.attachments.length)} intents=${String(record.intents.length)} commands=${String(record.commands.length)}`,
      );
      send(conn, { ok: true, id: record.id });
      return;
    }

    case "permit_attachment_read": {
      // 添付は人がバブルで開いた時に読む (user role 限定)。読めるのは依頼した
      // セッションがその依頼で名指したパスだけで、webui から任意のパスは
      // 読めない (DR-0040 §3、DR-0024 §3.2 と同じ信頼の形)。
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'permit_attachment_read' requires user role");
        return;
      }
      const record = daemon.permitRequests.find(req.id);
      if (record === undefined) {
        sendErr(conn, ErrorCode.invalid_args, `no permit request with id ${req.id}`);
        return;
      }
      if (!record.attachments.includes(req.path)) {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `permit request ${req.id} names no attachment ${req.path}`,
        );
        return;
      }
      send(conn, { ok: true, attachment: await readPermitAttachment(req.path) });
      return;
    }

    case "permit_request_read": {
      // 既読は webui のバブルの「許可する」からだけ立つ (user role 限定、
      // say_read と同じ理由)。存在しない id は黙って ack せず、どれも既読に
      // しない。変わった記録だけを 1 件ずつ全タブに送る。
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'permit_request_read' requires user role");
        return;
      }
      const marked = daemon.permitRequests.markRead(req.ids);
      if (marked.kind === "missing") {
        sendErr(conn, ErrorCode.invalid_args, `no permit request with id ${marked.ids.join(", ")}`);
        return;
      }
      for (const record of marked.changed) broadcastPermitRequest(daemon, record);
      send(conn, { ok: true, ids: req.ids });
      return;
    }

    case "say_read": {
      // 既読は webui の 🔔 バブル上のボタンからだけ立つ (user role 限定):
      // 未読数は「kawaz がまだ見ていない say」の数であって、喋った session が
      // 自分で消せる意味の数ではない。既読はファイルに書いてから答える
      // (DR-0045 §7)。
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'say_read' requires user role");
        return;
      }
      const marked = await markSaysRead(daemon.sayUnread, req.ids);
      if (marked.kind === "unknown") {
        // 未読でも既読でもない id を黙って ack すると、未読数が減らないまま
        // "既読にした" と見える。どれも既読にせず落として気づかせる。
        sendErr(conn, ErrorCode.invalid_args, `no say with id ${marked.ids.join(", ")}`);
        return;
      }
      // 他タブの webui にも既読を伝える。二度目の ack は何も変えないので送らない。
      if (marked.kind === "read") broadcastSayUnread(daemon);
      send(conn, { ok: true, ids: req.ids });
      return;
    }

    case "subscribe": {
      // The stream is the webui's (user role). What reaches a session goes
      // into its conversation (notify, the wake: DR-0039 §9), and a session
      // that still asks for a stream is running an older plugin, which a
      // restart replaces.
      if (conn.identity?.role !== "user") {
        sendErr(
          conn,
          ErrorCode.bad_request,
          "op 'subscribe' requires user role; a session receives notices in its conversation (restart the session to load the current ccmsg plugin)",
        );
        return;
      }
      conn.subscribed = true;
      daemon.subscribers.add(conn);
      send(conn, { ok: true, subscribed: true });
      // Catch-up for the agents list the poller already holds; later polls
      // and runs reach this conn through maybeBroadcastAgents.
      const { agents, polledAt } = daemon.agentsPoller.cache;
      if (polledAt !== null) {
        send(conn, {
          ev: "agents",
          agents: agentsWithModule(daemon, agents),
          polled_at: polledAt,
        });
      }
      // Catch-up for the windows that opened before this tab connected. Sent
      // only when something is live: an empty push would make a daemon with
      // no gateway configured look like one whose sessions all went cold.
      if (daemon.llmRequests.snapshot().length > 0) sendLlmRequests(daemon, conn);
      // Sent even when empty: a tab reconnecting to a restarted daemon still
      // holds the old daemon's unread says, and only this replaces them.
      sendSayUnread(daemon, conn);
      // Same reason as the unread says: sent even when empty.
      sendPermitRequests(daemon, conn);
      sendRequestOverrides(daemon, conn);
      return;
    }

    // The room logs are the webui's to read (DR-0036 §3), so the three ops
    // that read them answer the user role only.
    case "read": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'read' requires user role");
        return;
      }
      const room = await daemon.rooms.room(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      send(conn, { ok: true, room: room.id, msgs: readMsgs(room, req.mids) });
      return;
    }

    case "room_history": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'room_history' requires user role");
        return;
      }
      const room = await daemon.rooms.room(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      send(conn, { ok: true, room: room.id, events: [...room.events] });
      return;
    }

    case "rooms": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'rooms' requires user role");
        return;
      }
      const rooms = await daemon.rooms.list();
      send(conn, { ok: true, rooms: rooms.map(roomSummary) });
      return;
    }

    case "peers": {
      // Same settled-answer contract as `session_errors`: a session that
      // became live moments ago may still be catching up, and a peers list
      // whose ordering key fills in afterwards would sort wrong on first paint.
      if (conn.identity?.role === "user") await relaysCaughtUp(daemon.transcriptRelay);
      send(conn, { ok: true, peers: currentPeers(daemon) });
      return;
    }

    case "notify": {
      // Session role only (DR-0039 §9): the sender is the calling session,
      // stamped from the connection identity, never the request, and becomes
      // the envelope's from. Waits for the delivery as send_message does.
      const id = conn.identity;
      if (id?.role !== "session") {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          "notify is sent by a session; a person's input reaches a session through user_prompt",
        );
        return;
      }
      const result = await sendNotice(
        { from: id.sid, sid: req.sid ?? id.sid, text: req.text },
        noticeDeps(daemon),
      );
      send(conn, { ok: true, result });
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
        default_effort: await defaultEfforts(daemon.env),
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
      // Both roles (DR-0018 §3.8): what runs is the one command the config
      // names, and the caller chooses only the launch.
      const id = conn.identity;
      if (id === null) {
        sendErr(conn, ErrorCode.hello_required, "op 'session_launch' requires hello first");
        return;
      }
      const launcher = daemon.config.session_launcher;
      // A shutdown waits for the launches running; it takes no more. (With no
      // launcher there is nothing to take: launchSession says so.)
      if (launcher !== undefined && daemon.shuttingDown) {
        sendErr(
          conn,
          ErrorCode.launch_busy,
          "the daemon is shutting down; ask again once it is back",
        );
        return;
      }
      if (launcher !== undefined && daemon.launches.size >= launcher.launch_max_concurrency) {
        sendErr(
          conn,
          ErrorCode.launch_busy,
          `${String(daemon.launches.size)} launches are running (launch_max_concurrency); ask again once one ends`,
        );
        return;
      }
      const running = launchSession(
        {
          launcher,
          requester: id.role === "user" ? "user" : id.sid,
          baseEnv: daemon.env,
          launchesDir: daemon.paths.launches,
          log: daemon.log,
        },
        req.launch,
      );
      daemon.launches.add(running);
      let outcome: Awaited<typeof running>;
      try {
        outcome = await running;
      } finally {
        daemon.launches.delete(running);
      }
      if (!outcome.ok) {
        sendErr(conn, outcome.code, outcome.msg);
        return;
      }
      send(conn, outcome.response);
      return;
    }

    case "session_kill": {
      // DR-0028: user role only — session-role agents must never be able to
      // kill each other.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_kill' requires user role");
        return;
      }
      // Slow: up to 3s of kill grace
      // (DR-0028). `force` is forwarded to session-kill.ts for the SIGKILL
      // escalation path.
      const killDeps = {
        ...productionKillDeps,
        configDirs: () => scopeDirsOf(daemon, req.session_id),
      };
      const killed = await sessionKill(req.session_id, killDeps, {
        force: req.force === true,
      });
      if (!killed.found) {
        // Unresolvable sid and a pid that failed the ps verification are the
        // same outcome for the caller: the session's process is not there
        // (anymore) — DR-0028 maps both to not_found.
        sendErr(conn, ErrorCode.not_found, `no process for session ${req.session_id}`);
        return;
      }
      if (killed.terminated) {
        forgetSession(daemon, req.session_id);
        maybeBroadcastPeers(daemon);
      }
      send(conn, { ok: true, terminated: killed.terminated });
      return;
    }

    case "session_restart": {
      // DR-0028 「restart」: user role only, as session_kill. Counted as one of
      // the launches from the first check to the reply, so the in-flight
      // bound and a shutdown's wait cover the stop as well as the launch.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_restart' requires user role");
        return;
      }
      const launcher = daemon.config.session_launcher;
      if (launcher !== undefined && daemon.shuttingDown) {
        sendErr(
          conn,
          ErrorCode.launch_busy,
          "the daemon is shutting down; ask again once it is back",
        );
        return;
      }
      if (launcher !== undefined && daemon.launches.size >= launcher.launch_max_concurrency) {
        sendErr(
          conn,
          ErrorCode.launch_busy,
          `${String(daemon.launches.size)} launches are running (launch_max_concurrency); ask again once one ends`,
        );
        return;
      }
      const sid = req.session_id;
      const entry = daemon.sessions.get(sid);
      const running = restartSession(sid, {
        launcher,
        baseEnv: daemon.env,
        sessionConfigDir: entry?.configDir,
        kill: { ...productionKillDeps, configDirs: () => scopeDirsOf(daemon, sid) },
        runsAs: async () => {
          const facts = daemon.sessionFacts.get(sid);
          const file = entry?.meta.transcript_path;
          const tail = file !== undefined ? await readSessionLaunchContext(file) : {};
          const model = facts?.model ?? tail.model;
          const effort = facts?.effort ?? tail.effort;
          return {
            ...(model !== undefined ? { model } : {}),
            ...(effort !== undefined ? { effort } : {}),
          };
        },
        stopped: () => {
          forgetSession(daemon, sid);
          maybeBroadcastPeers(daemon);
        },
        launch: (launch) =>
          launchSession(
            {
              launcher,
              requester: "user",
              baseEnv: daemon.env,
              launchesDir: daemon.paths.launches,
              log: daemon.log,
            },
            launch,
          ),
        log: daemon.log,
      });
      daemon.launches.add(running);
      let outcome: Awaited<typeof running>;
      try {
        outcome = await running;
      } finally {
        daemon.launches.delete(running);
      }
      if (!outcome.ok) {
        sendErr(conn, outcome.code, outcome.msg);
        return;
      }
      send(conn, outcome.response);
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
      // Title validation happens before the delivery attempt so a malformed
      // title costs nothing but a synchronous invalid_args.
      const titleCheck = validateRenameTitle(req.title);
      if (!titleCheck.ok) {
        sendErr(conn, ErrorCode.invalid_args, titleCheck.msg);
        return;
      }
      const renamed = await sessionRename(
        req.session_id,
        titleCheck.title,
        productionRenameDeps(
          (sid) =>
            agentsWithModule(daemon, daemon.agentsPoller.cache.agents).find(
              (agent) => agent.sessionId === sid && agent.hyoui_session_id !== undefined,
            )?.hyoui_session_id ?? null,
        ),
      );
      if (renamed.ok) {
        send(conn, {
          ok: true,
          hyoui_session_id: renamed.hyoui_session_id,
          title: renamed.title,
        });
        return;
      }
      if (renamed.reason === "terminal_unavailable") {
        sendErr(
          conn,
          ErrorCode.terminal_unavailable,
          `session ${req.session_id} has no known terminal (no run of it named a HYOUI_SESSION_ID); rename it from the session's own terminal instead`,
        );
        return;
      }
      // The browser shows this once and moves on; the log line is what a
      // later "why did rename fail" investigation has to go on.
      daemon.log.warn(`op 'session_rename' send failed for ${req.session_id}: ${renamed.msg}`);
      sendErr(conn, "internal", `sending /rename to the session's terminal failed: ${renamed.msg}`);
      return;
    }

    case "user_prompt": {
      // user role only (DR-0035 §4): what this op puts into a session is
      // recorded as a person's typing, so no session-role agent may call it.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'user_prompt' requires user role");
        return;
      }
      // Slow reply: it waits for the session's hooks module to reply, up to
      // USER_PROMPT_DEADLINE_MS. Other requests on this connection run on
      // meanwhile (DR-0029).
      const { tries, ...outcome } = await userPrompt(
        {
          sid: req.session_id,
          text: req.text,
          override: {
            ...(req.model !== undefined ? { model: req.model } : {}),
            ...(req.effort !== undefined ? { effort: req.effort } : {}),
          },
        },
        productionInputDeps(daemon.sidecarReplies, daemon.sidecarRuns),
      );
      daemon.log.info(
        `session-input -> ${req.session_id}: ${outcome.outcome}` +
          (outcome.outcome === "not_delivered" ? ` (${outcome.reason})` : "") +
          ` tries=[${tries.map((t) => `${t.id} ${path.basename(t.socket)} ${t.result}`).join(", ")}]`,
      );
      send(conn, { ok: true, ...outcome });
      return;
    }

    case "request_override": {
      // user role only (DR-0041 §3): what a session's requests run on is the
      // person's to change, not a session's, for itself or another.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'request_override' requires user role");
        return;
      }
      const sid = req.session_id;
      const patch = {
        ...(req.model !== undefined ? { model: req.model } : {}),
        ...(req.effort !== undefined ? { effort: req.effort } : {}),
      };
      const override = daemon.sessionOverrides.change(sid, patch);
      // The fields the change named go out of the one-shot override too
      // (DR-0041 §6.5): `null` returns a field to the session's own value.
      const named = namedFields(patch);
      const args = { ...override, ...(named.length > 0 ? { clear_once: named } : {}) };
      // Slow reply: it waits for the modules' replies, up to
      // REQUEST_OVERRIDE_DEADLINE_MS (DR-0029).
      const { delivery, tries } = await sendRequestOverride(
        sid,
        args,
        daemon.sidecarRuns.liveOf(sid),
        productionRequestOverrideDeps(productionSidecarDeps(daemon.sidecarReplies)),
      );
      daemon.log.info(
        `request-override -> ${sid}: ${JSON.stringify(args)} ${delivery}` +
          ` tries=[${tries.map((t) => `${t.id} ${path.basename(t.socket)} ${t.result}`).join(", ")}]`,
      );
      send(conn, { ok: true, delivery });
      return;
    }

    case "turn_abort": {
      // user role only (DR-0044 §2): stopping a session's turn is the
      // person's, not a session's, for itself or another.
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'turn_abort' requires user role");
        return;
      }
      const sid = req.session_id;
      // Slow reply: it waits for the modules' replies, up to
      // TURN_ABORT_DEADLINE_MS (DR-0029).
      const { outcome, tries } = await abortTurn(
        sid,
        productionTurnAbortDeps(
          productionSidecarDeps(daemon.sidecarReplies),
          daemon.sidecarRuns,
          (s) => daemon.sessions.has(s),
        ),
      );
      daemon.log.info(
        `turn_abort: session_id=${sid} result=${outcome.ok ? "aborted" : outcome.code}` +
          ` tries=[${tries.map((t) => `${t.id} ${path.basename(t.socket)} ${t.result}`).join(", ")}]`,
      );
      if (!outcome.ok) {
        sendErr(conn, outcome.code, outcome.msg);
        return;
      }
      send(conn, { ok: true });
      return;
    }

    case "user_message": {
      // user role only, as user_prompt: what it adds is recorded as the
      // person's, through the webui (DR-0039 §6).
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'user_message' requires user role");
        return;
      }
      const { tries, ...outcome } = await userMessage(
        { sid: req.session_id, agentId: req.agent_id, text: req.text },
        {
          ...productionSidecarDeps(daemon.sidecarReplies),
          deadlineMs: USER_MESSAGE_DEADLINE_MS,
          runs: daemon.sidecarRuns,
          isRunning: (sid) => daemon.sessions.has(sid),
        },
      );
      daemon.log.info(
        `agent-input -> ${req.session_id} ${req.agent_id}: ${outcome.outcome}` +
          (outcome.outcome === "not_delivered" ? ` (${outcome.reason})` : "") +
          ` tries=[${tries.map((t) => `${t.id} ${path.basename(t.socket)} ${t.result}`).join(", ")}]`,
      );
      send(conn, { ok: true, ...outcome });
      return;
    }

    case "sidecar_reply": {
      // The replier is the session the request went to: its hooks module
      // asks `POST /op` as that session (op-http.ts), the same process even
      // when the session has changed its id since.
      if (conn.identity?.role !== "session") {
        sendErr(conn, ErrorCode.bad_request, "op 'sidecar_reply' requires session role");
        return;
      }
      // A refused reply is logged: the module's own debug log is the only
      // other place it would show, and a late or misaddressed reply is what
      // explains a user_prompt that came back unconfirmed.
      const reply = req.reply;
      if (!daemon.sidecarReplies.take(conn.identity.sid, reply)) {
        daemon.log.warn(
          `sidecar_reply ${reply.id} from ${conn.identity.sid} refused: no request is waiting under that id for this session (answered already, past its wait, or sent elsewhere)`,
        );
        sendErr(
          conn,
          ErrorCode.not_found,
          `no request to this session's module is waiting under id ${reply.id}`,
        );
        return;
      }
      send(conn, { ok: true });
      return;
    }

    case "sidecar_hello": {
      // The namer is a run of the session: its sidecar hellos as that session
      // on a connection of its own, and the run is live until it closes
      // (removeConn).
      if (conn.identity?.role !== "session") {
        sendErr(conn, ErrorCode.bad_request, "op 'sidecar_hello' requires session role");
        return;
      }
      const configDir = normalizeConfigDir(req.config_dir);
      const run = daemon.sidecarRuns.announce(
        conn,
        {
          sid: conn.identity.sid,
          runId: req.run_id,
          startedAt: req.started_at,
          ...(configDir !== undefined ? { configDir } : {}),
          ...(req.hyoui_session_id !== undefined ? { hyouiSessionId: req.hyoui_session_id } : {}),
        },
        agentRows(daemon.agentsPoller.cache.agents),
      );
      daemon.log.info(
        `sidecar ${run.sid}.${run.runId} named` +
          (run.pid !== undefined ? ` pid=${String(run.pid)}` : "") +
          (run.hyouiSessionId !== undefined ? " terminal" : " no terminal"),
      );
      send(conn, { ok: true });
      refreshReadiness(daemon);
      // A daemon that started after the module has none of the facts it sent
      // before; one that had them loses nothing by asking again.
      void askSessionFacts(daemon, run);
      void resendSessionOverride(daemon, run);
      return;
    }

    case "session_facts": {
      // The sender is the session the facts are of: its hooks module asks
      // `POST /op` (op-http.ts) under that session's hello.
      if (conn.identity?.role !== "session") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_facts' requires session role");
        return;
      }
      takeSessionFacts(daemon, conn.identity.sid, req.facts);
      send(conn, { ok: true });
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
      const envRead = await sessionEnv(
        req.session_id,
        productionEnvDeps({
          ...productionKillDeps,
          configDirs: () => scopeDirsOf(daemon, req.session_id),
        }),
      );
      if (!envRead.found) {
        // Unresolvable sid and a pid that failed ps verification are the
        // same outcome for the caller, exactly as in session_kill.
        sendErr(conn, ErrorCode.not_found, `no process for session ${req.session_id}`);
        return;
      }
      send(conn, { ok: true, pid: envRead.pid, env: envRead.env });
      return;
    }

    case "session_search": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_search' requires user role");
        return;
      }
      // The bounded filesystem scan is read-only but slow; the reply comes
      // back when it finishes, which holds back nothing else on this conn.
      const found = await sessionSearch(req, daemon.log);
      if (!found.ok) sendErr(conn, found.code, found.msg);
      else send(conn, found.data);
      return;
    }

    case "fork_origin": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fork_origin' requires user role");
        return;
      }
      // Same resolver transcript_read uses, so a historical sid is answerable
      // and no path ever comes from the client.
      const resolved = await resolveTranscript(daemon.sessions, req.sid, {
        allowVirtual: true,
      });
      if (!resolved.ok) {
        sendErr(conn, resolved.code, resolved.msg);
        return;
      }
      // Reading whole sibling transcripts is slow on the first ask for a
      // session; later asks are served from the memo.
      send(conn, { ok: true, origin: await daemon.forkOrigins.resolve(resolved.file, daemon.log) });
      return;
    }

    case "session_dump_file": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_dump_file' requires user role");
        return;
      }
      // Same resolver transcript_read and fork_origin use, so a connected or a
      // historical sid is answerable and no path ever comes from the client.
      const dumpTarget = await resolveTranscript(daemon.sessions, req.sid, {
        allowVirtual: true,
      });
      if (!dumpTarget.ok) {
        sendErr(conn, dumpTarget.code, dumpTarget.msg);
        return;
      }
      // Dumping reads the whole transcript plus every agent transcript beside
      // it, so this is slow. The destination is the daemon's own dumps/ —
      // nothing here is client-named.
      const dump = await dumpSession(req.sid, {
        dataDir: daemon.paths.dataDir,
        rooms: daemon.rooms,
        transcriptFile: dumpTarget.file,
        ...(req.since !== undefined ? { since: req.since } : {}),
        ...(req.until !== undefined ? { until: req.until } : {}),
        ...(req.no_thinking === true ? { noThinking: true } : {}),
        ...(req.no_agent === true ? { noAgent: true } : {}),
      });
      // Written as text, not jsonl: this file is meant to be picked up and
      // read directly by whatever session inherits it, not parsed as
      // structured data (kawaz: jsonl invites over-clever reads that burn
      // context or half-read the handoff).
      const dumpFile = writeSessionDumpFile(dump, { dir: daemon.paths.dumps }, "text");
      send(conn, {
        ok: true,
        path: dumpFile,
        entries: dump.entries.length,
        bytes: fs.statSync(dumpFile).size,
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
      // path linkifier). It reuses fs_read /
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
      // user-role only: file deletion is a viewer feature,
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
      const result = await transcriptRead(
        daemon.sessions,
        req.sid,
        { before: req.before, after: req.after, maxBytes: req.max_bytes },
        {
          allowVirtual: conn.identity?.role === "user",
          agentId: req.agent_id,
          runId: req.run_id,
          teammate: req.teammate,
        },
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    // user role only (webui-only op): the agents rows
    // result is not something a session (AI) needs to see.
    case "agents": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'agents' requires user role");
        return;
      }
      send(conn, {
        ok: true,
        agents: agentsWithModule(daemon, daemon.agentsPoller.cache.agents),
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
      await relaysCaughtUp(daemon.transcriptRelay);
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
      // Slow for session_search's reason: the upstream fetch can take seconds.
      // `refresh` reaches upstream as a real probe and can spend rate limit,
      // so it is passed through only when the client asked for it explicitly
      // (the webui's manual button, never its polling).
      const usage = await fetchLlmUsage(usageUrl, req.refresh === true);
      if (!usage.ok) sendErr(conn, usage.code, usage.msg);
      else send(conn, usage.data);
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
      // Validated here rather than passed through: an out-of-range window is
      // the client's bug, and forwarding it would hide that behind an error
      // that looks like the gateway's.
      if (req.days !== undefined && !isValidDays(req.days)) {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `op 'llm_stats' days must be an integer in ${LLM_STATS_DAYS_MIN}..${LLM_STATS_DAYS_MAX}`,
        );
        return;
      }
      const stats = await fetchLlmStats(statsUrl, req.days);
      if (!stats.ok) sendErr(conn, stats.code, stats.msg);
      else send(conn, stats.data);
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
      // `refresh` makes the gateway re-read every configured status page, so
      // it is passed through only for the screen's own button — never for the
      // fetch a connecting client makes, and never for the webhook-driven
      // re-read (the gateway refreshes its sources on that trigger itself).
      const status = await fetchLlmStatus(statusUrl, req.refresh === true);
      if (!status.ok) sendErr(conn, status.code, status.msg);
      else send(conn, { ok: true, ...status.data });
      return;
    }

    // Same role rationale as the three above: stopping a session's keepalive
    // is the person's call about what the host's gateway spends, made from
    // outside the session so that the session's context stays as it was.
    case "llm_keepalive_pause": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'llm_keepalive_pause' requires user role");
        return;
      }
      const pauseUrl = daemon.config.llm_keepalive_pause_url;
      if (!pauseUrl) {
        sendErr(
          conn,
          ErrorCode.llm_keepalive_pause_not_configured,
          "llm keepalive pause endpoint is not configured",
        );
        return;
      }
      const paused = await pauseLlmKeepalive(pauseUrl, req.sid);
      if (!paused.ok) {
        sendErr(conn, paused.code, paused.msg);
        return;
      }
      daemon.llmRequests.pause(req.sid, Date.now());
      broadcastLlmRequests(daemon);
      send(conn, { ok: true });
      return;
    }

    case "translate": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'translate' requires user role");
        return;
      }
      // Translation.framework and helper process I/O are async; a thrown
      // helper failure is mapped to translate_helper_failed here rather than
      // falling through to the dispatch-wide `internal`.
      let translated;
      try {
        translated = await daemon.translator.translate(req.texts);
      } catch (error) {
        daemon.log.error(`op 'translate' failed: ${String(error)}`);
        sendErr(conn, ErrorCode.translate_helper_failed, String(error));
        return;
      }
      if (translated.ok) send(conn, { ok: true, results: translated.results });
      else sendErr(conn, translated.code, translated.msg);
      return;
    }

    // user role only, same rationale as "agents": live-tailing a transcript is a
    // webui viewer feature, not something a session needs from the wire protocol.
    case "transcript_subscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'transcript_subscribe' requires user role");
        return;
      }
      const result = relaySubscribe(daemon.transcriptRelay, daemon.sessions, req.sid, conn);
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
      relayUnsubscribe(daemon.transcriptRelay, req.sid, conn);
      send(conn, { ok: true, sid: req.sid });
      return;
    }

    // The rows its hooks module saw go into the caller's conversation (DR-0045
    // §2). The jsonl is read on for the Timelines that follow it: the main
    // thread's rows only (a subagent's are in its own file, which no
    // Timeline follows live), and not a `queue` row, which has no line.
    case "transcript_push": {
      if (conn.identity?.role !== "session") {
        sendErr(conn, ErrorCode.bad_request, "op 'transcript_push' requires session role");
        return;
      }
      const sid = conn.identity.sid;
      // The rows not read off the file yet are new: their tool calls are acted
      // on (DR-0045 §6). Asked before the read below, which may reach them.
      const fresh = req.rows.filter((row) => !relayHasRead(daemon.transcriptRelay, sid, row.uuid));
      actOnPushedRows(daemon.rowEffects, sid, fresh, {
        speak: (text) => daemon.speaker.speak(text),
      });
      const uuids = req.rows.flatMap((row) =>
        row.agent_id === undefined && row.door !== "queue" ? [row.uuid] : [],
      );
      if (uuids.length > 0) {
        relayPushed(daemon.transcriptRelay, daemon.sessions, sid, uuids);
      }
      send(conn, { ok: true });
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
      const points = req.points.slice(0, CLIENT_TRACE_MAX_POINTS);
      // Every point of a batch is queued in this turn, so they share one flush;
      // awaiting the last of them is awaiting the whole batch reaching disk,
      // which is what makes `written` an honest count rather than an intent.
      let written: Promise<void> | null = null;
      for (const point of points) {
        written = daemon.trace.write({
          ts: point.ts,
          comp: point.comp,
          edge: point.edge,
          kind: point.kind,
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
        daemon.sessions,
        req.sid,
        conn,
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
      unsubscribeSessionStatus(daemon.sessionStatus, req.sid, conn);
      send(conn, { ok: true, sid: req.sid });
      return;
    }

    // DR-0043 §6: user role only — a session's agent must not be able to
    // replace the binary every session on this host runs. Slow (the
    // download), and the connection's other requests run beside it.
    case "claude_update": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'claude_update' requires user role");
        return;
      }
      if (daemon.claudeUpdateRunning) {
        daemon.log.info(
          `claude_update: exit_code=- version=- error=${ErrorCode.claude_update_busy}`,
        );
        sendErr(conn, ErrorCode.claude_update_busy, "a claude update is already running");
        return;
      }
      daemon.claudeUpdateRunning = true;
      const outcome = await runClaudeUpdate(daemon.claudeUpdateDeps).finally(() => {
        daemon.claudeUpdateRunning = false;
      });
      if (!outcome.ok) {
        daemon.log.info(
          `claude_update: exit_code=${outcome.exitCode ?? "-"} version=- error=${outcome.code}`,
        );
        sendErr(conn, outcome.code, outcome.msg);
        return;
      }
      daemon.log.info(`claude_update: exit_code=0 version=${outcome.version}`);
      const observed = { version: outcome.version, observed_at: outcome.observedAt };
      daemon.claudeVersion = observed;
      send(conn, { ok: true, version: outcome.version, exit_code: 0 });
      broadcastClaudeVersion(daemon, observed);
      return;
    }

    case "shutdown": {
      send(conn, { ok: true, stopping: true });
      void shutdownDaemon(daemon, req.reason);
      return;
    }

    default: {
      // Every op the request schema reads has a case above; an unknown op is
      // answered before dispatch (refuseRequest).
      const unhandled: never = req;
      void unhandled;
      return;
    }
  }
}

// --- lifecycle -------------------------------------------------------------

/** Stop everything the daemon runs, tell every connection, release what can
 * block a successor, then end the host (`daemon.exit`). */
export async function shutdownDaemon(daemon: Daemon, reason?: string): Promise<void> {
  if (daemon.shuttingDown) return;
  daemon.shuttingDown = true;
  daemon.log.info(`graceful shutdown (${reason ?? ""})`);
  // The launches running are answered before anything stops: each ends by
  // its own deadline (launch_timeout_seconds, then SIGTERM), and its asker would
  // otherwise not know whether a session was started (DR-0018 §3.5).
  if (daemon.launches.size > 0) {
    daemon.log.info(`graceful shutdown: waiting for ${String(daemon.launches.size)} launches`);
    await Promise.allSettled(daemon.launches);
  }
  daemon.testLifeline?.release();
  stopAgentsPoller(daemon.agentsPoller);
  daemon.translator.stop();
  stopAllRelays(daemon.transcriptRelay);
  stopAllSessionStatus(daemon.sessionStatus);
  daemon.networkWatch?.stop();
  daemon.llmStatusRefresher?.stop();
  daemon.peerInjector.close();

  // Notify every connection — UDS and WS alike, `send` doesn't care which — before
  // tearing down either transport so both sides can receive the restarting frame.
  const ev: RestartingStreamEvent = { ev: "restarting", ...(reason ? { reason } : {}) };
  for (const conn of daemon.connections) send(conn, ev);

  // UDS disappearance is the sole boundary clients use to conclude that this
  // daemon has yielded. Release every resource that can block its successor
  // before closing UDS. The predecessor deliberately leaves the socket pathname:
  // after releasing the lock, unlinking it could delete a successor's newly bound
  // socket; the next lock holder owns the existing stale-socket cleanup at startup.
  await releaseDaemonResources({
    stopHttp: async () => {
      await Promise.allSettled([
        ...daemon.httpListeners.map((listener) => listener.stop()),
        ...(daemon.opHttp !== null ? [daemon.opHttp.stop()] : []),
      ]);
    },
    removePid: () => {
      try {
        fs.unlinkSync(daemon.paths.pid);
      } catch {
        // ignore
      }
    },
    releaseLock: () => daemon.lock.release(),
    stopUds: () => {
      try {
        daemon.server?.stop();
      } catch {
        // ignore
      }
    },
  });
  // The files the daemon writes are closed here, not left to the process
  // exit: a daemon hosted in a test process outlives its shutdown, and an
  // open FileHandle collected by GC is reported as an error.
  await daemon.trace.close();
  daemon.log.close();
  daemon.exit();
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
 *  DEFAULT_HTTP_ALLOW (DR-0004 §3). Empty/whitespace-only falls back to the
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
 *  (DR-0004 §3). Unset/empty = no extra origins. */
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

interface UdsConnState {
  conn: Conn;
  decoder: TextDecoder;
  buffer: string;
  /** Bytes not yet accepted by the kernel due to backpressure (DR-0008: fs_read
   *  responses can be hundreds of KB, well past the point tiny replies
   *  ever hit). `socket.write()` uses sendto(2) directly and returns a short
   *  count instead of blocking/queueing when the socket buffer is full — unlike
   *  Bun's higher-level `ws.send()` on the HTTP/WS side, nothing retries the
   *  remainder for us. `flushPending` below is that retry, driven by both the
   *  writer and the socket's own `drain` event. */
  pending: Buffer[];
}

function flushPending(socket: Bun.Socket<UdsConnState>): void {
  const state = socket.data;
  for (let chunk = state.pending[0]; chunk !== undefined; chunk = state.pending[0]) {
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

/** Accept the wire on the daemon's UNIX socket (`paths.sock`): each
 * connection's lines go to handleRequest, its writes back are queued past
 * backpressure, and its close removes it from the daemon. */
export function listenUds(daemon: Daemon): Listener {
  return Bun.listen<UdsConnState>({
    unix: daemon.paths.sock,
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
}

export async function startDaemon(opts: StartOptions = {}): Promise<void> {
  const paths = resolvePaths();
  fs.mkdirSync(paths.stateDir, { recursive: true });
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

  migrateLegacyConfigFiles(paths, log);
  writeConfigTypesFile(paths.configDir, VERSION, log);
  const loaded = await loadConfig(paths, log);
  if (!loaded.ok) {
    // A configuration that does not read stops the daemon rather than starting
    // it with parts left out (DR-0038 §6). The lines go to daemon.log (and to
    // stderr in the foreground); a CLI that spawned this daemon prints them.
    log.error("config does not read; the daemon does not start");
    for (const line of loaded.errors) log.error(line);
    lock.release();
    process.exit(1);
  }
  const daemon = createDaemon({
    paths,
    config: loaded.config,
    log,
    lock,
    httpAllow,
    env: process.env,
    exit: () => process.exit(0),
  });

  daemon.webhooks = buildWebhookSources(daemon, log);
  daemon.llmStatusRefresher = createStatusRefresher(daemon);

  if (agentsPollEnabled()) {
    startAgentsPoller(
      daemon.agentsPoller,
      () => sessionScope(daemon),
      log,
      async (poll, polledAt) => {
        await syncSessionsFromAgents(daemon, poll);
        maybeBroadcastAgents(daemon, poll.agents, polledAt);
      },
      async (poll) => {
        await resolvePendingTranscripts(daemon, poll);
        // Every round, not only when the rows change: a run named since the
        // last round may find its process in rows that did not change, and a
        // harness that died leaves a run whose sidecar is still connected.
        const begunAfter = daemon.agentsRoundAt;
        daemon.agentsRoundAt = Date.now();
        const round = {
          agents: agentRows(poll.agents),
          answeredDirs: poll.answeredDirs.map((dir) => normalizeConfigDir(dir) ?? dir),
        };
        forgetUnlistedHellos(daemon, round.answeredDirs, begunAfter);
        const { found, dropped } = daemon.sidecarRuns.reconcile(round, begunAfter);
        for (const run of found) {
          daemon.log.info(`sidecar ${run.sid}.${run.runId} is pid=${String(run.pid)}`);
        }
        for (const run of dropped) {
          daemon.log.info(
            `sidecar ${run.sid}.${run.runId} dropped: its harness is gone` +
              (run.pid !== undefined ? ` (pid=${String(run.pid)})` : " (not listed)"),
          );
        }
        if (found.length > 0 || dropped.length > 0) refreshReadiness(daemon);
      },
    );
  }

  // `CCMSG_NETWORK_WATCH=off` turns the wake off — the switch exists for test
  // daemons, which would otherwise each carry a `route -n monitor` child and
  // hold api-error folds open with no user watching.
  if (process.env.CCMSG_NETWORK_WATCH !== "off") {
    const sourceFile = process.env.CCMSG_NETWORK_WATCH_FILE;
    daemon.networkWatch = createNetworkWatch({
      log,
      onOnline: () => {
        wakeStalledSessions(daemon).catch((e: unknown) => {
          log.info(`network online: wake failed: ${errorText(e)}`);
        });
      },
      ...(sourceFile ? fileNetworkSource(sourceFile) : {}),
      ...(process.env.CCMSG_NETWORK_WATCH_DEBOUNCE_MS
        ? { debounceMs: Number(process.env.CCMSG_NETWORK_WATCH_DEBOUNCE_MS) }
        : {}),
    });
  }

  // A daemon a test run spawned holds that run's lifeline before it accepts
  // anyone, so a client that reached it knows it is held; one whose run is
  // already gone shuts down without ever listening.
  const lifeline = process.env.CCMSG_TEST_LIFELINE;
  if (lifeline && lifeline !== "") {
    daemon.testLifeline = await holdTestLifeline(
      lifeline,
      paths.stateDir,
      () => void shutdownDaemon(daemon, "test run ended"),
    );
    if (daemon.shuttingDown) return;
  }

  // Launch outputs past their 7 days (DR-0018 §3.6) go before anyone can ask
  // for a launch that writes more.
  await pruneLaunchOutputs(paths.launches, Date.now(), log);

  // The pid file must exist by the time the socket accepts: a client that
  // connects and then reads the pid (the upgrade test does exactly this) would
  // otherwise race the write below listen().
  fs.writeFileSync(paths.pid, `${process.pid}\n`);
  daemon.server = listenUds(daemon);

  fs.chmodSync(paths.sock, 0o600);
  log.info(`listening on ${paths.sock} (v${VERSION})`);
  daemon.opHttp = listenOpHttp(daemon);
  log.info(`op http listening on ${paths.httpSock}`);

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
  if (httpListeners.length > 0) {
    daemon.webuiUrls = async () => webuiUrlsOf(httpAllowOrigin, await originsFile.get());
  }

  // Zero-config tailscale serve origin auto-allow (DR-0004 §3): best-effort, async,
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

  process.on("SIGTERM", () => void shutdownDaemon(daemon, "signal"));
  process.on("SIGINT", () => void shutdownDaemon(daemon, "signal"));
}
