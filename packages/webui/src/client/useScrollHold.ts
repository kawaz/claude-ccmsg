// 明示的に決めたスクロール位置 (末尾 / 先頭 / ある要素) へ動かし、その後に内容が
// 伸び縮みしても保つ hook。画像・フォント・markdown・Shiki highlight・翻訳は描画の
// 後から高さを変えるので、1 度 scrollTop を書いただけでは狙った位置から
// ずれる。
//
// 保ち方: 位置を決める関数 (place) を 1 つ覚え、scroller と、scroller の子の
// どれかの大きさが変わるたびに (ResizeObserver) 書き直す。scroller の高さ
// (scrollHeight) を決めるのは子の全部なので、行の列だけでなく、その上下に
// 並ぶもの (ツールバー、TL の下のパネル等) の伸び縮みも追う。子が入れ替わった
// 時 (条件付き描画) は MutationObserver で見る先を付け替え、その場でも書き
// 直す。手放すのはユーザが自分で動かした
// 時 (wheel / touch / pointer / キー。プログラムからのスクロールはこれらを
// 出さない)、別の位置を覚えた時、要素で決めた位置ならその要素が DOM から
// 外れた時。時間で区切らないので、いつ伸びても追い、ユーザの操作とは競合
// しない。
//
// 動かし方 (DR-0056、scroll-motion.ts): 位置を覚えた最初の 1 回は、ユーザの
// 操作が起点 ("user") ならブラウザ標準の smooth、機械的 ("machine") なら一瞬。
// 書き直しはいつも一瞬。smooth で動いている間は書き直さず (書き直すと動きが
// 途切れる)、動き終わり (`scrollend`) にその時の狙った位置を計算し直して、
// ずれていたら一瞬で直す。その後は一瞬の書き直しで保つ。
// - `scrollend` は動いている途中にも来る (実測)。Chromium は直前の一瞬の
//   スクロール (止めるためのもの、ブラウザ自身の要素を見せるスクロール) の分を
//   smooth が動き始めた後に出し、その時はまだ 1 frame 目も動いていない。WebKit
//   は scroll anchoring の調整の分を途中で出す。smooth が動き出す前 (動き始めの
//   位置から scroll が 1 度も離れていない間) の scrollend は数えない。動き出した
//   後で狙った位置に着いていない時は次の frame で位置が動いたかを見て、まだ
//   動いていれば終わりとみなさない
// - ブラウザは wheel や touch が来ても programmatic な smooth を止めない
//   (Chromium / WebKit で実測)。ユーザの操作で手放す時は、今の位置への一瞬の
//   スクロールで止める。止めないと、手放した後に古い smooth が位置を引き戻す
// - 動いている途中で scroller が隠れると (タブの切り替え)、ブラウザは動きを
//   やめ `scrollend` を出さない。大きさの変化で隠れたことを知り、動きは終わった
//   とする (また見えた時の大きさの変化で一瞬で置き直す)
// - `scrollend` を持たないブラウザ (Safari 26.1 まで) では動き終わりを確かめ
//   られないので、smooth にせず一瞬で動かす
//
// Design rationale: 末尾追従を CSS の scroll anchoring (`overflow-anchor`、
// 末尾に置いた 1px の anchor 要素を選ばせる技法) だけで済ませない。Safari は
// 27 まで scroll anchoring を持たず、この UI の利用者の iOS / macOS Safari の
// 多くで効かない。ResizeObserver はどの対象ブラウザでも同じに動く。読書中
// (= 何も保っていない時) に上の内容が伸びた場合の位置の維持は、ブラウザの
// 既定 (`overflow-anchor: auto`) の scroll anchoring に任せる。
import { useEffect, useLayoutEffect, useState } from "preact/hooks";
import { scrollBehaviorFor, type ScrollCause } from "./scroll-motion.ts";

/** ユーザ自身の操作だけが出すイベント。scrollbar のドラッグは pointerdown で
 * 拾う。 */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

/** 狙った位置に着いたとみなす差 (px)。scrollTop は小数になりうる。 */
const SETTLED_PX = 1;

