// The wire's room requests (client -> daemon), as schemas (DR-0038). Rooms
// are read-only (DR-0036 §2): these ops read the room logs that are left on
// disk, and nothing on the wire writes one. request.ts joins them into one
// request and reads a line with them.
//
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";
import type { Output } from "./parse.ts";

/** The msgs of one room, by mid. */
export const ReadRequestSchema = v.object({
  op: v.literal("read"),
  room: v.string(),
  /** "10-15,18" range/list string, or explicit mid list. */
  mids: v.union([v.string(), v.array(v.number())]),
});
export type ReadRequest = Output<typeof ReadRequestSchema>;

/** Every event of one room's log, in the order the log holds them. */
export const RoomHistoryRequestSchema = v.object({
  op: v.literal("room_history"),
  room: v.string(),
});
export type RoomHistoryRequest = Output<typeof RoomHistoryRequestSchema>;

/** A summary of every room log. */
export const RoomsRequestSchema = v.object({
  op: v.literal("rooms"),
});
export type RoomsRequest = Output<typeof RoomsRequestSchema>;
