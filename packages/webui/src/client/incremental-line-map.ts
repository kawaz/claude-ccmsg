// Per-line derived values (parsed JSON, UTF-8 byte length) for the Timeline's
// cached transcript, recomputed only for the lines that actually changed.
//
// The store hands Timeline.tsx a fresh `string[]` on every update, so a
// `useMemo` keyed on that array re-derives everything from scratch: a single
// live-tail line appended to a 3MB transcript re-parsed all 3MB. Matching the
// new array against the previous one line by line finds the lines that are
// still the same and carries their values over.
//
// Comparing lines with `===` is a value comparison, but the case that matters
// most is also the cheapest one: the store builds a live-tail update out of
// the *same string objects* (`[...prev.lines, ...action.lines]`), so every
// carried-over line hits the engine's identical-object fast path. A
// `mode:"replace"` re-read arrives as new string objects and does pay a
// content comparison per line — still far less than re-parsing them, and the
// lines whose content really did change are the only ones recomputed.
//
// Reuse is matched from both ends because the two ways the window grows add
// lines at opposite ends: a live tail appends (common prefix = everything
// cached), a "load older" page prepends (common suffix = everything cached).

/** Previous input lines and the values derived from them, 1:1 by index. */
export interface LineMapCache<T> {
  lines: readonly string[];
  values: readonly T[];
}

export function emptyLineMapCache<T>(): LineMapCache<T> {
  return { lines: [], values: [] };
}

/** Number of leading elements `a` and `b` share. */
function commonPrefixLength(a: readonly string[], b: readonly string[]): number {
  const max = Math.min(a.length, b.length);
  let i = 0;
  while (i < max && a[i] === b[i]) i++;
  return i;
}

/** Number of trailing elements `a` and `b` share, never counting
 * an element already claimed by the prefix (`limit` caps the overlap so a
 * line can't be reused as both). */
function commonSuffixLength(a: readonly string[], b: readonly string[], limit: number): number {
  let i = 0;
  while (i < limit && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
  return i;
}

/**
 * Derive one value per line, reusing the cached value for every line that is
 * unchanged from last time.
 *
 * `compute` must be a pure function of the single line it is given: values are
 * carried across calls untouched, so anything that depends on neighbouring
 * lines (the queue-operation pairing, tool_use/tool_result joining) has to run
 * as a separate pass over the result, not inside `compute`.
 *
 * Returns the next cache; `cache.values` is the answer. Callers keep it in a
 * ref and pass it back on the next call.
 */
export function mapLinesIncrementally<T>(
  cache: LineMapCache<T>,
  lines: readonly string[],
  compute: (line: string) => T,
): LineMapCache<T> {
  const previous = cache.lines;
  if (previous === lines) return cache;
  const prefix = commonPrefixLength(previous, lines);
  const suffix = commonSuffixLength(
    previous,
    lines,
    Math.min(previous.length, lines.length) - prefix,
  );
  const values: T[] = [];
  for (let i = 0; i < prefix; i++) values.push(cache.values[i]!);
  for (let i = prefix; i < lines.length - suffix; i++) values.push(compute(lines[i]!));
  for (let i = previous.length - suffix; i < previous.length; i++) values.push(cache.values[i]!);
  return { lines, values };
}
