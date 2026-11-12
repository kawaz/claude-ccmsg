// Timeline のスクロールまわりの hook をマウントして、hook ごとの契約を固定する。
// - classifyEndChange: transcript の終わりの動きを、開いた / 初回の読み込み /
//   追記 / 縮んだ / 同じ に分ける
// - useStickToBottom: 開いた時・初回の読み込み・タブの再表示で末尾へ寄せ、
//   追記は最下部付近に居る時だけ追う。いずれも位置を張っていない時だけ。
//   scroller を測るたびに結果を渡し、読み手のスクロール操作を知らせる
// - usePositionPin / usePositionLanding: 位置はクリックで選んで (もう一度で
//   外す) URL に書き、外から来た位置には 1 度だけ着地する。最下部に来ても、
//   読み手が自分でスクロールしてきた時だけ位置を外す
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { timelineHref, type TimelineFilter } from "../src/client/locator.ts";
import type { ScrollHold } from "../src/client/useScrollHold.ts";
import { classifyEndChange } from "../src/client/components/timeline/transcript-end.ts";
import {
  usePositionLanding,
  usePositionPin,
} from "../src/client/components/timeline/usePositionPin.ts";
import { useStickToBottom } from "../src/client/components/timeline/useStickToBottom.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { renderHook, type RenderedHook } from "./render-hook.ts";
import { SID, uuidOf } from "./timeline-harness.ts";

withDom();

let unmounts: Array<() => Promise<void>> = [];
let restores: Array<() => void> = [];
let navigations: string[] = [];

beforeEach(() => {
  navigations = [];
  restores = [
    stubGlobal("navigation", {
      navigate(url: string) {
        navigations.push(url);
      },
    }),
    stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
    })),
  ];
});

afterEach(async () => {
  for (const unmount of unmounts) await unmount();
  unmounts = [];
  for (const restore of restores.reverse()) restore();
});

function track<P, R>(hook: RenderedHook<P, R>): RenderedHook<P, R> {
  unmounts.push(hook.unmount);
  return hook;
}

/** 呼ばれた順に寄せ先を記録する ScrollHold。 */
function recordingHold(): { hold: ScrollHold; calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    hold: {
      toBottom: () => calls.push("bottom"),
      toTop: () => calls.push("top"),
      toElement: (target, place) => {
        calls.push(`element:${target.dataset.timelineUuid ?? target.className}`);
        const scroller = target.closest(".scroller");
        if (scroller instanceof HTMLElement) place(scroller, target);
      },
      release: () => calls.push("release"),
    },
  };
}

/** 高さを決め打ちにした scroller (happy-dom はレイアウトしない)。 */
function setGeometry(el: HTMLElement, geometry: { scrollHeight: number; clientHeight: number }) {
  Object.defineProperty(el, "scrollHeight", { configurable: true, value: geometry.scrollHeight });
  Object.defineProperty(el, "clientHeight", { configurable: true, value: geometry.clientHeight });
}

describe("classifyEndChange", () => {
  test("tells entering, the first load, an append, a shrink and no change apart", () => {
    expect(classifyEndChange(null, "s", 0)).toBe("entered");
    expect(classifyEndChange({ sid: "other", end: 10 }, "s", 10)).toBe("entered");
    expect(classifyEndChange({ sid: "s", end: 0 }, "s", 10)).toBe("initial-load");
    expect(classifyEndChange({ sid: "s", end: 10 }, "s", 20)).toBe("appended");
    expect(classifyEndChange({ sid: "s", end: 20 }, "s", 10)).toBe("shrank");
    expect(classifyEndChange({ sid: "s", end: 10 }, "s", 10)).toBe("unchanged");
  });
});

