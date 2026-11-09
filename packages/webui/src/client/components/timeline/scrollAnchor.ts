// 内容が変わる前に測った要素の画面内の位置 (scroller の上端からの距離) を、
// 変わった後も保つ道具。フィルタを外す時 (useFilterScroll.ts) と、過去分を
// 読み込んで上に行が足される時 (Timeline の「過去分を読み込む」) が使う。
//
// Design rationale: ブラウザの scroll anchoring (`overflow-anchor`) には
// 任せない。Safari は 27 まで持たず (useScrollHold.ts)、持つブラウザでも基準の
// 要素をブラウザが選ぶので、こちらが保ちたい要素が基準になるとは限らない。先に
// scroll anchoring が動いていても、差は実際の距離から測るので結果は同じ。
import type { ScrollHold } from "../../useScrollHold.ts";

/** 保つもの: 要素と scroller の上端からの距離、または末尾。 */
export type ScrollAnchor =
  | { kind: "element"; element: HTMLElement; offset: number }
  | { kind: "bottom" };

/** 要素が描かれているか (display: none で隠れていないか)。 */
export function isRendered(el: HTMLElement): boolean {
  return el.getClientRects().length > 0;
}

function offsetIn(scroller: HTMLElement, el: HTMLElement): number {
  return el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
}

/** `el` を今の距離のまま保つ anchor。 */
export function elementScrollAnchor(scroller: HTMLElement, el: HTMLElement): ScrollAnchor {
  return { kind: "element", element: el, offset: offsetIn(scroller, el) };
}

/**
 * 過去分を読み込む前に、行の列 (`lines` = `.tl-lines`) の先頭に描かれている行を
 * 保つ anchor。位置 (`data-timeline-uuid`) を持つ行を優先する: 先頭の fold は、
 * 読み込んだ分の末尾の fold と 1 つにまとまって作り直されることがあり、作り
 * 直された要素は保てないので。位置を持つ行が無ければ先頭に描かれている子。
 * 何も描かれていなければ null。
 */
export function firstRowScrollAnchor(
  scroller: HTMLElement,
  lines: HTMLElement,
): ScrollAnchor | null {
  const rendered = [...lines.children].filter(
    (child): child is HTMLElement => child instanceof HTMLElement && isRendered(child),
  );
  const first = rendered.find((el) => el.dataset.timelineUuid !== undefined) ?? rendered[0];
  return first === undefined ? null : elementScrollAnchor(scroller, first);
}

/** `anchor` を保つ寄せ方を `scrollHold` に渡す。要素なら、今の距離と測った
 * 距離の差だけ scrollTop を動かす (内容が伸びるたびにやり直される)。 */
export function holdScrollAnchor(anchor: ScrollAnchor, scrollHold: ScrollHold): void {
  if (anchor.kind === "bottom") {
    scrollHold.toBottom();
    return;
  }
  scrollHold.toElement(anchor.element, (scroller, el) => {
    scroller.scrollTop += offsetIn(scroller, el) - anchor.offset;
  });
}
