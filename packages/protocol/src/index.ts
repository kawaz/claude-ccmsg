// Wire protocol & storage schema shared by daemon and cli (DR-0003).
//
// Two byte streams, both newline-delimited JSON ("jsonl", DR-0003 §1):
//   - storage: room event log, one <room-id>.jsonl per room, append-only
//   - wire: client<->daemon request/response, plus subscribe event stream
//
// `id` = typed member identifier, `u1`/`a3` style (DR-0006). The `u`/`a` namespace
// disambiguates human vs agent members sharing a single `from`/`to` field. `u1` is
// the reserved User (kawaz) admin, implicitly present in every room with no member
// row. `u2+` are guests (room-local, explicit member row, `role: "guest"`). Agents
// get `a1, a2, ...` in room join order. This is NOT the Unix UID.

export { VERSION } from "./version.ts";
export { compareVersions } from "./version-compare.ts";
export * from "./paths.ts";
export * from "./search-query.ts";
export * from "./file-search-query.ts";

/** Reserved id for the User (kawaz), admin role. Implicit member of every room. */
export const ADMIN_ID = "u1";

/** Default initial-delivery cap on join (DR-0003 §5, N=50). */
export const DEFAULT_JOIN_BACKLOG = 50;

/** Default dedup window for create_room (DR-0003 §4, minute-order). */
export const DEFAULT_DEDUP_WINDOW_MS = 60_000;

/** Default HTTP/WS bind for `/ws` (DR-0004 §3, 2026-07-10 trust-model addendum).
 *  `CCMSG_HTTP_BIND=off` disables it. Loopback only — a browser's Same-Origin
 *  Policy does not gate WebSocket connections, so binding beyond loopback (or
 *  trusting source-IP alone, e.g. a shared tailnet CGNAT range) would let any
 *  page a browser has open reach this daemon. tailscale serve (or any other
 *  reverse proxy) forwards to loopback from the outside; see `CCMSG_HTTP_ALLOW_ORIGIN`
 *  for allowing that proxy's Origin through the check below. */
export const DEFAULT_HTTP_BIND = "127.0.0.1:8642,[::1]:8642";

/** Default source-IP allowlist for `/ws` and HTTP fallback (DR-0004 §3 addendum,
 *  2026-07-10 trust-model addendum). loopback only — override with `CCMSG_HTTP_ALLOW`
 *  (comma-separated CIDR/IP). This is a defense-in-depth belt against a misconfigured
 *  `CCMSG_HTTP_BIND`; the actual trust boundary for browser clients is the `Origin`
 *  header check (see `CCMSG_HTTP_ALLOW_ORIGIN`), since source IP alone can't
 *  distinguish this daemon's own webui from any other page open in the same browser. */
export const DEFAULT_HTTP_ALLOW = "127.0.0.0/8,::1";

/** fs_read (DR-0008) sends at most this many bytes of a file's head; larger
 * files come back `truncated: true` so the viewer can say so instead of
 * silently showing a partial file. */
export const FS_READ_MAX_BYTES = 512 * 1024;

/** DR-0018 §3.1 defaults used when session launcher config omits or corrupts
 * the corresponding positive numeric fields. */
export const DEFAULT_DIR_TREE_DEPTH = 2;
export const DEFAULT_LAUNCH_TIMEOUT_SECONDS = 10;

/** Name given to the implicit single template a flat (pre-templates)
 * `session_launcher` config parses into. */
export const DEFAULT_LAUNCHER_TEMPLATE_NAME = "default";

/** One launch parameter a template declares: the shell variable name its
 * command may read, and the value the form opens with. The declaration is the
 * only source of truth for which variables exist — the launcher shell defines
 * exactly the declared ones (nothing else), and the webui renders one input per
 * declaration, in declaration order. */
export interface LauncherParam {
  /** A shell identifier (`[A-Za-z_][A-Za-z0-9_]*`), unique within one template.
   * Reaches the command as `$NAME`. Names the webui knows get a dedicated
   * widget (CWD a directory picker, MODEL/EFFORT a dropdown, PROMPT a
   * textarea); any other name gets a plain text input. */
  name: string;
  /** The form's initial value, and what its "default" button restores. Empty
   * string is the normal "user fills this in" case. */
  default: string;
}

/** Every template implicitly declares this parameter, because the launcher has
 * to have a directory to spawn in: it is the child process's working directory
 * and the one value checked against `root_dirs`. A config that omits it from a
 * template's `params` gets it prepended at parse time. */
export const LAUNCHER_CWD_PARAM = "CWD";

/** One named launch recipe in the parsed normal form of `session_launcher`.
 * Every field is fully resolved at parse time (a legacy config's inherited
 * `command`/`default_prompt`/`shell` and its implied parameter list are
 * normalized here), so nothing downstream has to re-apply fallbacks.
 *
 * `command` is a shell program, not an argv: its vocabulary is the shell
 * variables this template declares in `params`, which the launcher shell
 * defines from the request before running this text. The daemon never
 * substitutes anything into it. */
export interface SessionLauncherTemplate {
  /** Non-empty, unique within one launcher config. Shown verbatim in the
   * webui's template picker and named by SessionLaunchRequest.template. */
  name: string;
  command: string;
  /** Declared parameters in config order; always contains LAUNCHER_CWD_PARAM. */
  params: LauncherParam[];
  shell: "bash" | "zsh";
}

/** Parsed normal form of `<dataDir>/config.json`'s `session_launcher` key
 * (DR-0018 §3.1). Paths are home-expanded and absolute; shell is a deliberate
 * built-in choice so launch never falls through to an implicit `sh -c`.
 *
 * `templates` is always non-empty — a config that yields no usable template
 * disables the launcher entirely (same posture as a missing `command` before
 * templates existed). The flat single-command form stays valid and parses to
 * exactly one template; `templates[0]` is the launcher's default recipe. */
export interface SessionLauncherConfig {
  root_dirs: string[];
  templates: SessionLauncherTemplate[];
  timeout_seconds: number;
  dir_tree_depth: number;
  /** DR-0018 §3.1 addendum 2026-07-18: wildcard patterns naming environment
   * variables to REMOVE from the daemon's own environment before a launched
   * child inherits it. The daemon itself is typically started from inside a
   * Claude session's shell, so its process.env carries that origin session's
   * variables (CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, ANTHROPIC_*
   * …) which would silently reconfigure every launched session. `*` matches
   * any substring of a key name (no separator semantics); everything else is
   * literal, case-sensitive. Absent/empty = no cleaning (previous behavior).
   * The launcher's own `ccmsg_new_session_*` carriers (which the launcher
   * shell turns into the template variables) are layered on AFTER
   * cleaning, so they can never be removed by a pattern. */
  clean_env?: string[];
  /** DR-0018 §3.1 addendum 2026-07-18 (2nd): wildcard patterns naming
   * environment variables to KEEP even when a `clean_env` pattern matches
   * them — keep_env takes precedence over clean_env. Same pattern grammar as
   * clean_env (`*` = any substring, otherwise literal, case-sensitive,
   * anchored whole-key match). Motivation: a broad clean pattern like
   * `CLAUDE*` also removes CLAUDE_CONFIG_DIR, which the launched session
   * needs for config-plane isolation; the allowlist carves such exceptions
   * out of the broad removal. A key matching only keep_env (and no
   * clean_env pattern) is a no-op — it would have survived anyway. */
  keep_env?: string[];
}

/** transcript_read (DR-0009) returns at most this many bytes of jsonl lines
 * per request; the viewer pages with byte offsets instead of asking for more.
 * 1 MB (kawaz r76 m107、2026-07-31。500KB を試して増量)。旧 2 MB (kawaz
 * r15 mid=18 の「older 連打を減らす」判断) は全項目 DOM 化の描画コストが
 * 実測で判明した後 (issue timeline-virtual-scroll) には初期表示の重さ側が
 * 勝つため縮小した。 */
export const TRANSCRIPT_READ_MAX_BYTES = 1024 * 1024;

/** Historical session search response caps (DR-0021 Phase 1). These are wire
 * contract limits so every client can render truncation consistently. */
export const SESSION_SEARCH_RESULT_MAX = 50;
export const SESSION_SEARCH_MATCH_SUMMARY_MAX = 3;

// ---------------------------------------------------------------------------
// Storage events (room jsonl lines). File line order is the source of truth for
// ordering; `mid` (msg only) is a per-room daemon-assigned sequence. `seq`
// (DR-0016) is a SEPARATE per-room daemon-assigned sequence spanning ALL event
// types (msg, member, leave, next, prev, title, archive, kind) — the cursor
// coordinate for subscribe reconnect. Optional only for pre-append event
// construction (caller hasn't been stamped yet) and legacy log rows written
// before this field existed (in-memory backfilled by loadRoom, see storage.ts);
// every appended/delivered event carries one.
// ---------------------------------------------------------------------------

export interface MemberEvent {
  type: "member";
  id: string;
  sid: string;
  repo: string;
  ws: string;
  cwd: string;
  joined_at: string;
  /** guest role marker; absent = regular member (agent, or admin's implicit row is absent entirely). */
  role?: "admin" | "guest";
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
}

export interface LeaveEvent {
  type: "leave";
  id: string;
  ts: string;
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
}

export interface MsgEvent {
  type: "msg";
  mid: number;
  from: string;
  /** DELIVERY targets, member id[]. Absent = deliver to every member. When
   * present, the subscribe stream (live and since-replay both) delivers this
   * msg only to the listed members, the sender, and the admin User (u1 —
   * exempt because the webui is an observation surface and the User has no
   * agent-style context cost). NOT a storage/visibility filter: the event
   * stays in the room log, every member sees the mid gap in `rooms` /
   * neighboring mids, and `read` serves it to any member on request
   * (deliberate pull, kawaz 2026-07-12: skipped mids signal "a conversation
   * you weren't part of happened; read it iff you care"). */
  to?: string[];
  ts: string;
  msg: string;
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
  /** the msg this one replies to, as "r<N>m<M>" (DR-0017 §2.2). Recorded by
   * the daemon's reply op (never client-supplied); absent on plain posts.
   * Persisted in the room jsonl — future thread-display material. */
  reply_to?: string;
}

export interface NextEvent {
  type: "next";
  room: string;
  ts: string;
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
}

export interface PrevEvent {
  type: "prev";
  room: string;
  ts: string;
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
}

export interface TitleEvent {
  type: "title";
  title: string;
  ts: string;
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
}

/** Room archive toggle (DR-0012): a display-organization flag, NOT a lifecycle
 * change — an archived room still accepts posts and still delivers events.
 * Appended per toggle; the log's LAST archive event wins (same rule as title). */
export interface ArchiveEvent {
  type: "archive";
  archived: boolean;
  ts: string;
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
}

/** Room kind marker (DR-0013 broadcast / DR-0014 1on1). Written exactly once
 * at room creation for non-`"normal"` rooms — a normal room carries no `kind`
 * event and defaults to `"normal"` on load. Persisting it as its own event
 * keeps rooms/*.jsonl append-only and lets scanRooms recover the kind on
 * daemon restart without inventing a separate metadata sidecar. `"normal"` is
 * the absence of this event. */
export interface KindEvent {
  type: "kind";
  kind: "broadcast" | "1on1";
  ts: string;
  /** per-room sequence number (DR-0016), see file banner above. */
  seq?: number;
}

export type StorageEvent =
  | MemberEvent
  | LeaveEvent
  | MsgEvent
  | NextEvent
  | PrevEvent
  | TitleEvent
  | ArchiveEvent
  | KindEvent;

/** Room kind (DR-0013 broadcast / DR-0014 1on1).
 * - `"normal"` = every other room (default).
 * - `"broadcast"` = auto-populated by session lifecycle, agent post is
 *   restricted to `to: ["u1", ...]`, member/leave events are suppressed from
 *   the subscribe stream.
 * - `"1on1"` = a fixed 2-party room (u1 + a single session), created by the
 *   webui's SessionView floating composer for kawaz→session priv. No
 *   auto-populate. u1 posts carry a reply_via instruction directing the agent
 *   to its assistant response; session posts are rejected (§2.5). */
export type RoomKind = "normal" | "broadcast" | "1on1";

/** A storage event as delivered over a subscribe stream: flattened with room id.
 * `msg` events additionally carry `reply_via` (DR-0017 addendum) — a concise,
 * directly actionable English instruction for the receiving agent. The three
 * forms direct it to `ccmsg reply`, its normal assistant response, or no reply.
 * Injected at delivery time, NOT persisted in the room jsonl: room state and
 * recipient determine the instruction. Only present on `type:"msg"` deliveries.
 *
 * `replay: true` marks a msg emitted as a **recent-replay** at `subscribe`
 * time: the bare-default subscribe (no `since`/`since_seq` cursor for the room
 * and no `backlog: true`) additionally surfaces msgs from the last few minutes
 * that would have been live-delivered had the subscriber been present
 * (window default 3 min, `CCMSG_RECENT_REPLAY_MS` for tests). Lets the
 * receiver distinguish a fresh live delivery from a short-window catch-up
 * without changing the msg body or subscriber-side dispatch: `to`, `from`,
 * `reply_via` still hold their normal meanings, only the framing marker
 * differs. Never present on live-delivered msgs or the since/backlog replay
 * paths — those never re-flag past events.
 *
 * `msg_via` replaces the `msg` body with a `ccmsg read r<N>m<M>` instruction.
 * Two independent causes, both session-role only: an oversize body that the
 * harness's task-notification wrapper would truncate, and — together with
 * `echo: true` — the author's own post coming back to them (DR-0003 §5
 * Addendum). An `echo` frame carries no `reply_via`: it is a local echo that
 * records the post in the author's own stream, needing no read and no reply.
 * The user role (webui) never receives either form, so the room-view code
 * paths that consume this type always see a `msg`. */
