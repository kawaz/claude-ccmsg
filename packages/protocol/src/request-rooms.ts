// The wire's room requests (client -> daemon), as schemas (DR-0038). Each
// request's type is its schema's output; request.ts joins them into one
// request and reads a line with them.
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";

/** Post a new message. A 1on1 room is read-only (DR-0035 §2): a post to one
 * is refused with `invalid_args` for every role. */
export const PostRequestSchema = v.object({
  op: v.literal("post"),
  room: v.string(),
  msg: v.string(),
  /** delivery target member id(s) (see MsgEvent.to). string | string[];
   * absent = deliver to everyone. An empty id names nobody and is left out. */
  to: v.optional(v.union([v.string(), v.array(v.string())])),
});
export type PostRequest = v.InferOutput<typeof PostRequestSchema>;

/** Reply to an existing msg (DR-0017 §2.2): the daemon computes the delivery
 * targets from the referenced msg — `to` = original from + (original to −
 * replier) + u1 — so the replier never assembles a `to` list. The appended
 * MsgEvent records `reply_to: "r<N>m<M>"` (thread material). Errors:
 * msg_not_found / self_reply / invalid_args (the room is a read-only 1on1
 * room, DR-0035 §2). */
export const ReplyRequestSchema = v.object({
  op: v.literal("reply"),
  room: v.string(),
  mid: v.number(),
  msg: v.string(),
});
export type ReplyRequest = v.InferOutput<typeof ReplyRequestSchema>;

/** The kinds create_room opens. A `"1on1"` room is not one of them
 * (DR-0035 §2), and asking for one is answered with where it comes from. */
const CreateRoomKindSchema = v.picklist(["normal", "broadcast"], (issue) =>
  issue.input === "1on1"
    ? "a 1on1 room is not opened through create_room; omit kind for a normal room"
    : `Invalid type: Expected ${issue.expected} but received ${issue.received}`,
);

export const CreateRoomRequestSchema = v.object({
  op: v.literal("create_room"),
  /** participant sids. If the caller is a session and include_self is not false,
   * the caller's own sid is auto-prepended (dedup-safe, see server.ts create_room). */
  members: v.array(v.string()),
  msg: v.optional(v.string()),
  title: v.optional(v.string()),
  /** Default true. When false, a session caller is NOT auto-added to the room's
   * members — used by the CLI's `--exclude-self` opt-out when the caller wants
   * a room that observes without participating. Ignored for user-role callers
   * (who never auto-include either way). */
  include_self: v.optional(v.boolean()),
  /** Room kind (DR-0013 broadcast). Default `"normal"`.
   * - `"broadcast"` opens a broadcast room whose members are auto-populated
   *   from the live session registry — `members` is ignored and the daemon
   *   returns a `warning` field explaining so (§2.9).
   * A `"1on1"` room is not created through this op (DR-0035 §2); the daemon
   * refuses it with `invalid_args`. */
  kind: v.optional(CreateRoomKindSchema),
});
export type CreateRoomRequest = v.InferOutput<typeof CreateRoomRequestSchema>;

/** Record that this session spoke through `ccmsg say`.
 * Session role only. The daemon resolves the caller's own 1on1 room (u1 + this
 * sid), creating one if none exists, and appends a `SayEvent` there — the
 * caller names no room, because "the session's own 1on1" is the only place
 * this belongs. The reply carries the room and the event's `seq`; the CLI
 * ignores both and goes on to exec `/usr/bin/say` regardless, so a failure
 * here costs the observation, never the speech. */
export const SayRequestSchema = v.object({
  op: v.literal("say"),
  /** The argv forwarded to `/usr/bin/say`, joined by spaces (see SayEvent.text). */
  text: v.string(),
});
export type SayRequest = v.InferOutput<typeof SayRequestSchema>;

/** Ack one `say` event as read (webui 既読 button). User role only: the
 * unread count exists for the person watching the session list, and a session
 * acking its own speech would clear a badge nobody looked at. */
export const SayReadRequestSchema = v.object({
  op: v.literal("say_read"),
  room: v.string(),
  /** `seq` of the SayEvent being acked (SayEvent doc comment explains why the
   * ack target is `seq` and not a `mid`). */
  seq: v.number(),
});
export type SayReadRequest = v.InferOutput<typeof SayReadRequestSchema>;

/** Spawn the next thread of a room. A 1on1 room is read-only (DR-0035 §2)
 * and has no next thread: next_room on one is refused with `invalid_args`. */
export const NextRoomRequestSchema = v.object({
  op: v.literal("next_room"),
  room: v.string(),
  msg: v.optional(v.string()),
  title: v.optional(v.string()),
});
export type NextRoomRequest = v.InferOutput<typeof NextRoomRequestSchema>;

/** Rename a room: appends a TitleEvent to the room log (the log's LAST title
 * event wins, same rule create_room/next_room titles already follow) and
 * broadcasts it to subscribers. Allowed for the admin User and for member
 * sessions of the room. The title is trimmed, and one that is empty after
 * that, or longer than the daemon keeps, is refused with `invalid_args`. */
