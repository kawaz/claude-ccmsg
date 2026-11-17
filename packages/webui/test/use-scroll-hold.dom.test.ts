// useScrollHold を scroller ごとマウントして、保つ位置を書き直すきっかけを固定する。
// - scroller の高さ (scrollHeight) を決めるのは子の全部なので、行の列だけで
//   なく、その下に並ぶもの (TL の下のパネル) が後から伸びても末尾を保つ。これが
//   漏れると、フィルタを外す直前に末尾から数 px ずれていて、末尾を見ていた読み
//   手が末尾に戻らなかった (DR-0050 §6)
// - 後から入った子も見る。外れた子は見なくなる。子の入れ替わりの時にも書き直す
// - 手放すと書き直さない
// - 動かし方 (DR-0056): ユーザの操作が起点 ("user") の最初の 1 回はブラウザ標準の
//   smooth、機械的 ("machine"、渡し忘れも) と書き直しはいつも一瞬。smooth の
//   途中は書き直さず、動き終わり (scrollend) に狙い直して、ずれていたら一瞬で
//   直す。割り込み (ユーザの操作、別の位置、隠れた) で古い smooth が位置を引き
//   戻さない
// happy-dom はレイアウトせず ResizeObserver も呼ばないので、見ている要素を記録
// する ResizeObserver に差し替え、ブラウザが呼ぶ所でテストが呼ぶ。smooth の
// 動きと scrollend もテストが動かす (scrollTo を記録に差し替える)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { useScrollHold, type ScrollHold } from "../src/client/useScrollHold.ts";
import { instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { renderHook } from "./render-hook.ts";

withDom();

/** 見ている要素と通知の先を記録する ResizeObserver。 */
class RecordingResizeObserver {
  static all: RecordingResizeObserver[] = [];
  readonly observed = new Set<Element>();
  private readonly callback: () => void;
  constructor(callback: () => void) {
    this.callback = callback;
    RecordingResizeObserver.all.push(this);
  }
  observe(target: Element): void {
    this.observed.add(target);
  }
  unobserve(target: Element): void {
    this.observed.delete(target);
  }
  disconnect(): void {
    this.observed.clear();
  }
  /** `target` の大きさが変わった時のブラウザの通知。見ていなければ何も来ない。 */
  resized(target: Element): void {
    if (this.observed.has(target)) this.callback();
  }
}

let restores: Array<() => void> = [];
let unmounts: Array<() => Promise<void>> = [];

/** OS の「視差効果を減らす」設定。テストごとに既定 (入っていない) に戻す。 */
let reducedMotion = false;

beforeEach(() => {
  RecordingResizeObserver.all = [];
  reducedMotion = false;
  restores = [
    stubGlobal("ResizeObserver", RecordingResizeObserver),
    stubGlobal("matchMedia", (query: string) => ({
      matches: query === "(prefers-reduced-motion: reduce)" && reducedMotion,
      media: query,
    })),
  ];
});

afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
  for (const restore of restores.reverse()) restore();
});

/** Timeline と同じ並び: ツールバー、行の列、下のパネル。scrollTop は
 * scrollHeight - clientHeight で頭打ちにする (ブラウザと同じ)。 */
/** scroller の scrollTo の呼び出し。一瞬はその場で scrollTop を動かし、smooth
 * はブラウザが後の frame で動かすので、ここでは動かさない (テストが動かす)。 */
interface ScrollToCall {
  top: number;
  behavior: ScrollBehavior | undefined;
}