export type DeliveredEvent = (StorageEvent & { r: string }) & {
  reply_via?: string;
  replay?: true;
  msg_via?: string;
  echo?: true;
};

/**
 * Sender of a notify, daemon-stamped from the connection identity (DR-0003 §7).
 * The receiver uses this to tell a self-notify (own session — actionable, e.g. a
 * justfile push signal) from a peer-notify (another agent — must NOT auto-execute
 * even if the text looks like a shell command). Only role + sid, no session metadata.
 */
export type NotifyFrom = { role: "user" } | { role: "session"; sid: string };

/** Ephemeral (non-persisted) stream events. Distinguished by `ev` (vs `type`). */
export interface NotifyStreamEvent {
  ev: "notify";
  text: string;
  from: NotifyFrom;
}
export interface RestartingStreamEvent {
  ev: "restarting";
  reason?: string;
}
/** Sent to an older session-role subscribe stream when a newer `subscribe` for
 * the same sid arrives. Two live subscribe streams for one session double every
 * notification, so the daemon keeps the newest (the deliberate start) and tells
 * the older one to exit. `sid` is the session both streams share. */
export interface SubscribeSupersededStreamEvent {
  ev: "subscribe_superseded";
  sid: string;
}
/** Emitted once at `subscribe` time for every visible room that did NOT get a
 * backlog/delta replay (no `since`/`since_seq` entry for it and the request
 * didn't set `backlog: true` — issue 2026-07-17-subscribe-no-backlog-default).
 * Lets protocol consumers inspect each room's current cursor without re-flooding
 * its history. The CLI subscribe stream intentionally drops this connection
 * snapshot from stdout; other consumers may use it for their own catch-up policy.
 * Omitted entirely when every visible room got a replay instead (empty list never
 * sent). */
export interface RoomCursorsStreamEvent {
  ev: "room_cursors";
  rooms: Array<{ room: string; last_mid: number }>;
}
/** Push update of the `claude agents --json` poll result (user-role subscribers
 * only). Emitted when the merged agent list changes; the daemon polls only
 * while at least one user-role subscriber is connected. */
export interface AgentsStreamEvent {
  ev: "agents";
  agents: AgentInfo[];
  polled_at: string;
}
/** Push update of the connected-session list (user-role subscribers only,
 * same shape the `peers` op returns). Emitted whenever a session registers
 * (hello), fully disconnects, or updates its hello metadata — so the webui's
 * member-connectivity display (chip greying) and session list stay live
 * without manual refresh (issue 2026-07-12-peers-live-update-protocol). */
export interface PeersStreamEvent {
  ev: "peers";
  peers: PeerInfo[];
}
/** Appended transcript lines for a session the subscriber asked to follow via
 * transcript_subscribe (DR-0009 live-tail addendum). Only complete jsonl lines
 * are delivered; byte offsets line up with transcript_read paging so a client
 * can stitch tail events onto a paged view without re-reading. */
export interface TranscriptStreamEvent {
  ev: "transcript";
  sid: string;
  lines: string[];
  start: number;
  end: number;
  size: number;
}

/** How long an upstream prompt cache entry stays warm after a request. The
 * daemon prunes its per-sid cache with it and the webui counts down to it, so
 * both sides must agree on the same deadline. */
export const LLM_PROMPT_CACHE_TTL_MS = 5 * 60 * 1000;

/** One upstream LLM request as the gateway observed it (its
 * `event: request` SSE payload, minus the fields ccmsg has no use for).
 * `session_id` is the Claude Code session id the gateway read off the
 * request header, which is the same identifier ccmsg keys sessions by — that
 * shared key is what lets a browser tab put a countdown on a session row.
 * Requests the gateway could not attribute to a session are dropped by the
 * daemon and never appear here. */
export interface LlmRequestInfo {
  /** Epoch SECONDS (not ms — the gateway's unit, kept verbatim so the two
   * sides never disagree about a converted value) at which the upstream
   * response headers arrived. This is the instant the prompt cache TTL starts
   * running, not when the request was sent. */
  ts: number;
  /** ccmsg sid (`X-Claude-Code-Session-Id`). Never empty. */
  session_id: string;
  /** Conversation-series id: the gateway's 8-hex digest of the first system
   * prompt block. A session's subagents travel under the SAME session_id but a
   * DIFFERENT prefix, and their cache entries are genuinely separate — so a
   * cache window belongs to (session_id, prefix), never to session_id alone.
   * Empty string for events from a gateway older than v0.13.0, which reports
   * no prefix; those collapse to one unnamed series per session, the behaviour
   * ccmsg had before prefixes existed.
   *
   * NOTE: prefixes are not globally unique — two different sessions can share
   * one (identical leading system block), which is why the pair is the key. */
  prefix: string;
  /** True for the session's primary series: the one whose cache window the
   * session's own turns keep alive, as opposed to a subagent's. The daemon
   * decides this (first series it sees for the sid, re-learned once that
   * series goes cold), so every client agrees on which ring to draw. */
  main: boolean;
  ns?: string;
  model?: string;
  credential?: string;
  status?: number;
}

/** Push of the most recent LLM request per conversation series (user-role
 * only, same webui-only posture as ev:"agents"/ev:"peers"). Always the full
 * non-expired set rather than the one request that just arrived: a client
 * that connects mid-window — a browser reload, or a tab opened after the
 * session's request was already in flight — still needs the countdown that
 * started before it was listening, and one snapshot shape serves both the
 * subscribe-time catch-up and the live update. Entries past
 * LLM_PROMPT_CACHE_TTL_MS are pruned before sending, so an empty list is a
 * legitimate "no session has a warm cache". */
export interface LlmRequestsStreamEvent {
  ev: "llm_requests";
  requests: LlmRequestInfo[];
}

/** DR-0020 Phase 1: folded current status of a session's transcript. */
export interface SessionTodo {
  id: string;
  subject: string;
  /** "pending" | "in_progress" | "completed" — open set (upstream may add values). */
  status: string;
  owner?: string;
  /** DR-0020 addendum (r38 mid=4): task ID list this task is blocked by, folded
   * from TaskUpdate's `addBlockedBy` input (or task_reminder attachment when
   * present). Sorted numerically-first (id は文字列だが実データは "1", "2" 形式
   * が主なので数値順に見せた方が読み手が直感的)。Empty array is omitted
   * (undefined) — the UI treats no field / empty the same way. */
  blocked_by?: string[];
  /** Same shape as `blocked_by` but for tasks this task blocks (TaskUpdate の
   * `addBlocks`)。UI では現状表示していないが、fold は対称に保つ。 */
  blocks?: string[];
}
/** DR-0025 Phase 1: one row of a workflow's phase progress (name + done/total
 * count). Present only when the workflow's state json (written on completion)
 * carries a `workflowProgress` array — a still-running workflow has no such
 * file, so `phases` is intentionally undefined for it (running-workflow
 * agents alone are folded from the run directory's journal.jsonl). */
export interface WorkflowPhaseStatus {
  title: string;
  done: number;
  total: number;
}
/** DR-0025 Phase 1: one agent belonging to a workflow. `agent_id` is the
 * `a<...>` slug that `transcript_read`'s `agent_id`/`run_id` resolver accepts
 * (see `AgentTranscriptRequest` doc). Every rich field is optional because
 * the underlying `workflowProgress` entries carry different shapes for
 * `state === "done"`/`"error"`/`"progress"` (some omit `tokens`, `agent_type`,
 * `duration_ms`, etc.) and journal-only running rows expose almost nothing
 * beyond agentId + running flag. */
export interface WorkflowAgentStatus {
  agent_id: string;
  label?: string;
  model?: string;
  agent_type?: string;
  /** "done" | "error" | "progress" | "running" — open set: `done`/`error`/
   * `progress` come from the state json's workflow_agent entries, `running`
   * is synthesized when a journal `started` row has no matching `result`. */
  state: string;
  tokens?: number;
  tool_calls?: number;
  phase_index?: number;
  phase_title?: string;
  last_tool?: string;
  result_preview?: string;
  error?: string;
  /** epoch ms as recorded in the state json (numbers, not ISO strings). */
  started_at?: number;
  duration_ms?: number;
}
export interface SessionWorkflowStatus {
  /** task-notification correlation id (Workflow result taskId). */
  task_id: string;
  name: string;
  summary?: string;
  /** "running" | terminal task-notification values — open set. */
  status: string;
  started_at: string;
  ended_at?: string;
  /** DR-0025 Phase 1: the workflow's runId (`wf_XXXXXXXX-XXX`) folded from
   * the transcript's Workflow toolUseResult. Feeds the `run_id` argument of
   * `transcript_read` for agents that belong to this run. */
  run_id?: string;
  /** DR-0025 Phase 1: undefined while the workflow is running (no state json
   * yet); present once the completion-time state json exists. */
  phases?: WorkflowPhaseStatus[];
  /** DR-0025 Phase 1: workflow agents (from state json when available; from
   * journal.jsonl fallback while still running). Undefined = fold could not
   * find anything readable in the run directory. */
  agents?: WorkflowAgentStatus[];
}
export interface SessionBackgroundStatus {
  /** Monitor/Bash taskId or Agent agentId. */
  task_id: string;
  kind: "monitor" | "bash" | "agent";
  description: string;
  /** "running" | terminal task-notification values — open set. */
  status: string;
  started_at: string;
  ended_at?: string;
  /** r44 m6: for kind=="agent", the spawn's `subagent_type` (`general-purpose`,
   * `Explore`, custom agent name...). Absent when the input row omitted it,
   * or when kind is not "agent". Not present for monitor/bash entries. */
  agent_type?: string;
}
/** Main-context observation from the latest non-sidechain, non-synthetic
 * assistant row. Environment overrides are not recorded in transcripts, so
 * the daemon transports raw values and leaves limit estimation to clients. */
export interface SessionContextUsage {
  /** input_tokens + cache_read_input_tokens + cache_creation_input_tokens. */
  tokens: number;
  /** Raw message.model value; launch-only suffixes such as [1m] are absent. */
  model: string;
  /** Top-level `effort` of the transcript assistant row. Rows from older CC
   * versions (observed absent at ≤2.1.211) do not carry it, so it stays
   * optional. Latest observed value, taken from the same row as `model`. */
  effort?: string;
  /** Timestamp of the assistant row carrying this observation. */
  timestamp: string;
}
/** Last transcript-observed activity for one agent-teams teammate. The TUI's
 * internal liveness state is unavailable, so `state` is an open-set estimate. */
export interface SessionTeammate {
  name: string;
  /** Whether a successful Agent result with status:"teammate_spawned" was observed. */
  spawned: boolean;
  agent_type?: string;
  color?: string;
  spawned_at?: string;
  last_sent_at?: string;
  last_received_at?: string;
  /** "spawned" | "active" | "idle" | "stopped" — open set, based on the latest observed event. */
  state: string;
  /** Model from `subagents/agent-*.meta.json` (fixed at spawn, raw value
   * including any `[1m]` suffix). Absent when no meta.json was found. */
  model?: string;
}
/** r44 m7: recursive agent tree rooted at the session, one node per
 * `subagents/agent-<agentId>.meta.json`. Direct children of the root session
 * appear at the top level of `SessionStatusSnapshot.agent_tree`; deeper
 * subagents nest under `children`. Depth is capped at 5 (root's direct
 * children = depth 0), matching CC's own spawnDepth ceiling; nodes with
 * `spawn_depth > 5` are dropped. Nodes whose `meta.toolUseId` cannot be
 * located in any candidate parent transcript (orphan — parent already
 * rotated / never observed) are surfaced at the top level so they remain
 * navigable rather than silently disappearing. */
export interface AgentTreeNode {
  /** stable id from the meta.json filename (`agent-<agentId>.meta.json`).
   * Used as the react key and as the `agentId` argument to
   * `agentTimelineHref`. */
  agent_id: string;
  /** teammate name (agent-teams `name` from meta.json) — present only for
   * teammate nodes. When set, the TL link uses the teammate ref instead of
   * the agentId ref (they resolve the same transcript but the teammate
   * locator is the observable identity for agent-teams). */
  teammate_name?: string;
  /** meta.json `agentType` — CC-side agent role (`Explore`, `general-purpose`,
   * a custom agent name, or the teammate role slug). Absent only when the
   * meta.json is malformed. */
  agent_type?: string;
  /** meta.json `description` — the spawn call's description, verbatim. */
  description?: string;
  /** teammate-only fields (mirror SessionTeammate). */
  color?: string;
  model?: string;
  team_name?: string;
  /** meta.json `spawnDepth` (0-based; root's direct child = 0). */
  spawn_depth: number;
  /** ノードの由来:
   *   - "teammate"        — agent-teams の長期在住メンバー (`taskKind ===
   *     "in_process_teammate"`)。
   *   - "subagent"        — 単発 Agent tool 起動 (sync/async 問わず)。
   *     plugin/skill 由来の `agentType`(`:` を含む) もこちらに含める。
   *   - "workflow_member" — `subagents/workflows/<runId>/agent-*.meta.json`
   *     配下のワークフロー構成員。ルート集約側では workflow run 単位に
   *     `AgentTreeGroups.workflows[]` としてネストされる。 */
  kind: "teammate" | "subagent" | "workflow_member";
  /** workflow_member 限定。所属 run の id (`wf_XXXXXXXX-XXX`)。 */
  workflow_id?: string;
  /** Estimated liveness state, open-set: "active" | "idle" | "spawned" |
   * "stopped" | "completed" | "unknown". Depth-0 nodes reuse the fold's
   * background/teammate state (transcript-observed); deeper nodes fall back
   * to a transcript-mtime heuristic — see readAgentTree's Design rationale
   * for the limitation. */
  state: string;
  /** transcript file mtime (ms since epoch), used both by the UI to show
   * relative age and by depth≥1's live heuristic. */
  last_activity_ms?: number;
  /** child nodes, already depth-capped and dedup-guarded by transcript path. */
  children: AgentTreeNode[];
}

