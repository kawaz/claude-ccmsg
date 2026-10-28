// Where a session's requests for permission (DR-0040) sit inside its own
// Timeline.
//
// A request for permission is recorded by the daemon (in memory, the
// `ev:"permit_requests"` / `ev:"permit_request"` pushes), apart from the
// session transcript the Timeline renders, so the transcript has no row for
// it. The bubbles are therefore merged in at render time by wall-clock time:
// the requests and the transcript rows are two logs of the same session, and
// `ts` is the only thing they share.
//
// Pure, per DR-0005 §1, so the placement rule is testable without a Timeline.
// Same shape as fork-divider.ts, which likewise turns "where does this belong"
// into an index in the rendered group list — but this one places many items
// and can place them past the end, hence a slot array rather than one index.
import type { ParsedLine, TimelineGroup } from "./transcript-model.ts";

/** What placement needs from a request: when it was made. Generic over the
 * caller's record type so the record comes back out unchanged. */
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
 * Slot array of length `groups.length + 1`: slot `i` holds the requests to
 * draw immediately before group `i`, in time order, and the last slot the
 * ones made after everything in the loaded window (a request from the current
 * turn, which is the common live case — the transcript row for that turn is
 * not written yet). Two requests sharing a stamp keep the order they came in
 * (the daemon's record order): Array.prototype.sort is stable.
 *
 * Requests older than the whole window land in slot 0 rather than being
 * dropped: "load older" is what moves them into place, and hiding them until
 * then would make the 🔐 in the Sessions list point at a bubble that is
 * nowhere.
 */
export function permitSlots<T extends Placement>(
  groups: readonly TimelineGroup[],
  requests: readonly T[],
): T[][] {
  const slots: T[][] = Array.from({ length: groups.length + 1 }, () => []);
  if (requests.length === 0) return slots;
  const stamps = groups.map(groupTs);
  const ordered = [...requests].sort((a, b) => toMillis(a.ts) - toMillis(b.ts));
  for (const request of ordered) {
    const at = toMillis(request.ts);
    const later = stamps.findIndex((stamp) => stamp !== null && toMillis(stamp) > at);
    const slot = slots[later < 0 ? groups.length : later];
    if (slot !== undefined) slot.push(request);
  }
  return slots;
}
