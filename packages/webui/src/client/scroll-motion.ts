// スクロールの動かし方の決まり (DR-0056)。
//
// - ユーザの操作 (押す・選ぶ・キーを打つ) の結果として画面を別の位置へ動かす
//   時 ("user") は、どこへどちら向きに動いたかを目で追えるよう、ブラウザ標準の
//   短い smooth で動かす
// - 機械的に動かす時 ("machine": 末尾への追従、位置の復元、高さが変わった時に
//   位置を保つ寄せ直し、初期表示) は一瞬で動かす。高頻度の寄せ直しが smooth
//   だと遅れて追いつかない
// - OS の「視差効果を減らす」設定 (`prefers-reduced-motion: reduce`) の時は、
//   ユーザの操作でも一瞬で動かす。ブラウザは programmatic な smooth にこの設定
//   を当てない (Chromium / WebKit で実測) ので、ここで見る
//
// どちらで動かすかは呼び出し側が渡す。渡し忘れは一瞬 (害の小さい方) になる。

/** スクロールを起こしたもの。 */
export type ScrollCause = "user" | "machine";

/** OS の「視差効果を減らす」設定が入っているか。 */
export function prefersReducedMotion(): boolean {
  return matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** `cause` のスクロールに渡す `behavior`。CSS の `scroll-behavior` に左右され
 * ないよう、一瞬も "instant" と明示する。 */
export function scrollBehaviorFor(cause: ScrollCause = "machine"): ScrollBehavior {
  return cause === "user" && !prefersReducedMotion() ? "smooth" : "instant";
}
