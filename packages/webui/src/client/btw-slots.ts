// Where a session's btws (DR-0060 §7) sit inside its Timeline: right after
// the item holding the row the btw was asked at (its anchor, `after_uuid`; a
// row drawn as nothing sits in the item it is grouped into, or is an item
// that draws nothing, which is the same place), or, when the loaded window
// has no such row (it was taken out of the transcript, or the btw names
// none), at its time — as long as that time falls inside the loaded window.
// One older than the window waits until older pages bring its place in.
//
// Pure, per DR-0005 §1, as time-slots.ts beside it.
import type { BtwAnswer, BtwRecord, CommentRecord, UserComment } from "@ccmsg/protocol";
import { slotsByTime } from "./time-slots.ts";
import type { TimelineGroup, TimelineEntry } from "./transcript-model.ts";

function entriesOf(group: TimelineGroup): readonly TimelineEntry[] {
  return group.kind === "entry" ? [group] : group.entries;
}

/** The first stamp of the loaded window, null when nothing in it is stamped. */
function windowStart(groups: readonly TimelineGroup[]): number | null {
  for (const group of groups) {
    for (const { line } of entriesOf(group)) {
      if (line.kind === "broken" || line.ts === null) continue;
      const ms = Date.parse(line.ts);
      if (!Number.isNaN(ms)) return ms;
    }
  }
  return null;
}

/** Slot array of length `groups.length + 1`, as slotsByTime's: slot `i`
 * holds the btws drawn right before group `i` (so right after group `i - 1`),
 * oldest first. `atStart` says the window starts at the transcript's first
 * byte: then nothing is older than the window. */
export function btwSlots(
  groups: readonly TimelineGroup[],
  btws: readonly BtwRecord[],
  atStart: boolean,
): BtwRecord[][] {
  return anchoredSlots(
    groups,
    btws,
    (btw) => btw.after_uuid,
    (btw) => btw.ts,
    atStart,
  );
}

/** A btw comment (DR-0062 §14) as the Timeline draws it: its question, its
 * answers in the order asked (the last one the one shown, P30), and where it
 * stands: the point it was sent at (what its fork read up to), or, not sent
 * (or waiting for room before its first fork), where it was written (§12). */
export interface PlacedBtw {
  question: UserComment;
  answers: BtwAnswer[];
  after: string | undefined;
  ts: string;
}

/** The btw comments of a session's records: the ones sent (or being sent),
 * and with `unsent` (the 💬 filter, which lists what is not sent) the drafts
 * too. Taken back ones are none. */
export function placedBtws(records: Iterable<CommentRecord>, unsent: boolean): PlacedBtw[] {
  const questions = new Map<string, PlacedBtw>();
  const answers: BtwAnswer[] = [];
  for (const record of records) {
    if (record.author === "btw") answers.push(record);
    if (record.author !== "user" || !record.btw || record.status === "deleted") continue;
    if (record.status === "draft" && !unsent) continue;
    const point = record.sent ?? record.written;
    questions.set(record.cid, {
      question: record,
      answers: [],
      after: point.after_uuid,
      ts: point.at,
    });
  }
  for (const answer of answers) {
    if (answer.anchor.kind !== "comment") continue;
    questions.get(answer.anchor.cid)?.answers.push(answer);
  }
  return [...questions.values()];
}

/** btwSlots' placement for any item that stands after a row (its anchor's
 * uuid, `anchorOf`) and was made at a time (`tsOf`): a comment's too
 * (DR-0062 §12, P10). */
export function anchoredSlots<T>(
  groups: readonly TimelineGroup[],
  items: readonly T[],
  anchorOf: (item: T) => string | undefined,
  tsOf: (item: T) => string,
  atStart: boolean,
): T[][] {
  const slots: T[][] = Array.from({ length: groups.length + 1 }, () => []);
  if (items.length === 0) return slots;
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const { line } of entriesOf(group)) {
      if (line.kind !== "broken" && line.uuid !== undefined) groupOf.set(line.uuid, index);
    }
  });
  const start = windowStart(groups);
  const timed: { item: T; ts: string }[] = [];
  for (const item of items) {
    const anchor = anchorOf(item);
    const anchored = anchor !== undefined ? groupOf.get(anchor) : undefined;
    if (anchored !== undefined) {
      slots[anchored + 1]?.push(item);
      continue;
    }
    const ts = tsOf(item);
    const at = Date.parse(ts);
    if (atStart || (start !== null && !Number.isNaN(at) && at >= start)) timed.push({ item, ts });
  }
  slotsByTime(groups, timed).forEach((slot, index) =>
    slots[index]?.push(...slot.map((placed) => placed.item)),
  );
  for (const slot of slots) slot.sort((a, b) => Date.parse(tsOf(a)) - Date.parse(tsOf(b)));
  return slots;
}