export interface ScrollHold {
  /** 末尾へ寄せ、手放すまで末尾に留める。 */
  toBottom(cause?: ScrollCause): void;
  /** 先頭へ寄せ、手放すまで先頭に留める。 */
  toTop(cause?: ScrollCause): void;
  /** `topOf` が返す scrollTop で `target` へ寄せ、手放すまで同じ寄せ方をやり
   * 直す。`topOf` は呼ばれるたびに、その時の配置から計算する。 */
  toElement(
    target: HTMLElement,
    topOf: (scroller: HTMLElement, target: HTMLElement) => number,
    cause?: ScrollCause,
  ): void;
  /** 今保っている位置を手放す (smooth で動いている途中ならその場で止める)。 */
  release(): void;
  /** ユーザの操作が起点の smooth で動いている途中なら、その行き先の scrollTop
   * (動き始めた時に計算したもの)。動いていなければ null。途中の位置は読み手が
   * 選んだ位置ではないので、位置を測る側はこの間は行き先で測る。 */
  movingTo(): number | null;
}

/** `el` を scroller の表示領域の上下の真ん中に置く scrollTop。 */
export function centerTop(scroller: HTMLElement, el: HTMLElement): number {
  const box = el.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  return (
    scroller.scrollTop +
    box.top -
    view.top -
    scroller.clientTop -
    (scroller.clientHeight - box.height) / 2
  );
}

function maxTop(scroller: HTMLElement): number {
  return Math.max(0, scroller.scrollHeight - scroller.clientHeight);
}

function clampTop(scroller: HTMLElement, top: number): number {
  return Math.min(Math.max(top, 0), maxTop(scroller));
}

class ScrollHolder implements ScrollHold {
  private scroller: HTMLElement | null = null;
  private resizes: ResizeObserver | null = null;
  private childList: MutationObserver | null = null;
  /** 狙う scrollTop。null を返したら、もう保てないので手放す。 */
  private place: ((scroller: HTMLElement) => number | null) | null = null;
  /** smooth で動いている途中なら、その行き先 (動き始めた時に計算した
   * scrollTop) と動き始めの位置、動き始めの位置を離れたか。 */
  private flight: { top: number; from: number; moved: boolean } | null = null;
  /** 動き終わりを確かめる frame の予約。 */
  private settleFrame: number | null = null;

