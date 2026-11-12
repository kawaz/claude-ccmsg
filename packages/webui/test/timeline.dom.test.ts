// Timeline をマウントして、外から観測できる振る舞いを DOM・送った要求・URL
// の書き換えで固定する。対象は Timeline の本体が束ねている関心ごと:
// - transcript の読み込み (初回・接続待ち・再訪・過去分・再試行・tail のずれ)
// - live tail の購読と fork 地点の問い合わせ
// - 末尾追従 (初回・追記・遡って読んでいる時・タブの再表示)
// - 位置 (`/timeline/<uuid>`) への着地・クリックでの選択・最下部での解除
// - in-view 検索、auto open、側面パネル
// happy-dom はレイアウトをしないので、scroller (`.timeline-view`) の高さは
// 項目数から決まるように差し替える (1 項目 100px、表示領域 200px)。
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef } from "../src/client/locator.ts";
import { timelineHref } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { timelineAutoOpenStorageKey } from "../src/client/timeline-auto-open.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { defined, instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import {
  endOf,
  exchange,
  FakeTranscriptWs,
  Mounted,
  page,
  SID,
  timelineStore,
  uuidOf,
} from "./timeline-harness.ts";

withDom();

const ITEM_PX = 100;
const VIEWPORT_PX = 200;

/** scroller の scrollTo の呼び出し (位置への着地・最上部へが使う)。 */
let scrollTos: number[] = [];
let navigations: Array<{ url: string; history: string | undefined }> = [];
let restores: Array<() => void> = [];
/** HTMLElement.prototype の差し替えを戻す (戻す先は差し替えた時に掴んだ
 * prototype なので、DOM が外れた後の afterAll でも戻せる)。 */
let layoutRestores: Array<() => void> = [];
const mounted = new Mounted();

function isScroller(el: HTMLElement): boolean {
  return el.classList.contains("timeline-view");
}

beforeAll(() => {
  const proto = HTMLElement.prototype;
  layoutRestores = [
    stubProperty(proto, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this)
          ? this.querySelectorAll("[data-timeline-uuid]").length * ITEM_PX
          : 0;
      },
    }),
    stubProperty(proto, "clientHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return isScroller(this) ? VIEWPORT_PX : 0;
      },
    }),
    stubProperty(proto, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        if (isScroller(this)) scrollTos.push(options.top ?? 0);
        this.scrollTop = options.top ?? this.scrollTop;
      },
    }),
  ];
});

afterAll(() => {
  for (const restore of layoutRestores.reverse()) restore();
  layoutRestores = [];
});

beforeEach(() => {
  scrollTos = [];
  navigations = [];
  localStorage.clear();
  restores = [
    stubGlobal("navigation", {
      navigate(url: string, options: { history?: string }) {
        navigations.push({ url, history: options.history });
      },
    }),
  ];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

/** SessionView と同じく、store の sid の木から Timeline に渡す。 */
function TimelineOf({
  agent,
  active,
  visible,
}: {
  agent?: AgentRef;
  active: boolean;
  visible: boolean;
}) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent: agent ?? null,
    active,
    visible,
  });
}

const ACTIVE = { active: true, visible: true };

interface View {
  store: Store;
  ws: FakeTranscriptWs;
  root: HTMLElement;
  rerender(props: { active?: boolean; visible?: boolean }): Promise<void>;
}

async function open(
  options: { position?: string; agent?: AgentRef; connected?: boolean } = {},
): Promise<View> {
  const store = timelineStore(options);
  const ws = new FakeTranscriptWs(store);
  const props = { agent: options.agent, active: true, visible: true };
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, props));
  return {
    store,
    ws,
    root,
    rerender: (next) => mounted.rerender(store, ws.handle, h(TimelineOf, { ...props, ...next })),
  };
}

/** 開いて、初回の読み込みに `lines` を返した状態。 */
async function openLoaded(
  lines: readonly string[],
  options: { position?: string; agent?: AgentRef } = {},
): Promise<View> {
  const view = await open(options);
  await view.ws.lastRead().answer(page(lines));
  return view;
}

function threeExchanges(): string[] {
  return [...exchange(1), ...exchange(2), ...exchange(3)];
}

function scroller(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".timeline-view"), HTMLElement, "scroller");
}

