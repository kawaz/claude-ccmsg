// 図の箱 (FenceFigure) の大きさが変わる時に、見ている物を画面上で動かさない
// (DR-0010 §12)。変わるのは 2 つ:
//
// - 図の切り替え (描画 / ソース、mermaid の配色) を押した時。mermaid の選択は
//   全部の図に効くので、押した図より上の図も一斉に伸び縮みする。押した切り替え
//   を、押した時の画面上の縦位置に留める
// - 見ている位置より上で mermaid の図が描き上がった時。最後に押した切り替えが
//   見えていればそれを、無ければ図の下端 (図の次から後ろの物) を留める
//
// 留め方: 変わる前の縦位置を測っておき、変わった後でずれた分だけ、その要素を
// 含むスクロールの容器を一瞬で動かす (位置を保つ機械的な寄せ直し、DR-0056)。
// 容器の範囲を超えて動かす必要がある時 (末尾の近くで後ろが縮んだ、先頭より上が
// 要る) は、一時的な余白を容器の末尾 (先頭) に置いて位置を保ってから、余白を
// CSS の transition で縮めて滑らかに動かす。余白の高さは、置いて測ったずれが
// 消えるまで合わせる (末尾の子が負の margin で前の子に重なっていると、余白の
// 高さの一部は範囲を伸ばさない)。OS の「視差効果を減らす」設定の時は余白を
// 置かず、範囲の端で止める。
//
// 測った後の補正は次の frame の描画の前 (requestAnimationFrame) に行う。
// 切り替えは store を通して Preact の描き直しを起こし、描き直しは同じ task の
// microtask で全部の図について済むので、その後で 1 回測れば足りる。描画の前
// なので、ずれた状態は画面に出ない。Timeline が末尾や位置を保っている間
// (useScrollHold) は、その保持が同じ frame の ResizeObserver で置き直すので、
// そちらが勝つ (切り替えを押すと、押下で保持は手放される)。
//
// Design rationale: dirview の同じ仕組みは容器に `overflow-anchor: none` を
// 付けてブラウザの scroll anchoring を止めるが、ここでは止めない。Timeline の
// 容器は、何も保っていない読書中に上の内容が伸びた時の位置の維持をブラウザの
// scroll anchoring に任せている (useScrollHold.ts) ので、止めると図以外の伸び
// (画像・ハイライト・翻訳) で読んでいる位置がずれる。scroll anchoring が先に
// 動いていても、ずれは変わった後の実際の位置から測るので二重には動かさない
// (scrollAnchor.ts と同じ考え方)。補正の後に scroll anchoring がもう一度動かない
// ことは、Chromium と WebKit で切り替えと描き上がりの前後の位置を測って確かめた
// (e2e/markdown-mermaid-prefs.e2e.ts)。
import { prefersReducedMotion } from "./scroll-motion.ts";

/** ずれとみなさない差 (px)。 */
const SETTLED_PX = 0.5;

/** 縦にスクロールしている容器か。 */
function scrollsVertically(el: Element): boolean {
  const overflow = getComputedStyle(el).overflowY;
  return (overflow === "auto" || overflow === "scroll") && el.scrollHeight > el.clientHeight;
}

/** `el` を含む、縦にスクロールしている一番近い容器。無ければ文書の容器。 */
function scrollerOf(el: Element): HTMLElement | null {
  for (let e = el.parentElement; e !== null; e = e.parentElement) {
    if (scrollsVertically(e)) return e;
  }
  const root = document.scrollingElement;
  return root instanceof HTMLElement && root.scrollHeight > root.clientHeight ? root : null;
}

/** 容器の見えている範囲の上下 (viewport の座標)。文書の容器なら viewport。 */
function viewOf(scroller: HTMLElement): { top: number; bottom: number } {
  if (scroller === document.scrollingElement) return { top: 0, bottom: window.innerHeight };
  const box = scroller.getBoundingClientRect();
  return {
    top: box.top + scroller.clientTop,
    bottom: box.top + scroller.clientTop + scroller.clientHeight,
  };
}

/** 範囲を超えた分の余白 (高さ 0 で置く)。文書の容器では body に置く。 */
function spacer(scroller: HTMLElement, atTop: boolean): HTMLElement {
  const s = document.createElement("div");
  s.className = "keep-scroll-spacer";
  s.setAttribute("aria-hidden", "true");
  // 高さを合わせている間は transition させない (shrink で外す)。
  s.style.transition = "none";
  s.style.blockSize = "0px";
  const host = scroller === document.scrollingElement ? document.body : scroller;
  if (atTop) host.prepend(s);
  else host.append(s);
  const remove = () => s.remove();
  s.addEventListener("transitionend", remove, { once: true });
  s.addEventListener("transitioncancel", remove, { once: true });
  return s;
}

/** 合わせた高さを style として解決させてから、CSS の transition で 0 へ縮め
 * 始める。縮み終わると外れる。 */
function shrink(s: HTMLElement): void {
  if (s.getBoundingClientRect().height < SETTLED_PX) {
    s.remove();
    return;
  }
  s.style.removeProperty("transition");
  s.style.blockSize = "0px";
}

