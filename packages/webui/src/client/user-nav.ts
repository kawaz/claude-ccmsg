/**
 * Re-index a selected item after a stable-key list changes.
 *
 * Returns `null` when the previous selection cannot be identified in both
 * lists, leaving initial-load and replacement-refresh policy to the caller.
 */
export function reindexStableSelection(
  currentOneBasedIndex: number,
  previousKeys: readonly string[],
  nextKeys: readonly string[],
): number | null {
  const selectedKey = previousKeys[currentOneBasedIndex - 1];
  if (selectedKey === undefined) return null;
  const nextIndex = nextKeys.indexOf(selectedKey);
  return nextIndex < 0 ? null : nextIndex + 1;
}
