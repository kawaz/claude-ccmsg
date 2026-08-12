// The cross-line half of the Timeline's transcript derivation — queue pairing,
// tool_use/tool_result joining, byte offsets, tools-folding — recomputed on
// every update but handed back with the *identity* of everything that did not
// actually change.
//
// incremental-line-map.ts already keeps the per-line parse of an untouched
// line, but everything downstream of it built fresh arrays and fresh objects
// on every live-tail append: `groups`, each fold group's `entries`, and (for
// any line whose segments were rewritten by the tool_result join) the
// ParsedLine itself. Preact compares props by reference, so a single appended
// line handed every FoldGroup in the transcript a new `entries` array and made
// the whole tree re-diff.
//
// Two things make identity recoverable cheaply rather than by re-deriving the
// passes incrementally:
//
//   1. The passes stay whole-window. They have to: appending a tool_result can
//      legitimately change a tool_use line thousands of lines back, and a
//      delivered user turn cancels a queued copy that appeared earlier. Any
//      "only recompute the tail" scheme would have to reproduce that reach,
//      and would be wrong in exactly the cases that are hardest to notice.
//   2. What the passes return is *mostly the previous objects*. Their inputs
//      (`perLine`) are reference-stable, and the passes return their input
//      line untouched unless they rewrite it. So a structural comparison that
//      short-circuits on `===` settles an unchanged line in one pointer
//      compare and a rewritten-but-equal line in a handful.
//
// So: recompute, then reconcile against the previous result and keep the old
// object wherever the new one is equal. The reconciliation is matched from
// both ends for the same reason incremental-line-map.ts is — a live tail
// appends, a "load older" page prepends.

import {
  byteOffsetsFromLengths,
  groupTimelineLines,
  pairQueuedTurns,
  resolveToolResults,
  type ParsedLine,
  type TimelineGroup,
} from "./transcript-model.ts";

/** Inputs and outputs of one cross-line derivation, kept so the next one can
 * reuse whatever it still agrees with. */
export interface CrossLineCache {
  parsed: ParsedLine[];
  offsets: number[];
  groups: TimelineGroup[];
}

export function emptyCrossLineCache(): CrossLineCache {
  return { parsed: [], offsets: [], groups: [] };
}

export interface CrossLineInput {
  /** Absolute byte offset of the first cached line (`timeline.start`). */
  start: number;
  /** Raw transcript lines, index-aligned with `perLine` and `byteLengths`. */
  raws: readonly string[];
  /** Per-line parse, reference-stable for unchanged lines (see
   * incremental-line-map.ts). */
  perLine: readonly ParsedLine[];
  /** Per-line UTF-8 size, same provenance as `perLine`. */
  byteLengths: readonly number[];
}

/**
 * Structural equality that treats reference identity as the answer.
 *
 * Every leaf of a ParsedLine that a pass did not rewrite is the *same object*
 * as last time (the passes spread over their input rather than rebuilding it
 * from the raw text), so the walk stops at the first `===` on every branch
 * that is genuinely unchanged. A line the tail really did change is walked in
 * full, but there are only ever a handful of those per update and the walk is
 * cheaper than the parse that produced it.
 */
function equalByStructure(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  const aIsArray = Array.isArray(a);
  if (aIsArray !== Array.isArray(b)) return false;
  if (aIsArray) {
    const bArray = b as unknown[];
    if (a.length !== bArray.length) return false;
    for (let i = 0; i < a.length; i++) if (!equalByStructure(a[i], bArray[i])) return false;
    return true;
  }
  const aRecord = a as Record<string, unknown>;
  const bRecord = b as Record<string, unknown>;
  const keys = Object.keys(aRecord);
  if (keys.length !== Object.keys(bRecord).length) return false;
  for (const key of keys) {
    if (!Object.hasOwn(bRecord, key)) return false;
    if (!equalByStructure(aRecord[key], bRecord[key])) return false;
  }
  return true;
}

/** Number of leading elements two arrays share under `equal`. */
function sharedPrefix<T>(a: readonly T[], b: readonly T[], equal: (x: T, y: T) => boolean): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && equal(a[i]!, b[i]!)) i++;
  return i;
}

/** Number of trailing elements two arrays share under `equal`, capped by
 * `limit` so an element already claimed by the prefix is never counted twice. */
function sharedSuffix<T>(
  a: readonly T[],
  b: readonly T[],
  limit: number,
  equal: (x: T, y: T) => boolean,
): number {
  let i = 0;
  while (i < limit && equal(a[a.length - 1 - i]!, b[b.length - 1 - i]!)) i++;
  return i;
}

/**
 * Replaces each element of `next` with the equal element of `previous`,
 * matching the two arrays from both ends. Elements between the two matched
 * runs — the part that really changed — are kept as computed.
 *
 * Returns `previous` itself when nothing changed at all, so a redundant update
 * (a websocket push that adds no lines, a re-render with the same store state)
 * propagates no new identity anywhere.
 */
function reuseUnchanged<T>(previous: readonly T[], next: T[], equal: (x: T, y: T) => boolean): T[] {
  const prefix = sharedPrefix(previous, next, equal);
  if (prefix === previous.length && prefix === next.length) return previous as T[];
  const suffix = sharedSuffix(
    previous,
    next,
    Math.min(previous.length, next.length) - prefix,
    equal,
  );
  for (let i = 0; i < prefix; i++) next[i] = previous[i]!;
  for (let i = 0; i < suffix; i++) next[next.length - 1 - i] = previous[previous.length - 1 - i]!;
  return next;
}

function equalNumber(a: number, b: number): boolean {
  return a === b;
}

/** Two groups render identically: same kind, same byte offsets, and the same
 * ParsedLine objects (already reconciled by the time this runs, so `===` here
 * is the full test rather than an approximation of one). */
function equalGroup(a: TimelineGroup, b: TimelineGroup): boolean {
  if (a === b) return true;
  if (a.kind === "entry") {
    return b.kind === "entry" && a.offset === b.offset && a.line === b.line;
  }
  if (b.kind !== "fold" || a.entries.length !== b.entries.length) return false;
  for (let i = 0; i < a.entries.length; i++) {
    const x = a.entries[i]!;
    const y = b.entries[i]!;
    if (x.offset !== y.offset || x.line !== y.line) return false;
  }
  return true;
}

/**
 * Runs the cross-line passes over the whole window and returns their results
 * with unchanged parts carried over from `cache` by identity.
 *
 * The three outputs are equal, element for element, to what
 * `resolveToolResults(pairQueuedTurns(...))` / `byteOffsetsFromLengths` /
 * `groupTimelineLines` return when called directly — the reconciliation only
 * chooses *which* of two equal objects to hand back. That equivalence is what
 * the property test in test/incremental-cross-line.test.ts pins down.
 */
export function crossLineIncrementally(
  cache: CrossLineCache,
  { start, raws, perLine, byteLengths }: CrossLineInput,
): CrossLineCache {
  const offsets = reuseUnchanged(
    cache.offsets,
    byteOffsetsFromLengths(start, byteLengths),
    equalNumber,
  );
  const parsed = reuseUnchanged(
    cache.parsed,
    resolveToolResults(pairQueuedTurns(perLine, raws)),
    equalByStructure,
  );
  // Nothing downstream can have changed if neither input to the grouping did,
  // and the grouping is the expensive half.
  const groups =
    parsed === cache.parsed && offsets === cache.offsets
      ? cache.groups
      : reuseUnchanged(cache.groups, groupTimelineLines(parsed, offsets), equalGroup);
  return { parsed, offsets, groups };
}
