// The scroll position across the Timeline's filter (DR-0050 §6, §9 U5 / U6),
// with a fake layout (happy-dom lays nothing out): each item has a top in the
// content, the scroller shows it at `top - scrollTop`.
// - entering a filter at the head holds the bottom; with a position selected
//   it leaves the landing to the position
// - taking the filter off keeps the selected bubble at the distance from the
//   scroller's top it had just before: scrollTop moves by exactly how much the
//   rows coming back above it grew, and keeps doing so as content grows later
// - with nothing selected: at the bottom it stays at the bottom, otherwise the
//   topmost bubble on screen is kept still the same way
// - the distance is measured on the navigation's eve (BEFORE_NAVIGATION_EVENT),
//   so a back / forward that drops the filter is covered too
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { useFilterScroll } from "../src/client/components/timeline/useFilterScroll.ts";
import type { TimelineFilter } from "../src/client/locator.ts";
import { BEFORE_NAVIGATION_EVENT } from "../src/client/navigation.ts";
import type { ScrollHold } from "../src/client/useScrollHold.ts";
import { instanceOf } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { renderHook, type RenderedHook } from "./render-hook.ts";

withDom();

let unmounts: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
});

interface Props {
  filter: TimelineFilter | null;
  position: string;
}

/** 寄せ方を覚えて呼ぶ ScrollHold。`reapply` は内容が伸びた時の
 * ResizeObserver の呼び直しの代わり。 */
function fakeHold(scroller: () => HTMLElement): {
  hold: ScrollHold;
  calls: string[];
  reapply: () => void;
} {
  const calls: string[] = [];
  let place: (() => void) | null = null;
  return {
    calls,
    reapply: () => place?.(),
    hold: {
      toBottom: () => {
        calls.push("bottom");
        place = null;
      },
      toElement: (target, how) => {
        calls.push(`element:${target.dataset.timelineUuid ?? ""}`);
        place = () => how(scroller(), target);
        place();
      },
      release: () => {
        place = null;
      },
    },
  };
}

/** 項目ごとの内容の中の上端と、描かれているか。 */
interface Layout {
  tops: Map<string, number>;
  hidden: Set<string>;
  scrollHeight: number;
}

async function mountScroll(initial: Props, layout: Layout) {
  let scrollerEl: HTMLElement | null = null;
  const { hold, calls, reapply } = fakeHold(() => instanceOf(scrollerEl, HTMLElement, "scroller"));
  function useProbe(props: Props) {
    const scrollRef = useRef<HTMLDivElement | null>(null);
    useFilterScroll({ ...props, scrollRef, scrollHold: hold });
    return { scrollRef };
  }
  const ids = [...layout.tops.keys()];
  const hook: RenderedHook<Props, { scrollRef: { current: HTMLDivElement | null } }> =
    await renderHook(useProbe, initial, {
      extra: ({ scrollRef }) =>
        h(
          "div",
          { class: "scroller", ref: scrollRef },
          ids.map((id) => h("div", { key: id, "data-timeline-uuid": id, "data-notif": "say" })),
        ),
    });
  unmounts.push(hook.unmount);
  scrollerEl = instanceOf(document.querySelector(".scroller"), HTMLElement, "scroller");
  const scroller = scrollerEl;
  let scrollTop = 0;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    get: () => scrollTop,
    set: (value: number) => {
      scrollTop = value;
    },
  });
  Object.defineProperty(scroller, "clientHeight", { configurable: true, value: 500 });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => layout.scrollHeight,
  });
  scroller.getBoundingClientRect = () => new DOMRect(0, 0, 100, 500);
  for (const el of scroller.querySelectorAll<HTMLElement>("[data-timeline-uuid]")) {
    const id = el.dataset.timelineUuid ?? "";
    const rect = () => new DOMRect(0, (layout.tops.get(id) ?? 0) - scrollTop, 100, 40);
    el.getBoundingClientRect = rect;
    el.getClientRects = () => {
      const list: DOMRect[] = layout.hidden.has(id) ? [] : [rect()];
      return Object.assign(list, { item: (i: number) => list[i] ?? null });
    };
  }
  return {
    hook,
    calls,
    reapply,
    scroller,
    offsetOf: (id: string) => (layout.tops.get(id) ?? 0) - scrollTop,
  };
}

function navigateSoon(): void {
  window.dispatchEvent(new Event(BEFORE_NAVIGATION_EVENT));
}

