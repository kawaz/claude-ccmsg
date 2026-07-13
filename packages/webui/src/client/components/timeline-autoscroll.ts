/** timeline 新着到達時の自動 scroll 判定 (kawaz 2026-07-13)。
 *
 * ROOM の timeline は event 追加のたびに `room.timeline` が伸びる。全 event
 * 到着ごとに問答無用で末尾へ飛ばすと、ユーザが過去ログを遡っている最中に
 * 勝手に一番下へ吹っ飛ばされて読めなくなる (chat UI の古典的なアンチパターン)。
 *
 * 実挙動: append **前** の scroll 位置が末尾に居た時だけ、append 後の末尾に
 * 追随する。過去を見ている間は無視。
 *
 * 実装分担:
 * - **`isAtBottom` (本ファイル)**: DOM element の scroll 3 メトリクス
 *   (`scrollTop` / `clientHeight` / `scrollHeight`) から「末尾に居るか」を
 *   判定する pure function。境界条件を単体テストしたいので pure に切り出す。
 * - **RoomView.tsx**: `onScroll` で `isAtBottom` を毎回 Ref に記録 →
 *   `useLayoutEffect` (`[room.timeline]` 依存) が paint 前に発火し、Ref が
 *   `true` だった時のみ `scrollTop = scrollHeight` を書く。
 *
 * append 前の状態を捉える経路は「append の直前に判定を走らせる」ではなく
 * 「scroll のたびに Ref に最新の in-view 状態をキャッシュしておく」。前者は
 * append の副作用として Store から発火して DOM を触るタイミングを合わせる
 * のが難しいが、後者なら React/Preact の commit タイミングに載せられる。
 */

/** el が縦スクロールで末尾 (もう下に何もない位置) に居るかを判定する。
 *
 * epsilon (px) は「サブピクセル・rendering 誤差 / high-DPI 端数を末尾扱いに
 * するための吸収」。ズームや display scaling で `scrollTop + clientHeight`
 * が `scrollHeight` にちょうど一致せず 0.x px の残差になることがあり、
 * 厳密比較だと「一番下まで自分でスクロールしたはずなのに末尾扱いされない」
 * となるので、既定 1px の余裕を持たせる。
 *
 * scroll できないほど短い timeline (`scrollHeight <= clientHeight`) は
 * 必然的に `scrollTop === 0` なので `0 + clientHeight >= clientHeight - 1`
 * = true を返し、末尾扱いになる (= 新着で末尾追随 = 空 room / 短い timeline
 * が伸び始めた最初から追随する、意図した挙動)。
 */
export function isAtBottom(
  el: { scrollTop: number; clientHeight: number; scrollHeight: number },
  epsilon = 1,
): boolean {
  return el.scrollTop + el.clientHeight >= el.scrollHeight - epsilon;
}
