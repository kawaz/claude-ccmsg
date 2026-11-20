// 画面 (#app) を、ソフトウェアキーボードを除いた見える範囲に合わせる。
//
// iOS の Safari はキーボードが出ても layout viewport (初期包含ブロック、
// `100dvh` と fixed の基準) を縮めず、visual viewport (見える範囲) だけを
// 縮めて、その中で文書を動かせるようにする。動かせる幅は「初期包含ブロックの
// 高さ − 見える範囲の高さ」で、文書の中身の高さや `overflow: hidden` では
// 消えない (WebKit bug 240860)。だから #app を見える範囲の高さに縮めるだけでは、
// iOS がフォーカスした入力欄を見せるために見える範囲を下へずらした時、#app が
// 文書の上端に残って見える範囲から外れる。#app は見える範囲の位置
// (`visualViewport.offsetTop`) と高さの両方に追従させる。
//
// 値は :root の custom property に流し、配置は CSS が持つ (app.css の #app と
// .modal-dialog)。キーボードが出ていない時とピンチで拡大している時は property を
// 外し、CSS の既定 (`100dvh`、上端 0) のままにする。拡大中に合わせると、拡大の
// たびに画面全体の配置が組み直される。
//
// Design rationale: 見える範囲に合わせるのを CSS だけで行う手は、iOS では
// まだ使えない。viewport の meta の `interactive-widget=resizes-content` が
// キーボードの分だけ layout viewport ごと縮めるが、Safari は 27.3 beta で実装
// (WebKit bug 259770)、公開版に無い (選定判断基準日: 2026-11-21)。それが
// 使えるようになれば、キーボード表示中も visual viewport と layout viewport が
// 一致して `offsetTop` が 0・高さが初期包含ブロックと同じになり、ここは何も
// 書かなくなる。見える範囲を `window.scrollTo` で上端へ戻す手は採らない:
// 指で動かしている最中のパンと奪い合い、画面が揺れる (WebKit bug 332417)。
import { useEffect } from "preact/hooks";

/** :root に書く custom property。app.css がこの名前で読む。 */
export const VISIBLE_TOP = "--visible-top";
export const VISIBLE_HEIGHT = "--visible-height";
export const VISIBLE_BOTTOM = "--visible-bottom";

/** 見える範囲を初期包含ブロックの座標で表したもの (px)。`bottom` は見える範囲の
 * 下端から初期包含ブロックの下端まで (キーボードに覆われている高さ)。 */
export interface VisibleArea {
  top: number;
  height: number;
  bottom: number;
}

/** visual viewport のうち、ここが読むもの。 */
export interface ViewportMetrics {
  offsetTop: number;
  height: number;
  scale: number;
}

/** 1px 未満の差は合わせない (小数の丸めで出る差)。 */
const EPSILON = 0.5;

/** 見える範囲に合わせるべき時はその範囲、合わせない時は null。合わせるのは、
 * 拡大していないのに見える範囲が初期包含ブロック (`icbHeight` の高さ、上端 0)
 * より狭いか下へずれている時: ソフトウェアキーボードが出ている時。 */
export function visibleAreaOf(vv: ViewportMetrics, icbHeight: number): VisibleArea | null {
  if (Math.abs(vv.scale - 1) > 0.01) return null;
  const bottom = icbHeight - (vv.offsetTop + vv.height);
  if (Math.abs(vv.offsetTop) < EPSILON && bottom < EPSILON) return null;
  return { top: vv.offsetTop, height: vv.height, bottom: Math.max(0, bottom) };
}

/** 変わった時に `resize` / `scroll` を送ってくる visual viewport。 */
export interface ViewportSource extends ViewportMetrics, EventTarget {}

/** `vv` の見える範囲を `root` (文書の根要素) の custom property に流し続ける。
 * 初期包含ブロックの高さは `root.clientHeight` (overflow: hidden の根要素では
 * スクロールバーの分も引かれない)。止める関数を返し、止めると property を外す。 */
export function followVisibleArea(vv: ViewportSource, root: HTMLElement): () => void {
  let written: VisibleArea | null = null;
  const sync = () => {
    const area = visibleAreaOf(vv, root.clientHeight);
    if (
      area === written ||
      (area !== null &&
        written !== null &&
        area.top === written.top &&
        area.height === written.height &&
        area.bottom === written.bottom)
    ) {
      return;
    }
    written = area;
    if (area === null) {
      clear();
      return;
    }
    root.style.setProperty(VISIBLE_TOP, `${area.top}px`);
    root.style.setProperty(VISIBLE_HEIGHT, `${area.height}px`);
    root.style.setProperty(VISIBLE_BOTTOM, `${area.bottom}px`);
  };
  const clear = () => {
    root.style.removeProperty(VISIBLE_TOP);
    root.style.removeProperty(VISIBLE_HEIGHT);
    root.style.removeProperty(VISIBLE_BOTTOM);
  };
  sync();
  vv.addEventListener("resize", sync);
  vv.addEventListener("scroll", sync);
  return () => {
    vv.removeEventListener("resize", sync);
    vv.removeEventListener("scroll", sync);
    clear();
  };
}

/** 画面が開いている間、#app を見える範囲に合わせる (visual viewport との同期)。 */
export function useVisibleAreaFit(): void {
  useEffect(() => {
    // 型は VisualViewport | null だが、持たない実装 (happy-dom) は undefined。
    const vv = window.visualViewport;
    if (!vv) return;
    return followVisibleArea(vv, document.documentElement);
  }, []);
}
