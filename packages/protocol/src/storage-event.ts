// Storage events (room jsonl lines), as schemas (DR-0038). File line order is
// the source of truth for ordering; `mid` (msg only) is a per-room
// daemon-assigned sequence. `seq` (DR-0016) is a SEPARATE per-room
// daemon-assigned sequence spanning ALL event types (msg, member, leave, next,
// prev, title, archive, kind, say, say_read) — the cursor coordinate for
// subscribe reconnect. Optional only for pre-append event construction (caller
// hasn't been stamped yet) and persisted rows that carry no seq (in-memory
// backfilled by loadRoom, see storage.ts); every appended/delivered event
// carries one.
//
// The same events travel the wire as delivered events (stream-event.ts), each
// with the room it belongs to.
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
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type MemberEvent = Output<typeof MemberEventSchema>;

export const LeaveEventSchema = v.object({
  type: v.literal("leave"),
  id: v.string(),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type LeaveEvent = Output<typeof LeaveEventSchema>;

export const MsgEventSchema = v.object({
  type: v.literal("msg"),
  mid: v.number(),
  from: v.string(),
  /** DELIVERY targets, member id[]. Absent = deliver to every member. When
   * present, the subscribe stream (live and since-replay both) delivers this
   * msg only to the listed members, the sender, and the admin User (u1 —
   * exempt because the webui is an observation surface and the User has no
   * agent-style context cost). NOT a storage/visibility filter: the event
   * stays in the room log, every member sees the mid gap in `rooms` /
   * neighboring mids, and `read` serves it to any member on request
   * (deliberate pull, kawaz 2026-07-12: skipped mids signal "a conversation
   * you weren't part of happened; read it iff you care"). */
  to: v.optional(v.array(v.string())),
  ts: v.string(),
  msg: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
  /** the msg this one replies to, as "r<N>m<M>" (DR-0017 §2.2). Recorded by
   * the daemon's reply op (never client-supplied); absent on plain posts.
   * Persisted in the room jsonl — future thread-display material. */
  reply_to: v.optional(v.string()),
});
export type MsgEvent = Output<typeof MsgEventSchema>;

export const NextEventSchema = v.object({
  type: v.literal("next"),
  room: v.string(),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type NextEvent = Output<typeof NextEventSchema>;

export const PrevEventSchema = v.object({
  type: v.literal("prev"),
  room: v.string(),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type PrevEvent = Output<typeof PrevEventSchema>;

export const TitleEventSchema = v.object({
  type: v.literal("title"),
  title: v.string(),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type TitleEvent = Output<typeof TitleEventSchema>;

/** Room archive toggle (DR-0012): a display-organization flag, NOT a lifecycle
 * change — an archived room still accepts posts and still delivers events.
 * Appended per toggle; the log's LAST archive event wins (same rule as title). */
export const ArchiveEventSchema = v.object({
  type: v.literal("archive"),
  archived: v.boolean(),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type ArchiveEvent = Output<typeof ArchiveEventSchema>;

/** Room kind marker (DR-0013 broadcast / DR-0014 1on1). Written exactly once
 * at room creation for non-`"normal"` rooms — a normal room carries no `kind`
 * event and defaults to `"normal"` on load. Persisting it as its own event
 * keeps rooms/*.jsonl append-only and lets scanRooms recover the kind on
 * daemon restart without inventing a separate metadata sidecar. `"normal"` is
 * the absence of this event. */
export const KindEventSchema = v.object({
  type: v.literal("kind"),
  kind: v.picklist(["broadcast", "1on1"]),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type KindEvent = Output<typeof KindEventSchema>;

/** A session spoke through `ccmsg say`, as a 1on1 room holds it. The daemon
 * reads these rows from existing 1on1 rooms (read-only, DR-0035 §2) and never
 * appends one: a say is kept in daemon memory and pushed as `ev:"says"`
 * (stream-event.ts SayRecord, DR-0036 §3). Never delivered into a session-role
 * subscribe stream (the session that spoke already knows it spoke). */
export const SayEventSchema = v.object({
  type: v.literal("say"),
  /** sid of the session that spoke. */
  sid: v.string(),
  /** The argv `ccmsg say` forwarded to `/usr/bin/say`, joined by spaces. */
  text: v.string(),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
  seq: SeqSchema,
});
export type SayEvent = Output<typeof SayEventSchema>;

/** Read-ack for one `say` event of the same room (`ref` is the acked
 * SayEvent's `seq`). Like SayEvent, a row the daemon reads from existing 1on1
 * rooms and never appends. */
export const SayReadEventSchema = v.object({
  type: v.literal("say_read"),
  /** `seq` of the SayEvent this acks. */
  ref: v.number(),
  ts: v.string(),
  /** per-room sequence number (DR-0016), see file banner above. */
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

/** Room kind (DR-0013 broadcast / DR-0014 1on1).
 * - `"normal"` = every other room (default).
 * - `"broadcast"` = auto-populated by session lifecycle, agent post is
 *   restricted to `to: ["u1", ...]`, member/leave events are suppressed from
 *   the subscribe stream.
 * - `"1on1"` = a fixed 2-party room (u1 + a single session). Not created by
 *   `create_room` (DR-0035 §2); the daemon's `say` op creates one to record
 *   a session's says. No auto-populate. Read-only: post / reply / next_room
 *   are refused for every role, so it holds only says and the messages it
 *   already had. */
export const RoomKindSchema = v.picklist(["normal", "broadcast", "1on1"]);
export type RoomKind = Output<typeof RoomKindSchema>;