/** r46 m8: エージェントツリーのルート集約。種別ごとに 3 グループに分ける
 * (kawaz「ルートはその辺で分けるべき」)。同一種別のノードは (親子関係が
 * 通常はフラットなので) 各配列に並列で並ぶ。空カテゴリ (= 0 件) は空配列を
 * 返す — UI 側でヘッダごと非表示にする。 */
export interface AgentTreeGroups {
  /** agent-teams の在住メンバー。root 直下 = depth 0。 */
  teammates: AgentTreeNode[];
  /** 単発 Agent 起動 (plugin/skill 由来含む)。親子関係がある場合は
   * `children` にネストする (既存挙動)。 */
  agents: AgentTreeNode[];
  /** ワークフロー run 単位。1 run = 1 subgroup。 */
  workflows: AgentTreeWorkflowGroup[];
}

/** r46 m8 / m12: 1 workflow run 分の subgroup。フェーズ情報の出典は
 * `readWorkflowDrilldown` (state.json → journal.jsonl の 2 段フォールバック、
 * DR-0025 Phase 1)。既存 `SessionWorkflowStatus.phases` / `.agents` と同一
 * ソースを再利用する = TUI / SessionStatusView の phase 表示と数値が揃う。 */
export interface AgentTreeWorkflowGroup {
  /** `wf_XXXXXXXX-XXX` (RUN_ID_RE)。 */
  workflow_id: string;
  /** run 全体の done/total (all agents 集計)。UI ヘッダの
   *「Workflow wf_xxx  4/6」表示に使う。 */
  done: number;
  total: number;
  /** 宣言済みフェーズ (state.json 由来)。run 中で state.json が未 landing の
   * 場合は空配列 (このとき agents は `unassigned` に流れる、フェーズ未知)。 */
  phases: AgentTreeWorkflowPhase[];
  /** phase_index を持たない member (state.json 未 landing の run 中、または
   * drilldown が phase を割当てられなかった変則) の fallback bucket。
   * 通常は空。空でない場合 UI は「(phase 未確定)」ヘッダで並べる。 */
  unassigned: AgentTreeNode[];
  /** run 内 member で最も新しい `last_activity_ms`。run 単位のソート用。 */
  last_activity_ms?: number;
}

/** r46 m12: workflow run 内の 1 フェーズ (title + 完了/総数 + 構成 member)。 */
export interface AgentTreeWorkflowPhase {
  /** 1-based (readWorkflowDrilldown の canonical index を踏襲)。 */
  index: number;
  title: string;
  done: number;
  total: number;
  /** 当該フェーズに割当てられた member (順序は drilldown 出現順)。 */
  members: AgentTreeNode[];
}

/** Which kind of transcript record named a DR-0024 external file. The webui
 * groups the "プロジェクト外" section by it; authorization ignores it (every
 * origin grants the same exact-path read). `tool` covers the file tools
 * (Read/Write/Edit/MultiEdit/NotebookEdit) and the `! <cmd>` persisted-output
 * sidecar; `attachment` covers file-shaped attachment rows. A path named by
 * both is reported as `tool`, whichever came first. */
export type ExternalFileOrigin = "tool" | "attachment";

export interface ExternalFile {
  path: string;
  origin: ExternalFileOrigin;
}

export interface SessionStatusSnapshot {
  todos: SessionTodo[];
  workflows: SessionWorkflowStatus[];
  background: SessionBackgroundStatus[];
  context?: SessionContextUsage;
  /** Absent only for older/locally constructed snapshots; daemon snapshots carry an array. */
  teammates?: SessionTeammate[];
  /** r44 m7 / r46 m8: セッションが起点となるエージェントツリーの種別別集約。
   * `subagents/` が無い、または全カテゴリ空のセッションでは省略される。
   * カテゴリ内のノードは `AgentTreeNode` (深さ上限つきの再帰木) が並ぶ。
   * 完了 (state) 毎の 2 分割は UI 側で行い、daemon は state を保持して
   * そのまま返す。 */
  agent_tree?: AgentTreeGroups;
  /** DR-0024: absolute paths outside the session's containment root that the
   * transcript names. Existing targets are realpaths; missing/deleted targets
   * retain a normalized lexical path. This is exactly the allowlist accepted by
   * fs_read_external — one list, so an allowlist consumer cannot honour one
   * origin and forget another. */
  external_files?: ExternalFile[];
  /** DR-0026: VS Code `.code-workspace` folders discovered directly under the
   * session's cwd. Each `path` is a realpath-resolved absolute directory —
   * the same absolute prefix accepted by fs_list_workspace / fs_read_workspace
   * as an allowlist for directory-scoped reads outside the containment root.
   * `name` mirrors the workspace file entry (falls back to basename when
   * `folders[].name` is absent). Deduplicated by realpath — the same folder
   * referenced twice (or via two different workspace files) appears once. */
  workspace_folders?: WorkspaceFolder[];
  /** Present iff the session's latest main-context turn ended with a harness
   * API-error row — the session is stopped waiting for the user, not working.
   * Absent for a healthy session (see SessionApiError for the exact rule). */
  api_error?: SessionApiError;
}

/** A harness-synthesized API-error row observed as the last thing the main
 * context did (`{"type":"assistant","isApiErrorMessage":true,...}` with
 * `message.model === "<synthetic>"`). Claude Code writes these in the agent's
 * own voice — "Prompt is too long", "API Error: 500 ...", "You're out of extra
 * usage · resets 7pm", "Please run /login" — but they are the CLI reporting a
 * stopped turn, not the agent speaking, and the session sits idle until the
 * user intervenes.
 *
 * Only the *latest* turn counts: a later real assistant row clears this, so a
 * session that hit a transient connection error and recovered is not flagged.
 * Sidechain (subagent) error rows never set it — a failed subagent does not
 * stop the main context. */
export interface SessionApiError {
  /** Verbatim error text of the row, so a client can show *why* the session
   * stopped. Concatenation of the row's text blocks; may be multi-line. */
  text: string;
  /** ISO timestamp of the error row. */
  timestamp: string;
}

/** DR-0026 workspace folder descriptor: one entry from the `folders[]` array
 * of a `*.code-workspace` file discovered under the session cwd, resolved to
 * a realpath. `path` is the allowlist key fs_list_workspace / fs_read_workspace
 * check against; `name` is display-only. */
export interface WorkspaceFolder {
  /** display name — `folders[].name` from the workspace file, or the folder's
   * basename when `name` is absent. Never empty. */
  name: string;
  /** absolute realpath of the folder — allowlist prefix for fs_list_workspace
   * / fs_read_workspace. Never a trailing separator (except at filesystem
   * root itself). */
  path: string;
}
/** Full recomputed snapshot pushed after a status-changing transcript event. */
export interface SessionStatusStreamEvent extends SessionStatusSnapshot {
  ev: "session_status";
  sid: string;
}
/** Push update of the set of connected sessions stopped on a harness API
 * error (user-role subscribers only, same shape the `session_errors` op
 * returns). Emitted whenever that set changes — a session hitting an error,
 * recovering from one, or disconnecting while flagged. Always the full list,
 * not a delta, so a client that missed a push still converges. */
export interface SessionErrorsStreamEvent {
  ev: "session_errors";
  errors: SessionErrorEntry[];
}

/** Sent to a single session whose last turn stopped on a harness API error,
 * when the host's network comes back. It carries no room and no seq: the point
 * is the delivery itself, which reaches the session's `subscribe` stream and
 * re-prompts it — the same effect as a human typing one character into the
 * stalled session. Sessions that are not stopped on an error never receive it,
 * and one recovery produces at most one of these per stopped session. */
export interface NetworkOnlineStreamEvent {
  ev: "net_online";
  /** Why the session is being woken and what to do, in one line. */
  text: string;
  /** Timestamp of the API-error row this wake is for, so a session (or a log
   * reader) can tell which stall it answers. */
  error_ts: string;
}

/** Completion of a 2-phase `translate` request (see TranslateRequest's doc
 * comment for why the reply is split). Pushed to the requesting connection
 * only, correlated by the client-generated `request_id` from the request.
 * Carries the same success/error payload a deferred reply would have carried —
 * including per-op failures like translate_unavailable, which after the
 * immediate ack can only travel on this event. NOTE for client authors:
 * result events carry `ok`, so a frame must be classified as push-vs-reply by
 * the presence of `ev`, never by `ok` alone. */
export type TranslateResultEvent = {
  ev: "translate_result";
  request_id: string;
} & (TranslateResponse | ErrorResponse);

/** Completion of a 2-phase `session_launch` request (see SessionLaunchRequest's
 * doc comment). Same correlation/classification rules as TranslateResultEvent. */
export type SessionLaunchResultEvent = {
  ev: "session_launch_result";
  request_id: string;
} & (SessionLaunchResponse | ErrorResponse);

/** Completion of a 2-phase `session_kill` request (see SessionKillRequest's
 * doc comment). Same correlation/classification rules as TranslateResultEvent. */
export type SessionKillResultEvent = {
  ev: "session_kill_result";
  request_id: string;
} & (SessionKillResponse | ErrorResponse);

/** Completion of a 2-phase `session_env` request (see SessionEnvRequest's
 * doc comment). Same correlation/classification rules as TranslateResultEvent. */
export type SessionEnvResultEvent = {
  ev: "session_env_result";
  request_id: string;
} & (SessionEnvResponse | ErrorResponse);

/** Completion of a 2-phase `session_search` request (see SessionSearchRequest's
 * request_id doc comment). Same correlation/classification rules as
 * TranslateResultEvent. */
export type SessionSearchResultEvent = {
  ev: "session_search_result";
  request_id: string;
} & (SessionSearchResponse | ErrorResponse);

/** Completion of a 2-phase `fork_origin` request (see ForkOriginRequest's doc
 * comment). Same correlation/classification rules as TranslateResultEvent. */
export type ForkOriginResultEvent = {
  ev: "fork_origin_result";
  request_id: string;
} & (ForkOriginResponse | ErrorResponse);

/** Completion of a 2-phase `llm_usage` request (see LlmUsageRequest's doc
 * comment). Same correlation/classification rules as TranslateResultEvent. */
export type LlmUsageResultEvent = {
  ev: "llm_usage_result";
  request_id: string;
} & (LlmUsageResponse | ErrorResponse);

/** Completion of a 2-phase `llm_stats` request (see LlmStatsRequest's doc
 * comment). Same correlation/classification rules as TranslateResultEvent. */
export type LlmStatsResultEvent = {
  ev: "llm_stats_result";
  request_id: string;
} & (LlmStatsResponse | ErrorResponse);

export type StreamEvent =
  | DeliveredEvent
  | NotifyStreamEvent
  | RestartingStreamEvent
  | SubscribeSupersededStreamEvent
  | RoomCursorsStreamEvent
  | AgentsStreamEvent
  | PeersStreamEvent
  | TranscriptStreamEvent
  | SessionStatusStreamEvent
  | SessionErrorsStreamEvent
  | LlmRequestsStreamEvent
  | TranslateResultEvent
  | SessionLaunchResultEvent
  | SessionKillResultEvent
  | SessionEnvResultEvent
  | SessionSearchResultEvent
  | ForkOriginResultEvent
  | LlmUsageResultEvent
  | LlmStatsResultEvent;

// ---------------------------------------------------------------------------
// Wire: identity
// ---------------------------------------------------------------------------

export interface SessionIdentity {
  role: "session";
  sid: string;
  repo: string;
  ws: string;
  cwd: string;
  /** absolute path of this session's Claude Code transcript jsonl (DR-0009).
   * Sourced by the CLI's resolveIdentity from the SessionStart/UserPromptSubmit
   * hooks' session state file (`<stateDir>/sessions/<sid>.json`), or from
   * CCMSG_TRANSCRIPT_PATH as an override; the daemon validates it at hello time
   * and it is the ONLY file transcript_read serves for this sid. */
  transcript_path?: string;
  /** absolute path of the repository container holding ALL of this repo's
   * workspaces/worktrees (DR-0008 addendum). When announced and accepted by
   * the daemon's hello-time validation (absolute, realpath-resolvable, a
   * strict ancestor of cwd, not "/" or $HOME itself), it becomes the
   * containment root and fs_list/fs_read base so sibling workspaces are
   * browsable. fs_write remains cwd-relative inside that boundary. Rejected or
   * absent = cwd is both the browse base and containment root. */
  repo_root?: string;
  /** current branch / bookmark name of the session's checkout (informational,
   * for the webui session list). Empty/absent when detached or unknown. */
  branch?: string;
}
export interface UserIdentity {
  role: "user";
}
export type Identity = SessionIdentity | UserIdentity;

// ---------------------------------------------------------------------------
// Wire: requests (client -> daemon), one JSON per line
// ---------------------------------------------------------------------------

export interface HelloRequest {
  op: "hello";
  role: "session" | "user";
  sid?: string;
  repo?: string;
  ws?: string;
  cwd?: string;
  transcript_path?: string;
  repo_root?: string;
  branch?: string;
}

/** Post a new message. Session-authored posts to a 1on1 room are rejected
 * with `reply_via_tl`; that room's response path is the assistant transcript.
 * User-authored webui posts remain allowed. */
export interface PostRequest {
  op: "post";
  room: string;
  msg: string;
  /** delivery target member id(s) (see MsgEvent.to). string | string[];
   * absent = deliver to everyone. */
  to?: string | string[];
}