function element(root: HTMLElement, selector: string): HTMLElement {
  return instanceOf(root.querySelector(selector), HTMLElement, selector);
}

function buttonTitled(root: HTMLElement, title: string): HTMLButtonElement {
  return instanceOf(
    root.querySelector(`button[title="${title}"]`),
    HTMLButtonElement,
    `button "${title}"`,
  );
}

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return element(root, `[data-timeline-uuid="${uuid}"]`);
}

/** live tail の push を store に流す (ws.ts が ev:"transcript" から作るのと同じ)。 */
async function tail(store: Store, lines: readonly string[], start: number): Promise<void> {
  const end = endOf(lines, start);
  await act(() =>
    store.dispatch({ type: "timeline/tail", sid: SID, lines: [...lines], start, end, size: end }),
  );
}

function loadedEnd(store: Store): number {
  return defined(store.getState().sessionTrees.get(SID), "session tree").timeline.end;
}

/** 読み手自身のスクロール: 入力イベントを出してから位置を動かし、scroll を
 * 通知して、Timeline が rAF で測り終えるまで待つ。 */
async function userScrollTo(root: HTMLElement, top: number): Promise<void> {
  const el = scroller(root);
  await act(async () => {
    el.dispatchEvent(new Event("wheel"));
    el.scrollTop = top;
    el.dispatchEvent(new Event("scroll"));
    await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  });
}