describe("useStickToBottom", () => {
  interface Props {
    end: number;
    atHead: boolean;
    visible: boolean;
    content: number;
  }

  async function mountStick(initial: Partial<Props> = {}) {
    const { hold, calls } = recordingHold();
    const measured: boolean[] = [];
    let intents = 0;
    // Timeline が渡すのと同じく、render をまたいで同じ関数。
    const onScrollMeasured = (_scroller: HTMLElement, nearBottom: boolean) => {
      measured.push(nearBottom);
    };
    const onUserScrollIntent = () => {
      intents += 1;
    };
    function useProbe(props: Props) {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const stick = useStickToBottom({
        sid: SID,
        ...props,
        scrollRef,
        scrollHold: hold,
        onScrollMeasured,
        onUserScrollIntent,
      });
      return { stick, scrollRef };
    }
    const hook = track(
      await renderHook(
        useProbe,
        { end: 0, atHead: true, visible: true, content: 0, ...initial },
        { extra: ({ scrollRef }) => h("div", { class: "scroller", ref: scrollRef }) },
      ),
    );
    const scroller = instanceOf(document.querySelector(".scroller"), HTMLElement, "scroller");
    return { hook, calls, measured, scroller, intents: () => intents };
  }

  /** 読み手が上へスクロールして、そこで測られた状態にする。 */
  async function scrollUp(scroller: HTMLElement): Promise<void> {
    setGeometry(scroller, { scrollHeight: 1000, clientHeight: 200 });
    await act(async () => {
      scroller.dispatchEvent(new Event("wheel"));
      scroller.scrollTop = 0;
      scroller.dispatchEvent(new Event("scroll"));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    });
  }

  test("opening at the head goes to the bottom; opening at a position does not", async () => {
    const atHead = await mountStick();
    expect(atHead.calls).toEqual(["bottom"]);
    const pinned = await mountStick({ atHead: false });
    expect(pinned.calls).toEqual([]);
  });

  test("the first load goes to the bottom even when the reader is not near it", async () => {
    const { hook, calls, scroller } = await mountStick();
    await scrollUp(scroller);
    calls.length = 0;
    await hook.rerender({ end: 500, atHead: true, visible: true, content: 1 });
    expect(calls).toEqual(["bottom"]);
  });

  test("an append follows only a reader near the bottom", async () => {
    const { hook, calls, scroller } = await mountStick({ end: 100 });
    setGeometry(scroller, { scrollHeight: 1000, clientHeight: 200 });
    scroller.scrollTop = 800;
    calls.length = 0;
    await hook.rerender({ end: 200, atHead: true, visible: true, content: 1 });
    expect(calls).toEqual(["bottom"]);

    await scrollUp(scroller);
    calls.length = 0;
    await hook.rerender({ end: 300, atHead: true, visible: true, content: 2 });
    expect(calls).toEqual([]);

    await act(() => hook.current().stick.resumeFollowing());
    expect(calls).toEqual(["bottom"]);
    calls.length = 0;
    // 読み直しの後は、測り直しが来るまで最下部扱いで追う。
    await hook.rerender({ end: 400, atHead: true, visible: true, content: 2 });
    expect(calls).toEqual(["bottom"]);
  });

  test("an append does not move a reader at a position", async () => {
    const { hook, calls } = await mountStick({ end: 100, atHead: false });
    await hook.rerender({ end: 200, atHead: false, visible: true, content: 1 });
    expect(calls).toEqual([]);
  });

  test("becoming visible again goes to the bottom at the head", async () => {
    const { hook, calls } = await mountStick({ end: 100 });
    await hook.rerender({ end: 100, atHead: true, visible: false, content: 0 });
    calls.length = 0;
    await hook.rerender({ end: 100, atHead: true, visible: true, content: 0 });
    expect(calls).toEqual(["bottom"]);
  });

  test("a scroll is measured and reported, and the reader's own scrolling is passed on", async () => {
    const { hook, measured, scroller, intents } = await mountStick();
    expect(measured).toEqual([]);
    await scrollUp(scroller);
    expect(measured).toEqual([false]);
    expect(intents()).toBe(1);
    // 内容が変わっても読み手は動いていないので、測らない。
    scroller.scrollTop = 800;
    await hook.rerender({ end: 0, atHead: true, visible: true, content: 1 });
    expect(measured).toEqual([false]);
  });
});

