// Where the bubbles that have no row of the loaded window sit inside a
// session's Timeline: a subagent's or teammate's say (its row is in the
// agent's own transcript, DR-0050 §10), and, under the 🔔 / 🔐 filter, the
// session's says and requests for permission outside the window
// (notification_list, DR-0050 §5). They are merged in at render time by
// wall-clock time: `ts` is the only thing they share with the window's rows.
//
// Pure, per DR-0005 §1, so the placement rule is testable without a Timeline.
// Same shape as fork-divider.ts, which likewise turns "where does this belong"
// into an index in the rendered group list — but this one places many items
// and can place them past the end, hence a slot array rather than one index.
import type { ParsedLine, TimelineGroup } from "./transcript-model.ts";

/** What placement needs from an item: when it was made. Generic over the
 * caller's item type so the item comes back out unchanged. */
interface Placement {
  ts: string;
}

function lineTs(line: ParsedLine): string | null {
  return line.kind === "broken" ? null : line.ts;
}

/** When a group starts. A fold group holds many rows, so the first row that
 * carries a stamp is what the group is dated by — inserting before a group
 * means inserting before its first row. Null when nothing in the group is
 * stamped (a window of broken lines), which makes the group transparent to
 * placement rather than an arbitrary boundary. */
function groupTs(group: TimelineGroup): string | null {
  if (group.kind === "entry") return lineTs(group.line);
  for (const entry of group.entries) {
    const ts = lineTs(entry.line);
    if (ts !== null) return ts;
  }
  return null;
}

function toMillis(ts: string): number {
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

/**
 * Slot array of length `groups.length + 1`: slot `i` holds the items to
 * draw immediately before group `i`, in time order, and the last slot the
 * ones made after everything in the loaded window (an item from the current
 * turn, which is the common live case). Two items sharing a stamp keep the
 * order they came in: Array.prototype.sort is stable.
 *
 * Items older than the whole window land in slot 0 rather than being
 * dropped: they are shown at the window's top, in time order.
 */
export function slotsByTime<T extends Placement>(
  groups: readonly TimelineGroup[],
  items: readonly T[],
): T[][] {
  const slots: T[][] = Array.from({ length: groups.length + 1 }, () => []);
  if (items.length === 0) return slots;
  const stamps = groups.map(groupTs);
  const ordered = [...items].sort((a, b) => toMillis(a.ts) - toMillis(b.ts));
  for (const request of ordered) {
    const at = toMillis(request.ts);
    const later = stamps.findIndex((stamp) => stamp !== null && toMillis(stamp) > at);
    const slot = slots[later < 0 ? groups.length : later];
    if (slot !== undefined) slot.push(request);
  }
  return slots;
}