/**
 * 最後の補正で残ったずれ。スクロールの位置は整数 px に丸められるので、補正の
 * たびに 1 px 未満のずれが残る。図が次々に描き上がって補正が続く時に、その
 * 残りが積み重ならないよう、次の補正の基準から差し引く。補正の後に容器が
 * 動いていれば (読み手のスクロール等) 使わない。
 */
let carry: { scroller: HTMLElement; scrollTop: number; residual: number } | null = null;

/** `scroller` の中の要素の今の縦位置 `now` から、前の補正で残ったずれを除いた
 * 位置 (前の補正が丸めなしで効いていた時の位置)。 */
function intended(scroller: HTMLElement, now: number): number {
  return carry !== null && carry.scroller === scroller && carry.scrollTop === scroller.scrollTop
    ? now - carry.residual
    : now;
}

/** `scroller` を動かして、`measure` が測る縦位置を `before` に戻す。 */
function restore(scroller: HTMLElement, measure: () => number | null, before: number): void {
  const now = measure();
  if (now === null) return;
  const delta = now - before;
  if (Math.abs(delta) < SETTLED_PX) {
    carry = { scroller, scrollTop: scroller.scrollTop, residual: delta };
    return;
  }
  const want = scroller.scrollTop + delta;
  const max = scroller.scrollHeight - scroller.clientHeight;
  const atTop = want < -SETTLED_PX;
  if ((!atTop && want <= max + SETTLED_PX) || prefersReducedMotion()) {
    scroller.scrollTo({ top: want, behavior: "instant" });
    carry = { scroller, scrollTop: scroller.scrollTop, residual: (measure() ?? before) - before };
    return;
  }
  // 余白を足して範囲の端へ寄せ、まだ残るずれの分だけ余白を足す。余白の高さが
  // そのまま範囲に足されるとは限らない (末尾の子が負の margin で前の子に
  // 重なっていると、その分は範囲を伸ばさない) ので、測って合わせる。
  const s = spacer(scroller, atTop);
  let height = atTop ? -want : want - max;
  for (let i = 0; i < 3; i++) {
    s.style.blockSize = `${height}px`;
    scroller.scrollTo({ top: atTop ? 0 : scroller.scrollHeight, behavior: "instant" });
    const left = (measure() ?? before) - before;
    if (Math.abs(left) < SETTLED_PX) break;
    height = Math.max(0, height + (atTop ? -left : left));
  }
  // 余白が縮む間は容器が動くので、残りのずれは次へ持ち越さない。
  carry = null;
  shrink(s);
}

function topOf(el: Element): number | null {
  return el.isConnected ? el.getBoundingClientRect().top : null;
}

/** 押した切り替えと、押した時の縦位置。 */
let pressed: { at: HTMLElement; top: number; scroller: HTMLElement | null } | null = null;
/** 最後に使った切り替え。後から描き上がる図は、これが見えていればこれを留める。 */
let lastSwitch: HTMLElement | null = null;

/** 切り替えの列 (`bar`) にポインタが降りた時・キーが押された時に呼ぶ。選択が
 * 変わる前の縦位置を覚える。 */
export function pressSwitch(bar: HTMLElement): void {
  pressed = { at: bar, top: bar.getBoundingClientRect().top, scroller: scrollerOf(bar) };
}

/** 切り替えの列 (`bar`) で選択を変えた直後に呼ぶ。描き直しの後で、列を押した
 * 時の縦位置に戻す。 */
export function keepSwitch(bar: HTMLElement): void {
  lastSwitch = bar;
  const press = pressed;
  pressed = null;
  if (press === null || press.at !== bar) return;
  requestAnimationFrame(() => {
    // 押した時に容器がスクロールしていなくても、上が伸びてスクロールするように
    // なっていれば、その容器で戻す。
    const scroller = press.scroller ?? scrollerOf(bar);
    if (scroller !== null) restore(scroller, () => topOf(bar), press.top);
  });
}

function inView(el: HTMLElement, scroller: HTMLElement): boolean {
  if (!el.isConnected || !scroller.contains(el)) return false;
  const box = el.getBoundingClientRect();
  const view = viewOf(scroller);
  return box.bottom > view.top && box.top < view.bottom;
}

/**
 * `block` (図の箱) の大きさが変わる直前に呼ぶ。返す関数を変わった後 (描き直しの
 * 後) に呼ぶと、読んでいる位置を保つ: 最後に使った切り替えが同じ容器の中で
 * 見えていればそれを、無ければ図が見えている範囲より上から始まる時に図の下端を
 * 留める。どちらでもなければ何もしない (図より上は動かない)。
 */
export function holdAround(block: HTMLElement): () => void {
  const scroller = scrollerOf(block);
  if (scroller === null) return () => {};
  if (lastSwitch !== null && inView(lastSwitch, scroller)) {
    const anchor = lastSwitch;
    const before = intended(scroller, anchor.getBoundingClientRect().top);
    return () => restore(scroller, () => topOf(anchor), before);
  }
  const box = block.getBoundingClientRect();
  if (box.top >= viewOf(scroller).top) return () => {};
  const bottomOf = () => (block.isConnected ? block.getBoundingClientRect().bottom : null);
  const before = intended(scroller, box.bottom);
  return () => restore(scroller, bottomOf, before);
}