describe("usePositionPin and usePositionLanding", () => {
  interface Props {
    position: string;
    status: "loading" | "loaded";
    parsedVersion: number;
    agentActive?: boolean;
    filter?: TimelineFilter | null;
  }

  const UUIDS = [uuidOf("u", 1), uuidOf("u", 2)];

  async function mountPin(initial: Props) {
    const { hold, calls } = recordingHold();
    const parsedBy = new Map<number, readonly never[]>();
    function useProbe({ position, status, parsedVersion, agentActive, filter }: Props) {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const pin = usePositionPin({
        sid: SID,
        currentPosition: position,
        currentFilter: filter ?? null,
        agentActive: agentActive ?? false,
      });
      let parsed = parsedBy.get(parsedVersion);
      if (parsed === undefined) {
        parsed = [];
        parsedBy.set(parsedVersion, parsed);
      }
      usePositionLanding({
        sid: SID,
        currentPosition: position,
        currentFilter: filter ?? null,
        timelineStatus: status,
        parsed,
        scrollRef,
        scrollHold: hold,
        tracker: pin.tracker,
      });
      return { pin, scrollRef };
    }
    const hook = track(
      await renderHook(useProbe, initial, {
        extra: ({ scrollRef }) =>
          h(
            "div",
            { class: "scroller", ref: scrollRef },
            UUIDS.map((uuid) => h("div", { key: uuid, "data-timeline-uuid": uuid })),
          ),
      }),
    );
    const scroller = instanceOf(document.querySelector(".scroller"), HTMLElement, "scroller");
    return { hook, calls, scroller };
  }

  test("a position from outside lands once, and again only after going back to the head", async () => {
    const target = UUIDS[1] ?? "";
    const { hook, calls } = await mountPin({
      position: target,
      status: "loaded",
      parsedVersion: 0,
    });
    expect(calls).toEqual([`element:${target}`]);
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 1 });
    expect(calls).toEqual([`element:${target}`]);

    await hook.rerender({ position: "head", status: "loaded", parsedVersion: 1 });
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 1 });
    expect(calls).toEqual([`element:${target}`, `element:${target}`]);
  });

  test("nothing lands before the transcript is loaded; a position not loaded falls back to the head", async () => {
    const { hook, calls } = await mountPin({
      position: uuidOf("u", 9),
      status: "loading",
      parsedVersion: 0,
    });
    expect(calls).toEqual([]);
    expect(navigations).toEqual([]);
    await hook.rerender({ position: uuidOf("u", 9), status: "loaded", parsedVersion: 0 });
    expect(navigations).toEqual([timelineHref(SID)]);
  });

  test("a click selects without landing, and clicking the selected one clears it", async () => {
    const target = UUIDS[0] ?? "";
    const { hook, calls } = await mountPin({
      position: "head",
      status: "loaded",
      parsedVersion: 0,
    });
    await act(() => hook.current().pin.selectPosition(target));
    expect(navigations).toEqual([timelineHref(SID, target)]);
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0 });
    expect(calls).toEqual([]);
    await act(() => hook.current().pin.selectPosition(target));
    expect(navigations.at(-1)).toBe(timelineHref(SID));
  });

  // DR-0050 §4: the filter is the URL's query beside the position, and no
  // write of the position may drop it.
  test("selecting, clearing and returning to the head keep the filter", async () => {
    const target = UUIDS[0] ?? "";
    const { hook, scroller } = await mountPin({
      position: "head",
      status: "loaded",
      parsedVersion: 0,
      filter: "say",
    });
    await act(() => hook.current().pin.selectPosition(target));
    expect(navigations).toEqual([timelineHref(SID, target, "say")]);
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0, filter: "say" });
    await act(() => hook.current().pin.selectPosition(target));
    expect(navigations.at(-1)).toBe(timelineHref(SID, "head", "say"));
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0, filter: "say" });
    hook.current().pin.onUserScrollIntent();
    hook.current().pin.onScrollMeasured(scroller, true);
    expect(navigations.at(-1)).toBe(timelineHref(SID, "head", "say"));
    await hook.rerender({
      position: uuidOf("u", 9),
      status: "loaded",
      parsedVersion: 0,
      filter: "permit",
    });
    expect(navigations.at(-1)).toBe(timelineHref(SID, "head", "permit"));
  });

  // The 🔐 filter's 「TL に移動」 (DR-0050 §6): the filter comes off and the
  // position is landed on as if arrived at from outside, the one already
  // selected under the filter included. Taking the filter off at that
  // position otherwise (「TL に戻る」, the badge) does not land.
  test("landOn takes the filter off and lands, even on the position already selected", async () => {
    const target = UUIDS[1] ?? "";
    const { hook, calls } = await mountPin({
      position: "head",
      status: "loaded",
      parsedVersion: 0,
      filter: "permit",
    });
    await act(() => hook.current().pin.selectPosition(target));
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0, filter: "permit" });
    expect(calls).toEqual([]);

    await act(() => hook.current().pin.landOn(target));
    expect(navigations.at(-1)).toBe(timelineHref(SID, target));
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0, filter: null });
    expect(calls).toEqual([`element:${target}`]);
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 1, filter: null });
    expect(calls).toEqual([`element:${target}`]);
  });

  test("taking the filter off at the selected position does not land on it", async () => {
    const target = UUIDS[1] ?? "";
    const { hook, calls } = await mountPin({
      position: "head",
      status: "loaded",
      parsedVersion: 0,
      filter: "permit",
    });
    await act(() => hook.current().pin.selectPosition(target));
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0, filter: "permit" });
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0, filter: null });
    expect(calls).toEqual([]);
  });

  // Pressing the bar is a mousedown on the scroller, which counts as the
  // reader's own scrolling; the bottom measured after the filter came off and
  // before the landing must not take the position the bar moved to away.
  test("the press before landOn does not count: the bottom measured before landing keeps the position", async () => {
    const target = UUIDS[0] ?? "";
    const { hook, scroller } = await mountPin({
      position: "head",
      status: "loading",
      parsedVersion: 0,
      filter: "permit",
    });
    hook.current().pin.onUserScrollIntent();
    await act(() => hook.current().pin.landOn(target));
    await hook.rerender({ position: target, status: "loading", parsedVersion: 0, filter: null });
    hook.current().pin.onScrollMeasured(scroller, true);
    expect(navigations).toEqual([timelineHref(SID, target)]);
  });

  test("landOn from the head lands on the position it moves to", async () => {
    const target = UUIDS[0] ?? "";
    const { hook, calls } = await mountPin({
      position: "head",
      status: "loaded",
      parsedVersion: 0,
      filter: "permit",
    });
    await act(() => hook.current().pin.landOn(target));
    expect(navigations).toEqual([timelineHref(SID, target)]);
    await hook.rerender({ position: target, status: "loaded", parsedVersion: 0, filter: null });
    expect(calls).toEqual([`element:${target}`]);
  });

  test("an agent Timeline does not select positions", async () => {
    const { hook } = await mountPin({
      position: "head",
      status: "loaded",
      parsedVersion: 0,
      agentActive: true,
    });
    await act(() => hook.current().pin.selectPosition(UUIDS[0] ?? ""));
    expect(navigations).toEqual([]);
  });

  test("at the bottom the position is dropped only after the reader scrolled there", async () => {
    const target = UUIDS[0] ?? "";
    const { hook, scroller } = await mountPin({
      position: target,
      status: "loaded",
      parsedVersion: 0,
    });
    hook.current().pin.onScrollMeasured(scroller, true);
    expect(navigations).toEqual([]);
    hook.current().pin.onUserScrollIntent();
    hook.current().pin.onScrollMeasured(scroller, true);
    expect(navigations).toEqual([timelineHref(SID)]);
  });

  test("scrolling done before going back to the head does not drop a position arrived at later", async () => {
    const target = UUIDS[0] ?? "";
    const { hook, scroller } = await mountPin({
      position: target,
      status: "loaded",
      parsedVersion: 0,
    });
    hook.current().pin.onUserScrollIntent();
    await hook.rerender({ position: "head", status: "loaded", parsedVersion: 0 });
    // 戻ってきた位置へ着地する前 (読み込み中) に、スクロール位置の復元で
    // 最下部が測られる。
    await hook.rerender({ position: target, status: "loading", parsedVersion: 0 });
    hook.current().pin.onScrollMeasured(scroller, true);
    expect(navigations).toEqual([]);
  });
});
