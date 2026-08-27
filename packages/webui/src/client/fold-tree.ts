// Which folds enclose a given transcript line, decided from the model rather
// than from the DOM. Timeline mounts a closed fold's body lazily (72-96% of
// every entry in a real transcript lives inside one, see
// docs/findings/2026-08-12-timeline-windowing-design.md), so "scroll to this
// line" can no longer start by looking the element up: the element does not
// exist until its enclosing folds are open. These keys name the folds to open
// first, and match the keys FoldGroup registers itself under.
import {
  foldGroupNeedsOuterFold,
  type TimelineEntry,
  type TimelineGroup,
} from "./transcript-model.ts";

/** Keyed by first entry offset, the same value Timeline already uses as the
 * component's Preact key — stable across live-tail appends and "load older"
 * prepends for the same reason (transcript-model.ts's lineByteOffsets doc). */
export function foldGroupKey(entries: readonly TimelineEntry[]): string {
  return `fold:${entries[0]!.offset}`;
}

/**
 * For every line offset, the folds enclosing it from outermost to innermost.
 * Empty for a line that is always mounted (a boundary bubble, or a hoisted
 * single-item fold group).
 *
 * Mirrors FoldGroup's own render decision exactly: a group that renders no
 * `<details>` (foldGroupNeedsOuterFold) encloses nothing. A key listed here
 * that never gets a fold in the DOM would strand a nav target as un-openable,
 * so the two must agree.
 */
export function foldPathsByOffset(groups: readonly TimelineGroup[]): Map<number, string[]> {
  const paths = new Map<number, string[]>();
  for (const group of groups) {
    if (group.kind !== "fold") continue;
    const path = foldGroupNeedsOuterFold(group.entries) ? [foldGroupKey(group.entries)] : [];
    for (const entry of group.entries) paths.set(entry.offset, path);
  }
  return paths;
}