/** Reply to an existing msg (DR-0017 §2.2): the daemon computes the delivery
 * targets from the referenced msg — `to` = original from + (original to −
 * replier) + u1 — so the replier never assembles a `to` list. The appended
 * MsgEvent records `reply_to: "r<N>m<M>"` (thread material). Errors:
 * msg_not_found / self_reply / reply_via_tl (the msg's route is the assistant
 * transcript, not the room). */
export interface ReplyRequest {
  op: "reply";
  room: string;
  mid: number;
  msg: string;
}

export interface CreateRoomRequest {
  op: "create_room";
  /** participant sids. If the caller is a session and include_self is not false,
   * the caller's own sid is auto-prepended (dedup-safe, see server.ts create_room). */
  members: string[];
  msg?: string;
  title?: string;
  /** Default true. When false, a session caller is NOT auto-added to the room's
   * members — used by the CLI's `--exclude-self` opt-out when the caller wants
   * a room that observes without participating. Ignored for user-role callers
   * (who never auto-include either way). */
  include_self?: boolean;
  /** Room kind (DR-0013 broadcast / DR-0014 1on1). Default `"normal"`.
   * - `"broadcast"` opens a broadcast room whose members are auto-populated
   *   from the live session registry — `members` is ignored and the daemon
   *   returns a `warning` field explaining so (§2.9).
   * - `"1on1"` opens a 2-party priv room (u1 + a single session). `members`
   *   MUST contain exactly one sid; empty or multiple returns
   *   `one_on_one_requires_single_member` (DR-0014 §2.1). */
  kind?: RoomKind;
}

export interface NextRoomRequest {
  op: "next_room";
  room: string;
  msg?: string;
  title?: string;
}

/** Rename a room: appends a TitleEvent to the room log (the log's LAST title
 * event wins, same rule create_room/next_room titles already follow) and
 * broadcasts it to subscribers. Allowed for the admin User and for member
 * sessions of the room. */
export interface SetTitleRequest {
  op: "set_title";
  room: string;
  title: string;
}

/** Toggle a room's archived flag (DR-0012). Same permission as set_title
 * (admin User or member session). Appends an ArchiveEvent + broadcasts it;
 * the webui folds archived rooms into an "アーカイブ" section at the bottom
 * of the room list. No behavioral change to the room itself. */
export interface ArchiveRoomRequest {
  op: "archive_room";
  room: string;
  archived: boolean;
}

/** Force-remove a member from a room (DR-0012, webui の ✕ ボタン). Appends
 * the same LeaveEvent a voluntary `leave` would and broadcasts it. Admin
 * User only — a room's agents must not be able to evict each other. NOT a
 * ban: nothing prevents a later re-invite/re-join (deliberate, kawaz
 * 2026-07-12: 「再joinを制限までは今のとこ不要」). */
export interface KickRequest {
  op: "kick";
  room: string;
  /** member id (e.g. "a2") as shown in the room's member list */
  id: string;
}

export interface SubscribeRequest {
  op: "subscribe";
  /** per-room last-seen mid for delta replay (BBS model, DR-0003 §5). Retained
   * for old-client compat; a room present in `since_seq` uses that cursor
   * instead (DR-0016 §2.3). */
  since?: Record<string, number>;
  /** per-room last-seen seq for delta replay, spanning ALL event types
   * (DR-0016 §2.3) — supersedes `since` (mid, msg-only) for any room key it
   * covers. Do NOT derive this from a stored `since` value: seq >= mid always
   * holds, so reinterpreting a mid as a seq would skip events. */
  since_seq?: Record<string, number>;
  /** Opt into the legacy per-room snapshot/full-replay for any visible room
   * NOT covered by `since`/`since_seq` (issue 2026-07-17-subscribe-no-backlog-default).
   * Without this, such a room gets no backlog at all — only a `room_cursors`
   * summary event — so a fresh CLI sidecar connect doesn't re-flood a room's
   * history. The webui sets this unconditionally (it paints room history from
   * the backlog); rooms it already has a `since_seq` cursor for still take the
   * cheaper delta-replay path regardless of this flag. */
  backlog?: boolean;
}

export interface ReadRequest {
  op: "read";
  room: string;
  /** "10-15,18" range/list string, or explicit mid list. */
  mids: string | number[];
}

/**
 * "Paint me this room's history" — the room's full join snapshot (present
 * member state + title/link/kind events + msgs) streamed to the requesting
 * connection as ordinary delivered events, exactly as the no-cursor
 * `subscribe` snapshot would have sent them. Unlike `read` (msgs only, by mid
 * selector) this carries every event type, so a client that renders a mixed
 * room timeline can paint from it directly.
 *
 * Intended for a client that subscribes without `backlog` and fetches history
 * per room when the user opens one, instead of receiving every room's history
 * up front. The `{ok:true, room}` reply is sent AFTER the snapshot events, so
 * it doubles as the "snapshot complete" sentinel.
 */
export interface RoomHistoryRequest {
  op: "room_history";
  room: string;
}

export interface RoomsRequest {
  op: "rooms";
}

export interface PeersRequest {
  op: "peers";
}

export interface NotifyRequest {
  op: "notify";
  /** target session sid; absent = self. */
  sid?: string;
  text: string;
}

/** Session-launcher cwd tree (DR-0018 §3.2, user role only). Requested roots
 * may be configured roots or any descendants: descendant roots are required
 * for LN-Q3 lazy expansion after the initial bounded fetch. */
export interface DirTreeRequest {
  op: "dir_tree";
  roots: string[];
  /** Absent uses config dir_tree_depth; lazy expansion sends 1. */
  depth?: number;
  /** Root-relative path substring; matching nodes and their ancestors survive. */
  filter?: string;
}

/** One directory-only cwd-picker entry. `children` absent means the depth
 * boundary was reached and the UI may lazily fetch this path. */
export interface DirTreeEntry {
  path: string;
  is_dir: true;
  children?: DirTreeEntry[];
}

/** Session launch request (DR-0018 §3.2, user role only). The daemon validates
 * the opaque values, builds env/argv, and executes the configured command.
 *
 * 2-phase reply: launching awaits the whole run (up to timeout_seconds + kill
 * escalation, potentially ~10s), and the wire protocol has no request ids for
 * ordinary ops — clients pair replies by arrival order, so a deferred reply
 * used to hold back every later reply on the same connection (the webui's
 * single WS connection stalled all panes behind one slow op). Instead the
 * daemon acks immediately with RequestAcceptedResponse (on the arrival-order
 * contract) and pushes the outcome as an ev:"session_launch_result" event
 * correlated by `request_id` (events live outside the arrival-order contract,
 * like transcript/session_status pushes). */
export interface SessionLaunchRequest {
  op: "session_launch";
  /** Client-generated correlation id echoed in the ack and the result event.
   * Uniqueness only needs to hold among this connection's in-flight requests. */
  request_id: string;
  /** Working directory for the launched process, and the value the command
   * sees as `$CWD`. Carried as its own field rather than inside `params`
   * because it is the one launch value the daemon itself acts on: it is
   * `realpath`-checked against `root_dirs` and passed to spawn(). */
  cwd: string;
  /** Values for the chosen template's declared parameters, by name. A declared
   * parameter the request omits falls back to its configured default; a name
   * the template does not declare is rejected as invalid_args rather than
   * silently dropped (a client sending a value nothing will read is a client
   * bug worth surfacing). CWD belongs in `cwd`, not here. Values are opaque
   * strings — they travel as environment carriers, never interpolated into
   * shell text, so no value can inject shell syntax. */
  params: Record<string, string>;
  /** Optional user-supplied command template override (DR-0018 §3.2 addendum
   * 2026-07-17). When absent, the daemon uses the administrator-configured
   * `session_launcher.command` verbatim. When present, it must be a non-empty
   * string; empty string is rejected as invalid_args. Rationale: user role
   * (webui = kawaz-in-person) editing the template is equivalent to typing
   * the command in a terminal, and the session-role launch gate is untouched
   * (server.ts continues to reject session_launch from non-user roles before
   * this field is even inspected). No template substitution is performed on
   * this value either — it is passed to the same `shellArgv(shell, command)`
   * path as the config value, and sees the same declared parameters as shell
   * variables. */
  command?: string;
  /** Which configured template to launch with, by `SessionLauncherTemplate.name`.
   * Absent = the launcher's default recipe (`templates[0]`). An unknown name is
   * rejected as invalid_args rather than silently falling back — a client that
   * asks for a recipe it can't get should say so, not launch something else.
   * The chosen template supplies `shell`, its parameter declaration (which
   * decides what `params` may contain), and `command` unless the request
   * overrides it. */
  template?: string;
}

/** Terminate the OS process behind a Claude Code session (DR-0028, user role
 * only — session-role agents must never be able to kill each other). The
 * daemon resolves sid→pid FRESH at request time via `claude agents --json
 * --all` across every detected config dir (never the agents poller cache,
 * which can be up to 5s stale — a stale pid is a mis-kill), then verifies the
 * pid's command line still looks like a claude process (`ps -p <pid> -o
 * command=`, pid-reuse guard) before signalling. Kill sequence: SIGTERM →
 * ~1s wait → SIGTERM again if still alive (the claude TUI's first SIGTERM
 * only arms its quit-confirmation guard; the second confirms) → observe up
 * to ~3s total. Never escalates to SIGKILL (graceful shutdown / transcript
 * flush must not be broken by the daemon's own judgement).
 *
 * 2-phase reply (same arrival-order rationale as SessionLaunchRequest: the
 * resolve + kill sequence takes up to ~4s, and a deferred positional reply
 * would desynchronize every later reply on the connection): the direct reply
 * is RequestAcceptedResponse and the outcome arrives as
 * `ev:"session_kill_result"` correlated by `request_id`. */
export interface SessionKillRequest {
  op: "session_kill";
  /** Client-generated correlation id echoed in the ack and the result event
   * (same uniqueness contract as SessionLaunchRequest.request_id). */
  request_id: string;
  /** The Claude Code session UUID whose process to terminate. The request
   * intentionally carries NO pid — a client-asserted pid would be a weaker
   * basis for killing than the daemon's own fresh resolution (DR-0028). */
  session_id: string;
  /** DR-0028 addendum (r38 mid=6): escalate to SIGKILL when true. Absent /
   * false runs the normal two-shot SIGTERM sequence (DR-0028 original).
   * SIGKILL is irreversible and can break transcript flush, so the daemon
   * never chooses it on its own — the caller must explicitly opt in after
   * observing that a graceful attempt failed (webui: 「終了確認」で `terminated:
   * false` を観測してから「強制終了 (-KILL)」に切り替わったボタンをもう一度
   * 押す 2 段動線)。sid→pid 解決と ps 検証は force 時も同じで、pid-reuse ガード
   * だけは絶対に外さない。 */
  force?: boolean;
}

/** Read the environment variables of a session's own process (user role
 * only, kawaz r55m133). The env is read from the resolved pid rather than
 * from the daemon's session connection: the subscribe helper the session
 * spawns carries whatever Claude Code added on the way down, which is not
 * the session process's environment. sid→pid resolution and the ps
 * pid-reuse verification are shared verbatim with session_kill — reading a
 * recycled pid's environment would disclose an unrelated process's secrets.
 *
 * 2-phase for the same reason as session_kill: the fresh `claude agents`
 * resolution makes this an async op, and handleRequest pairs ordinary replies
 * by arrival order. The outcome arrives as `ev:"session_env_result"`. */
export interface SessionEnvRequest {
  op: "session_env";
  /** Client-generated correlation id echoed in the ack and the result event
   * (same uniqueness contract as SessionKillRequest.request_id). */
  request_id: string;
  /** The Claude Code session UUID whose process environment to read. Carries
   * no pid for the same reason session_kill doesn't — a client-asserted pid
   * is a weaker basis than the daemon's own fresh resolution. */
  session_id: string;
}

/** Session-launcher capability probe (DR-0018 §3.4 webui addendum, user role
 * only). Neither `dir_tree` (roots required, containment-checked against
 * root_dirs) nor `session_launch` (opaque cwd/model/effort/prompt, no
 * config echo) gives the webui a way to learn `root_dirs` (needed for the
 * CwdTree's initial fetch) or the templates and their parameter declarations
 * (which are the form itself) before the user has already picked something —
 * this op fills that one gap with a read-only projection of the config fields
 * the form needs. Same `launcher_not_configured` error as the other two ops
 * when session_launcher is absent, so the webui can reuse one error-handling
 * path to decide whether to show the launcher UI at all (DR-0018 §2.1
 * "launcher 未設定時" case). */
export interface SessionLauncherConfigRequest {
  op: "session_launcher_config";
}

/** Per-credential LLM quota snapshot, proxied from the gateway named by
 * `<dataDir>/config.json`'s `llm_usage_url` (user role only — quota is an
 * operator's view of the host's credentials, not something a session's agent
 * has any use for). The daemon fetches rather than the browser because the
 * gateway serves no CORS headers, so a direct fetch from the webui origin is
 * impossible; routing it through the daemon also keeps the gateway URL (an
 * internal address) out of the browser entirely.
 *
 * 2-phase for session_env's reason: the upstream fetch is async and
 * handleRequest pairs ordinary replies by arrival order. The outcome arrives
 * as `ev:"llm_usage_result"`. */
export interface LlmUsageRequest {
  op: "llm_usage";
  /** Client-generated correlation id echoed in the ack and the result event
   * (same uniqueness contract as SessionEnvRequest.request_id). */
  request_id: string;
  /** Ask the gateway to probe upstream instead of answering from its cache,
   * passed through as `?refresh=true`. Only a probe response carries
   * `LlmUsageCredential.limits` and `probe_error` — the cached document has
   * neither. It is also the only request that can spend upstream rate limit
   * (an account already limited answers the probe with a 429, which arrives
   * as that credential's `probe_error`), so this is for an explicit user
   * action and never for polling. */
  refresh?: boolean;
}