async function mountHold(options: { scrollend?: boolean } = {}): Promise<{
  hold: ScrollHold;
  scroller: HTMLElement;
  setScrollHeight: (value: number) => void;
  scrollTos: ScrollToCall[];
}> {
  function useProbe() {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    return { hold: useScrollHold(scrollRef), scrollRef };
  }
  const hook = await renderHook(useProbe, undefined, {
    extra: ({ scrollRef }) =>
      h("div", { class: "scroller", ref: scrollRef }, [
        h("div", { key: "toolbar", class: "toolbar" }),
        h("div", { key: "lines", class: "lines" }),
        h("div", { key: "bottom", class: "bottom" }),
      ]),
  });
  unmounts.push(hook.unmount);
  const scroller = instanceOf(document.querySelector(".scroller"), HTMLElement, "scroller");
  let scrollHeight = 1000;
  let scrollTop = 0;
  const clientHeight = 800;
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: clientHeight });
  Object.defineProperty(scroller, "scrollHeight", { configurable: true, get: () => scrollHeight });
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = Math.max(0, Math.min(value, scrollHeight - clientHeight));
    },
  });
  const scrollTos: ScrollToCall[] = [];
  Object.defineProperty(scroller, "scrollTo", {
    configurable: true,
    value: (options: ScrollToOptions) => {
      const top = options.top ?? scrollTop;
      scrollTos.push({ top, behavior: options.behavior });
      if (options.behavior !== "smooth") scroller.scrollTop = top;
    },
  });
  // scrollend を持つブラウザ (Chrome 114+ / Safari 26.2+) かどうか。happy-dom は持たない。
  if (options.scrollend !== false) {
    Object.defineProperty(scroller, "onscrollend", {
      configurable: true,
      writable: true,
      value: null,
    });
  }
  return {
    hold: hook.current().hold,
    scroller,
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
    scrollTos,
  };
}

function observer(): RecordingResizeObserver {
  const last = RecordingResizeObserver.all.at(-1);
  if (last === undefined) throw new Error("expected a ResizeObserver, found none");
  return last;
}

function child(scroller: HTMLElement, cls: string): HTMLElement {
  return instanceOf(scroller.querySelector(`:scope > .${cls}`), HTMLElement, cls);
}

/** MutationObserver の通知 (microtask) まで流す。 */
const drained = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("useScrollHold", () => {
  test("watches the scroller and every child of it, not only the rows", async () => {
    const { scroller } = await mountHold();
    const watched = observer().observed;
    expect(watched.has(scroller)).toBe(true);
    for (const cls of ["toolbar", "lines", "bottom"]) {
      expect(watched.has(child(scroller, cls))).toBe(true);
    }
  });

  // The bottom panel growing alone (its size changes, the rows' does not)
  // raises the scroller's scrollHeight: the bottom is kept all the same.
  test("keeps the bottom when a child below the rows grows", async () => {
    const { hold, scroller, setScrollHeight } = await mountHold();
    hold.toBottom();
    expect(scroller.scrollTop).toBe(200);
    setScrollHeight(1004);
    observer().resized(child(scroller, "bottom"));
    expect(scroller.scrollTop).toBe(204);
  });

  test("a child added later is watched, one taken out is not, and the change re-places", async () => {
    const { hold, scroller, setScrollHeight } = await mountHold();
    hold.toBottom();
    const added = document.createElement("div");
    setScrollHeight(1100);
    scroller.append(added);
    await drained();
    expect(observer().observed.has(added)).toBe(true);
    expect(scroller.scrollTop).toBe(300);

    const bottom = child(scroller, "bottom");
    bottom.remove();
    await drained();
    expect(observer().observed.has(bottom)).toBe(false);
  });

  test("once released, a child growing does not move the scroller", async () => {
    const { hold, scroller, setScrollHeight } = await mountHold();
    hold.toBottom();
    hold.release();
    setScrollHeight(1004);
    observer().resized(child(scroller, "bottom"));
    expect(scroller.scrollTop).toBe(200);
  });
});

/** smooth の動きの 1 frame: ブラウザが scrollTop を動かし、scroll を出す。 */
function animateTo(scroller: HTMLElement, top: number): void {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event("scroll"));
}

/** 次の animation frame まで流す。 */
const nextFrame = () =>
  act(() => new Promise<void>((resolve) => requestAnimationFrame(() => resolve())));