export const SetTitleRequestSchema = v.object({
  op: v.literal("set_title"),
  room: v.string(),
  title: v.string(),
});
export type SetTitleRequest = v.InferOutput<typeof SetTitleRequestSchema>;

/** Toggle a room's archived flag (DR-0012). Same permission as set_title
 * (admin User or member session). Appends an ArchiveEvent + broadcasts it;
 * the webui folds archived rooms into an "アーカイブ" section at the bottom
 * of the room list. No behavioral change to the room itself. */
export const ArchiveRoomRequestSchema = v.object({
  op: v.literal("archive_room"),
  room: v.string(),
  archived: v.boolean(),
});
export type ArchiveRoomRequest = v.InferOutput<typeof ArchiveRoomRequestSchema>;

/** Force-remove a member from a room (DR-0012, webui の ✕ ボタン). Appends
 * the same LeaveEvent a voluntary `leave` would and broadcasts it. Admin
 * User only — a room's agents must not be able to evict each other. NOT a
 * ban: nothing prevents a later re-invite/re-join (deliberate: a re-join
 * restriction has no use case yet). */
export const KickRequestSchema = v.object({
  op: v.literal("kick"),
  room: v.string(),
  /** member id (e.g. "a2") as shown in the room's member list */
  id: v.string(),
});
export type KickRequest = v.InferOutput<typeof KickRequestSchema>;

/** One room's cursor in `since` / `since_seq`: a position, or `null` for a
 * value that is not one. A room named with a value that is not a position
 * still says "I have a cursor for this room", and is replayed in full rather
 * than refused or skipped — duplicates over silent loss (DR-0016 §2.5). */
const SinceCursorSchema = v.fallback(v.nullable(v.number()), null);

/** A `since_seq` cursor: a seq is a finite, non-negative position, and
 * anything else reads as `null` (DR-0016 §2.5). */
const SinceSeqCursorSchema = v.fallback(
  v.nullable(v.pipe(v.number(), v.finite(), v.minValue(0))),
  null,
);

export const SubscribeRequestSchema = v.object({
  op: v.literal("subscribe"),
  /** per-room last-seen mid for delta replay (BBS model, DR-0003 §5). Retained
   * for old-client compat; a room present in `since_seq` uses that cursor
   * instead (DR-0016 §2.3). */
  since: v.optional(v.record(v.string(), SinceCursorSchema)),
  /** per-room last-seen seq for delta replay, spanning ALL event types
   * (DR-0016 §2.3) — supersedes `since` (mid, msg-only) for any room key it
   * covers. Do NOT derive this from a stored `since` value: seq >= mid always
   * holds, so reinterpreting a mid as a seq would skip events. */
  since_seq: v.optional(v.record(v.string(), SinceSeqCursorSchema)),
  /** Opt into the per-room snapshot/full-replay for any visible room
   * NOT covered by `since`/`since_seq` (issue 2026-07-17-subscribe-no-backlog-default).
   * Without this, such a room gets no backlog at all — only a `room_cursors`
   * summary event — so a fresh CLI sidecar connect doesn't re-flood a room's
   * history. The webui sets this unconditionally (it paints room history from
   * the backlog); rooms it already has a `since_seq` cursor for still take the
   * cheaper delta-replay path regardless of this flag. */
  backlog: v.optional(v.boolean()),
});
export type SubscribeRequest = v.InferOutput<typeof SubscribeRequestSchema>;

export const ReadRequestSchema = v.object({
  op: v.literal("read"),
  room: v.string(),
  /** "10-15,18" range/list string, or explicit mid list. */
  mids: v.union([v.string(), v.array(v.number())]),
});
export type ReadRequest = v.InferOutput<typeof ReadRequestSchema>;

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
export const RoomHistoryRequestSchema = v.object({
  op: v.literal("room_history"),
  room: v.string(),
});
export type RoomHistoryRequest = v.InferOutput<typeof RoomHistoryRequestSchema>;

export const RoomsRequestSchema = v.object({
  op: v.literal("rooms"),
});
export type RoomsRequest = v.InferOutput<typeof RoomsRequestSchema>;

export const LeaveRequestSchema = v.object({
  op: v.literal("leave"),
  room: v.string(),
});
export type LeaveRequest = v.InferOutput<typeof LeaveRequestSchema>;

/** Add a connected session to an existing room (webui drag-a-session-onto-
 * the-chat, or a member session pulling in a collaborator). Appends a
 * MemberEvent and broadcasts it. Allowed for the admin User and member
 * sessions; the target must be a currently connected session (its metadata
 * comes from the live registry, same as create_room members). Inviting an
 * existing member is a no-op (already: true). */
export const InviteRequestSchema = v.object({
  op: v.literal("invite"),
  room: v.string(),
  /** sid of the session to add */
  sid: v.pipe(v.string(), v.nonEmpty("Expected a session id, not an empty string")),
});
export type InviteRequest = v.InferOutput<typeof InviteRequestSchema>;