/** Per-day LLM spend, proxied from the gateway named by `<dataDir>/config.json`'s
 * `llm_stats_url` (user role only, same posture as `llm_usage`: what the host's
 * credentials cost is an operator's view). The daemon fetches for the same
 * reason — the gateway serves no CORS headers, and proxying keeps its internal
 * address out of the browser.
 *
 * 2-phase like `llm_usage`: a wide window is a much larger document than the
 * quota one and the fetch is correspondingly slow. The outcome arrives as
 * `ev:"llm_stats_result"`. */
export interface LlmStatsRequest {
  op: "llm_stats";
  /** Client-generated correlation id echoed in the ack and the result event
   * (same uniqueness contract as SessionEnvRequest.request_id). */
  request_id: string;
  /** How many days back to ask the gateway for, passed through as its `days`
   * query parameter. Must be an integer in LLM_STATS_DAYS_MIN..MAX; omitted
   * leaves the gateway's own default in place. The gateway clamps a request
   * wider than its own history, so asking for more than it holds is the
   * supported way to say "everything you have". */
  days?: number;
}

/**
 * Workspace file access (DR-0008 / DR-0021): read-only browsing from a
 * connected session or a daemon-resolved historical UUID. The client names a
 * session (`sid`), never a filesystem root, and `path` is always relative to
 * the derived containment root. The daemon resolves and containment-checks
 * every path (realpath prefix check, so symlinks cannot escape the root) before
 * touching the filesystem.
 */
export interface FsListRequest {
  op: "fs_list";
  /** session whose project root (its cwd) to browse */
  sid: string;
  /** directory path relative to the session root; "" / "." / absent = root */
  path?: string;
}

export interface FsReadRequest {
  op: "fs_read";
  sid: string;
  /** file path relative to the session root */
  path: string;
}

/** DR-0024 allowlist read for one transcript-observed file outside the
 * session containment root. Unlike fs_read, this path is absolute and grants
 * no directory/prefix access: it must exactly match external_files for sid. */
export interface FsReadExternalRequest {
  op: "fs_read_external";
  sid: string;
  /** absolute path — must exactly match the session's external_files allowlist */
  path: string;
}

/**
 * DR-0026 workspace-folder allowlist list/read for `.code-workspace` folders
 * discovered under the session cwd. Unlike fs_list/fs_read (relative to the
 * containment root) and fs_read_external (single exact-file grant), these ops
 * take an absolute path and grant *directory-prefix* access: any realpath
 * inside one of the session's workspace_folders[].path is browseable. Both
 * ops are user-role only — the browsable folder set comes from the cwd's
 * workspace file, which is a first-class artifact the user themselves
 * maintains, but reading them is a viewer feature, not something the AI
 * session itself needs. Symlink escapes are rejected by realpath.
 */
export interface FsListWorkspaceRequest {
  op: "fs_list_workspace";
  sid: string;
  /** absolute directory path — must be a workspace_folders entry itself,
   * or a descendant of one (realpath-checked). */
  path: string;
}

export interface FsReadWorkspaceRequest {
  op: "fs_read_workspace";
  sid: string;
  /** absolute file path — must be a descendant of some workspace_folders
   * entry (realpath-checked); a bare folder root refuses as "not a file". */
  path: string;
}

/**
 * Inbox file creation (DR-0019 Phase W1): create one new UTF-8 text file under
 * docs/inbox/ in a connected session's cwd. The daemon applies the same
 * realpath containment boundary as fs_list/fs_read, rejects every other
 * cwd-relative directory, and never overwrites an existing path.
 */
export interface FsWriteRequest {
  op: "fs_write";
  sid: string;
  /** file path relative to the session cwd */
  path: string;
  /** UTF-8 text content */
  content: string;
}

/**
 * Overwrite an existing text file in place (webui file viewer's edit action).
 * Unlike fs_write (inbox-only create) this op EXCLUSIVELY overwrites an
 * existing regular file — it does not create, delete, or rename. `kind` picks
 * the same three authorization surfaces the read ops use (fs_read /
 * fs_read_external / fs_read_workspace); the daemon reuses their containment /
 * allowlist checks so no new trust surface is introduced. `expected_mtime` and
 * `expected_size` come straight from the FsReadResponse the viewer used to
 * populate its textarea — if the file changed on disk between read and edit,
 * the write is refused with `file_conflict` rather than clobbering the newer
 * copy. Binary files (NUL byte in current on-disk head) are refused with
 * `not_a_text_file` so this op can never turn a binary into a UTF-8 blob.
 */
/**
 * Create a new empty (or short-content) text file at `path` under the same
 * authorization surfaces fs_edit / fs_read use (kind ∈ {contained, workspace}
 * — external is not supported because that allowlist is per-file, not per-dir,
 * so there is no notion of a "directory to create in"). Unlike fs_write
 * (inbox-only) this op accepts any writable location inside the read
 * containment, making it the symmetric partner of fs_edit: fs_edit overwrites,
 * fs_create creates. Never overwrites — an existing path replies `file_exists`
 * (O_EXCL). Parent directory must already exist; the op does not mkdir. `kind`
 * mirrors fs_edit exactly so no new trust surface is introduced.
 */
export interface FsCreateRequest {
  op: "fs_create";
  sid: string;
  /** relative when kind="contained", absolute when kind="workspace" — mirrors
   * the corresponding read op's path contract exactly. */
  path: string;
  kind: "contained" | "workspace";
  /** UTF-8 text content, capped at FS_READ_MAX_BYTES. Empty string is fine
   * (the common case — the UI creates an empty file and lets the user edit). */
  content: string;
}

/**
 * Delete an existing regular file under fs_edit's authorization surfaces
 * (kind ∈ {contained, workspace} — external is not supported: the transcript
 * allowlist is read-oriented; deleting a file the user only observed via
 * transcript is out of scope). Refuses directories, symlinks, and every
 * non-regular file — this op only ever unlinks real files the user could see
 * as a leaf in the tree. Never recursive.
 */
export interface FsDeleteRequest {
  op: "fs_delete";
  sid: string;
  /** relative when kind="contained", absolute when kind="workspace" — same
   * path contract as fs_edit/fs_read. */
  path: string;
  kind: "contained" | "workspace";
}

/**
 * Batch file-existence probe for the message-body path linkifier (kawaz r46
 * m55-m58). Client extracts inline-code tokens shaped like
 * `filepath[:LINE[:COL]]` / `filepath[:L1-L2]` from an agent message, absolute-
 * resolves them against the sender's cwd / repo_root, and asks the daemon
 * which ones point at real regular files it is willing to serve. Only paths
 * that come back non-null are turned into FileViewer links; unknowns stay as
 * plain inline code.
 *
 * Each requested path is tried against the same three authorization surfaces
 * the read ops use — `fs_read` (contained containment root), `fs_read_workspace`
 * (DR-0026 workspace_folders directory-prefix allowlist), and `fs_read_external`
 * (DR-0024 exact-file transcript allowlist), in that order — and the first
 * surface that admits the path *and* whose target is a regular file wins.
 * Everything else (not found, forbidden, not-a-file/dir/symlink) collapses to
 * `null` so the daemon does not leak "does this exist?" information about
 * paths outside the caller's authorization: an allowlist miss and a genuine
 * ENOENT are indistinguishable from the response shape.
 *
 * User-role only (viewer feature), like the other absolute-path fs ops.
 */
export interface FsStatBatchRequest {
  op: "fs_stat_batch";
  sid: string;
  /** Absolute paths (client-side pre-resolved from cwd / repo_root). Any
   * non-string / empty / relative entry is answered with `null` in the
   * corresponding response slot rather than rejecting the whole batch —
   * one client-side rendering bug shouldn't blank every link on the screen. */
  paths: string[];
}

/** One resolved entry in `FsStatBatchResponse.results`. `path` is the shape
 * the client passes to `fileHref` / FileViewer — relative to the session's
 * containment root for `contained`, absolute (echoed as requested / normalized)
 * for `workspace` and `external`. Mirrors the read-op dispatch FileViewer
 * already uses (relative → fs_read, absolute → fs_read_workspace or
 * fs_read_external). */
export interface FsStatEntry {
  kind: "contained" | "workspace" | "external";
  path: string;
}

export interface FsStatBatchResponse {
  ok: true;
  /** Parallel to `request.paths` — same length, same order. Slot values:
   *   - `FsStatEntry` when the daemon is willing to serve the target as a
   *     regular file under one of the three authorization surfaces;
   *   - `null` otherwise (client renders that token as plain inline code). */
  results: (FsStatEntry | null)[];
}

/** Maximum paths per fs_stat_batch request. A single agent message rarely
 * exceeds a handful of file references; the cap defends the daemon against
 * a runaway client from opening an unbounded loop of stat syscalls. Chosen
 * generously (256) so a heavily-cited migration report still fits in one
 * batch without needing multi-round coordination. */
export const FS_STAT_BATCH_MAX_PATHS = 256;

/**
 * Recursive file-name search under one of the browsable roots (Files pane's
 * "Search files by name"). The lazy tree (fs_list per expanded directory)
 * cannot answer "where is the file whose path contains X" without the user
 * having already opened every candidate directory, so the walk happens on the
 * daemon where the whole subtree is reachable in one request.
 *
 * `kind` selects the authorization surface, exactly mirroring the list ops it
 * is built on: `contained` walks the fs_list containment root and returns
 * root-relative paths; `workspace` walks one DR-0026 workspace folder (or a
 * directory inside one) named by an absolute `root` and returns absolute
 * paths. There is no `external` variant — DR-0024's allowlist is per-file with
 * no directory to descend, so nothing could be enumerated.
 *
 * User-role only, like the other viewer-side fs ops: a session AI searches its
 * own filesystem through its own tool loop, never through the daemon.
 */
export interface FsFindRequest {
  op: "fs_find";
  sid: string;
  kind: "contained" | "workspace";
  /** Directory to search under. Relative to the containment root for
   * `contained` ("" / absent = the root itself); absolute for `workspace`. */
  root?: string;
  /** Whitespace-separated words ANDed against each candidate's path, with a
   * `-word` exclusion prefix — the grammar `parseFileSearchQuery` defines (see
   * file-search-query.ts for the full rules and their rationale). Matching is
   * case-insensitive. A query with nothing to include (empty, whitespace-only,
   * or exclusions alone) matches nothing rather than dumping the entire tree,
   * so a cleared input box costs no walk. */
  query: string;
  /** Skip paths a `.gitignore` hides, and don't descend into ignored
   * directories. Absent = true.
   *
   * Filtering is the default because the unfiltered result is dominated by
   * vendored trees: searching this repo for "package.json" reaches ~100 hits
   * inside `node_modules` before the user's own, and with FS_FIND_RESULT_MAX
   * capping the reply those hits don't merely add noise — they push the real
   * answer out of it. A default that is usually wrong would be toggled on
   * every search, which is a worse trade than the occasional deliberate
   * "search build output too". */
  respect_gitignore?: boolean;
}

/** One fs_find hit. `path` is directly usable as a locator/FileViewer key:
 * root-relative for `kind:"contained"`, absolute for `kind:"workspace"` —
 * the same two path shapes the tree already stores. */
export interface FsFindHit {
  path: string;
  type: "file" | "dir" | "symlink";
}

export interface FsFindResponse {
  ok: true;
  sid: string;
  hits: FsFindHit[];
  /** The walk stopped early — either the result cap or the visited-entry
   * budget was reached, so `hits` is not the complete match set. The client
   * says so instead of implying "these are all the matches". */
  truncated: boolean;
}

/** Maximum hits one fs_find reply carries. A name search is a navigation aid:
 * past a screenful or two the user narrows the query rather than scrolling, so
 * a modest cap keeps the response small and the walk short. */
export const FS_FIND_RESULT_MAX = 200;

/** Maximum directory entries one fs_find walk will visit before giving up,
 * independent of how many matched. Bounds the syscall cost of a search in a
 * repo whose tree is enormous (a monorepo with vendored dependencies), so one
 * request cannot stall the daemon's synchronous handler indefinitely — the
 * same concern MAX_DIR_TREE_DEPTH addresses for dir_tree. */
export const FS_FIND_VISIT_MAX = 50_000;

export interface FsEditRequest {
  op: "fs_edit";
  sid: string;
  /** relative when kind="contained", absolute when kind="external"/"workspace" —
   * mirrors the corresponding read op's path contract exactly. */
  path: string;
  kind: "contained" | "external" | "workspace";
  /** UTF-8 text content, capped at FS_READ_MAX_BYTES (same cap fs_read enforces
   * on the read side so the viewer never edits a truncated view). */
  content: string;
  /** Optimistic-lock: the mtime the viewer originally read; a mismatch means
   * something else touched the file between the read and this edit. */
  expected_mtime: string;
  /** Optimistic-lock companion: guards against a mutation that happens to
   * preserve the mtime (mtime resolution differs by filesystem). */
  expected_size: number;
}

/**
 * Mint a capability URL on the sandbox origin (DR-0030 §4.1). The webui calls
 * this when the user asks to open a file as HTML or download it raw; the reply
 * is a URL on a different eTLD+1 that serves the file with its real MIME type,
 * which the same-origin `/fs-serve` deliberately refuses to do.
 *
 * The grant does not widen anything. The daemon runs `fsResolveForServe` here
 * at mint time AND again on every request the URL produces, so this op can
 * only fail the way the corresponding read op would (`path_forbidden` /
 * `not_found`) and can never reach a file the caller could not already read.
 *
 * Scope is the file's parent directory for `contained` / `workspace` — an HTML
 * page's relative CSS/JS has to resolve — and the single file for `external`,
 * whose authorization is an exact-match allowlist (§4.1.1). Re-minting the
 * same scope returns the same `gid` and `token` with a later `exp` (§4.1.2),
 * so an already-open preview tab keeps working.
 *
 * User role only: this is a viewer feature, like the other absolute-path fs ops.
 */