describe("useScrollHold: how it moves (DR-0056)", () => {
  // 機械的な移動 (追従・復元・寄せ直し) は一瞬。cause を渡し忘れても一瞬:
  // 渡し忘れで smooth になると、高頻度の追従が遅れて追いつかない。CSS の
  // scroll-behavior に左右されないよう "instant" を明示する。
  test("a machine move, or one with no cause given, is instant", async () => {
    const { hold, scroller, scrollTos } = await mountHold();
    hold.toBottom("machine");
    hold.toTop();
    hold.toElement(child(scroller, "lines"), () => 50);
    expect(scrollTos.map((c) => c.behavior)).toEqual(["instant", "instant", "instant"]);
    expect(scroller.scrollTop).toBe(50);
    expect(hold.movingTo()).toBeNull();
  });

  // ユーザの操作の結果の移動は、どこへどちら向きに動いたかが分かるよう標準の
  // smooth。動いている途中は行き先を返す (位置を測る側が途中の位置で測らない)。
  test("a move the user asked for is smooth, and tells where it is going", async () => {
    const { hold, scroller, scrollTos } = await mountHold();
    hold.toBottom("user");
    expect(scrollTos).toEqual([{ top: 1000, behavior: "smooth" }]);
    // 行き先は scroller が届く所 (scrollHeight - clientHeight)。
    expect(hold.movingTo()).toBe(200);
    expect(scroller.scrollTop).toBe(0);
  });

  // 「視差効果を減らす」設定の時は、ユーザの操作でも一瞬。ブラウザは
  // programmatic な smooth にこの設定を当てない (Chromium 143 / WebKit 27 で実測)。
  test("with reduced motion, a move the user asked for is instant", async () => {
    reducedMotion = true;
    const { hold, scroller, scrollTos } = await mountHold();
    hold.toBottom("user");
    expect(scrollTos).toEqual([{ top: 1000, behavior: "instant" }]);
    expect(scroller.scrollTop).toBe(200);
    expect(hold.movingTo()).toBeNull();
  });

  // scrollend を持たないブラウザでは動き終わりの着地を確かめられないので一瞬。
  test("without scrollend, a move the user asked for is instant", async () => {
    const { hold, scroller, scrollTos } = await mountHold({ scrollend: false });
    hold.toBottom("user");
    expect(scrollTos).toEqual([{ top: 1000, behavior: "instant" }]);
    expect(scroller.scrollTop).toBe(200);
  });

  // 行き先が今の位置なら smooth にしない: 動かない smooth には scrollend が来ず、
  // 動いている途中のまま残って書き直しが止まる。
  test("a move the user asked for to where the scroller already is does not start a smooth one", async () => {
    const { hold, scrollTos } = await mountHold();
    hold.toTop("user");
    expect(scrollTos).toEqual([{ top: 0, behavior: "instant" }]);
    expect(hold.movingTo()).toBeNull();
  });

  // smooth の途中に内容が伸びても書き直さない (書き直すと動きが途切れる)。
  // 動き終わりに伸びた後の末尾へ一瞬で直し、その後は一瞬の書き直しで保つ。
  // ⤓ で末尾へ動いている途中に行が足されても、最後は末尾に着く。
  test("growth during a smooth move waits for its end, which puts it right instantly", async () => {
    const { hold, scroller, setScrollHeight, scrollTos } = await mountHold();
    hold.toBottom("user");
    animateTo(scroller, 100);
    setScrollHeight(1300);
    observer().resized(child(scroller, "lines"));
    expect(scrollTos).toHaveLength(1);
    animateTo(scroller, 200);
    scroller.dispatchEvent(new Event("scrollend"));
    expect(scrollTos.at(-1)).toEqual({ top: 1300, behavior: "instant" });
    expect(scroller.scrollTop).toBe(500);
    expect(hold.movingTo()).toBeNull();

    setScrollHeight(1400);
    observer().resized(child(scroller, "lines"));
    expect(scroller.scrollTop).toBe(600);
  });

  // Chromium は smooth を始める直前の一瞬のスクロール (前の smooth を止めたもの、
  // ブラウザ自身が要素を見せたもの) の scrollend を、smooth が動き始めた後に出す。
  // その時 smooth はまだ 1 frame も動いておらず、次の frame でも位置が同じなので、
  // 「止まった」と読むと smooth を一瞬の移動で打ち切ってしまう (実ブラウザの
  // TL で日付の帯の ↑ がこうなった)。動き始めの位置を離れるまでの scrollend は
  // 数えない。
  test("a scrollend before the smooth move has left its start is not its end", async () => {
    const { hold, scroller, scrollTos } = await mountHold();
    hold.toElement(child(scroller, "lines"), () => 150, "user");
    scroller.dispatchEvent(new Event("scroll"));
    scroller.dispatchEvent(new Event("scrollend"));
    await nextFrame();
    await nextFrame();
    expect(hold.movingTo()).toBe(150);
    expect(scrollTos).toHaveLength(1);

    animateTo(scroller, 150);
    scroller.dispatchEvent(new Event("scrollend"));
    expect(hold.movingTo()).toBeNull();
  });

  // 動き出す前に内容が縮んで行き先が今の位置になったら、もう動かず scrollend も
  // 来ないので、動いている途中のまま残さない (残ると書き直しも末尾追従も止まる)。
  test("a smooth move whose destination shrank to where it still is ends on the resize", async () => {
    const { hold, scroller, setScrollHeight } = await mountHold();
    scroller.scrollTop = 100;
    hold.toBottom("user");
    expect(hold.movingTo()).toBe(200);
    setScrollHeight(900);
    observer().resized(child(scroller, "lines"));
    expect(hold.movingTo()).toBeNull();
    expect(scroller.scrollTop).toBe(100);
  });

  // 動き出した後に行き先の手前で来た scrollend はまだ動いているかもしれない
  // (WebKit は scroll anchoring の調整の分、Chromium は wheel の分を動いている
  // 途中に出す。実測)。次の frame で位置が動いていれば終わりとみなさず、止まって
  // いれば終わりとして狙い直す。
  test("a scrollend short of the destination ends the move only once a frame finds it still", async () => {
    const { hold, scroller, scrollTos } = await mountHold();
    hold.toElement(child(scroller, "lines"), () => 150, "user");
    animateTo(scroller, 20);
    scroller.dispatchEvent(new Event("scrollend"));
    animateTo(scroller, 60);
    await nextFrame();
    expect(hold.movingTo()).toBe(150);
    expect(scrollTos).toHaveLength(1);

    // 止まった所で scrollend: 次の frame でも同じ位置なので終わり、狙い直す。
    scroller.dispatchEvent(new Event("scrollend"));
    await nextFrame();
    expect(hold.movingTo()).toBeNull();
    expect(scrollTos.at(-1)).toEqual({ top: 150, behavior: "instant" });
    expect(scroller.scrollTop).toBe(150);
  });

  // ユーザが自分でスクロールしたら、今の位置で smooth を止めて手放す。ブラウザは
  // wheel や touch で programmatic な smooth を止めない (Chromium / WebKit で
  // 実測) ので、止めないと手放した後に古い smooth が位置を引き戻す。
  test("the reader's own scrolling stops a smooth move where it is and lets go", async () => {
    const { hold, scroller, setScrollHeight, scrollTos } = await mountHold();
    hold.toBottom("user");
    animateTo(scroller, 120);
    scroller.dispatchEvent(new Event("wheel"));
    expect(scrollTos.at(-1)).toEqual({ top: 120, behavior: "instant" });
    expect(hold.movingTo()).toBeNull();

    // 後から来る scrollend も伸びも位置を動かさない。
    scroller.dispatchEvent(new Event("scrollend"));
    setScrollHeight(1300);
    observer().resized(child(scroller, "lines"));
    expect(scroller.scrollTop).toBe(120);
    expect(scrollTos).toHaveLength(2);
  });

  // 別の位置を覚えたら (別のボタン、追従、セッションの切り替え) 古い smooth は
  // 止まり、その行き先へは戻らない。
  test("another move takes over from a smooth one, which no longer pulls back", async () => {
    const { hold, scroller, scrollTos } = await mountHold();
    hold.toBottom("user");
    animateTo(scroller, 80);
    hold.toElement(child(scroller, "lines"), () => 30);
    expect(scrollTos.slice(1)).toEqual([
      { top: 80, behavior: "instant" },
      { top: 30, behavior: "instant" },
    ]);
    expect(hold.movingTo()).toBeNull();
    scroller.dispatchEvent(new Event("scrollend"));
    expect(scroller.scrollTop).toBe(30);
  });

  // 動いている途中で scroller が隠れると (タブの切り替え)、ブラウザは動きをやめ
  // scrollend を出さない (Chromium / WebKit で実測)。隠れたことを大きさの変化で
  // 知って動きを終わりにし、また見えた時の大きさの変化で一瞬で置き直す。
  test("a scroller hidden during a smooth move ends it; shown again, it is placed instantly", async () => {
    const { hold, scroller, scrollTos } = await mountHold();
    const restoreRects = stubProperty(scroller, "getClientRects", {
      configurable: true,
      value: () => [],
    });
    hold.toBottom("user");
    scroller.scrollTop = 50;
    observer().resized(scroller);
    expect(hold.movingTo()).toBeNull();
    restoreRects();

    Object.defineProperty(scroller, "getClientRects", {
      configurable: true,
      value: () => [new DOMRect(0, 0, 100, 800)],
    });
    observer().resized(scroller);
    expect(scrollTos.at(-1)).toEqual({ top: 1000, behavior: "instant" });
    expect(scroller.scrollTop).toBe(200);
  });
});
