/** @jsxImportSource preact */
// prompt cache の残り時間リングの描画 (進行の算術は llm-cache-view.ts)。
//
// 輪郭そのものを 1 本の線として描き、線の「見えている割合」を減らしていく。
// 上辺の中央 (= 0 時) から時計回りに消える。等速で進むのは周長に沿って
// 測っているからで、角度基準の扇形と違って辺の中央と角で速さが変わらない。
// 円は周長を `pathLength="1"` で正規化して進行をそのまま使い、矩形は周長が
// 辺の比で変わるので CSS 側がコンテナクエリ単位で実寸から組む。
//
// **塗らない**のが要点: 塗りつぶした図形の内側を不透明な子で隠す作りだと、
// 子が覆えない瞬間 (未レイアウト / 画像が未描画 / mask 未適用) にその塗りが
// そのまま出る (実測: 子を隠すと扇形に欠けた緑の四角が現れる)。線しか無ければ
// 露出する面が存在しない。
//
// 重ねるために `position: absolute` を使うが、これは同じ場所に装飾を 1 枚
// 足しているだけで、レイアウトの構造には参加しない (親の寸法も兄弟の位置も
// 変えない)。
import type { JSX } from "preact";

/** 縁の形。要素自身の枠に重ねるので、角丸は CSS 側が要素ごとに持つ。 */
export type CacheRingShape = "rect" | "circle";

/** `dash` は目盛り (合図 1 回 = 点 1 個) の破線パターン。位置の算術は
 * llm-cache-view.ts が持ち、ここは同じ座標系にもう 1 本重ねるだけ。周長は
 * 矩形も円も cq 単位の実寸で組むので (CSS 側)、目盛り側は本体と違って
 * pathLength を持たない。パターンが周長と線幅の var() を含むので、要素自身の
 * インライン style に置く (カスタムプロパティ経由だと、宣言した側の要素で
 * var() が解決されてしまい、そこには周長も線幅も無い)。null なら要素ごと
 * 出さない。 */
export function CacheRing({
  shape,
  dash = null,
}: {
  shape: CacheRingShape;
  dash?: string | null;
}): JSX.Element {
  return (
    <svg class="cache-ring-svg" aria-hidden="true">
      {shape === "circle" ? (
        <circle class="cache-ring-shape" pathLength={1} />
      ) : (
        <rect class="cache-ring-shape" />
      )}
      {dash === null ? null : shape === "circle" ? (
        <circle class="cache-ring-shape cache-ring-ticks" style={{ strokeDasharray: dash }} />
      ) : (
        <rect class="cache-ring-shape cache-ring-ticks" style={{ strokeDasharray: dash }} />
      )}
    </svg>
  );
}
