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
  /** attention (mention) targets, member id[]. Absent = everyone. Not a visibility filter. */
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

export type StorageEvent = MemberEvent | LeaveEvent | MsgEvent | NextEvent | PrevEvent | TitleEvent;

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
export type StreamEvent = DeliveredEvent | NotifyStreamEvent | RestartingStreamEvent;

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
}

export interface PostRequest {
  op: "post";
  room: string;
  msg: string;
  /** mention target member id(s). string | string[]; absent = everyone. */
  to?: string | string[];
}

export interface CreateRoomRequest {
  op: "create_room";
  /** participant sids (caller session is auto-added). */
  members: string[];
  msg?: string;
  title?: string;
}

export interface NextRoomRequest {
  op: "next_room";
  room: string;
  msg?: string;
  title?: string;
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

export type Request =
  | HelloRequest
  | PostRequest
  | CreateRoomRequest
  | NextRoomRequest
  | SubscribeRequest
  | ReadRequest
  | RoomsRequest
  | PeersRequest
  | NotifyRequest
  | FsListRequest
  | FsReadRequest
  | TranscriptReadRequest
  | PingRequest
  | ShutdownRequest
  | LeaveRequest;

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
export interface PingResponse {
  ok: true;
  pong: true;
  version: string;
  uptime: number;
  pid: number;
  rooms: number;
  clients: number;
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

export type Response =
  | ErrorResponse
  | HelloResponse
  | PostResponse
  | CreateRoomResponse
  | NextRoomResponse
  | SubscribeAck
  | ReadResponse
  | RoomsResponse
  | PeersResponse
  | NotifyResponse
  | FsListResponse
  | FsReadResponse
  | TranscriptReadResponse
  | PingResponse
  | ShutdownResponse
  | LeaveResponse;

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
