// Where a session's btws (DR-0060 §7) sit inside its Timeline: right after
// the item holding the row the btw was asked at (its anchor, `after_uuid`; a
// row drawn as nothing sits in the item it is grouped into, or is an item
// that draws nothing, which is the same place), or, when the loaded window
// has no such row (it was taken out of the transcript, or the btw names
// none), at its time — as long as that time falls inside the loaded window.
// One older than the window waits until older pages bring its place in.
//
// Pure, per DR-0005 §1, as time-slots.ts beside it.
import type { BtwRecord } from "@ccmsg/protocol";
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
  const slots: BtwRecord[][] = Array.from({ length: groups.length + 1 }, () => []);
  if (btws.length === 0) return slots;
  const groupOf = new Map<string, number>();
  groups.forEach((group, index) => {
    for (const { line } of entriesOf(group)) {
      if (line.kind !== "broken" && line.uuid !== undefined) groupOf.set(line.uuid, index);
    }
  });
  const start = windowStart(groups);
  const timed: BtwRecord[] = [];
  for (const btw of btws) {
    const anchored = btw.after_uuid !== undefined ? groupOf.get(btw.after_uuid) : undefined;
    if (anchored !== undefined) {
      slots[anchored + 1]?.push(btw);
      continue;
    }
    const at = Date.parse(btw.ts);
    if (atStart || (start !== null && !Number.isNaN(at) && at >= start)) timed.push(btw);
  }
  slotsByTime(groups, timed).forEach((slot, index) => slots[index]?.push(...slot));
  for (const slot of slots) slot.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
  return slots;
}
