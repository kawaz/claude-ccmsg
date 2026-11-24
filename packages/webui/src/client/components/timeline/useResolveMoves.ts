// What has changed under the 💬 filter since it was entered (DR-0062 §13,
// kawaz 2026-11-24): the threads resolved or not anew and whether the
// `resolved` box was turned, which fold away and back (comment-threads.ts
// ResolveMoves). Kept from the render before, as react.dev's "Storing
// information from previous renders" (useKeyedState.ts): a step is taken in
// the render that sees the change, so the item that folds carries its mark in
// the same commit as the change that hides it.
import { useState } from "preact/hooks";
import { resolveMovesFrom, resolveMovesNext, type ResolveMoves } from "../../comment-threads.ts";

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/** The moves since `key` (the session and the filter) last changed, with the
 * thread roots `resolved` now, the box `showResolved` and the `others` (what
 * else shows or hides items). */
export function useResolveMoves(
  key: readonly unknown[],
  resolved: ReadonlySet<string>,
  showResolved: boolean,
  others: string,
): ResolveMoves {
  const [slot, setSlot] = useState(() => ({
    key,
    moves: resolveMovesFrom(resolved, showResolved, others),
  }));
  const moves = sameKey(slot.key, key)
    ? resolveMovesNext(slot.moves, resolved, showResolved, others)
    : resolveMovesFrom(resolved, showResolved, others);
  if (moves !== slot.moves) setSlot({ key, moves });
  return moves;
}
