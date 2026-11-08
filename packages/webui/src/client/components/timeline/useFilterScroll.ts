// フィルタ (DR-0050 §4) の切り替えでのスクロール位置 (§6)。
//
// - フィルタに入った (または種類を替えた) 時、位置を選んでいなければ末尾へ
//   寄せる。バッジは位置を外した `head?filter=` へ遷移するので、新しいものが
//   下に並んだ一番下から見る
// - フィルタを外した時は、外す前に見ていた要素の画面内の位置 (scroller の上端
//   からの距離) を保つ。隠れていた行が戻ってその要素を中心に上下が伸びる。
//   基準の要素は、選択中のバブル (URL の位置) が出ていればそれ、無ければ末尾を
//   見ていたなら末尾のまま、それ以外は画面の一番上に見えているバブル
//
// 測るのは遷移の直前 (BEFORE_NAVIGATION_EVENT、FileViewer と同じ口) で、戻る /
// 進むでフィルタが外れる時もこのイベントが先に来る。合わせるのはフィルタが
// 外れた描画の後 (layout effect) で、useScrollHold に寄せ方として渡すので、戻った
// 行の markdown や highlight が後から伸びても距離を保ち続ける。
//
// Design rationale: ブラウザの scroll anchoring (`overflow-anchor`) には
// 任せない。Safari は 27 まで持たず (useScrollHold.ts)、持つブラウザでも基準の
// 要素をブラウザが選ぶので、選択したバブルが基準になるとは限らない。先に
// scroll anchoring が動いていても、差は実際の距離から測るので結果は同じ。
import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import type { TimelineFilter } from "../../locator.ts";
import { BEFORE_NAVIGATION_EVENT } from "../../navigation.ts";
import type { ScrollHold } from "../../useScrollHold.ts";
import { useEffectEvent } from "../../useEffectEvent.ts";
import { isAtBottom } from "../timeline-autoscroll.ts";

/** フィルタを外す前に測ったもの: 保つ要素と scroller の上端からの距離、
 * または末尾。 */
export type FilterScrollAnchor =
  | { kind: "element"; element: HTMLElement; offset: number }
  | { kind: "bottom" };

/** 要素が描かれているか (display: none で隠れていないか)。 */
function isRendered(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

function offsetIn(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/**
 * フィルタ中の TL で、外した後に保つものを決める。`position` は URL の位置
 * (選んでいなければ "head")。選んだバブルが出ていればそれを、選んでいなくて
 * 末尾を見ていれば末尾を、それ以外は画面の一番上に見えているバブル
 * (`data-notif` を名乗る行のうち、フィルタを外しても残るもの) を基準にする。
 * 何も見えていなければ null。
 */
export function filterScrollAnchor(
  scroller: HTMLElement,
  position: string,
): FilterScrollAnchor | null {
  if (position !== "head") {
    const selected = scroller.querySelector<HTMLElement>(
      `[data-timeline-uuid="${CSS.escape(position)}"]`,
    );
    if (selected !== null && isRendered(selected)) {
      return { kind: "element", element: selected, offset: offsetIn(scroller, selected) };
    }
  }
  if (isAtBottom(scroller)) return { kind: "bottom" };
  const top = scroller.getBoundingClientRect().top;
  // フィルタだけのバブル (窓の外の say) は外すと消えるので基準にしない。
  const first = [
    ...scroller.querySelectorAll<HTMLElement>("[data-notif]:not([data-filter-only])"),
  ].find((el) => isRendered(el) && el.getBoundingClientRect().bottom > top);
  return first === undefined
    ? null
    : { kind: "element", element: first, offset: offsetIn(scroller, first) };
}

/** `anchor` を保つ寄せ方を `scrollHold` に渡す。要素なら、今の距離と測った
 * 距離の差だけ scrollTop を動かす (内容が伸びるたびにやり直される)。 */
export function holdFilterScrollAnchor(anchor: FilterScrollAnchor, scrollHold: ScrollHold): void {
  if (anchor.kind === "bottom") {
    scrollHold.toBottom();
    return;
  }
  scrollHold.toElement(anchor.element, (scroller, el) => {
    scroller.scrollTop += offsetIn(scroller, el) - anchor.offset;
  });
}

export function useFilterScroll({
  filter,
  position,
  scrollRef,
  scrollHold,
}: {
  /** URL のフィルタ (agent TL では常に null)。 */
  filter: TimelineFilter | null;
  /** URL の位置 (選んでいなければ "head")。 */
  position: string;
  scrollRef: { readonly current: HTMLElement | null };
  scrollHold: ScrollHold;
}): void {
  // 遷移の直前に測ったもの。描画には出ないので state でなく ref。
  const anchorRef = useRef<FilterScrollAnchor | null>(null);
  // 測るのは遷移の直前の URL のフィルタと位置 (この render の値)。
  const capture = useEffectEvent(() => {
    const scroller = scrollRef.current;
    anchorRef.current =
      scroller !== null && filter !== null ? filterScrollAnchor(scroller, position) : null;
  });
  useEffect(() => {
    window.addEventListener(BEFORE_NAVIGATION_EVENT, capture);
    return () => window.removeEventListener(BEFORE_NAVIGATION_EVENT, capture);
  }, []);

  const previousRef = useRef(filter);
  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = filter;
    if (previous === filter) return;
    if (filter === null) {
      const anchor = anchorRef.current;
      anchorRef.current = null;
      if (anchor !== null) holdFilterScrollAnchor(anchor, scrollHold);
      return;
    }
    if (position === "head") scrollHold.toBottom();
  }, [filter, position, scrollHold]);
}
