// 「key が変わった時だけ作り直す / 初期値に戻す」を render 中に表す hook。
//
// react.dev の "Adjusting some state when a prop changes" / "Storing information
// from previous renders" の形 (前回の key を state に持ち、render 中に比べて
// set する) をまとめたもの。Effect で後から作り直すと、古い値で 1 度描いて
// から描き直すことになる。useMemo は性能のための目印で、値を保つ保証が無い。
//
// key は配列で、要素ごとに Object.is で比べる (useMemo の deps と同じ比べ方)。
// render 中の set は、Preact も React も commit 前にそのコンポーネントを描き
// 直すので、作り直した値が 1 度も古い key と一緒に画面へ出ない。
import { useCallback, useState } from "preact/hooks";

function sameKey(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => Object.is(value, b[i]));
}

/** `create()` の結果を `key` が同じ間ずっと同じ値として返す。`key` が変わった
 * render で 1 度だけ作り直す。 */
export function useKeyedValue<T>(key: readonly unknown[], create: () => T): T {
  const [slot, setSlot] = useState(() => ({ key, value: create() }));
  if (sameKey(slot.key, key)) return slot.value;
  const next = { key, value: create() };
  setSlot(next);
  return next.value;
}

type Primitive = string | number | boolean | null | undefined;

/** useState と同じだが、`key` が変わった render で `initial()` に戻る。 */
export function useResettableState<T extends Primitive>(
  key: readonly unknown[],
  initial: () => T,
): [T, (next: T | ((previous: T) => T)) => void] {
  const [slot, setSlot] = useState(() => ({ key, value: initial() }));
  let current = slot;
  if (!sameKey(slot.key, key)) {
    current = { key, value: initial() };
    setSlot(current);
  }
  const setValue = useCallback((next: T | ((previous: T) => T)) => {
    setSlot((previous) => ({
      key: previous.key,
      value: typeof next === "function" ? next(previous.value) : next,
    }));
  }, []);
  return [current.value, setValue];
}
