// The wire's replies to room requests (daemon -> client), as schemas
// (DR-0038). Each reply's type is its schema's output; response.ts joins them
// with the other topics' replies, by the op each answers.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): ccmsg owns both ends of the wire, and a daemon of the same
// generation may add one.
import * as v from "valibot";
import { MemberEventSchema, MsgEventSchema, RoomKindSchema } from "./storage-event.ts";

export const PostResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  mid: v.number(),
});
export type PostResponse = v.InferOutput<typeof PostResponseSchema>;

/** Reply to `reply`: the posted msg, like PostResponse, and the delivery
 * targets the daemon computed for it (see ReplyRequest), sorted. */
export const ReplyResponseSchema = v.object({
  ...PostResponseSchema.entries,
  to: v.array(v.string()),
});
export type ReplyResponse = v.InferOutput<typeof ReplyResponseSchema>;

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
export type CreateRoomResponse = v.InferOutput<typeof CreateRoomResponseSchema>;

export const SayResponseSchema = v.object({
  ok: v.literal(true),
  /** The 1on1 room the say landed in (resolved or freshly created). */
  room: v.string(),
  /** `seq` stamped on the appended SayEvent — the ack target a later
   * `say_read` names. */
  seq: v.number(),
  /** true when this call is what created the 1on1 room. */
  created: v.boolean(),
});
export type SayResponse = v.InferOutput<typeof SayResponseSchema>;

export const SayReadResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  /** echo of the acked SayEvent's seq */
  ref: v.number(),
});
export type SayReadResponse = v.InferOutput<typeof SayReadResponseSchema>;

export const NextRoomResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  mid: v.optional(v.number()),
});
export type NextRoomResponse = v.InferOutput<typeof NextRoomResponseSchema>;

export const SetTitleResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  title: v.string(),
});
export type SetTitleResponse = v.InferOutput<typeof SetTitleResponseSchema>;

export const ArchiveRoomResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  archived: v.boolean(),
});
export type ArchiveRoomResponse = v.InferOutput<typeof ArchiveRoomResponseSchema>;

export const KickResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  id: v.string(),
});
export type KickResponse = v.InferOutput<typeof KickResponseSchema>;

export const SubscribeAckSchema = v.object({
  ok: v.literal(true),
  subscribed: v.literal(true),
});
export type SubscribeAck = v.InferOutput<typeof SubscribeAckSchema>;

export const ReadResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  msgs: v.array(MsgEventSchema),
});
export type ReadResponse = v.InferOutput<typeof ReadResponseSchema>;

/** Sent after the room's snapshot events (see RoomHistoryRequest): receiving it
 * means the history for `room` has been fully delivered on this connection. */
export const RoomHistoryResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
});
export type RoomHistoryResponse = v.InferOutput<typeof RoomHistoryResponseSchema>;

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
  /** `seq` of every `say` event in this room with no matching `say_read` ack
   * Only ever non-empty on a 1on1 room; absent when there
   * is nothing unread. Seeds the webui's sidebar 📣 marker, which then tracks
   * live `say` / `say_read` deliveries on the subscribe stream.
   *
   * Design rationale (the seqs, not just their count): the client keeps this
   * as a set, so folding a replayed history — opening the room refetches every
   * past `say` and `say_read` through `room_history` — is idempotent. A bare
   * count plus increment/decrement deltas would double-count on exactly that
   * very ordinary path. */
  say_unread_seqs: v.optional(v.array(v.number())),
});
export type RoomSummary = v.InferOutput<typeof RoomSummarySchema>;

export const RoomsResponseSchema = v.object({
  ok: v.literal(true),
  rooms: v.array(RoomSummarySchema),
});
export type RoomsResponse = v.InferOutput<typeof RoomsResponseSchema>;

export const LeaveResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
});
export type LeaveResponse = v.InferOutput<typeof LeaveResponseSchema>;

export const InviteResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  /** member id assigned to (or already held by) the invited session */
  id: v.string(),
  /** true = the session was already a member, nothing appended */
  already: v.boolean(),
});
export type InviteResponse = v.InferOutput<typeof InviteResponseSchema>;
