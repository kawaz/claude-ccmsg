// Timeline のスクロールまわりの hook をマウントして、hook ごとの契約を固定する。
// - classifyEndChange: transcript の終わりの動きを、開いた / 初回の読み込み /
//   追記 / 縮んだ / 同じ に分ける
// - useStickToBottom: 開いた時・初回の読み込み・タブの再表示で末尾へ寄せ、
//   追記は最下部付近に居る時だけ追う。いずれも位置を張っていない時だけ。
//   scroller を測るたびに結果を渡し、読み手のスクロール操作を知らせる
// - useUserTurnNav: 開いた時・初回の読み込み・縮んだ時は最後の発話、追記では
//   選んでいる発話を保つ。↑/↓ は端で回ってその発話へスクロールし、クリックは
//   スクロールせずに選ぶ
// - usePositionPin / usePositionLanding: 位置はクリックで選んで (もう一度で
//   外す) URL に書き、外から来た位置には 1 度だけ着地する。最下部に来ても、
//   読み手が自分でスクロールしてきた時だけ位置を外す
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { useRef } from "preact/hooks";
import { act } from "preact/test-utils";
import { timelineHref } from "../src/client/locator.ts";
import type { ScrollHold } from "../src/client/useScrollHold.ts";
import { classifyEndChange } from "../src/client/components/timeline/transcript-end.ts";
import {
  usePositionLanding,
  usePositionPin,
} from "../src/client/components/timeline/usePositionPin.ts";
import { useStickToBottom } from "../src/client/components/timeline/useStickToBottom.ts";
import { useUserTurnNav } from "../src/client/components/timeline/useUserTurnNav.ts";
import { parseTranscriptLine, type TimelineGroup } from "../src/client/transcript-model.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { renderHook, type RenderedHook } from "./render-hook.ts";
import { exchange, SID, uuidOf } from "./timeline-harness.ts";

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

/** 発話だけの group の列 (発話 n は offset n*100)。 */
function userGroups(count: number, first = 1): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  for (let n = first; n < first + count; n++) {
    const [user] = exchange(n);
    if (user === undefined) continue;
    groups.push({ kind: "entry", offset: n * 100, line: parseTranscriptLine(user) });
  }
  return groups;
}

describe("useUserTurnNav", () => {
  interface Props {
    groups: TimelineGroup[];
    end: number;
    agentId?: string;
  }

  async function mountNav(initial: Props) {
    function useProbe({ groups, end, agentId }: Props) {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const nav = useUserTurnNav({
        sid: SID,
        agent: agentId === undefined ? null : { agentId },
        groups,
        end,
        scrollRef,
      });
      return { nav, scrollRef };
    }
    const hook = track(
      await renderHook(useProbe, initial, {
        extra: ({ nav, scrollRef }) =>
          h(
            "div",
            { class: "scroller", ref: scrollRef },
            nav.keys.map((key) =>
              h("div", {
                key,
                class: `turn ${key}`,
                ref: (el: HTMLElement | null) => nav.registerUserTurnRef(key, el),
              }),
            ),
          ),
      }),
    );
    const scroller = instanceOf(document.querySelector(".scroller"), HTMLElement, "scroller");
    return { hook, scroller };
  }

  function counter(hook: RenderedHook<Props, { nav: ReturnType<typeof useUserTurnNav> }>) {
    const { nav } = hook.current();
    return `${nav.currentIndex}/${nav.keys.length}`;
  }

  test("starts at the last turn, and at 0 when there is none", async () => {
    const { hook } = await mountNav({ groups: userGroups(3), end: 300 });
    expect(counter(hook)).toBe("3/3");
    const empty = await mountNav({ groups: [], end: 0 });
    expect(counter(empty.hook)).toBe("0/0");
  });

  test("the first load and a shrink select the last turn; an append keeps the selected one", async () => {
    const { hook } = await mountNav({ groups: [], end: 0 });
    await hook.rerender({ groups: userGroups(3), end: 300 });
    expect(counter(hook)).toBe("3/3");

    await act(() => hook.current().nav.goPrev());
    expect(counter(hook)).toBe("2/3");
    await hook.rerender({ groups: userGroups(4), end: 400 });
    expect(counter(hook)).toBe("2/4");
    // older を前に足しても (end は動かない) 同じ発話を指したまま番号が付け直る。
    await hook.rerender({ groups: [...userGroups(1, 0), ...userGroups(4)], end: 400 });
    expect(counter(hook)).toBe("3/5");

    await hook.rerender({ groups: userGroups(2), end: 200 });
    expect(counter(hook)).toBe("2/2");
  });

  test("↑ / ↓ wrap around and scroll the scroller to the chosen turn", async () => {
    const { hook, scroller } = await mountNav({ groups: userGroups(3), end: 300 });
    const tops: number[] = [];
    scroller.scrollTo = (options?: ScrollToOptions | number) => {
      if (typeof options === "object") tops.push(options.top ?? -1);
    };
    for (const [i, el] of [...scroller.querySelectorAll<HTMLElement>(".turn")].entries()) {
      el.getBoundingClientRect = () => new DOMRect(0, (i + 1) * 100, 10, 10);
    }
    await act(() => hook.current().nav.goNext());
    expect(counter(hook)).toBe("1/3");
    expect(tops).toEqual([100]);
    await act(() => hook.current().nav.goPrev());
    expect(counter(hook)).toBe("3/3");
    expect(tops).toEqual([100, 300]);
    expect(hook.current().nav.selectedKey).toBe(hook.current().nav.keys[2]);
  });

  test("a click selects a turn without scrolling; a key not on the page is ignored", async () => {
    const { hook } = await mountNav({ groups: userGroups(3), end: 300 });
    expect(hook.current().nav.selectedKey).toBeUndefined();
    const first = hook.current().nav.keys[0] ?? "";
    await act(() => hook.current().nav.onUserTurnClick(first));
    expect(counter(hook)).toBe("1/3");
    expect(hook.current().nav.selectedKey).toBe(first);
    await act(() => hook.current().nav.onUserTurnClick("user:999999"));
    expect(counter(hook)).toBe("1/3");
  });

  test("switching agents drops the highlight of the selected turn", async () => {
    const { hook } = await mountNav({ groups: userGroups(2), end: 200, agentId: "a" });
    await act(() => hook.current().nav.onUserTurnClick(hook.current().nav.keys[0] ?? ""));
    expect(hook.current().nav.selectedKey).toBeDefined();
    await hook.rerender({ groups: userGroups(2), end: 200, agentId: "b" });
    expect(hook.current().nav.selectedKey).toBeUndefined();
  });
});

describe("usePositionPin and usePositionLanding", () => {
  interface Props {
    position: string;
    status: "loading" | "loaded";
    parsedVersion: number;
    agentActive?: boolean;
  }

  const UUIDS = [uuidOf("u", 1), uuidOf("u", 2)];

  async function mountPin(initial: Props) {
    const { hold, calls } = recordingHold();
    const parsedBy = new Map<number, readonly never[]>();
    function useProbe({ position, status, parsedVersion, agentActive }: Props) {
      const scrollRef = useRef<HTMLDivElement | null>(null);
      const pin = usePositionPin({
        sid: SID,
        currentPosition: position,
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
