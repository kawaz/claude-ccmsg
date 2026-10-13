// The wire's replies to room requests (daemon -> client), as schemas
// (DR-0038). Each reply's type is its schema's output; response.ts joins them
// with the other topics' replies, by the op each answers.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): ccmsg owns both ends of the wire, and a daemon of the same
// generation may add one.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import { MemberEventSchema, MsgEventSchema, RoomKindSchema } from "./storage-event.ts";

export const PostResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  mid: v.number(),
});
export type PostResponse = Output<typeof PostResponseSchema>;

/** Reply to `reply`: the posted msg, like PostResponse, and the delivery
 * targets the daemon computed for it (see ReplyRequest), sorted. */
export const ReplyResponseSchema = v.object({
  ...PostResponseSchema.entries,
  to: v.array(v.string()),
});
export type ReplyResponse = Output<typeof ReplyResponseSchema>;

export const CreateRoomResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  reused: v.boolean(),
  mid: v.optional(v.number()),
  /** Advisory notice about the request (DR-0013 §2.9: `kind:"broadcast"` +
   * non-empty `members` returns a warning that the explicit members list was
   * ignored — broadcast rooms auto-populate from the session registry, so any
   * caller-supplied list is redundant). Non-fatal; the room is still created.
   * Absent when there's nothing to warn about. */
  warning: v.optional(v.string()),
});
export type CreateRoomResponse = Output<typeof CreateRoomResponseSchema>;

export const NextRoomResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  mid: v.optional(v.number()),
});
export type NextRoomResponse = Output<typeof NextRoomResponseSchema>;

export const SetTitleResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  title: v.string(),
});
export type SetTitleResponse = Output<typeof SetTitleResponseSchema>;

export const ArchiveRoomResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  archived: v.boolean(),
});
export type ArchiveRoomResponse = Output<typeof ArchiveRoomResponseSchema>;

export const KickResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  id: v.string(),
});
export type KickResponse = Output<typeof KickResponseSchema>;

export const SubscribeAckSchema = v.object({
  ok: v.literal(true),
  subscribed: v.literal(true),
});
export type SubscribeAck = Output<typeof SubscribeAckSchema>;

export const ReadResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  msgs: v.array(MsgEventSchema),
});
export type ReadResponse = Output<typeof ReadResponseSchema>;

/** Sent after the room's snapshot events (see RoomHistoryRequest): receiving it
 * means the history for `room` has been fully delivered on this connection. */
export const RoomHistoryResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
});
export type RoomHistoryResponse = Output<typeof RoomHistoryResponseSchema>;

export const RoomSummarySchema = v.object({
  id: v.string(),
  title: v.optional(v.string()),
  members: v.array(MemberEventSchema),
  last_mid: v.number(),
  last_ts: v.nullable(v.string()),
  /** archived flag (DR-0012), last archive event wins; absent = not archived */
  archived: v.optional(v.boolean()),
  /** room kind (DR-0013); absent = "normal". webui shows a broadcast badge
   * and swaps the Composer for a broadcast-target picker when this is set. */
  kind: v.optional(RoomKindSchema),
  /** How many of `members` currently have a connected session — i.e. how many
   * people in this room can be reached right now. The User (`ADMIN_ID`) is
   * never counted: it is an implicit member of every room with no session
   * behind it, so counting it would make every room look inhabited. Derived
   * from the live session registry on each request (never persisted), so it
   * changes on every connect/disconnect. `0` means nobody in the room is
   * reachable; absent means the daemon predates the field (a client must then
   * treat liveness as unknown rather than as zero). */
  live_members: v.optional(v.number()),
});
export type RoomSummary = Output<typeof RoomSummarySchema>;

export const RoomsResponseSchema = v.object({
  ok: v.literal(true),
  rooms: v.array(RoomSummarySchema),
});
export type RoomsResponse = Output<typeof RoomsResponseSchema>;

export const LeaveResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
});
export type LeaveResponse = Output<typeof LeaveResponseSchema>;

export const InviteResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  /** member id assigned to (or already held by) the invited session */
  id: v.string(),
  /** true = the session was already a member, nothing appended */
  already: v.boolean(),
});
export type InviteResponse = Output<typeof InviteResponseSchema>;
