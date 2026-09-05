/** @jsxImportSource preact */
// prompt cache の残り時間リングの描画 (進行の算術は llm-cache-view.ts)。
//
// 輪郭そのものを 1 本の線として描き、線の「見えている割合」を減らしていく。
// `pathLength="1"` で周長を 1 に正規化してあるので、`stroke-dashoffset` に
// 0→1 の進行をそのまま入れれば、始点から順に線が消える。等速で進むのは
// 周長に沿って測っているからで、角度基準の扇形と違って辺の中央と角で速さが
// 変わらない。
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

export function CacheRing({ shape }: { shape: CacheRingShape }): JSX.Element {
  return (
    <svg class="cache-ring-svg" aria-hidden="true">
      {shape === "circle" ? (
        <circle class="cache-ring-shape" pathLength={1} />
      ) : (
        <rect class="cache-ring-shape" pathLength={1} />
      )}
    </svg>
  );
}
