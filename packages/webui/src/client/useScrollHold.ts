// 明示的に決めたスクロール位置 (末尾 / ある要素) を、その後に内容が伸び縮み
// しても保つ hook。画像・フォント・markdown・Shiki highlight・翻訳は描画の
// 後から高さを変えるので、1 度 scrollTop を書いただけでは狙った位置から
// ずれる。
//
// 保ち方: 位置を決める関数 (place) を 1 つ覚え、scroller と内容の要素の大きさが
// 変わるたびに (ResizeObserver) 書き直す。手放すのはユーザが自分で動かした
// 時 (wheel / touch / pointer / キー。プログラムからのスクロールはこれらを
// 出さない)、別の位置を覚えた時、要素で決めた位置ならその要素が DOM から
// 外れた時。時間で区切らないので、いつ伸びても追い、ユーザの操作とは競合
// しない。
//
// Design rationale: 末尾追従を CSS の scroll anchoring (`overflow-anchor`、
// 末尾に置いた 1px の anchor 要素を選ばせる技法) だけで済ませない。Safari は
// 27 まで scroll anchoring を持たず、この UI の利用者の iOS / macOS Safari の
// 多くで効かない。ResizeObserver はどの対象ブラウザでも同じに動く。読書中
// (= 何も保っていない時) に上の内容が伸びた場合の位置の維持は、ブラウザの
// 既定 (`overflow-anchor: auto`) の scroll anchoring に任せる。
import { useEffect, useLayoutEffect, useState } from "preact/hooks";

/** ユーザ自身の操作だけが出すイベント。scrollbar のドラッグは pointerdown で
 * 拾う。 */
const USER_SCROLL_EVENTS = ["wheel", "touchstart", "pointerdown", "keydown"] as const;

export interface ScrollHold {
  /** 末尾へ寄せ、手放すまで末尾に留める。 */
  toBottom(): void;
  /** `place` で `target` へ寄せ、手放すまで同じ寄せ方をやり直す。 */
  toElement(target: HTMLElement, place: (scroller: HTMLElement, target: HTMLElement) => void): void;
  /** 今保っている位置を手放す。 */
  release(): void;
}

class ScrollHolder implements ScrollHold {
  private scroller: HTMLElement | null = null;
  private content: Element | null = null;
  private observer: ResizeObserver | null = null;
  /** false を返したら、もう保てないので手放す。 */
  private place: ((scroller: HTMLElement) => boolean) | null = null;

  attach(scroller: HTMLElement | null, content: Element | null): void {
    if (scroller === this.scroller && content === this.content) return;
    this.detach();
    this.scroller = scroller;
    this.content = content;
    if (!scroller) return;
    for (const type of USER_SCROLL_EVENTS) {
      scroller.addEventListener(type, this.release, { passive: true });
    }
    // observe した直後にも 1 度通知が来るので、attach 前に覚えた位置もここで効く。
    const observer = new ResizeObserver(this.reapply);
    observer.observe(scroller);
    if (content) observer.observe(content);
    this.observer = observer;
  }

  detach(): void {
    const scroller = this.scroller;
    if (scroller) {
      for (const type of USER_SCROLL_EVENTS) scroller.removeEventListener(type, this.release);
    }
    this.observer?.disconnect();
    this.observer = null;
    this.scroller = null;
    this.content = null;
  }

  private readonly reapply = (): void => {
    const scroller = this.scroller;
    if (!scroller || !this.place) return;
    if (!this.place(scroller)) this.place = null;
  };

  private hold(place: (scroller: HTMLElement) => boolean): void {
    this.place = place;
    this.reapply();
  }

  readonly toBottom = (): void => {
    this.hold((scroller) => {
      scroller.scrollTop = scroller.scrollHeight;
      return true;
    });
  };

  readonly toElement = (
    target: HTMLElement,
    place: (scroller: HTMLElement, target: HTMLElement) => void,
  ): void => {
    this.hold((scroller) => {
      if (!target.isConnected) return false;
      place(scroller, target);
      return true;
    });
  };

  readonly release = (): void => {
    this.place = null;
  };
}

/** `scrollerRef` (overflow でスクロールする要素) と `contentRef` (その中で
 * 伸び縮みする内容) の位置を保つ。どちらの要素が差し替わっても (条件付き
 * 描画) 次の commit で付け直す。返す値は mount の間ずっと同じ。 */
export function useScrollHold(
  scrollerRef: { readonly current: HTMLElement | null },
  contentRef: { readonly current: Element | null },
): ScrollHold {
  const [holder] = useState(() => new ScrollHolder());
  // deps 無し: ref の中身は commit ごとに変わりうるので毎回照合する (同じ要素
  // なら attach は何もしない)。layout effect なので、同じコンポーネントの
  // useEffect から toBottom / toElement を呼ぶ時には付け終わっている。
  useLayoutEffect(() => {
    holder.attach(scrollerRef.current, contentRef.current);
  });
  useEffect(() => () => holder.detach(), [holder]);
  return holder;
}
