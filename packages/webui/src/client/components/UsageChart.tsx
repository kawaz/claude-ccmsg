// Stacked bars: spend per bucket, split by model. Hand-written SVG rather than
// a charting dependency — the shape is one rectangle per segment, and the
// geometry it needs is already computed as fractions in llm-stats-view.
//
// The table under it is this chart's table-view twin, which is also what
// discharges the light-mode contrast relief: four of the eight categorical
// slots sit below 3:1 on the card surface, so the values have to be readable
// without relying on the fills.
import { useState } from "preact/hooks";
import { formatUsd, showsLabel, type ChartData, type ChartSegment } from "../llm-stats-view.ts";

/** Plot box in user units; the SVG scales to its container. Sized to include
 * the axis bands rather than letting labels spill outside the viewBox. */
const WIDTH = 720;
const HEIGHT = 220;
const PAD_LEFT = 56;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 28;
const PLOT_W = WIDTH - PAD_LEFT - PAD_RIGHT;
const PLOT_H = HEIGHT - PAD_TOP - PAD_BOTTOM;

/** A 2px surface gap separates stacked segments and adjacent bars alike —
 * never a border drawn around a mark. */
const GAP = 2;

/** Categorical slots are assigned by index and never cycled: the ninth model
 * has already been folded into "その他" upstream, which takes the neutral. */
function seriesClass(index: number, model: string, models: readonly string[]): string {
  const isOther = model === "その他" && index === models.length - 1;
  return isOther ? "series-other" : `series-${index + 1}`;
}

function tickLabel(usd: number, max: number): string {
  // Whole dollars on a wide axis, cents only when the whole range is small
  // enough that dropping them would collapse the ticks into "$0".
  if (max >= 10) return `$${Math.round(usd).toLocaleString("en-US")}`;
  return formatUsd(usd);
}

export function UsageChart({
  data,
  caption,
  selected,
  onToggleModel,
}: {
  data: ChartData;
  caption: string;
  /** Legend entries the reader picked out. Empty means no filter, which reads
   * the same as every entry being on — so an empty set and a full set are the
   * same screen, and there is no way to select nothing. */
  selected: ReadonlySet<string>;
  onToggleModel: (model: string) => void;
}) {
  const [hover, setHover] = useState<{ bar: string; segment: ChartSegment } | null>(null);

  if (data.bars.length === 0 || data.max <= 0) {
    return <p class="stats-empty">この期間に表示できる使用量はありません。</p>;
  }

  const ceiling = data.ticks[data.ticks.length - 1] ?? data.max;
  const slot = PLOT_W / data.bars.length;
  const barWidth = Math.max(1, slot - GAP);
  const y = (fraction: number): number =>
    PAD_TOP + PLOT_H - fraction * PLOT_H * (data.max / ceiling);

  return (
    <div class="stats-chart">
      {/* Identity is never colour alone: every series is named here, and the
       * table below carries the same values in text. Each entry is also the
       * control that includes or excludes that model — a button so the
       * keyboard reaches it, and so the pressed state is announced rather
       * than left to the dimming. */}
      <ul class="stats-legend">
        {data.models.map((model, index) => {
          const on = selected.size === 0 || selected.has(model);
          return (
            <li key={model}>
              <button
                type="button"
                class={on ? "stats-legend-entry" : "stats-legend-entry stats-legend-off"}
                aria-pressed={selected.has(model)}
                title={
                  selected.has(model) ? `${model} の選択を解除` : `${model} だけを表示 (複数選択可)`
                }
                onClick={() => onToggleModel(model)}
              >
                <span class={`stats-swatch ${seriesClass(index, model, data.models)}`} />
                {model}
              </button>
            </li>
          );
        })}
      </ul>
      {/* Uniform scaling (the default preserveAspectRatio): stretching the
       * viewBox to the container would stretch the axis text with it. */}
      <svg viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={caption}>
        {/* Recessive hairline grid, solid — a dashed rule would read as a
         * threshold rather than as a scale. */}
        {data.ticks.map((tick) => {
          const ty = PAD_TOP + PLOT_H - (tick / ceiling) * PLOT_H;
          return (
            <g key={tick}>
              <line class="stats-grid" x1={PAD_LEFT} x2={WIDTH - PAD_RIGHT} y1={ty} y2={ty} />
              <text class="stats-axis-label" x={PAD_LEFT - 6} y={ty + 3} text-anchor="end">
                {tickLabel(tick, ceiling)}
              </text>
            </g>
          );
        })}
        {data.bars.map((bar, index) => {
          const x = PAD_LEFT + index * slot + GAP / 2;
          return (
            <g key={bar.key}>
              {bar.segments.map((segment) => {
                const top = y(segment.end);
                const bottom = y(segment.start);
                // The gap comes out of the segment, not off the baseline, so
                // the stack still adds up to the bar's true height.
                const height = Math.max(1, bottom - top - GAP);
                const modelIndex = data.models.indexOf(segment.model);
                return (
                  <rect
                    key={segment.model}
                    class={`stats-bar ${seriesClass(modelIndex, segment.model, data.models)}`}
                    x={x}
                    y={top}
                    width={barWidth}
                    height={height}
                    onMouseEnter={() => setHover({ bar: bar.label, segment })}
                    onMouseLeave={() => setHover(null)}
                  >
                    <title>{`${bar.label} / ${segment.model}: ${formatUsd(segment.usd)}`}</title>
                  </rect>
                );
              })}
              {showsLabel(index, data.bars.length) ? (
                // The newest bar sits against the right edge, where a centred
                // label would run past the viewBox and get cropped; it anchors
                // to its end instead. Same at the left for the oldest.
                <text
                  class="stats-axis-label"
                  x={
                    index === data.bars.length - 1
                      ? WIDTH - PAD_RIGHT
                      : index === 0
                        ? PAD_LEFT
                        : x + barWidth / 2
                  }
                  y={HEIGHT - 10}
                  text-anchor={
                    index === data.bars.length - 1 ? "end" : index === 0 ? "start" : "middle"
                  }
                >
                  {bar.axisLabel}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
      {/* Held in a fixed row rather than floated over the plot: a tooltip that
       * moves the layout under the pointer is worse than one that does not
       * follow it. */}
      <p class="stats-hover" aria-live="polite">
        {hover ? `${hover.bar} / ${hover.segment.model}: ${formatUsd(hover.segment.usd)}` : caption}
      </p>
    </div>
  );
}