describe("useFilterScroll", () => {
  test("entering a filter at the head holds the bottom; with a position it does not", async () => {
    const layout: Layout = { tops: new Map([["a", 0]]), hidden: new Set(), scrollHeight: 2000 };
    const { hook, calls } = await mountScroll({ filter: null, position: "head" }, layout);
    await hook.rerender({ filter: "say", position: "head" });
    expect(calls).toEqual(["bottom"]);
    await hook.rerender({ filter: null, position: "a" });
    await hook.rerender({ filter: "permit", position: "a" });
    expect(calls).toEqual(["bottom"]);
  });

  test("taking the filter off keeps the selected bubble at the same distance from the top", async () => {
    // フィルタ中: 選んだ say "s2" は内容の 300、scroller の上端から 180 に居る。
    const layout: Layout = {
      tops: new Map([
        ["s1", 100],
        ["s2", 300],
      ]),
      hidden: new Set(),
      scrollHeight: 900,
    };
    const { hook, calls, reapply, scroller, offsetOf } = await mountScroll(
      { filter: "say", position: "s2" },
      layout,
    );
    scroller.scrollTop = 120;
    expect(offsetOf("s2")).toBe(180);
    navigateSoon();
    // 外すと上に隠れていた行が戻り、s2 は内容の 1,700 へ下がる。
    layout.tops.set("s1", 900);
    layout.tops.set("s2", 1700);
    layout.scrollHeight = 5000;
    await act(() => hook.rerender({ filter: null, position: "s2" }));
    expect(calls).toEqual(["element:s2"]);
    // 補正量は上に戻った分 (1,700 - 300 = 1,400) と同じ。
    expect(scroller.scrollTop).toBe(120 + 1400);
    expect(offsetOf("s2")).toBe(180);
    // 戻った行の markdown などが後から伸びても、同じ距離を保つ。
    layout.tops.set("s2", 1760);
    reapply();
    expect(scroller.scrollTop).toBe(120 + 1460);
    expect(offsetOf("s2")).toBe(180);
  });

  test("with nothing selected, at the bottom it stays at the bottom", async () => {
    const layout: Layout = { tops: new Map([["s1", 100]]), hidden: new Set(), scrollHeight: 600 };
    const { hook, calls, scroller } = await mountScroll(
      { filter: "say", position: "head" },
      layout,
    );
    scroller.scrollTop = 100;
    calls.length = 0;
    navigateSoon();
    await hook.rerender({ filter: null, position: "head" });
    expect(calls).toEqual(["bottom"]);
  });

  test("with nothing selected and not at the bottom, the topmost bubble on screen stays still", async () => {
    // "s1" は画面の上に抜けている (下端 = 140 - 200 + 40 < 0)。"s2" が一番上に見える。
    const layout: Layout = {
      tops: new Map([
        ["s1", 140],
        ["s2", 400],
        ["s3", 900],
      ]),
      hidden: new Set(),
      scrollHeight: 3000,
    };
    const { hook, calls, scroller, offsetOf } = await mountScroll(
      { filter: "say", position: "head" },
      layout,
    );
    scroller.scrollTop = 200;
    calls.length = 0;
    navigateSoon();
    layout.tops.set("s2", 1000);
    await hook.rerender({ filter: null, position: "head" });
    expect(calls).toEqual(["element:s2"]);
    expect(offsetOf("s2")).toBe(200);
  });

  test("a selected bubble the filter hides is not the anchor", async () => {
    const layout: Layout = {
      tops: new Map([
        ["u1", 50],
        ["s1", 300],
      ]),
      hidden: new Set(["u1"]),
      scrollHeight: 3000,
    };
    const { hook, calls, scroller } = await mountScroll({ filter: "say", position: "u1" }, layout);
    scroller.scrollTop = 100;
    navigateSoon();
    await hook.rerender({ filter: null, position: "u1" });
    expect(calls).toEqual(["element:s1"]);
  });

  test("without a navigation's eve to measure on, nothing is moved", async () => {
    const layout: Layout = { tops: new Map([["s1", 100]]), hidden: new Set(), scrollHeight: 3000 };
    const { hook, calls } = await mountScroll({ filter: "say", position: "s1" }, layout);
    await hook.rerender({ filter: null, position: "s1" });
    expect(calls).toEqual([]);
  });
});