describe("Timeline loading", () => {
  test("waits for the connection, then reads the tail once and shows the rows", async () => {
    const view = await open({ connected: false });
    expect(view.ws.reads).toHaveLength(0);
    expect(view.root.textContent).toContain("読み込み中");

    await act(() => view.store.dispatch({ type: "conn/status", status: "connected" }));
    expect(view.ws.reads).toHaveLength(1);
    expect(view.ws.lastRead().sid).toBe(SID);
    expect(view.ws.lastRead().opts).toBeUndefined();

    await view.ws.lastRead().answer(page(exchange(1)));
    expect(view.root.textContent).toContain("question 1");
    expect(view.root.textContent).toContain("answer 1");
    expect(view.ws.reads).toHaveLength(1);
  });

  test("a session Timeline follows the live tail and asks where its fork history ends", async () => {
    const view = await openLoaded(exchange(1));
    expect(view.ws.subscribes).toEqual([SID]);
    expect(view.ws.forkOrigins).toEqual([SID]);

    await mounted.unmount();
    await act(() => Promise.resolve());
    expect(view.ws.unsubscribes).toEqual([SID]);
  });

  test("an agent Timeline reads that agent's transcript and neither subscribes nor asks for a fork", async () => {
    const agent = { agentId: "agent-1" };
    const view = await openLoaded(exchange(1), { agent });
    expect(view.ws.reads[0]?.opts).toEqual({ agent_id: "agent-1" });
    expect(view.ws.subscribes).toEqual([]);
    expect(view.ws.forkOrigins).toEqual([]);
    expect(view.root.textContent).toContain("agent: agent-1");
  });

  test("an inactive Timeline reads nothing until it becomes active", async () => {
    const store = timelineStore();
    const ws = new FakeTranscriptWs(store);
    const props = { active: false, visible: false };
    await mounted.mount(store, ws.handle, h(TimelineOf, props));
    expect(ws.reads).toHaveLength(0);
    expect(ws.subscribes).toHaveLength(0);

    await mounted.rerender(store, ws.handle, h(TimelineOf, { active: true, visible: true }));
    expect(ws.reads).toHaveLength(1);
    expect(ws.subscribes).toEqual([SID]);
  });

  test("coming back to a cached transcript reads what was appended after it while still showing the cache", async () => {
    const view = await openLoaded(exchange(1));
    const end = loadedEnd(view.store);
    await view.rerender({ active: false, visible: false });
    await view.rerender({ active: true, visible: true });
    expect(view.ws.reads).toHaveLength(2);
    expect(view.ws.lastRead().opts).toEqual({ after: end });
    expect(view.root.textContent).toContain("question 1");
    expect(view.root.textContent).not.toContain("読み込み中");

    await view.ws.lastRead().answer(page(exchange(2), end));
    expect(view.root.textContent).toContain("question 1");
    expect(view.root.textContent).toContain("question 2");
  });

  test("過去分を上に読み込む reads the page before the loaded start and puts it in front", async () => {
    const newer = exchange(2);
    const older = exchange(1);
    const view = await open();
    const olderEnd = endOf(older, 0);
    await view.ws.lastRead().answer(page(newer, olderEnd));

    await act(() => loadOlderButton(view.root, "above").click());
    expect(view.ws.lastRead().opts).toEqual({ before: olderEnd });
    // Both are off while it reads; only the one pressed says so.
    expect(loadOlderButton(view.root, "above").disabled).toBe(true);
    expect(loadOlderButton(view.root, "above").textContent).toBe("読み込み中…");
    expect(loadOlderButton(view.root, "below").disabled).toBe(true);
    expect(loadOlderButton(view.root, "below").textContent).toBe("↓過去分を下に読み込む↓");
    await view.ws.lastRead().answer(page(older, 0));

    const text = view.root.textContent ?? "";
    expect(text.indexOf("question 1")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("question 1")).toBeLessThan(text.indexOf("question 2"));
    expect(view.root.querySelector(".tl-load-older")).toBeNull();
  });

  test("過去分を下に読み込む reads the same page and puts it in front", async () => {
    const newer = exchange(2);
    const older = exchange(1);
    const view = await open();
    await view.ws.lastRead().answer(page(newer, endOf(older, 10)));

    await act(() => loadOlderButton(view.root, "below").click());
    expect(view.ws.lastRead().opts).toEqual({ before: endOf(older, 10) });
    expect(loadOlderButton(view.root, "below").disabled).toBe(true);
    expect(loadOlderButton(view.root, "below").textContent).toBe("読み込み中…");
    expect(loadOlderButton(view.root, "above").disabled).toBe(true);
    expect(loadOlderButton(view.root, "above").textContent).toBe("↑過去分を上に読み込む↑");
    await view.ws.lastRead().answer(page(older, 10));

    const text = view.root.textContent ?? "";
    expect(text.indexOf("question 1")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("question 1")).toBeLessThan(text.indexOf("question 2"));
    // More is left before it: both are back, enabled, with their labels.
    expect(loadOlderButton(view.root, "below").disabled).toBe(false);
    expect(loadOlderButton(view.root, "below").textContent).toBe("↓過去分を下に読み込む↓");
    expect(loadOlderButton(view.root, "above").disabled).toBe(false);
    expect(loadOlderButton(view.root, "above").textContent).toBe("↑過去分を上に読み込む↑");
  });

  test("a transcript read from its first byte has no 過去分を読み込む buttons", async () => {
    const view = await open();
    await view.ws.lastRead().answer(page(exchange(1), 0));
    expect(view.root.querySelector(".tl-load-older")).toBeNull();
    // The rest of the toolbar is still there.
    expect(element(view.root, ".tl-toolbar").querySelectorAll("button").length).toBeGreaterThan(0);
  });

  test("a transcript with more before its loaded start shows the two enabled 過去分を読み込む buttons side by side above the first row, not in the toolbar", async () => {
    const view = await open();
    await view.ws.lastRead().answer(page(exchange(1), 100));
    const buttons = [...element(view.root, ".tl-load-older").querySelectorAll("button")];
    // Left to right: 上に, then 下に.
    expect(buttons.map((b) => b.textContent)).toEqual([
      "↑過去分を上に読み込む↑",
      "↓過去分を下に読み込む↓",
    ]);
    for (const button of buttons) {
      expect(button.disabled).toBe(false);
      // It looks as the filter's 「TL に戻る」 does: the one class both carry.
      expect(button.classList.contains("tl-wide-button")).toBe(true);
    }
    expect(buttonsTitledText(element(view.root, ".tl-toolbar"), "older")).toHaveLength(0);
    for (const label of ["↑過去分を上に読み込む↑", "↓過去分を下に読み込む↓"]) {
      expect(buttonsTitledText(element(view.root, ".tl-toolbar"), label)).toHaveLength(0);
    }
    // The scroller's content: the toolbar, then the buttons, then the rows.
    const children = [...scroller(view.root).children];
    const button = children.indexOf(element(view.root, ".tl-load-older"));
    expect(button).toBe(children.indexOf(element(view.root, ".tl-toolbar")) + 1);
    expect(children.indexOf(element(view.root, ".tl-lines"))).toBe(button + 1);
  });

  test("過去分を上に読み込む keeps the row right below the buttons where it was on screen once the older page is in", async () => {
    const observers = stubRowLayout(0);

    const older = exchange(1);
    const olderEnd = endOf(older, 0);
    const view = await open();
    await view.ws.lastRead().answer(page([...exchange(2), ...exchange(3)], olderEnd));
    // The reader went up to the top, one row scrolled past.
    await userScrollTo(view.root, ITEM_PX / 2);
    const below = itemOf(view.root, uuidOf("u", 2));
    const offset = below.getBoundingClientRect().top;
    expect(offset).toBe(-ITEM_PX / 2);

    await act(() => loadOlderButton(view.root, "above").click());
    await view.ws.lastRead().answer(page(older, 0));
    await act(() => {
      for (const observe of observers) observe();
    });

    expect(itemOf(view.root, uuidOf("u", 1))).toBeDefined();
    expect(itemOf(view.root, uuidOf("u", 2))).toBe(below);
    expect(below.getBoundingClientRect().top).toBe(offset);
    expect(scroller(view.root).scrollTop).toBe(2 * ITEM_PX + ITEM_PX / 2);
  });

  test("過去分を下に読み込む goes to the top, even from a little scrolled past, and the oldest row read comes right below the buttons", async () => {
    // The rows start LINES_TOP below the scroller's top, under the toolbar and
    // the buttons.
    const LINES_TOP = ITEM_PX / 2;
    const observers = stubRowLayout(LINES_TOP);

    const older = exchange(1);
    const view = await open();
    await view.ws.lastRead().answer(page([...exchange(2), ...exchange(3)], endOf(older, 10)));
    // The buttons are on screen, a little scrolled past.
    await userScrollTo(view.root, LINES_TOP / 2);
    const firstBefore = itemOf(view.root, uuidOf("u", 2));

    await act(() => loadOlderButton(view.root, "below").click());
    expect(scroller(view.root).scrollTop).toBe(0);
    await view.ws.lastRead().answer(page(older, 10));
    // A browser's own scroll anchoring would move the view along with the
    // rows that were on screen; the hold puts it back once the content grew.
    scroller(view.root).scrollTop += 2 * ITEM_PX;
    await act(() => {
      for (const observe of observers) observe();
    });

    expect(scroller(view.root).scrollTop).toBe(0);
    expect(loadOlderButton(view.root, "below").disabled).toBe(false);
    expect(itemOf(view.root, uuidOf("u", 1)).getBoundingClientRect().top).toBe(LINES_TOP);
    expect(itemOf(view.root, uuidOf("u", 2))).toBe(firstBefore);
    expect(firstBefore.getBoundingClientRect().top).toBe(LINES_TOP + 2 * ITEM_PX);
  });

  test("過去分を下に読み込む that reaches the transcript's first byte leaves the view at the top with the buttons gone", async () => {
    const observers = stubRowLayout(0);

    const older = exchange(1);
    const view = await open();
    await view.ws.lastRead().answer(page([...exchange(2), ...exchange(3)], endOf(older, 0)));
    await userScrollTo(view.root, ITEM_PX / 2);

    await act(() => loadOlderButton(view.root, "below").click());
    await view.ws.lastRead().answer(page(older, 0));
    scroller(view.root).scrollTop += 2 * ITEM_PX;
    await act(() => {
      for (const observe of observers) observe();
    });

    expect(view.root.querySelector(".tl-load-older")).toBeNull();
    expect(scroller(view.root).scrollTop).toBe(0);
    expect(itemOf(view.root, uuidOf("u", 1)).getBoundingClientRect().top).toBe(0);
  });

  test("a failed read offers a retry that reads the tail again", async () => {
    const view = await open();
    await view.ws.lastRead().answer({ ok: false, error: { code: "io", msg: "boom" } });
    expect(view.root.textContent).toContain("transcript を読み込めませんでした");
    expect(view.root.textContent).toContain("boom");

    await act(() => buttonTitledText(view.root, "再試行 (tail から読み直す)").click());
    expect(view.ws.reads).toHaveLength(2);
    await view.ws.lastRead().answer(page(exchange(1)));
    expect(view.root.textContent).toContain("question 1");
  });

  test("a tail push that does not line up catches up in the background without blanking the rows", async () => {
    const view = await openLoaded(exchange(1));
    const end = loadedEnd(view.store);
    await tail(view.store, exchange(3), end + 10);
    expect(view.ws.reads).toHaveLength(2);
    expect(view.ws.lastRead().opts).toEqual({ after: end });
    expect(view.root.textContent).toContain("question 1");
    expect(view.root.textContent).not.toContain("読み込み中");

    await view.ws.lastRead().answer(page([...exchange(2), ...exchange(3)], end));
    expect(view.root.textContent).toContain("question 1");
    expect(view.root.textContent).toContain("question 3");
  });

  test("a contiguous tail push is appended without a read", async () => {
    const view = await openLoaded(exchange(1));
    await tail(view.store, exchange(2), loadedEnd(view.store));
    expect(view.ws.reads).toHaveLength(1);
    expect(view.root.textContent).toContain("question 2");
  });
});