export interface SandboxGrantRequest {
  op: "sandbox_grant";
  sid: string;
  /** relative when kind="contained", absolute when kind="external"/"workspace"
   * — the same path contract as the matching read op. */
  path: string;
  kind: "contained" | "external" | "workspace";
}

/**
 * Drop a grant early (DR-0030 §4.3). The webui fires this when a preview tab
 * closes. Best-effort by design: `exp` is what actually bounds a grant's life,
 * so an unknown or already-expired gid is still `ok:true` — there is nothing
 * for the caller to do differently either way, and reporting "no such gid"
 * would turn revoke into an existence oracle.
 */
export interface SandboxRevokeRequest {
  op: "sandbox_revoke";
  /** The `gid` a previous `sandbox_grant` returned. */
  gid: string;
}

/**
 * Session transcript access (DR-0009 / DR-0021): read a slice of a connected
 * session's hello-validated transcript, or a historical UUID resolved by the
 * daemon below detected config dirs. There is NO client-supplied path, so no
 * traversal surface exists. Paging is by byte offset, aligned to line
 * boundaries, so a multi-hundred-MB transcript never needs a full scan or a
 * line index: the viewer starts from the tail (`before` absent) and pages older
 * by passing the previous reply's `start`.
 */
export interface TranscriptReadRequest {
  op: "transcript_read";
  sid: string;
  /** read lines that END at or before this byte offset (exclusive); absent = file end */
  before?: number;
  /** cap on returned line bytes; clamped to TRANSCRIPT_READ_MAX_BYTES */
  max_bytes?: number;
  /** DR-0025 Phase 1: read a subagent / workflow-agent / teammate transcript
   * that lives under `<sid>`'s sibling directory instead of `<sid>`'s own
   * transcript. User role only; strictly validated by the daemon-side
   * resolver (`AGENT_ID_RE` / `RUN_ID_RE` / `TEAMMATE_NAME_RE` reject any
   * character that could form a traversal). Mutually exclusive with
   * `teammate`; `run_id` only makes sense with `agent_id`. */
  agent_id?: string;
  /** DR-0025 Phase 1: workflow run id (`wf_XXXXXXXX-XXX`) that owns the
   * `agent_id`. Absent = the agent is a direct child of `<sid>` (bare
   * `subagents/agent-*.jsonl`). Ignored when `agent_id` is absent. */
  run_id?: string;
  /** DR-0025 Phase 1: teammate name whose transcript should be resolved via
   * `subagents/agent-*.meta.json` scan (the transcript-side `teammate_id` is
   * `name@team`, so it cannot be reused as a filename hash). Mutually
   * exclusive with `agent_id`. */
  teammate?: string;
}

/** Search historical Claude Code session transcripts under daemon-detected
 * config dirs (DR-0021 Phase 1, user role only). */
export interface SessionSearchRequest {
  op: "session_search";
  /** Client-generated correlation id echoed in the ack and the result event
   * (2-phase reply, same rationale as TranslateRequest: the bounded
   * filesystem scan takes long enough that a deferred arrival-order reply
   * would stall every later reply on the same connection). */
  request_id: string;
  /** newline-separated clauses, OR-ed; blank lines are ignored, and a clause's
   * whitespace-separated terms are ANDed across the session's messages */
  query?: string;
  /** default false; preserves pattern/text case when matching */
  case_sensitive?: boolean;
  /** default false; treats each non-blank query line as a RegExp pattern */
  regex?: boolean;
  /** default true; includes ccmsg queue deliveries authored by u1 */
  target_user?: boolean;
  /** default true; includes ccmsg queue deliveries authored by non-u1 members */
  target_agent?: boolean;
  /** space-separated, case-insensitive substring words matched against restored cwd */
  cwd?: string;
  /** UUID substring filter */
  sid?: string;
  /** intersected with daemon-detected dirs; paths outside that set are ignored */
  config_dirs?: string[];
  /** `<number>m`, `<number>h`, or `<number>d`; default `5d` */
  mtime_within?: string;
}

/**
 * Ask where a forked session stopped being a copy of its ancestor (user role
 * only). `claude --fork-session` duplicates the ancestor's records into the new
 * file preserving each `uuid`, rewriting only `sessionId`
 * (docs/findings/2026-08-11-checkpoint-rewind.md §5) — so nothing inside the
 * file marks the seam, and answering needs the sibling transcripts the daemon
 * can already enumerate. There is no client-supplied path: the sid resolves
 * through the same historical resolver transcript_read uses, and only its own
 * project directory is scanned.
 */
export interface ForkOriginRequest {
  op: "fork_origin";
  sid: string;
  /** Client-generated correlation id echoed in the ack and the result event
   * (2-phase reply, same rationale as SessionSearchRequest: resolving reads
   * whole sibling transcripts the first time, which is slow enough that a
   * deferred arrival-order reply would stall every later reply on the same
   * connection). */
  request_id: string;
}

/** One-shot fetch of the latest `claude agents --json` poll result (user role
 * only). The webui uses this for the initial paint; subsequent changes arrive
 * as `ev:"agents"` stream events. */
export interface AgentsRequest {
  op: "agents";
}

/** Follow a connected session's transcript live (user role only): after this,
 * appended complete lines arrive as `ev:"transcript"` events on this
 * connection's subscribe stream until transcript_unsubscribe / disconnect.
 * Same no-traversal property as transcript_read — the daemon only ever tails
 * the hello-validated transcript of `sid`. */
export interface TranscriptSubscribeRequest {
  op: "transcript_subscribe";
  sid: string;
}
export interface TranscriptUnsubscribeRequest {
  op: "transcript_unsubscribe";
  sid: string;
}

export interface ClientTracePoint {
  ts: string;
  comp: "webui";
  edge: "in" | "out";
  kind: "ws_receive" | "store_dispatch" | "dom_commit";
}

/** Browser-side transcript boundary timestamps returned to the daemon so one
 * trace.jsonl contains the complete file-to-DOM path. User role only. */
export interface ClientTraceRequest {
  op: "client_trace";
  sid: string;
  start: number;
  end: number;
  size: number;
  sampled: boolean;
  elapsed_ms: number;
  points: ClientTracePoint[];
}

export interface SessionStatusRequest {
  op: "session_status";
  sid: string;
}
export interface SessionStatusSubscribeRequest {
  op: "session_status_subscribe";
  sid: string;
}
export interface SessionStatusUnsubscribeRequest {
  op: "session_status_unsubscribe";
  sid: string;
}

/** One-shot fetch of every connected session currently stopped on a harness
 * API error (user role only). The webui uses this for the initial paint;
 * later changes arrive as `ev:"session_errors"` stream events. Unlike
 * `session_status`, this is not per-sid: the sidebar has to colour *other*
 * sessions' rows, and subscribing a full status fold per visible peer is the
 * cost DR-0020 §2.1 (a) explicitly avoided. The daemon instead folds the one
 * api_error pattern over every connected peer's transcript tail. */
export interface SessionErrorsRequest {
  op: "session_errors";
}

export interface PingRequest {
  op: "ping";
}

/** Local en→ja translation through the daemon host (DR-0023, user role only).
 * An empty batch is a capability probe: it verifies the helper can be found or
 * built without starting a TranslationSession.
 *
 * 2-phase reply (same rationale as SessionLaunchRequest): translation takes
 * hundreds of ms to seconds per batch, and a deferred arrival-order reply
 * would hold back every later reply on the same connection — with the webui's
 * single WS connection, opening several thinking tabs stalled every other
 * pane behind the running translations. The daemon acks immediately with
 * RequestAcceptedResponse and pushes the outcome as an ev:"translate_result"
 * event correlated by `request_id`. */
export interface TranslateRequest {
  op: "translate";
  /** Client-generated correlation id echoed in the ack and the result event.
   * Uniqueness only needs to hold among this connection's in-flight requests. */
  request_id: string;
  texts: string[];
}

export interface ShutdownRequest {
  op: "shutdown";
  reason?: string;
}

export interface LeaveRequest {
  op: "leave";
  room: string;
}

/** Add a connected session to an existing room (webui drag-a-session-onto-
 * the-chat, or a member session pulling in a collaborator). Appends a
 * MemberEvent and broadcasts it. Allowed for the admin User and member
 * sessions; the target must be a currently connected session (its metadata
 * comes from the live registry, same as create_room members). Inviting an
 * existing member is a no-op (already: true). */
export interface InviteRequest {
  op: "invite";
  room: string;
  /** sid of the session to add */
  sid: string;
}

export type Request =
  | HelloRequest
  | PostRequest
  | ReplyRequest
  | CreateRoomRequest
  | NextRoomRequest
  | SetTitleRequest
  | ArchiveRoomRequest
  | KickRequest
  | SubscribeRequest
  | ReadRequest
  | RoomHistoryRequest
  | RoomsRequest
  | PeersRequest
  | NotifyRequest
  | DirTreeRequest
  | SessionLaunchRequest
  | SessionKillRequest
  | SessionEnvRequest
  | SessionLauncherConfigRequest
  | LlmUsageRequest
  | LlmStatsRequest
  | FsListRequest
  | FsReadRequest
  | FsReadExternalRequest
  | FsListWorkspaceRequest
  | FsReadWorkspaceRequest
  | FsWriteRequest
  | FsCreateRequest
  | FsDeleteRequest
  | FsEditRequest
  | FsStatBatchRequest
  | FsFindRequest
  | SandboxGrantRequest
  | SandboxRevokeRequest
  | TranscriptReadRequest
  | SessionSearchRequest
  | ForkOriginRequest
  | AgentsRequest
  | TranscriptSubscribeRequest
  | TranscriptUnsubscribeRequest
  | ClientTraceRequest
  | SessionStatusRequest
  | SessionStatusSubscribeRequest
  | SessionStatusUnsubscribeRequest
  | SessionErrorsRequest
  | PingRequest
  | TranslateRequest
  | ShutdownRequest
  | LeaveRequest
  | InviteRequest;

// ---------------------------------------------------------------------------
// Wire: responses (daemon -> client)
// ---------------------------------------------------------------------------

export interface ErrorBody {
  code: string;
  msg: string;
}

export interface ErrorResponse {
  ok: false;
  error: ErrorBody;
}

export interface HelloResponse {
  ok: true;
  version: string;
  /** DR-0018 拡張 (issue 2026-07-21-webui-terminal-tab-embed): user role の
   * hello に対してのみ、`<dataDir>/config.json` の `terminal_gateway_url`
   * トップレベルキー (http:// / https:// のみ、末尾スラッシュの有無問わず)
   * をエコーバックする。未設定 / スキーム不正 / role="session" の場合は
   * 省略。webui はこれを iframe embed の base URL として使い、未設定なら
   * Terminal タブ自体を出さない (= 設定していないユーザには存在しない機能
   * に倒す。旧 localStorage `ccmsg.terminalGatewayUrl` 方式は廃止)。 */
  terminal_gateway_url?: string;
  /** True when the daemon has a usable `llm_usage_url` configured, echoed to
   * user-role hellos only (same posture as terminal_gateway_url). The URL
   * itself is deliberately NOT sent: the daemon is the one that fetches it
   * (the gateway serves no CORS headers), so the browser needs to know only
   * whether the `llm_usage` op is worth offering. Absent means unconfigured,
   * and the webui then hides the usage screen entirely rather than showing a
   * menu entry that can only ever error. */
  llm_usage_available?: boolean;
  /** True when the daemon has a usable `llm_stats_url` configured. Same
   * posture and same reasons as llm_usage_available, and reported separately
   * because the two endpoints are configured independently — one can be set
   * up without the other, and the webui shows only the section it can fill. */
  llm_stats_available?: boolean;
  /** True when the daemon has a usable `sandbox_origin_template` configured
   * (DR-0030 §7.1), user-role hellos only. Same posture as the two flags
   * above: the template itself stays server-side (the client only ever
   * receives whole URLs from `sandbox_grant`), and an unconfigured daemon —
   * one with no canddy sandbox domain in front of it — makes the webui hide
   * the "HTML として開く" / "生ダウンロード" buttons entirely rather than
   * offer a button that can only fail. */
  sandbox_available?: boolean;
  /** True when this host's `claude` accepts `--resume-session-at` (the
   * undocumented option a fork launch needs to cut the resumed conversation at
   * a chosen record), user-role hellos only. Probed once at daemon startup by
   * running a launch that is guaranteed to fail at session lookup and reading
   * whether the option itself was rejected — see fork-probe.ts. Absent means
   * either an unsupported `claude` or one that could not be run at all, and
   * the webui then hides every fork affordance instead of offering a button
   * whose launch would die on an unknown option. */
  fork_available?: boolean;
}
export interface PostResponse {
  ok: true;
  room: string;
  mid: number;
}
export interface CreateRoomResponse {
  ok: true;
  room: string;
  reused: boolean;
  mid?: number;
  /** Advisory notice about the request (DR-0013 §2.9: `kind:"broadcast"` +
   * non-empty `members` returns a warning that the explicit members list was
   * ignored — broadcast rooms auto-populate from the session registry, so any
   * caller-supplied list is redundant). Non-fatal; the room is still created.
   * Absent when there's nothing to warn about. */
  warning?: string;
}
export interface NextRoomResponse {
  ok: true;
  room: string;
  mid?: number;
}
export interface SetTitleResponse {
  ok: true;
  room: string;
  title: string;
}
export interface ArchiveRoomResponse {
  ok: true;
  room: string;
  archived: boolean;
}
export interface KickResponse {
  ok: true;
  room: string;
  id: string;
}
export interface SubscribeAck {
  ok: true;
  subscribed: true;
}
export interface ReadResponse {
  ok: true;
  room: string;
  msgs: MsgEvent[];
}
/** Sent after the room's snapshot events (see RoomHistoryRequest): receiving it
 * means the history for `room` has been fully delivered on this connection. */