  attach(scroller: HTMLElement | null): void {
    if (scroller === this.scroller) return;
    this.detach();
    this.scroller = scroller;
    if (!scroller) return;
    for (const type of USER_SCROLL_EVENTS) {
      scroller.addEventListener(type, this.release, { passive: true });
    }
    scroller.addEventListener("scroll", this.onScroll, { passive: true });
    scroller.addEventListener("scrollend", this.onScrollEnd);
    // observe した直後にも 1 度通知が来るので、attach 前に覚えた位置もここで効く。
    const resizes = new ResizeObserver(this.reapply);
    resizes.observe(scroller);
    for (const child of scroller.children) resizes.observe(child);
    this.resizes = resizes;
    const childList = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.removedNodes) {
          if (node instanceof Element) resizes.unobserve(node);
        }
        for (const node of record.addedNodes) {
          if (node instanceof Element) resizes.observe(node);
        }
      }
      this.reapply();
    });
    childList.observe(scroller, { childList: true });
    this.childList = childList;
  }

  detach(): void {
    const scroller = this.scroller;
    if (scroller) {
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, this.release);
      scroller.removeEventListener("scroll", this.onScroll);
      scroller.removeEventListener("scrollend", this.onScrollEnd);
    }
    this.resizes?.disconnect();
    this.resizes = null;
    this.childList?.disconnect();
    this.childList = null;
    this.endFlight();
    this.scroller = null;
  }

  /** 覚えた位置へ置く。`smooth` なら標準の smooth で動き始める。 */
  private apply(scroller: HTMLElement, smooth: boolean): void {
    const place = this.place;
    if (!place) return;
    const top = place(scroller);
    if (top === null) {
      this.place = null;
      return;
    }
    // 行き先が今の位置なら動かない (動かない smooth には scrollend が来ない)。
    const destination = clampTop(scroller, top);
    if (smooth && Math.abs(destination - scroller.scrollTop) >= SETTLED_PX) {
      this.flight = { top: destination, from: scroller.scrollTop, moved: false };
      scroller.scrollTo({ top, behavior: "smooth" });
      return;
    }
    scroller.scrollTo({ top, behavior: "instant" });
  }

  private readonly reapply = (): void => {
    const scroller = this.scroller;
    if (!scroller || !this.place) return;
    if (this.flight) {
      // 隠れた scroller ではブラウザが動きをやめ、scrollend も来ない。
      if (scroller.getClientRects().length === 0) this.endFlight();
      // 動き出す前に内容が縮んで行き先が今の位置になった: もう動かないので
      // scrollend も来ない。
      else if (
        !this.flight.moved &&
        Math.abs(clampTop(scroller, this.flight.top) - scroller.scrollTop) < SETTLED_PX
      ) {
        this.settle(scroller);
      }
      return;
    }
    this.apply(scroller, false);
  };

  private endFlight(): void {
    this.flight = null;
    if (this.settleFrame !== null) cancelAnimationFrame(this.settleFrame);
    this.settleFrame = null;
  }

  /** smooth が終わった: 今の配置で狙い直し、ずれていれば一瞬で直す。 */
  private settle(scroller: HTMLElement): void {
    this.endFlight();
    this.apply(scroller, false);
  }

  private readonly onScroll = (): void => {
    const scroller = this.scroller;
    const flight = this.flight;
    if (scroller && flight && Math.abs(scroller.scrollTop - flight.from) >= SETTLED_PX) {
      flight.moved = true;
    }
  };

  private readonly onScrollEnd = (): void => {
    const scroller = this.scroller;
    const flight = this.flight;
    if (!scroller || !flight || !flight.moved || this.settleFrame !== null) return;
    const max = maxTop(scroller);
    if (Math.abs(scroller.scrollTop - flight.top) < SETTLED_PX || flight.top > max) {
      this.settle(scroller);
      return;
    }
    // 行き先の手前で来た scrollend: 次の frame で止まっていれば終わり。
    const at = scroller.scrollTop;
    this.settleFrame = requestAnimationFrame(() => {
      this.settleFrame = null;
      if (this.flight !== flight) return;
      if (Math.abs(scroller.scrollTop - at) < SETTLED_PX) this.settle(scroller);
    });
  };

  /** smooth で動いている途中なら、今の位置で止める。 */
  private stop(): void {
    const scroller = this.scroller;
    // 標準の smooth はユーザの操作でも別の位置を覚えても止まらない
    // (後者は次のスクロールが行き先を差し替えるが、行き先が無い時は動き続ける)。
    if (this.flight && scroller)
      scroller.scrollTo({ top: scroller.scrollTop, behavior: "instant" });
    this.endFlight();
  }

  private hold(place: (scroller: HTMLElement) => number | null, cause: ScrollCause): void {
    this.stop();
    this.place = place;
    const scroller = this.scroller;
    if (!scroller) return;
    const smooth = scrollBehaviorFor(cause) === "smooth" && "onscrollend" in scroller;
    this.apply(scroller, smooth);
  }

  readonly toBottom = (cause: ScrollCause = "machine"): void => {
    this.hold((scroller) => scroller.scrollHeight, cause);
  };

  readonly toTop = (cause: ScrollCause = "machine"): void => {
    this.hold(() => 0, cause);
  };

  readonly toElement = (
    target: HTMLElement,
    topOf: (scroller: HTMLElement, target: HTMLElement) => number,
    cause: ScrollCause = "machine",
  ): void => {
    this.hold((scroller) => (target.isConnected ? topOf(scroller, target) : null), cause);
  };

  readonly release = (): void => {
    this.place = null;
    this.stop();
  };

  readonly movingTo = (): number | null => this.flight?.top ?? null;
}

/** `scrollerRef` (overflow でスクロールする要素) の位置を保つ。要素が差し替わっ
 * ても (条件付き描画) 次の commit で付け直す。返す値は mount の間ずっと同じ。 */
export function useScrollHold(scrollerRef: { readonly current: HTMLElement | null }): ScrollHold {
  const [holder] = useState(() => new ScrollHolder());
  // deps 無し: ref の中身は commit ごとに変わりうるので毎回照合する (同じ要素
  // なら attach は何もしない)。layout effect なので、同じコンポーネントの
  // useEffect から toBottom / toElement を呼ぶ時には付け終わっている。
  useLayoutEffect(() => {
    holder.attach(scrollerRef.current);
  });
  useEffect(() => () => holder.detach(), [holder]);
  return holder;
}
