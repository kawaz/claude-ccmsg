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
}
export interface PeersResponse {
  ok: true;
  peers: PeerInfo[];
}
export interface NotifyResponse {
  ok: true;
  delivered: number;
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
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
