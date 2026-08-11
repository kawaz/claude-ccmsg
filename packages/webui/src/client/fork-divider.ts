// Where the "forked from here" rule is drawn in a forked session's Timeline.
//
// The daemon resolves the seam (fork-origin.ts) and names the last copied
// record by uuid; this turns that uuid into a position in the rendered group
// list. Pure, per DR-0005 §1, so the placement rule is testable without a
// Timeline. The launch-side counterpart is fork-point.ts: that one decides
// where to CUT when starting a fork, this one decides where to DRAW the seam of
// a fork that already exists.
import type { ParsedLine, TimelineGroup } from "./transcript-model.ts";

/** A broken line carries no uuid to match on, hence the narrowing. */
function lineUuid(line: ParsedLine): string | undefined {
  return line.kind === "broken" ? undefined : line.uuid;
}

function containsUuid(group: TimelineGroup, uuid: string): boolean {
  if (group.kind === "entry") return lineUuid(group.line) === uuid;
  return group.entries.some((entry) => lineUuid(entry.line) === uuid);
}

/**
 * Index in `groups` before which the fork divider belongs — the first group
 * that is entirely new history — or null when it cannot be placed in this
 * window.
 *
 * Null covers two cases that both mean "draw nothing": the boundary record is
 * not in the loaded window (paging older can bring it in), and the boundary is
 * the last thing loaded, where a divider would be a rule under the whole
 * transcript with nothing beneath it to separate.
 */
export function forkDividerGroupIndex(
  groups: readonly TimelineGroup[],
  boundaryUuid: string | undefined,
): number | null {
  if (boundaryUuid === undefined) return null;
  const index = groups.findIndex((group) => containsUuid(group, boundaryUuid));
  if (index < 0) return null;
  const next = index + 1;
  return next < groups.length ? next : null;
}