export interface RoomHistoryResponse {
  ok: true;
  room: string;
}
export interface RoomSummary {
  id: string;
  title?: string;
  members: MemberEvent[];
  last_mid: number;
  last_ts: string | null;
  /** archived flag (DR-0012), last archive event wins; absent = not archived */
  archived?: boolean;
  /** room kind (DR-0013); absent = "normal". webui shows a broadcast badge
   * and swaps the Composer for a broadcast-target picker when this is set. */
  kind?: RoomKind;
}
export interface RoomsResponse {
  ok: true;
  rooms: RoomSummary[];
}
export interface PeerInfo {
  sid: string;
  repo: string;
  ws: string;
  cwd: string;
  /** present iff the session announced a transcript the daemon accepted —
   * the webui uses this to decide whether a Timeline view is available */
  transcript_path?: string;
  /** present iff the session announced a repo container the daemon accepted —
   * fs browsing is rooted here (all workspaces/worktrees visible) instead of
   * cwd, and the webui highlights the session's own workspace within it */
  repo_root?: string;
  /** current branch / bookmark of the session's checkout, "" / absent if unknown */
  branch?: string;
  /** ISO time this session first registered with the running daemon (stable
   * across reconnects while the daemon lives; resets on daemon restart) */
  connected_at?: string;
  /** ISO time of this session's most recent request on any of its connections */
  last_activity_at?: string;
}
export interface PeersResponse {
  ok: true;
  peers: PeerInfo[];
}
export interface NotifyResponse {
  ok: true;
  delivered: number;
}
export interface DirTreeResponse {
  ok: true;
  entries: DirTreeEntry[];
}
/** Payload of a completed session launch, delivered inside
 * SessionLaunchResultEvent (2-phase reply — the direct reply to the request
 * is RequestAcceptedResponse). Signal termination uses null exit_code. */
export interface SessionLaunchResponse {
  ok: true;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}
/** Payload of a completed session_kill (DR-0028), delivered inside
 * SessionKillResultEvent. `terminated: true` = the process was observed gone
 * within the ~3s grace. `terminated: false` is NOT a failure: both SIGTERM
 * sends succeeded but the process was still alive when the grace expired —
 * the UI presents this as "signal sent, termination unconfirmed" and a human
 * decides whether to kill harder (the daemon never SIGKILLs). */
export interface SessionKillResponse {
  ok: true;
  terminated: boolean;
}
/** Payload of a completed session_env, delivered inside SessionEnvResultEvent.
 * `env` is the session process's environment as name→value pairs.
 *
 * On macOS the source is `ps eww`, whose output is space-separated with no
 * quoting, so a value containing a space cannot be told apart from the next
 * variable by tokenizing alone. The daemon reconstructs values by treating a
 * token as a new variable only when it matches `NAME=`; a value that itself
 * contains a `NAME=`-shaped token is the one case that mis-splits. Linux
 * reads `/proc/<pid>/environ` (NUL-separated), which has no such ambiguity.
 * Values are returned verbatim and are NOT redacted — the caller decides how
 * to present secrets. */
export interface SessionEnvResponse {
  ok: true;
  /** The pid the environment was read from, after the same ps verification
   * session_kill applies. Surfaced so the UI can show what it actually read. */
  pid: number;
  env: Record<string, string>;
}
/** One quota window of one credential (upstream key "5h" / "7d" / whatever a
 * future gateway adds — see LlmUsageSnapshot.windows). */
export interface LlmUsageWindow {
  /** Fraction of the window's quota already consumed, 0..1 (upstream sends
   * 0.13 for 13%). Values above 1 are possible and are NOT clamped here. */
  utilization: number;
  /** Upstream verdict for the window. Known values are "allowed",
   * "allowed_warning" and "rejected"; kept as a string because the set is the
   * gateway's to grow and an unknown value must reach the UI as-is rather
   * than being flattened into a wrong one. */
  status: string;
  /** Epoch seconds at which the window's counter resets. */
  reset?: number;
  reset_iso?: string;
  /** Length of the window's period in seconds (18000 for a 5h window, 604800
   * for a 7d one). Upstream states the period itself here rather than leaving
   * it to be read out of the key, because a key like "primary" names a slot
   * whose length differs between providers. Absent when the provider does not
   * report one, which means unknown — not a licence to guess. */
  window_seconds?: number;
}

/** Extra-credit spending state, which is per credential rather than per
 * window (a credential can be out of credits while both windows are still
 * "allowed"). */
export interface LlmUsageOverage {
  status: string;
  disabled_reason?: string;
}

/** One observation of a credential's quota, as of `observed_at` — which can
 * lag the response's own `generated_at` by minutes when the gateway has not
 * seen traffic on that credential recently, so the UI shows its age. */
export interface LlmUsageSnapshot {
  observed_at?: number;
  observed_at_iso?: string;
  overage?: LlmUsageOverage;
  /** Window key → window, keys verbatim from upstream. A map rather than
   * named `five_hour`/`seven_day` fields so a gateway that starts reporting a
   * third window shows up in the UI without a protocol change; the daemon
   * decides membership by shape (a `utilization` number + a `status` string),
   * so a future non-window sibling key is dropped rather than mis-rendered. */
  windows: Record<string, LlmUsageWindow>;
}

/** One named limit the upstream provider enforces on a credential, beside the
 * rolling quota windows. Upstream's vocabulary is passed through untranslated
 * (the gateway owns these words): `kind` is "session" / "weekly_all" /
 * "weekly_scoped" today and may grow, and a `weekly_scoped` entry names the
 * model family it applies to. */
export interface LlmUsageLimit {
  /** Which limit this is. A string rather than a union for LlmUsageWindow.status's
   * reason — the set is the gateway's to grow, and an unknown kind must reach
   * the UI as itself rather than be flattened into a wrong one. */
  kind: string;
  /** Consumed share of the limit as a PERCENTAGE, 0..100 — deliberately not
   * the same unit as LlmUsageWindow.utilization (0..1). Kept as upstream sends
   * it so the wire stays a faithful copy of the gateway's document; the webui
   * normalizes at the presentation boundary. */
  percent: number;
  /** Upstream's own verdict: "normal" / "warning" / "critical" today. String
   * for `kind`'s reason. */
  severity: string;
  /** RFC3339 instant the limit's counter resets. Absent for a limit with no
   * scheduled reset. */
  resets_at?: string;
  /** Model family the limit is scoped to, as a display name ("Fable").
   * Present on `weekly_scoped` entries. */
  model?: string;
  /** True when upstream is currently counting against this limit. NOT a
   * statement that the limit is blocking anything — an inactive limit can sit
   * at 0% and an active one at 47% "normal". */
  is_active?: boolean;
  /** Length of the limit's period in seconds, stated by the provider instead
   * of being inferred from `kind`. Absent when the provider does not report
   * one, which means unknown — not a licence to guess. */
  window_seconds?: number;
}

export interface LlmUsageCredential {
  name: string;
  /** Credential kind, e.g. "claude_oauth" / "claude_bedrock" / "relay". */
  type?: string;
  /** Whether quota is knowable for this credential at all. Known values:
   * "observed" (a snapshot is present), "not_applicable" (the credential has
   * no quota to report), "upstream_dependent" (quota lives behind a relay).
   * String for LlmUsageWindow.status's reason. */
  support: string;
  /** Present when `support` is "observed"; absent otherwise. */
  snapshot?: LlmUsageSnapshot;
  /** Provider-enforced limits beside the quota windows, in upstream's order.
   * Absent when the gateway reports none — which is every credential on a
   * gateway too old to send them, so the UI must read absence as "nothing to
   * show" rather than as an error. */
  limits?: LlmUsageLimit[];
  /** Why the gateway could not refresh this credential's reading. Present
   * only on failure; whatever `snapshot` holds alongside it is the last good
   * observation, and its `observed_at` says how old that is. */
  probe_error?: string;
}

/** Payload of a completed llm_usage, delivered inside LlmUsageResultEvent.
 * The gateway's own top-level fields are passed through; only `credentials`
 * is normalized (see LlmUsageSnapshot.windows). */
export interface LlmUsageResponse {
  ok: true;
  /** When the gateway assembled the response (epoch seconds). */
  generated_at?: number;
  generated_at_iso?: string;
  credentials: LlmUsageCredential[];
}

/** Bounds on LlmStatsRequest.days. One day is the smallest window the gateway
 * buckets by. The ceiling is a sanity bound rather than a real span — a
 * century of days: the gateway clamps any request to what it actually holds,
 * and the UI's widest view ("yearly") deliberately asks for more than that to
 * mean "everything". It exists only so a typo cannot ask for an absurd number. */
export const LLM_STATS_DAYS_MIN = 1;
export const LLM_STATS_DAYS_MAX = 36_524;

/** What one model cost on one day under one credential. Every field is
 * optional and passed through as sent: the gateway owns which counters it
 * reports, and a missing one must read as "not reported" rather than as a
 * zero the UI would then sum. */
export interface LlmStatsModelUsage {
  requests?: number;
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  /** Spend in USD. The one field the screen is built around. */
  usd?: number;
}

/** One day's spend, credential → model → counters. Credential names are
 * verbatim from upstream, including the literal "-" the gateway uses for
 * traffic it cannot attribute to a named credential. */
export interface LlmStatsDay {
  credentials: Record<string, Record<string, LlmStatsModelUsage>>;
  /** The gateway's own total for the day. Kept rather than recomputed from
   * the models so the screen can show the authoritative figure; it can differ
   * from the sum when the gateway counts something it does not break out. */
  total_usd?: number;
}

/** Payload of a completed llm_stats, delivered inside LlmStatsResultEvent.
 * Keyed by "YYYY-MM-DD" in the gateway's own timezone — the daemon does not
 * reinterpret the dates, so a day here means whatever the gateway means. */
export interface LlmStatsResponse {
  ok: true;
  /** When the gateway assembled the response (epoch seconds). */
  generated_at?: number;
  generated_at_iso?: string;
  days: Record<string, LlmStatsDay>;
}

/** Immediate ack for 2-phase ops (translate / session_launch): the request
 * passed synchronous validation and its outcome will arrive as the matching
 * `*_result` stream event carrying the echoed `request_id`. This ack is the
 * op's reply on the arrival-order contract, so later replies on the same
 * connection are never held back by the op's slow work. Synchronous
 * validation failures (role, invalid_args, launcher_not_configured, cwd
 * containment) still reply ErrorResponse directly instead of this ack. */
export interface RequestAcceptedResponse {
  ok: true;
  accepted: true;
  request_id: string;
}
/** session_launcher_config reply — see its request doc comment above.
 * `templates` is the configured recipe list in config order, each carrying its
 * shell command template verbatim (no variable substitution — `$CWD` and every
 * other declared parameter stay literal) plus the parameter declaration that
 * tells the form which inputs to render, in which order, with which initial
 * values; the webui surfaces the chosen template's command as an editable
 * textarea per DR-0018 §3.2 addendum 2026-07-17, and sends the edited value
 * back via SessionLaunchRequest.command override. Same
 * one-shot read as root_dirs — a re-fetch is only useful across a daemon
 * config reload + restart. */
export interface SessionLauncherConfigResponse {
  ok: true;
  root_dirs: string[];
  templates: SessionLauncherConfigTemplate[];
}

/** One template as seen by a client: the parsed template minus `shell`, which
 * is a daemon-side execution detail the form has no use for. */
export interface SessionLauncherConfigTemplate {
  name: string;
  command: string;
  params: LauncherParam[];
}
/** One directory entry from fs_list. `type:"symlink"` is reported as-is for
 * links whose target stays inside the root (out-of-root links are listed but
 * refuse to resolve); sockets/FIFOs/devices collapse to "other". */
