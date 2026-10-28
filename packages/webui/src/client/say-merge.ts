// Where a session's `say` bubbles sit inside its own Timeline (kawaz r244m14).
//
// A `ccmsg say` is recorded by the daemon (in memory, the `ev:"says"` push)
// and never echoed into the session transcript (mirroring it would spend agent
// context for nothing), so the transcript the Timeline renders has no row for
// it. The bubbles are therefore merged in at render time by wall-clock time:
// the say records and the transcript rows are two logs of the same session,
// and `ts` is the only thing they share.
//
// Pure, per DR-0005 §1, so the placement rule is testable without a Timeline.
// Same shape as fork-divider.ts, which likewise turns "where does this belong"
// into an index in the rendered group list — but this one places many items
// and can place them past the end, hence a slot array rather than one index.
import type { SayRecord } from "@ccmsg/protocol";
import type { ParsedLine, TimelineGroup } from "./transcript-model.ts";

/** What placement needs from a say: when it happened. Generic over the
 * caller's record type so the record comes back out unchanged. */
interface SayPlacement {
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

/** The says in the order the Timeline draws them. Two says sharing a stamp
 * keep the order they came in (the daemon's record order):
 * Array.prototype.sort is stable. Also orders the bubbles of one slot when
 * says and requests for permission (DR-0040) share it. */
export function inTimeOrder<T extends SayPlacement>(says: readonly T[]): T[] {
  return [...says].sort((a, b) => toMillis(a.ts) - toMillis(b.ts));
}

/**
 * Slot array of length `groups.length + 1`: slot `i` holds the say events to
 * draw immediately before group `i`, and the last slot the ones that happened
 * after everything in the loaded window (a say from the current turn, which is
 * the common live case — the transcript row for that turn is not written yet).
 *
 * Says older than the whole window land in slot 0 rather than being dropped:
 * "load older" is what moves them into place, and hiding them until then would
 * make the 🔔 in the Sessions list point at a bubble that is nowhere.
 */
export function saySlots<T extends SayPlacement>(
  groups: readonly TimelineGroup[],
  says: readonly T[],
): T[][] {
  const slots: T[][] = Array.from({ length: groups.length + 1 }, () => []);
  if (says.length === 0) return slots;
  const stamps = groups.map(groupTs);
  const ordered = inTimeOrder(says);
  for (const say of ordered) {
    const at = toMillis(say.ts);
    const later = stamps.findIndex(
      (stamp) => stamp !== null && stamp !== undefined && toMillis(stamp) > at,
    );
    const slot = slots[later < 0 ? groups.length : later];
    if (slot !== undefined) slot.push(say);
  }
  return slots;
}

/**
 * The ids the 既読 button on the say `id` acks, out of one Timeline's `says`.
 * The newest unread say's button acks every unread one (kawaz 2026-10-25: a
 * run of says piles up, and pressing each is a chore); any other button acks
 * its own say only. Newest is the last one the Timeline draws. The ids are
 * the ones drawn now, so a say arriving after the click stays unread.
 */
export function sayReadTargets(says: readonly SayRecord[], id: string): readonly string[] {
  const unread = inTimeOrder(says.filter((r) => !r.read)).map((r) => r.id);
  return unread.at(-1) === id ? unread : [id];
}
