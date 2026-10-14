// React の `useEffectEvent` (react.dev "Separating Events from Effects") を
// Preact で使うための実装。Effect の中から呼ぶ「最新の props / state を読む
// が、それ自体の変化では Effect を再実行させない」処理を切り出す。
//
// Design rationale: Preact (preact/hooks, preact/compat) には useEffectEvent が
// 無い。名前を React と揃えているのは、oxlint の react/rules-of-hooks と
// react/exhaustive-deps がこの名前の戻り値を Effect Event として扱い、「deps に
// 入れない」「Effect / Effect Event の中からしか呼ばない」を検査するため。
//
// 最新の handler は layout effect で写す (render 中に ref を書かない)。layout
// effect は同じコンポーネントの中では宣言順、commit 全体では全ての useEffect
// より先に走るので、呼び出し側の useEffect と、これより後に宣言した
// useLayoutEffect からは常に最新の handler が見える。
import { useCallback, useLayoutEffect, useRef } from "preact/hooks";

export function useEffectEvent<Args extends unknown[], Result>(
  handler: (...args: Args) => Result,
): (...args: Args) => Result {
  const handlerRef = useRef(handler);
  useLayoutEffect(() => {
    handlerRef.current = handler;
  });
  return useCallback((...args: Args) => handlerRef.current(...args), []);
}
