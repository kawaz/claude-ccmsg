// Timeline をマウントして、外から観測できる振る舞いを DOM・送った要求・URL
// の書き換えで固定する。対象は Timeline の本体が束ねている関心ごと:
// - transcript の読み込み (初回・接続待ち・再訪・older・再試行・tail のずれ)
// - live tail の購読と fork 地点の問い合わせ
// - 末尾追従 (初回・追記・遡って読んでいる時・タブの再表示)
// - 位置 (`/timeline/<uuid>`) への着地・クリックでの選択・最下部での解除
// - 👤 N/M のユーザ発話ナビ、in-view 検索、auto open、側面パネル
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

/** scroller の scrollTo の呼び出し (位置への着地・👤 nav が使う)。 */
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
    // 👤 nav のスクロールをアニメーションさせず、その場で書かせる。
    stubGlobal("matchMedia", (query: string) => ({
      matches: query.includes("prefers-reduced-motion"),
      media: query,
      addEventListener() {},
      removeEventListener() {},
    })),
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

function userNavCount(root: HTMLElement): string {
  return element(root, ".tl-user-nav-count").textContent ?? "";
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

  test("coming back to a cached transcript re-reads the tail while still showing the cache", async () => {
    const view = await openLoaded(exchange(1));
    await view.rerender({ active: false, visible: false });
    await view.rerender({ active: true, visible: true });
    expect(view.ws.reads).toHaveLength(2);
    expect(view.ws.lastRead().opts).toBeUndefined();

    await view.ws.lastRead().answer(page([...exchange(1), ...exchange(2)]));
    expect(view.root.textContent).toContain("question 2");
  });

  test("older reads the page before the loaded start and puts it in front", async () => {
    const newer = exchange(2);
    const older = exchange(1);
    const view = await open();
    const olderEnd = endOf(older, 0);
    await view.ws.lastRead().answer(page(newer, olderEnd));

    await act(() => buttonTitledText(view.root, "older").click());
    expect(view.ws.lastRead().opts).toEqual({ before: olderEnd });
    await view.ws.lastRead().answer(page(older, 0));

    const text = view.root.textContent ?? "";
    expect(text.indexOf("question 1")).toBeGreaterThanOrEqual(0);
    expect(text.indexOf("question 1")).toBeLessThan(text.indexOf("question 2"));
    expect(buttonTitledText(view.root, "先頭まで").disabled).toBe(true);
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

  test("a tail push that does not line up re-reads in the background without blanking the rows", async () => {
    const view = await openLoaded(exchange(1));
    const end = loadedEnd(view.store);
    await tail(view.store, exchange(3), end + 10);
    expect(view.ws.reads).toHaveLength(2);
    expect(view.root.textContent).toContain("question 1");
    expect(view.root.textContent).not.toContain("読み込み中");

    await view.ws.lastRead().answer(page([...exchange(1), ...exchange(2), ...exchange(3)]));
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
function buttonTitledText(root: HTMLElement, text: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(
    (button) => button.textContent?.trim() === text,
  );
  return instanceOf(found ?? null, HTMLButtonElement, `button "${text}"`);
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
    expect(userNavCount(root)).toBe("👤 3/3");
  });

  test("an append follows a reader who is at the bottom", async () => {
    const view = await openLoaded(threeExchanges());
    await tail(view.store, exchange(4), loadedEnd(view.store));
    const el = scroller(view.root);
    expect(el.scrollHeight).toBe(8 * ITEM_PX);
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

  test("reaching the bottom by the reader's own scroll releases the position", async () => {
    const view = await openLoaded(threeExchanges(), { position: uuidOf("u", 1) });
    expect(navigations).toEqual([]);
    await userScrollTo(view.root, 6 * ITEM_PX);
    expect(navigations).toEqual([{ url: timelineHref(SID), history: "replace" }]);
  });
});

describe("Timeline user-turn nav", () => {
  test("starts at the last user turn and ↑ / ↓ walk the turns with wrap-around", async () => {
    const view = await openLoaded(threeExchanges());
    expect(userNavCount(view.root)).toBe("👤 3/3");

    await act(() => buttonTitled(view.root, "前のユーザ発言へ").click());
    expect(userNavCount(view.root)).toBe("👤 2/3");
    await act(() => buttonTitled(view.root, "次のユーザ発言へ").click());
    await act(() => buttonTitled(view.root, "次のユーザ発言へ").click());
    expect(userNavCount(view.root)).toBe("👤 1/3");
    expect(
      element(itemOf(view.root, uuidOf("u", 1)), ".tl-bubble-right").classList.contains(
        "tl-bubble-user-nav-selected",
      ),
    ).toBe(true);
  });

  test("clicking a user bubble moves the counter to it", async () => {
    const view = await openLoaded(threeExchanges());
    await act(() => element(itemOf(view.root, uuidOf("u", 1)), ".tl-bubble-right").click());
    expect(userNavCount(view.root)).toBe("👤 1/3");
  });

  test("a re-read keeps the selected turn unless the transcript came back shorter", async () => {
    const view = await openLoaded(threeExchanges());
    await act(() => buttonTitled(view.root, "前のユーザ発言へ").click());
    expect(userNavCount(view.root)).toBe("👤 2/3");

    await tail(view.store, exchange(4), loadedEnd(view.store));
    expect(userNavCount(view.root)).toBe("👤 2/4");

    // 再訪の読み直しが同じ末尾まで返る: 選んでいた発話 (2 番目) を指したまま、
    // 窓から外れた 1 番目の分だけ番号が詰まる。
    const lines = [...threeExchanges(), ...exchange(4)];
    const secondStart = endOf(lines.slice(0, 2), 0);
    await revisit(view, page(lines.slice(2), secondStart));
    expect(userNavCount(view.root)).toBe("👤 1/3");

    // 末尾が手前に戻った (読み直しで短くなった) 時は、末尾の発話を選び直す。
    await revisit(view, page(lines.slice(2, 6), secondStart));
    expect(userNavCount(view.root)).toBe("👤 2/2");
  });
});

/** タブを離れて戻り、到着時の読み直しに `reply` を返す。 */
async function revisit(view: View, reply: ReturnType<typeof page>): Promise<void> {
  await view.rerender({ active: false, visible: false });
  await view.rerender({ active: true, visible: true });
  await view.ws.lastRead().answer(reply);
}

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

function autoOpenBox(root: HTMLElement, category: string): HTMLInputElement {
  const label = defined(
    [...root.querySelectorAll(".tl-auto-open label")].find(
      (el) => el.textContent?.trim() === category,
    ),
    `auto-open ${category}`,
  );
  return instanceOf(label.querySelector("input"), HTMLInputElement, `${category} checkbox`);
}
