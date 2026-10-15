// The wire's replies to room requests (daemon -> client), as schemas
// (DR-0038). Rooms are read-only (DR-0036 §2). Each reply's type is its
// schema's output; response.ts joins them with the other topics' replies, by
// the op each answers.
//
// Fields the client does not know are left out rather than refused
// (`v.object`): ccmsg owns both ends of the wire, and a daemon of the same
// generation may add one.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import {
  MemberEventSchema,
  MsgEventSchema,
  RoomKindSchema,
  StorageEventSchema,
} from "./storage-event.ts";

export const ReadResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  msgs: v.array(MsgEventSchema),
});
export type ReadResponse = Output<typeof ReadResponseSchema>;

/** Every event of the room's log, in the order the log holds them. */
export const RoomHistoryResponseSchema = v.object({
  ok: v.literal(true),
  room: v.string(),
  events: v.array(StorageEventSchema),
});
export type RoomHistoryResponse = Output<typeof RoomHistoryResponseSchema>;

/** One room log as the room list shows it. */
export const RoomSummarySchema = v.object({
  id: v.string(),
  title: v.optional(v.string()),
  /** the members present at the end of the log (member minus leave) */
  members: v.array(MemberEventSchema),
  last_mid: v.number(),
  /** ts of the log's last event; null for an empty log */
  last_ts: v.nullable(v.string()),
  /** archived flag (DR-0012), last archive event wins; absent = not archived */
  archived: v.optional(v.boolean()),
  /** room kind (DR-0013 broadcast / DR-0014 1on1); absent = "normal" */
  kind: v.optional(RoomKindSchema),
});
export type RoomSummary = Output<typeof RoomSummarySchema>;

export const RoomsResponseSchema = v.object({
  ok: v.literal(true),
  rooms: v.array(RoomSummarySchema),
});
export type RoomsResponse = Output<typeof RoomsResponseSchema>;
