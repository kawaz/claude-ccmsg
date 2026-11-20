// 浮いている層 (FAB の入力パネル、modal dialog) の上で始まったタッチの
// スクロールを、層の外 (ページ) へ伝えない hook。層の中にそのスクロールを
// 受けられる箱 (中身があふれて、その向きにまだ動ける textarea・本文の
// スクロール領域) がある時はブラウザに任せ、無い時だけ touchmove を止める。
//
// 層の CSS には `overscroll-behavior: contain` を付けてある (app.css)。仕様
// (CSS Overscroll Behavior 1) では、この指定は中身があふれていないスクロール
// コンテナでもスクロールの連鎖を止める。iOS の WebKit は中身があふれている
// 箱でしかこれを効かせず (WebKit bug 176454 comment 62、Blink の Intent to
// Ship "Respect overscroll-behavior on non-scrollable scroll containers" は
// 全ブラウザがこの扱いと書く)、あふれていない textarea の上の縦のスワイプは
// そのままページへ渡る。ソフトウェアキーボードが出ている間 (visual viewport が
// layout viewport より小さい間) は、ページ自体があふれていなくても iOS が
// 文書全体を動かせるので (WebKit bug 240860、`overflow: hidden` も効かない)、
// ページが指について動き、fixed の層の中の caret が文字と離れた位置に描かれる。
//
// Design rationale: CSS だけで止める手が無いので、touchmove の既定動作を
// 止める。`touch-action` は効く範囲がタッチした要素から最寄りのスクロール
// コンテナまでで、textarea 自身がスクロールコンテナなので、textarea の中が
// スクロールできる時とできない時を CSS で切り替えられない。visual viewport の
// 位置を JS で書き戻す手 (body を fixed にして scroll 位置を戻す類) は採らない:
// 層の外の配置まで JS が握ることになる。ここで止めるのは「層の中で受け手の
// いないスワイプ」だけで、層の中のスクロール・層の外のタッチ・2 本指
// (ピンチ) には触れない。
import { useEffect } from "preact/hooks";

/** Minimal ref shape this hook needs: what `useRef<T>(null)` returns. */
interface ElementRef<T extends HTMLElement> {
  current: T | null;
}

export type PanAxis = "x" | "y";

/** What decides whether one box can take a pan: how far it is scrolled, how
 * large its content and its window are, and whether the person may scroll it
 * on that axis (computed `overflow-x` / `overflow-y` is `auto` or `scroll`). */
export interface PanBox {
  scrollTop: number;
  scrollLeft: number;
  scrollHeight: number;
  scrollWidth: number;
  clientHeight: number;
  clientWidth: number;
}

/** Whether `box` moves when a finger moves by `delta` on `axis`. A finger
 * moving up (negative delta) scrolls the content toward its end. A remainder
 * under 1px (a fractional scroll position) counts as at the edge. */
export function boxTakesPan(
  box: PanBox,
  userScrollable: boolean,
  axis: PanAxis,
  delta: number,
): boolean {
  if (!userScrollable || delta === 0) return false;
  const position = axis === "y" ? box.scrollTop : box.scrollLeft;
  const room =
    axis === "y" ? box.scrollHeight - box.clientHeight : box.scrollWidth - box.clientWidth;
  return delta < 0 ? room - position >= 1 : position >= 1;
}

function userScrollable(el: Element, axis: PanAxis): boolean {
  const style = getComputedStyle(el);
  const overflow = axis === "y" ? style.overflowY : style.overflowX;
  return overflow === "auto" || overflow === "scroll";
}

/** Whether some box from `target` up to `layer` (both included) takes a pan
 * of (`dx`, `dy`) on its main axis. */
export function panStaysInLayer(target: Element, layer: Element, dx: number, dy: number): boolean {
  const axis: PanAxis = Math.abs(dy) >= Math.abs(dx) ? "y" : "x";
  const delta = axis === "y" ? dy : dx;
  for (let el: Element | null = target; el !== null; el = el.parentElement) {
    if (boxTakesPan(el, userScrollable(el, axis), axis, delta)) return true;
    if (el === layer) break;
  }
  return false;
}

/** While `active`, a one-finger swipe that starts on the element `layerRef`
 * points at and that no box in the layer takes does not scroll the page. The
 * decision is made on the gesture's first move and kept to its end: once a
 * browser starts a scroll, it no longer lets a touchmove be cancelled. */
export function useContainTouchPan<T extends HTMLElement>(
  layerRef: ElementRef<T>,
  active: boolean,
): void {
  useEffect(() => {
    const current = layerRef.current;
    if (!active || current === null) return;
    const layer: HTMLElement = current;
    let start: { x: number; y: number } | null = null;
    let blocked: boolean | null = null;
    function onTouchStart(e: TouchEvent): void {
      const touch = e.touches.length === 1 ? e.touches[0] : undefined;
      start = touch === undefined ? null : { x: touch.clientX, y: touch.clientY };
      blocked = null;
    }
    function onTouchMove(e: TouchEvent): void {
      const touch = e.touches.length === 1 ? e.touches[0] : undefined;
      if (start === null || touch === undefined) return;
      if (blocked === null) {
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (dx === 0 && dy === 0) return;
        blocked = !(e.target instanceof Element && panStaysInLayer(e.target, layer, dx, dy));
      }
      if (blocked && e.cancelable) e.preventDefault();
    }
    layer.addEventListener("touchstart", onTouchStart, { passive: true });
    // passive: false so preventDefault is honoured; Safari makes touch
    // listeners on the document passive by default, and saying it here keeps
    // that from depending on where the listener sits.
    layer.addEventListener("touchmove", onTouchMove, { passive: false });
    return () => {
      layer.removeEventListener("touchstart", onTouchStart);
      layer.removeEventListener("touchmove", onTouchMove);
    };
  }, [layerRef, active]);
}
