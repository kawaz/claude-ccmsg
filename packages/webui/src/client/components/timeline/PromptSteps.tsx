// ユーザの発言の吹き出しの「↑前 | 次↓」(DR-0058 §3)。「jsonl ⭐」の組の左に置く、
// 中に区切りのある 1 つのまとまりの部品で、左が 1 つ前の発言へ、右が 1 つ後の
// 発言へ移る。前と次はセッション全体の発言の並びで決め (Timeline)、どちらへも
// TL の位置への移動 (読み込み付き) で移る。

/** 1 つの発言の前と次。無い向き (最古の前、最新の次、まだ分からない前) は null。 */
export interface PromptStepTargets {
  prev: string | null;
  next: string | null;
  /** その発言の位置へ移る。 */
  onStep: (uuid: string) => void;
}

export function PromptSteps({ prev, next, onStep }: PromptStepTargets) {
  return (
    <span class="tl-item-prompt-steps" role="group" aria-label="発言の移動">
      <button
        type="button"
        class="tl-item-prompt-step"
        data-step="prev"
        title="1 つ前の発言へ"
        disabled={prev === null}
        onClick={prev === null ? undefined : () => onStep(prev)}
      >
        ↑前
      </button>
      <button
        type="button"
        class="tl-item-prompt-step"
        data-step="next"
        title="1 つ後の発言へ"
        disabled={next === null}
        onClick={next === null ? undefined : () => onStep(next)}
      >
        次↓
      </button>
    </span>
  );
}
