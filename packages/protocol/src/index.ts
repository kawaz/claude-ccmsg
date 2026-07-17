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

/** Parsed normal form of `<dataDir>/config.json`'s `session_launcher` key
 * (DR-0018 §3.1). Paths are home-expanded and absolute; shell is a deliberate
 * built-in choice so launch never falls through to an implicit `sh -c`. */
export interface SessionLauncherConfig {
  root_dirs: string[];
  default_prompt: string;
  shell: "bash" | "zsh";
  command: string;
  timeout_seconds: number;
  dir_tree_depth: number;
}

/** transcript_read (DR-0009) returns at most this many bytes of jsonl lines
 * per request; the viewer pages with byte offsets instead of asking for more.
 * 2 MB ≒ 数千行相当 (kawaz r15 mid=18、2026-07-14: 「初期表示分の tl が
 * 少なすぎる、5-10 倍出して」の 8 倍相当)。SPA rendering 側は既に fold
 * group (thinking/tool_use を折り畳み) で見た目を圧縮しているため、生 payload
 * を増やしても実 UX は「reload 後の older 連打」を大幅減らせる方が体感で
 * 勝つ、というのが実測ベースの判断。 */
export const TRANSCRIPT_READ_MAX_BYTES = 2 * 1024 * 1024;

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
 *   auto-populate. u1 posts are delivered with reply_hint = "tl"; session posts
 *   are rejected so responses stay on the assistant transcript (§2.5). */
export type RoomKind = "normal" | "broadcast" | "1on1";

/** A storage event as delivered over a subscribe stream: flattened with room id.
 * `msg` events additionally carry `reply_hint` (DR-0017 §2.3) — a per-recipient
 * hint telling the receiving agent HOW to respond. Exactly three shapes:
 * - `"r<N>m<M>"`: reply with `ccmsg reply r<N>m<M> <text>` — the daemon builds
 *   the delivery targets (original from + original to − replier + u1, §2.2),
 *   so the receiver never computes a `to` list itself.
 * - `"tl"`: respond via the normal assistant output (transcript); do NOT post
 *   back into the room (1on1 room, u1-authored — the webui SessionView
 *   Timeline picks the response up from the transcript).
 * - `"none"`: no response expected (archived room's inertial msg etc.).
 * Injected at delivery time, NOT persisted in the room jsonl: the value
 * differs by recipient, so a per-msg common storage field would be a
 * contradiction. Only present on `type:"msg"` deliveries. */
export type DeliveredEvent = (StorageEvent & { r: string }) & { reply_hint?: string };

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

/** DR-0020 Phase 1: folded current status of a session's transcript. */
export interface SessionTodo {
  id: string;
  subject: string;
  /** "pending" | "in_progress" | "completed" — open set (upstream may add values). */
  status: string;
  owner?: string;
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
}
/** Main-context observation from the latest non-sidechain, non-synthetic
 * assistant row. Environment overrides are not recorded in transcripts, so
 * the daemon transports raw values and leaves limit estimation to clients. */
export interface SessionContextUsage {
  /** input_tokens + cache_read_input_tokens + cache_creation_input_tokens. */
  tokens: number;
  /** Raw message.model value; launch-only suffixes such as [1m] are absent. */
  model: string;
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
}
export interface SessionStatusSnapshot {
  todos: SessionTodo[];
  workflows: SessionWorkflowStatus[];
  background: SessionBackgroundStatus[];
  context?: SessionContextUsage;
  /** Absent only for older/locally constructed snapshots; daemon snapshots carry an array. */
  teammates?: SessionTeammate[];
  /** DR-0024: absolute paths outside the session's containment root that its
   * transcript records as file-tool inputs. Existing targets are realpaths;
   * missing/deleted targets retain a normalized lexical path. This is exactly
   * the allowlist accepted by fs_read_external. */
  external_files?: string[];
}
/** Full recomputed snapshot pushed after a status-changing transcript event. */
export interface SessionStatusStreamEvent extends SessionStatusSnapshot {
  ev: "session_status";
  sid: string;
}

export type StreamEvent =
  | DeliveredEvent
  | NotifyStreamEvent
  | RestartingStreamEvent
  | AgentsStreamEvent
  | PeersStreamEvent
  | TranscriptStreamEvent
  | SessionStatusStreamEvent;

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
}

export interface ReadRequest {
  op: "read";
  room: string;
  /** "10-15,18" range/list string, or explicit mid list. */
  mids: string | number[];
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

/** Session launch request (DR-0018 §3.2, user role only). Phase 1 validates
 * these opaque values and builds env/argv; command execution lands in Phase 2. */
export interface SessionLaunchRequest {
  op: "session_launch";
  cwd: string;
  model: string;
  effort: string;
  prompt: string;
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
}

/** Search historical Claude Code session transcripts under daemon-detected
 * config dirs (DR-0021 Phase 1, user role only). */
export interface SessionSearchRequest {
  op: "session_search";
  /** newline-separated patterns; blank lines are ignored and all must match one message */
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

export interface PingRequest {
  op: "ping";
}

/** Local en→ja translation through the daemon host (DR-0023, user role only).
 * An empty batch is a capability probe: it verifies the helper can be found or
 * built without starting a TranslationSession. */
export interface TranslateRequest {
  op: "translate";
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
  | RoomsRequest
  | PeersRequest
  | NotifyRequest
  | DirTreeRequest
  | SessionLaunchRequest
  | FsListRequest
  | FsReadRequest
  | FsReadExternalRequest
  | FsWriteRequest
  | TranscriptReadRequest
  | SessionSearchRequest
  | AgentsRequest
  | TranscriptSubscribeRequest
  | TranscriptUnsubscribeRequest
  | SessionStatusRequest
  | SessionStatusSubscribeRequest
  | SessionStatusUnsubscribeRequest
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
/** Phase 1 returns the same stable shape with an explicit mock stderr; Phase 2
 * fills process output and uses null exit_code for signal termination. */
export interface SessionLaunchResponse {
  ok: true;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
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
}
export interface FsWriteResponse {
  ok: true;
  sid: string;
  /** normalized path relative to the session root */
  path: string;
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
  /** e.g. "busy"; absent = idle (upstream omits it) */
  status?: string;
  /** background sessions only, e.g. "done" */
  state?: string;
  /** background sessions only: short id */
  id?: string;
  /** the CLAUDE_CONFIG_DIR this row was polled from (auto-detected ~/.claude* dirs) */
  config_dir: string;
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
  | RoomsResponse
  | PeersResponse
  | NotifyResponse
  | DirTreeResponse
  | SessionLaunchResponse
  | FsListResponse
  | FsReadResponse
  | FsWriteResponse
  | TranscriptReadResponse
  | SessionSearchResponse
  | AgentsResponse
  | TranscriptSubscribeResponse
  | TranscriptUnsubscribeResponse
  | SessionStatusResponse
  | SessionStatusSubscribeResponse
  | SessionStatusUnsubscribeResponse
  | PingResponse
  | TranslateResponse
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
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