export interface FsEntry {
  name: string;
  type: "file" | "dir" | "symlink" | "other";
  /** bytes, files only */
  size?: number;
  /** ISO 8601 mtime, best-effort */
  mtime?: string;
}
export interface FsListResponse {
  ok: true;
  sid: string;
  /** normalized directory path relative to the root ("" = root itself) */
  path: string;
  entries: FsEntry[];
}
export interface TranscriptReadResponse {
  ok: true;
  sid: string;
  /** complete raw jsonl lines, oldest first (client parses each as JSON) */
  lines: string[];
  /** byte offset of the first returned line — pass as `before` to page older;
   * 0 means the beginning of the transcript is included */
  start: number;
  /** byte offset just past the last returned line's newline */
  end: number;
  /** current transcript size in bytes (grows while the session runs — pass as
   * `before` later to page content that appeared after this read) */
  size: number;
}
export interface FsReadResponse {
  ok: true;
  sid: string;
  path: string;
  /** true byte size on disk (may exceed what `content` carries) */
  size: number;
  /** content was cut at FS_READ_MAX_BYTES */
  truncated: boolean;
  /** NUL byte seen in the first 8 KiB — content omitted for binaries */
  binary: boolean;
  /** UTF-8 text content; "" when binary */
  content: string;
  /** ISO 8601 mtime — used by fs_edit as an optimistic-lock token so a
   * concurrent external edit between read and write is detected as
   * `file_conflict` instead of silently clobbered. */
  mtime: string;
}
export interface FsWriteResponse {
  ok: true;
  sid: string;
  /** normalized path relative to the session root */
  path: string;
}
export interface FsCreateResponse {
  ok: true;
  sid: string;
  /** normalized path (relative for contained — always relative to the session
   * containment root, matching fs_list — absolute for workspace, matching the
   * FsListWorkspace echo). */
  path: string;
}
export interface FsDeleteResponse {
  ok: true;
  sid: string;
  /** echoed request path (relative for contained, absolute for workspace) */
  path: string;
}
export interface FsEditResponse {
  ok: true;
  sid: string;
  /** echoed request path (relative for contained, absolute for external/workspace) */
  path: string;
  /** post-write size on disk */
  size: number;
  /** post-write mtime — the client uses this as the new optimistic-lock token
   * so a subsequent edit in the same viewer session doesn't need a full refetch. */
  mtime: string;
}
export interface SandboxGrantResponse {
  ok: true;
  /** Origin-separation key, non-secret: it rides in a DNS label and therefore
   * leaks to every recursive resolver on the way (DR-0030 §3.3). Pass it back
   * to `sandbox_revoke`. */
  gid: string;
  /** The capability. Secret, and the only thing that authorizes a request —
   * echoed here because the client needs it to build sibling URLs (a download
   * link next to a preview link) without a second mint. */
  token: string;
  /** Ready-to-open URL for the granted file, preview mode. Append `?dl=1` for
   * the download mode (DR-0030 §6.2). */
  url: string;
  /** Epoch ms the grant expires at (30 minutes from this mint). */
  exp: number;
}
export interface SandboxRevokeResponse {
  ok: true;
}
export interface SessionSearchMatch {
  role: "user" | "agent";
  text: string;
  timestamp?: string;
}

export interface SessionSearchHit {
  sid: string;
  config_dir: string;
  /** absolute path selected only from detected config dirs' projects trees */
  file: string;
  cwd: string | null;
  /** `owner/repo` when cwd matches the known repos path convention */
  repo: string | null;
  /** repo-relative workspace/worktree path when present */
  ws: string | null;
  created_at: string;
  updated_at: string;
  size: number;
  matches: SessionSearchMatch[];
}

export interface SessionSearchResponse {
  ok: true;
  hits: SessionSearchHit[];
  truncated: boolean;
}

/** Where a fork's copied history ends, when the session is a fork whose
 * ancestor transcript still exists. */
export interface ForkOrigin {
  /** The ancestor the copied records came from. */
  sid: string;
  /** uuid of the last copied record: the seam sits immediately after it. */
  boundary_uuid: string;
  /** How many records were copied — how far into the file the seam is, for a
   * client that wants to say so without holding the whole window. */
  copied: number;
}

/** `origin` is null both when the session is not a fork and when it is one
 * whose ancestor file is gone: neither case has a seam a viewer could place,
 * and the difference is not observable from what remains on disk. */
export interface ForkOriginResponse {
  ok: true;
  origin: ForkOrigin | null;
}

/** One row of `claude agents --json` output, annotated with which
 * CLAUDE_CONFIG_DIR produced it. Field names follow the upstream CLI output
 * (camelCase preserved via passthrough) — `kind`/`status`/`state` stay plain
 * strings so newer CLI values don't break older daemons. */
export interface AgentInfo {
  pid: number;
  cwd: string;
  /** "interactive" | "background" (upstream values, open set) */
  kind: string;
  /** epoch ms */
  startedAt: number;
  sessionId: string;
  name?: string;
  /** e.g. "waiting" / "running"; upstream-controlled open set */
  status?: string;
  /** Human-readable detail for the current status, e.g. "dialog open". */
  waitingFor?: string;
  /** background sessions only, e.g. "done" */
  state?: string;
  /** background sessions only: short id */
  id?: string;
  /** the CLAUDE_CONFIG_DIR this row was polled from (auto-detected ~/.claude* dirs) */
  config_dir: string;
  /** Value of the `HYOUI_SESSION_ID` environment variable on the underlying
   *  process (looked up per-poll via `ps eww` on the pid, cached per pid).
   *  Absent when the process doesn't set the var or when the env couldn't
   *  be read (permission denied on other users' processes, pid gone). The
   *  daemon deliberately reads this from the *current* process — resuming
   *  the same claude sessionId in a new process yields a new pid and thus
   *  the current env, not a stale start-time snapshot. */
  hyoui_session_id?: string;
}
export interface AgentsResponse {
  ok: true;
  agents: AgentInfo[];
  /** ISO time of the poll that produced `agents`; null when no poll has run yet */
  polled_at: string | null;
}
export interface TranscriptSubscribeResponse {
  ok: true;
  sid: string;
  /** current transcript size — tail events start from here */
  size: number;
}
export interface TranscriptUnsubscribeResponse {
  ok: true;
  sid: string;
}
export interface ClientTraceResponse {
  ok: true;
  sid: string;
  /** how many of the posted points reached trace.jsonl (the daemon caps the
   * batch, so a client that sends more learns its extras were dropped). */
  written: number;
}
export interface SessionStatusResponse extends SessionStatusSnapshot {
  ok: true;
  sid: string;
}
export interface SessionStatusSubscribeResponse extends SessionStatusSnapshot {
  ok: true;
  sid: string;
}
export interface SessionStatusUnsubscribeResponse {
  ok: true;
  sid: string;
}
/** One entry of the session-error list: which session is stopped, and on what. */
export interface SessionErrorEntry extends SessionApiError {
  sid: string;
}
export interface SessionErrorsResponse {
  ok: true;
  /** Only sessions currently stopped on an error appear; a recovered session
   * drops out of the list rather than appearing with an empty error. Sorted
   * by sid for a stable compare on the daemon's change check. */
  errors: SessionErrorEntry[];
}
export type TranslateResult = { ok: true; text: string } | { ok: false; error: string };
export interface TranslateResponse {
  ok: true;
  /** One result per request text, preserving input order. Per-item failures keep
   * the helper's Translation.framework error text (including notInstalled). */
  results: TranslateResult[];
}

export interface PingResponse {
  ok: true;
  pong: true;
  version: string;
  uptime: number;
  pid: number;
  rooms: number;
  clients: number;
  /** provenance of the running daemon: the bun executable and the entry
   * script path (Bun.main). The entry script tells which face's plugin cache
   * (e.g. ~/.claude-personal vs a work overlay) this daemon actually runs
   * from — version skew across faces is resolved by the newer-wins upgrade,
   * but provenance was previously unobservable. */
  exe?: string;
  script?: string;
  /** actual HTTP/WS bind addresses ("host:port"); empty when CCMSG_HTTP_BIND=off (DR-0004 §3). */
  http: string[];
  /** active source-IP allowlist entries (CIDR/IP strings, DR-0004 §3 addendum). */
  httpAllow: string[];
  /** The daemon's current view of the host link, which decides whether a
   * recovery can wake sessions stopped on an API error: `"off"` when no
   * network watch is running, `"unknown"` before its first probe settles,
   * otherwise the last probed state. Diagnostic only — nothing on the wire
   * depends on it. */
  network: "off" | "unknown" | "online" | "offline";
}
export interface ShutdownResponse {
  ok: true;
  stopping: true;
}
export interface LeaveResponse {
  ok: true;
  room: string;
}
export interface InviteResponse {
  ok: true;
  room: string;
  /** member id assigned to (or already held by) the invited session */
  id: string;
  /** true = the session was already a member, nothing appended */
  already: boolean;
}

export type Response =
  | ErrorResponse
  | HelloResponse
  | PostResponse
  | CreateRoomResponse
  | NextRoomResponse
  | SetTitleResponse
  | ArchiveRoomResponse
  | KickResponse
  | SubscribeAck
  | ReadResponse
  | RoomHistoryResponse
  | RoomsResponse
  | PeersResponse
  | NotifyResponse
  | DirTreeResponse
  | RequestAcceptedResponse
  | SessionLauncherConfigResponse
  | FsListResponse
  | FsReadResponse
  | FsWriteResponse
  | FsCreateResponse
  | FsDeleteResponse
  | FsEditResponse
  | FsStatBatchResponse
  | FsFindResponse
  | SandboxGrantResponse
  | SandboxRevokeResponse
  | TranscriptReadResponse
  | AgentsResponse
  | TranscriptSubscribeResponse
  | TranscriptUnsubscribeResponse
  | ClientTraceResponse
  | SessionStatusResponse
  | SessionStatusSubscribeResponse
  | SessionStatusUnsubscribeResponse
  | SessionErrorsResponse
  | PingResponse
  | ShutdownResponse
  | LeaveResponse
  | InviteResponse;

// ---------------------------------------------------------------------------
// HTTP-only responses (not part of the WS/UDS line-protocol Response union).
// DR-0015 §2.3: attachment upload runs over multipart HTTP, not the wire
// protocol, so the response shape is defined here but not appended to the
// Response union above — the WS handler never emits it.
// ---------------------------------------------------------------------------

/** DR-0015 §2.2 `POST /attachment` success body. `path` is the absolute file
 * path under `TMPDIR/claude-ccmsg-<uid>/attachment/<uuid>.<ext>` (same-UID
 * trust per DR-0001 §5 — the webui inlines it verbatim into the message body's
 * Markdown link so agents on the same UID can `Read`/`Bash` it directly). */
export interface AttachmentUploadResponse {
  ok: true;
  uuid: string;
  /** filename extension including the leading `.` (e.g. `.png`), or `""` when
   * the uploaded filename had no extension. */
  ext: string;
  size: number;
  /** MIME type, from `Content-Type` header if the client sent one, else
   * extension-based lookup (DR-0015 Open question §5: extension-based to
   * start, magic-byte sniff only if false positives show up in practice). */
  mime: string;
  path: string;
  /** original filename basename (display-only label for the Markdown link). */
  name: string;
}

/** DR-0015 §2.2 default upload size cap (bytes). Overridable via
 * `CCMSG_ATTACHMENT_MAX_BYTES`; upload exceeding this returns HTTP 413. */
export const DEFAULT_ATTACHMENT_MAX_BYTES = 50 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Error codes (string, per DR-0003 §1)
// ---------------------------------------------------------------------------

export const ErrorCode = {
  bad_request: "bad_request",
  hello_required: "hello_required",
  room_not_found: "room_not_found",
  not_a_member: "not_a_member",
  unknown_op: "unknown_op",
  invalid_args: "invalid_args",
  // Workspace file access (DR-0008)
  session_not_found: "session_not_found",
  path_forbidden: "path_forbidden",
  not_found: "not_found",
  // Inbox file creation (DR-0019): fs_write is restricted to new paths under
  // docs/inbox/ and never overwrites an existing filesystem entry.
  path_not_writable: "path_not_writable",
  file_exists: "file_exists",
  // fs_edit (in-place text edit): file was modified between read and write.
  file_conflict: "file_conflict",
  // fs_edit: on-disk content sniffed as binary (NUL byte in head) — refusing
  // ensures this op can only mutate what the viewer could faithfully display.
  not_a_text_file: "not_a_text_file",
  // Session launcher (DR-0018): no valid session_launcher configuration means
  // both directory browsing and launch remain closed.
  launcher_not_configured: "launcher_not_configured",
  // Broadcast room (DR-0013 §2.4): agent post to a broadcast room must include
  // "u1" in `to`. "u1 に届かない agent 発話" を broadcast の意味論で禁じるため。
  broadcast_agent_target_required: "broadcast_agent_target_required",
  // 1on1 room (DR-0014 §2.1): create_room --kind 1on1 requires exactly one sid
  // in `members`. Empty or multiple is refused up front — a 1on1 room's
  // meaning is "u1 と 1 session の 2 者確定"、複数 session なら通常 room /
  // broadcast room を使う。
  one_on_one_requires_single_member: "one_on_one_requires_single_member",
  // reply (DR-0017 §2.2): the mid the reply points at doesn't exist in the room.
  msg_not_found: "msg_not_found",
  // reply (DR-0017 §2.2): replying to your own msg is meaningless — the
  // constructed target list would collapse to just u1 + yourself.
  self_reply: "self_reply",
  // 1on1 response rail (DR-0017 §2.5): the response route is the assistant
  // transcript ("tl"), not the room. Both reply to a u1 msg and any plain post
  // from the member session are rejected with guidance at the wire boundary.
  reply_via_tl: "reply_via_tl",
  // DR-0023 host translation: the daemon is not running on macOS, the helper
  // cannot be built/found, or its persistent process failed.
  translate_unavailable: "translate_unavailable",
  translate_helper_failed: "translate_helper_failed",
  // llm_usage: `<dataDir>/config.json` has no valid `llm_usage_url`, so there
  // is nothing to proxy. Distinct from llm_usage_unavailable so the webui can
  // tell "operator never set this up" (hide the feature) from "the gateway is
  // down right now" (show the error and let the user retry).
  llm_usage_not_configured: "llm_usage_not_configured",
  // llm_usage: the gateway was configured but did not answer usably — refused
  // the connection, timed out, returned a non-2xx status, or sent a body that
  // is not the expected JSON shape.
  llm_usage_unavailable: "llm_usage_unavailable",
  // llm_stats: the same two distinctions as llm_usage, for the independently
  // configured spend endpoint (`llm_stats_url`).
  llm_stats_not_configured: "llm_stats_not_configured",
  llm_stats_unavailable: "llm_stats_unavailable",
  // sandbox_grant: `<dataDir>/config.json` has no usable
  // `sandbox_origin_template`, so there is no origin to mint a URL on
  // (DR-0030 §7.1). Same "operator never set this up" role
  // llm_usage_not_configured plays — hello's `sandbox_available` normally
  // keeps the webui from asking at all, and this covers the window where the
  // config changed under a live connection.
  sandbox_not_configured: "sandbox_not_configured",
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
