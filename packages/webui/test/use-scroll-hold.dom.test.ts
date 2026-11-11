// useScrollHold を scroller ごとマウントして、保つ位置を書き直すきっかけを固定する。
// - scroller の高さ (scrollHeight) を決めるのは子の全部なので、行の列だけで
//   なく、その下に並ぶもの (TL の下のパネル) が後から伸びても末尾を保つ。これが
//   漏れると、フィルタを外す直前に末尾から数 px ずれていて、末尾を見ていた読み
//   手が末尾に戻らなかった (DR-0050 §6)
// - 後から入った子も見る。外れた子は見なくなる。子の入れ替わりの時にも書き直す
// - 手放すと書き直さない
// happy-dom はレイアウトせず ResizeObserver も呼ばないので、見ている要素を記録
// する ResizeObserver に差し替え、ブラウザが呼ぶ所でテストが呼ぶ。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { useScrollHold, type ScrollHold } from "../src/client/useScrollHold.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
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

beforeEach(() => {
  RecordingResizeObserver.all = [];
  restores = [stubGlobal("ResizeObserver", RecordingResizeObserver)];
});

afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
  for (const restore of restores.reverse()) restore();
});

/** Timeline と同じ並び: ツールバー、行の列、下のパネル。scrollTop は
 * scrollHeight - clientHeight で頭打ちにする (ブラウザと同じ)。 */
async function mountHold(): Promise<{
  hold: ScrollHold;
  scroller: HTMLElement;
  setScrollHeight: (value: number) => void;
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
  return {
    hold: hook.current().hold,
    scroller,
    setScrollHeight: (value) => {
      scrollHeight = value;
    },
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
