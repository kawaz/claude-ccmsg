// Storage events (room jsonl lines), as schemas (DR-0038). Rooms are
// read-only (DR-0036 §2): the logs are what is left on disk, and nothing
// appends to them. File line order is the source of truth for ordering; `mid`
// (msg only) is a per-room sequence. `seq` is a separate per-room
// sequence spanning all event types; rows written before it carry none.
//
// The same events travel the wire in the `room_history` reply.
import * as v from "valibot";
import type { Output } from "./parse.ts";

const SeqSchema = v.optional(v.number());

export const MemberEventSchema = v.object({
  type: v.literal("member"),
  id: v.string(),
  sid: v.string(),
  repo: v.string(),
  ws: v.string(),
  cwd: v.string(),
  joined_at: v.string(),
  /** guest role marker; absent = regular member (agent, or admin's implicit row is absent entirely). */
  role: v.optional(v.picklist(["admin", "guest"])),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type MemberEvent = Output<typeof MemberEventSchema>;

export const LeaveEventSchema = v.object({
  type: v.literal("leave"),
  id: v.string(),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type LeaveEvent = Output<typeof LeaveEventSchema>;

export const MsgEventSchema = v.object({
  type: v.literal("msg"),
  mid: v.number(),
  from: v.string(),
  /** The member ids the msg was addressed to. Absent = every
   * member. */
  to: v.optional(v.array(v.string())),
  ts: v.string(),
  msg: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
  /** The msg this one replied to, as "r<N>m<M>". */
  reply_to: v.optional(v.string()),
});
export type MsgEvent = Output<typeof MsgEventSchema>;

export const NextEventSchema = v.object({
  type: v.literal("next"),
  room: v.string(),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type NextEvent = Output<typeof NextEventSchema>;

export const PrevEventSchema = v.object({
  type: v.literal("prev"),
  room: v.string(),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type PrevEvent = Output<typeof PrevEventSchema>;

export const TitleEventSchema = v.object({
  type: v.literal("title"),
  title: v.string(),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type TitleEvent = Output<typeof TitleEventSchema>;

/** Room archive toggle: a display-organization flag. The log's
 * last archive event wins (same rule as title). */
export const ArchiveEventSchema = v.object({
  type: v.literal("archive"),
  archived: v.boolean(),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type ArchiveEvent = Output<typeof ArchiveEventSchema>;

/** Room kind marker (broadcast / 1on1). A normal room
 * carries no `kind` event; `"normal"` is its absence. */
export const KindEventSchema = v.object({
  type: v.literal("kind"),
  kind: v.picklist(["broadcast", "1on1"]),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type KindEvent = Output<typeof KindEventSchema>;

/** A session spoke through `ccmsg say`, as a 1on1 room's log holds it. */
export const SayEventSchema = v.object({
  type: v.literal("say"),
  /** sid of the session that spoke. */
  sid: v.string(),
  /** The argv `ccmsg say` forwarded to `/usr/bin/say`, joined by spaces. */
  text: v.string(),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type SayEvent = Output<typeof SayEventSchema>;

/** Read-ack for one `say` event of the same room (`ref` is the acked
 * SayEvent's `seq`). */
export const SayReadEventSchema = v.object({
  type: v.literal("say_read"),
  /** `seq` of the SayEvent this acks. */
  ref: v.number(),
  ts: v.string(),
  /** per-room sequence number, see the file banner. */
  seq: SeqSchema,
});
export type SayReadEvent = Output<typeof SayReadEventSchema>;

/** Every storage event, told apart by `type`. */
export const StorageEventSchema = v.variant("type", [
  MemberEventSchema,
  LeaveEventSchema,
  MsgEventSchema,
  NextEventSchema,
  PrevEventSchema,
  TitleEventSchema,
  ArchiveEventSchema,
  KindEventSchema,
  SayEventSchema,
  SayReadEventSchema,
]);
export type StorageEvent = Output<typeof StorageEventSchema>;

/** Room kind: `"normal"`, a broadcast
 * room that every session joined, or a 1on1 room between the person and one
 * session. */
export const RoomKindSchema = v.picklist(["normal", "broadcast", "1on1"]);
export type RoomKind = Output<typeof RoomKindSchema>;
