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

/** transcript_read (DR-0009) returns at most this many bytes of jsonl lines
 * per request; the viewer pages with byte offsets instead of asking for more. */
export const TRANSCRIPT_READ_MAX_BYTES = 256 * 1024;

// ---------------------------------------------------------------------------
// Storage events (room jsonl lines). File line order is the source of truth for
// ordering; `mid` (msg only) is a per-room daemon-assigned sequence.
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
}

export interface LeaveEvent {
  type: "leave";
  id: string;
  ts: string;
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
}

export interface NextEvent {
  type: "next";
  room: string;
  ts: string;
}

export interface PrevEvent {
  type: "prev";
  room: string;
  ts: string;
}

export interface TitleEvent {
  type: "title";
  title: string;
  ts: string;
}

/** Room archive toggle (DR-0012): a display-organization flag, NOT a lifecycle
 * change — an archived room still accepts posts and still delivers events.
 * Appended per toggle; the log's LAST archive event wins (same rule as title). */
export interface ArchiveEvent {
  type: "archive";
  archived: boolean;
  ts: string;
}

export type StorageEvent =
  | MemberEvent
  | LeaveEvent
  | MsgEvent
  | NextEvent
  | PrevEvent
  | TitleEvent
  | ArchiveEvent;

/** A storage event as delivered over a subscribe stream: flattened with room id. */
export type DeliveredEvent = StorageEvent & { r: string };

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
export type StreamEvent =
  | DeliveredEvent
  | NotifyStreamEvent
  | RestartingStreamEvent
  | AgentsStreamEvent
  | PeersStreamEvent
  | TranscriptStreamEvent;

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
   * strict ancestor of cwd, not "/" or $HOME itself), fs_list/fs_read use it
   * as the containment root instead of cwd — so sibling workspaces of the
   * same repo become browsable. Rejected or absent = cwd root as before. */
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

export interface PostRequest {
  op: "post";
  room: string;
  msg: string;
  /** delivery target member id(s) (see MsgEvent.to). string | string[];
   * absent = deliver to everyone. */
  to?: string | string[];
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
  /** per-room last-seen mid for delta replay (BBS model, DR-0003 §5). */
  since?: Record<string, number>;
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

/**
 * Workspace file access (DR-0008): read-only browsing of a connected
 * session's project files from the webui. The browsable universe is strictly
 * "the cwd of a currently-connected session" — the client names a session
 * (`sid`), never a filesystem root, and `path` is always relative to that
 * session's cwd. The daemon resolves and containment-checks every path
 * (realpath prefix check, so symlinks cannot escape the root) before touching
 * the filesystem.
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

/**
 * Session transcript access (DR-0009): read a slice of a connected session's
 * Claude Code transcript jsonl. Unlike fs_read there is NO client-supplied
 * path — the daemon only ever serves the single file the session announced
 * (and it validated) at hello time, so no traversal surface exists. Paging is
 * by byte offset, aligned to line boundaries, so a multi-hundred-MB transcript
 * never needs a full scan or a line index: the viewer starts from the tail
 * (`before` absent) and pages older by passing the previous reply's `start`.
 */
export interface TranscriptReadRequest {
  op: "transcript_read";
  sid: string;
  /** read lines that END at or before this byte offset (exclusive); absent = file end */
  before?: number;
  /** cap on returned line bytes; clamped to TRANSCRIPT_READ_MAX_BYTES */
  max_bytes?: number;
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

export interface PingRequest {
  op: "ping";
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
  | FsListRequest
  | FsReadRequest
  | TranscriptReadRequest
  | AgentsRequest
  | TranscriptSubscribeRequest
  | TranscriptUnsubscribeRequest
  | PingRequest
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
  | FsListResponse
  | FsReadResponse
  | TranscriptReadResponse
  | AgentsResponse
  | TranscriptSubscribeResponse
  | TranscriptUnsubscribeResponse
  | PingResponse
  | ShutdownResponse
  | LeaveResponse
  | InviteResponse;

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
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