/** 文言で引くボタン (title を持たないもの)。 */
function buttonsTitledText(root: HTMLElement, text: string): HTMLButtonElement[] {
  return [...root.querySelectorAll("button")].filter(
    (button) => button.textContent?.trim() === text,
  );
}

function loadOlderButton(root: HTMLElement, placement: "above" | "below"): HTMLButtonElement {
  return instanceOf(
    root.querySelector(`.tl-load-older button[data-placement="${placement}"]`),
    HTMLButtonElement,
    `過去分を読み込む (${placement})`,
  );
}

/**
 * happy-dom lays nothing out and has no ResizeObserver that fires: lay the
 * rows (`[data-timeline-uuid]`) out ITEM_PX tall in order from `linesTop`
 * below the scroller's top, with `.tl-lines` at `linesTop`, all moved up by
 * the scroller's scrollTop. Returns the ResizeObserver callbacks, for the
 * test to call where a browser would call them after the content grew.
 */
function stubRowLayout(linesTop: number): Array<() => void> {
  const observers: Array<() => void> = [];
  class FakeResizeObserver {
    private readonly callback: () => void;
    constructor(callback: () => void) {
      this.callback = callback;
    }
    observe(): void {
      observers.push(this.callback);
    }
    unobserve(): void {}
    disconnect(): void {}
  }
  restores.push(stubGlobal("ResizeObserver", FakeResizeObserver));
  const topOf = (el: HTMLElement): number => {
    if (isScroller(el)) return 0;
    const view = el.closest(".timeline-view");
    if (!(view instanceof HTMLElement)) return 0;
    if (el.classList.contains("tl-lines")) return linesTop - view.scrollTop;
    const index = [...view.querySelectorAll<HTMLElement>("[data-timeline-uuid]")].indexOf(el);
    return index >= 0 ? linesTop + index * ITEM_PX - view.scrollTop : 0;
  };
  const proto = HTMLElement.prototype;
  restores.push(
    stubProperty(proto, "getBoundingClientRect", {
      configurable: true,
      value(this: HTMLElement) {
        return new DOMRect(0, topOf(this), 100, ITEM_PX);
      },
    }),
    stubProperty(proto, "getClientRects", {
      configurable: true,
      value(this: HTMLElement) {
        const list = [new DOMRect(0, topOf(this), 100, ITEM_PX)];
        return Object.assign(list, { item: (i: number) => list[i] ?? null });
      },
    }),
  );
  return observers;
}

