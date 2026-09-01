// Where a session's `say` bubbles sit inside its own Timeline (kawaz r244m14).
//
// A `ccmsg say` is recorded in the session's 1on1 room and never echoed into
// the session transcript (protocol/index.ts SayEvent: mirroring it would spend
// agent context for nothing), so the transcript the Timeline renders has no
// row for it. The bubbles are therefore merged in at render time by wall-clock
// time: the room events and the transcript rows are two logs of the same
// session, and `ts` is the only thing they share.
//
// Pure, per DR-0005 §1, so the placement rule is testable without a Timeline.
// Same shape as fork-divider.ts, which likewise turns "where does this belong"
// into an index in the rendered group list — but this one places many items
// and can place them past the end, hence a slot array rather than one index.
import type { ParsedLine, TimelineGroup } from "./transcript-model.ts";

/** What placement needs from a say event: when it happened, and a tiebreak for
 * two says sharing a stamp. Generic over the caller's event type so the room
 * timeline's `DeliveredEvent` flavour (which carries routing fields on top of
 * SayEvent) comes back out unchanged. */
interface SayPlacement {
  ts: string;
  seq?: number;
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
 * Slot array of length `groups.length + 1`: slot `i` holds the say events to
 * draw immediately before group `i`, and the last slot the ones that happened
 * after everything in the loaded window (a say from the current turn, which is
 * the common live case — the transcript row for that turn is not written yet).
 *
 * Says older than the whole window land in slot 0 rather than being dropped:
 * "load older" is what moves them into place, and hiding them until then would
 * make the 📣 in the Sessions list point at a bubble that is nowhere.
 */
export function saySlots<T extends SayPlacement>(
  groups: readonly TimelineGroup[],
  says: readonly T[],
): T[][] {
  const slots: T[][] = Array.from({ length: groups.length + 1 }, () => []);
  if (says.length === 0) return slots;
  const stamps = groups.map(groupTs);
  const ordered = [...says].sort(
    (a, b) => toMillis(a.ts) - toMillis(b.ts) || (a.seq ?? 0) - (b.seq ?? 0),
  );
  for (const say of ordered) {
    const at = toMillis(say.ts);
    let slot = groups.length;
    for (let i = 0; i < stamps.length; i++) {
      const stamp = stamps[i];
      if (stamp === null || stamp === undefined) continue;
      if (toMillis(stamp) > at) {
        slot = i;
        break;
      }
    }
    slots[slot]!.push(say);
  }
  return slots;
}
