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
//
// 進行 (`--cache-ring-progress`) は線の要素に、線の端が半 px 動くたびに書く。
// 書く時刻は span と輪の周長から決まる (cacheRingStepMs)。輪が画面に見えて
// いない間 (行が fold や SESSIONS の中に畳まれている、一覧の外へスクロール
// されている、FAB が隠れている) は書かず、見えた時にその時刻の進行を書き直す。
// 進行は常に時刻から求めるので、止めていた間の分もずれない。
//
// Design rationale: CSS animation (登録済みカスタムプロパティを linear で回す)
// を使わない。main thread で回る animation は値が目に見えて変わらないフレーム
// でも毎フレーム style・paint・layerize をやり直し、輪 20 本で待機中の main
// thread の 6 割、100 本でほぼ全部を使っていた (steps() で間引いても style は
// 毎フレーム走った)。半 px ごとの書き込みなら、変わる時に変わる輪だけを描き
// 直す。
import type { JSX } from "preact";
import { useLayoutEffect, useRef } from "preact/hooks";
import { type CacheRingSpan, cacheRingProgress, cacheRingStepMs } from "../llm-cache-view.ts";
import { prefersReducedMotion } from "../scroll-motion.ts";

/** 縁の形。要素自身の枠に重ねるので、角丸は CSS 側が要素ごとに持つ。 */
export type CacheRingShape = "rect" | "circle";

/** 線の長さの見積もり (CSS px)。半 px の歩幅を決めるだけなので、角丸で短く
 * なる分は無視して長めに取る (歩幅が細かくなる側に外れる)。 */
function ringPerimeterPx(shape: CacheRingShape, box: DOMRect): number {
  return shape === "circle"
    ? Math.PI * Math.min(box.width, box.height)
    : 2 * (box.width + box.height);
}

/** `span` の進行を `line` に書き続ける。見えている間だけ時計を回し、止める
 * 関数を返す。OS の「視差効果を減らす」設定の時は、始めた時点の位置で止めて
 * おく (残量としての意味は残す)。 */
function runCacheRingClock(
  shape: CacheRingShape,
  svg: SVGSVGElement,
  line: SVGGeometryElement,
  span: CacheRingSpan,
): () => void {
  const write = (): void => {
    line.style.setProperty("--cache-ring-progress", String(cacheRingProgress(span, Date.now())));
  };
  write();
  if (prefersReducedMotion()) return () => {};
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = (): void => {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
  const step = (): void => {
    write();
    const now = Date.now();
    if (now >= span.end) {
      timer = null;
      return;
    }
    const wait =
      now < span.start
        ? span.start - now
        : cacheRingStepMs(span, ringPerimeterPx(shape, svg.getBoundingClientRect()));
    timer = setTimeout(step, wait);
  };
  const visibility = new IntersectionObserver((entries) => {
    stop();
    if (entries.at(-1)?.isIntersecting === true) step();
  });
  visibility.observe(svg);
  return () => {
    visibility.disconnect();
    stop();
  };
}

export function CacheRing({
  shape,
  span,
}: {
  shape: CacheRingShape;
  /** 輪が満ちている時刻と消える時刻 (epoch ms、useCacheRing の値)。 */
  span: CacheRingSpan;
}): JSX.Element {
  const svgRef = useRef<SVGSVGElement>(null);
  const { start, end } = span;
  // 進行は描く前に書く: 書く前の 1 フレームは満ちた輪 (進行 0) に見えてしまう。
  useLayoutEffect(() => {
    const svg = svgRef.current;
    const line = svg?.firstElementChild;
    if (!svg || !(line instanceof SVGGeometryElement)) return;
    return runCacheRingClock(shape, svg, line, { start, end });
  }, [shape, start, end]);
  return (
    <svg ref={svgRef} class="cache-ring-svg" aria-hidden="true">
      {shape === "circle" ? (
        <circle class="cache-ring-shape" pathLength={1} />
      ) : (
        <rect class="cache-ring-shape" />
      )}
    </svg>
  );
}