function buttonTitledText(root: HTMLElement, text: string): HTMLButtonElement {
  return instanceOf(
    buttonsTitledText(root, text)[0] ?? null,
    HTMLButtonElement,
    `button "${text}"`,
  );
}

describe("Timeline follows the bottom", () => {
  test("the first load lands at the bottom", async () => {
    const view = await openLoaded(threeExchanges());
    const el = scroller(view.root);
    expect(el.scrollHeight).toBe(6 * ITEM_PX);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  test("mounting over a cached transcript starts at the bottom", async () => {
    const view = await openLoaded(threeExchanges());
    await mounted.unmount();
    const root = await mounted.mount(view.store, view.ws.handle, h(TimelineOf, ACTIVE));
    const el = scroller(root);
    expect(el.scrollHeight).toBe(6 * ITEM_PX);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  test("an append follows a reader who is at the bottom", async () => {
    const view = await openLoaded(threeExchanges());
    await tail(view.store, exchange(4), loadedEnd(view.store));
    const el = scroller(view.root);
    expect(el.scrollHeight).toBe(8 * ITEM_PX);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  test("an append taller than the near-bottom margin follows a reader who scrolled back to the bottom", async () => {
    const view = await openLoaded(threeExchanges());
    await userScrollTo(view.root, 0);
    await userScrollTo(view.root, 6 * ITEM_PX - VIEWPORT_PX);
    // 2 往復分 (200px) は、最下部付近とみなす余裕 (80px) より高い。
    const end = loadedEnd(view.store);
    await tail(view.store, [...exchange(4), ...exchange(5)], end);
    const el = scroller(view.root);
    expect(el.scrollHeight).toBe(10 * ITEM_PX);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  test("an append leaves a reader who scrolled up where they are", async () => {
    const view = await openLoaded(threeExchanges());
    await userScrollTo(view.root, 0);
    await tail(view.store, exchange(4), loadedEnd(view.store));
    expect(scroller(view.root).scrollTop).toBe(0);
  });

  test("showing the Timeline tab again jumps back to the bottom", async () => {
    const view = await openLoaded(threeExchanges());
    await view.rerender({ visible: false });
    await userScrollTo(view.root, 0);
    await view.rerender({ visible: true });
    const el = scroller(view.root);
    expect(el.scrollTop).toBe(el.scrollHeight);
  });

  test("⤓ jumps to the bottom and ⤒ to the top", async () => {
    const view = await openLoaded(threeExchanges());
    await userScrollTo(view.root, 50);
    await act(() => buttonTitled(view.root, "最下部へ").click());
    expect(scroller(view.root).scrollTop).toBe(6 * ITEM_PX);
    await act(() => buttonTitled(view.root, "最上部へ").click());
    expect(scroller(view.root).scrollTop).toBe(0);
  });
});

describe("Timeline position", () => {
  test("a position URL lands on its row once and later appends do not pull back to it", async () => {
    const view = await openLoaded(threeExchanges(), { position: uuidOf("u", 2) });
    expect(scrollTos).toHaveLength(1);
    expect(itemOf(view.root, uuidOf("u", 2)).classList.contains("tl-position-selected")).toBe(true);

    await tail(view.store, exchange(4), loadedEnd(view.store));
    expect(scrollTos).toHaveLength(1);
    expect(navigations).toEqual([]);
  });

  test("a position outside the loaded rows falls back to the head", async () => {
    await openLoaded(threeExchanges(), { position: uuidOf("u", 9) });
    expect(navigations).toEqual([{ url: timelineHref(SID), history: "replace" }]);
  });

  test("clicking a row selects its position without scrolling, and clicking it again clears it", async () => {
    const view = await openLoaded(threeExchanges());
    const before = scrollTos.length;
    const target = element(itemOf(view.root, uuidOf("a", 2)), ".tl-bubble-body");
    await act(() => target.click());
    expect(navigations).toEqual([{ url: timelineHref(SID, uuidOf("a", 2)), history: "replace" }]);

    // URL の書き換えは navigation が store へ戻すので、ここでは store に直接流す。
    await act(() =>
      view.store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, position: uuidOf("a", 2) },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    // 最下部が見えたままでも、読み手がスクロールしていなければ選択は外れない。
    expect(scrollTos.length).toBe(before);
    expect(navigations).toHaveLength(1);

    await act(() => element(itemOf(view.root, uuidOf("a", 2)), ".tl-bubble-body").click());
    expect(navigations.at(-1)).toEqual({ url: timelineHref(SID), history: "replace" });
  });

  test("coming back to a position by 戻る lands on it and keeps it, even after wheeling at the bottom before leaving", async () => {
    const view = await openLoaded(threeExchanges());
    const target = uuidOf("a", 3);
    await act(() => element(itemOf(view.root, target), ".tl-bubble-body").click());
    await act(() =>
      view.store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, position: target },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    // 最下部で wheel を回しても、それ以上は動かない (scroll は来ない)。
    await act(() => {
      scroller(view.root).dispatchEvent(new Event("wheel"));
    });
    await act(() =>
      view.store.dispatch({
        type: "locator/changed",
        locator: { view: "usage", tab: "quota" },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    const before = { navigations: navigations.length, scrollTos: scrollTos.length };

    await act(() =>
      view.store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, position: target },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    expect(navigations.slice(before.navigations)).toEqual([]);
    expect(scrollTos.length).toBe(before.scrollTos + 1);
    expect(itemOf(view.root, target).classList.contains("tl-position-selected")).toBe(true);
  });

  test("reaching the bottom by the reader's own scroll releases the position", async () => {
    const view = await openLoaded(threeExchanges(), { position: uuidOf("u", 1) });
    expect(navigations).toEqual([]);
    await userScrollTo(view.root, 6 * ITEM_PX);
    expect(navigations).toEqual([{ url: timelineHref(SID), history: "replace" }]);
  });
});

describe("Timeline in-view search", () => {
  async function search(view: View, queryText: string): Promise<void> {
    await act(() =>
      view.store.dispatch({
        type: "timeline/search-changed",
        sid: SID,
        search: { queryText, caseSensitive: false, regex: false },
      }),
    );
  }

  function count(root: HTMLElement): string {
    return element(root, ".search-bar-count").textContent ?? "";
  }

  test("counts the matching units and ↑ / ↓ step through them with wrap-around", async () => {
    const view = await openLoaded(threeExchanges());
    await search(view, "question");
    expect(count(view.root)).toBe("1/3");
    await act(() => buttonTitled(view.root, "次のマッチへ").click());
    expect(count(view.root)).toBe("2/3");
    await act(() => buttonTitled(view.root, "前のマッチへ").click());
    await act(() => buttonTitled(view.root, "前のマッチへ").click());
    expect(count(view.root)).toBe("3/3");
  });

  // 何を保証するか: ツールバーの並び (🔔🔐 → 検索 → ⤒ ⤓ の組) と、チップの行の
  // 子の並び (チップ → 件数 → ↑ → ↓、チップどうしは隣り合う)。狭い幅でチップを
  // 縮めて 1 段に収める app.css の @container tl-toolbar は、チップの行を
  // `.search-bar > .search-bar-chips`、チップが 2 つ以上かを
  // `.search-bar-chip + .search-bar-chip` で引き、1 つの時だけチップを grid の
  // 最初の列に置く。幅そのものは playwright で見る
  // (docs/findings/2026-11-12-tl-toolbar-one-row.md)。
  test("the toolbar is 🔔🔐, the search bar and the ⤒ ⤓ pair, and the chip row is the chips, the count, ↑ and ↓", async () => {
    const view = await openLoaded(threeExchanges());
    const toolbar = element(view.root, ".tl-toolbar");
    const classesOf = (parent: Element): string[] =>
      [...parent.children].map((child) => child.classList.item(0) ?? child.tagName.toLowerCase());
    expect(classesOf(toolbar)).toEqual(["notif-badges", "search-bar", "tl-toolbar-end"]);
    expect(toolbar.firstElementChild).toBe(element(toolbar, ".tl-toolbar-badges"));
    expect(
      [...element(toolbar, ".tl-toolbar-end").querySelectorAll("button")].map((b) => b.title),
    ).toEqual(["最上部へ", "最下部へ"]);

    await search(view, "question");
    expect(classesOf(element(toolbar, ".search-bar > .search-bar-chips"))).toEqual([
      "search-bar-chip",
      "search-bar-count",
      "button",
      "button",
    ]);

    await search(view, "question answer");
    expect(classesOf(element(toolbar, ".search-bar > .search-bar-chips"))).toEqual([
      "search-bar-chip",
      "search-bar-chip",
      "search-bar-count",
      "button",
      "button",
    ]);
  });

  test("a query that matches nothing shows 0/0", async () => {
    const view = await openLoaded(threeExchanges());
    await search(view, "nowhere");
    expect(count(view.root)).toBe("0/0");
  });

  test("the 👤 target toggle drops user turns from the count", async () => {
    const view = await openLoaded([...exchange(1, "same word"), ...exchange(2, "same word")]);
    await search(view, "same");
    expect(count(view.root)).toBe("1/2");
    await act(() => buttonTitled(view.root, "検索").click());
    await act(() => buttonTitled(view.root, "ユーザメッセージを検索対象に含める").click());
    await act(() => buttonTitled(view.root, "検索").click());
    expect(count(view.root)).toBe("0/0");
  });
});

describe("Timeline side panel", () => {
  test("an auto-open toggle is saved for the session and read back on the next mount", async () => {
    const view = await openLoaded(exchange(1));
    const thinking = autoOpenBox(view.root, "T");
    expect(thinking.checked).toBe(true);
    await act(() => thinking.click());
    expect(autoOpenBox(view.root, "T").checked).toBe(false);
    expect(localStorage.getItem(timelineAutoOpenStorageKey(SID, undefined))).toContain(
      '"thinking":false',
    );

    await mounted.unmount();
    const again = await openLoaded(exchange(1));
    expect(autoOpenBox(again.root, "T").checked).toBe(false);
  });

  test("the handle opens the panel and a click outside it closes it", async () => {
    const view = await openLoaded(exchange(1));
    const float = element(view.root, ".tl-auto-open-float");
    await act(() => element(view.root, ".tl-auto-open-handle").click());
    expect(float.classList.contains("tl-auto-open-float-open")).toBe(true);

    await act(() => element(view.root, ".tl-toolbar").click());
    expect(float.classList.contains("tl-auto-open-float-open")).toBe(false);
  });
});

describe("Timeline auto open", () => {
  /** 発話、tool を挟んで最終応答、の 1 往復。`tools` は fold group に入る行。 */
  function exchangeWith(n: number, tools: readonly string[]): string[] {
    return [
      jsonl(userContentRow(`question ${n}`, { uuid: uuidOf("u", n) })),
      ...tools,
      jsonl(assistantContentRow([textBlock(`answer ${n}`)], { uuid: uuidOf("a", n) })),
    ];
  }
  function readCall(id: string): string[] {
    return [
      jsonl(assistantContentRow([toolUseBlock("Read", { file_path: "src/a.ts" }, id)])),
      jsonl(userContentRow([toolResultBlock("1\talpha", { tool_use_id: id })])),
    ];
  }
  const editing = exchangeWith(1, [
    ...readCall("tu_read_1"),
    jsonl(
      assistantContentRow([
        toolUseBlock(
          "Edit",
          { file_path: "src/a.ts", old_string: "alpha", new_string: "beta" },
          "tu_edit",
        ),
      ]),
    ),
    jsonl(userContentRow([toolResultBlock("updated", { tool_use_id: "tu_edit" })])),
  ]);
  const readingOnly = exchangeWith(2, readCall("tu_read_2"));

  function foldGroup(root: HTMLElement, index: number): HTMLDetailsElement {
    const group = defined(root.querySelectorAll(".tl-fold-group")[index], `fold group ${index}`);
    return instanceOf(group, HTMLDetailsElement, `fold group ${index}`);
  }
  function fileFold(root: HTMLElement, label: string): HTMLDetailsElement {
    const fold = defined(
      [...root.querySelectorAll(".tl-file-tool-fold")].find((el) =>
        el.querySelector("summary")?.textContent?.includes(label),
      ),
      `${label} fold`,
    );
    return instanceOf(fold, HTMLDetailsElement, `${label} fold`);
  }

  // E と N items が on なら、Edit を含む fold group と Edit のカードが開いて
  // 書き換えの diff が見える。Read だけの fold group と Read のカードは閉じたまま。
  test("E opens the fold group holding an Edit and the Edit card, not a Read-only group", async () => {
    localStorage.setItem(
      timelineAutoOpenStorageKey(SID, undefined),
      JSON.stringify({ thinking: false, ccmsg: false, agent: false, edit: true, items: true }),
    );
    const view = await openLoaded([...editing, ...readingOnly]);
    const withEdit = foldGroup(view.root, 0);
    const withReadOnly = foldGroup(view.root, 1);
    expect(withEdit.open).toBe(true);
    expect(withReadOnly.open).toBe(false);
    expect(fileFold(withEdit, "Edit src/a.ts").open).toBe(true);
    expect(fileFold(withEdit, "Read src/a.ts").open).toBe(false);

    // E を切ると、同じ fold group と Edit のカードは閉じた既定に戻る。
    await act(() => autoOpenBox(view.root, "E").click());
    expect(foldGroup(view.root, 0).open).toBe(false);
    expect(fileFold(foldGroup(view.root, 0), "Edit src/a.ts").open).toBe(false);
  });
});

function autoOpenBox(root: HTMLElement, category: string): HTMLInputElement {
  const label = defined(
    [...root.querySelectorAll(".tl-auto-open label")].find(
      (el) => el.textContent?.trim() === category,
    ),
    `auto-open ${category}`,
  );
  return instanceOf(label.querySelector("input"), HTMLInputElement, `${category} checkbox`);
}
