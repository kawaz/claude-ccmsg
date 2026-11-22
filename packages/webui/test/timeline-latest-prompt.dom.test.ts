// The 「↑最新のプロンプトへ移動↑」 at the end of the session's Timeline (DR-0054
// §10), mounted:
// - it stands last in the row list, after the end's marks, and is shown only
//   while the newest prompt's item is out of sight (the IntersectionObserver
//   watching that item says so); before the observer has said anything it is
//   hidden
// - a click moves to the prompt's row as a filter item's click does (DR-0058
//   §6): the position with `seek=true`, replacing the entry
// - a newer prompt is the one watched
// - only the window's prompts count: with none in it there is no button, and
//   nothing is asked or read to find one
// - not under a filter (the element stays, hidden), not in an agent's
//   Timeline
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { timelineHref, type AgentRef, type TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { defined, instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
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

/** Every IntersectionObserver the Timeline makes, driven by the test: the
 * element it watches comes into sight or leaves it when the test says so. */
class FakeVisibility implements IntersectionObserver {
  static made: FakeVisibility[] = [];
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  readonly #callback: IntersectionObserverCallback;
  observed: Element[] = [];
  disconnected = false;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.#callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    FakeVisibility.made.push(this);
  }
  observe(target: Element): void {
    this.observed.push(target);
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  disconnect(): void {
    this.disconnected = true;
  }
  set(target: Element, visible: boolean): void {
    const box = new DOMRect(0, 0, 100, 20);
    const entry: IntersectionObserverEntry = {
      time: 0,
      rootBounds: null,
      boundingClientRect: box,
      intersectionRect: visible ? box : new DOMRect(),
      isIntersecting: visible,
      intersectionRatio: visible ? 1 : 0,
      target,
    };
    this.#callback([entry], this);
  }
}

const mounted = new Mounted();
let restores: Array<() => void> = [];
let navigations: string[] = [];
let histories: Array<string | undefined> = [];

beforeEach(() => {
  navigations = [];
  histories = [];
  FakeVisibility.made = [];
  restores = [
    stubGlobal("IntersectionObserver", FakeVisibility),
    stubGlobal("navigation", {
      navigate(url: string, options?: { history?: string }) {
        navigations.push(url);
        histories.push(options?.history);
      },
    }),
  ];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

function TimelineOf({ agent }: { agent: AgentRef | null }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent,
    active: true,
    visible: true,
  });
}

const u = (n: number): string => uuidOf("u", n);

async function filterTo(store: Store, filter: TimelineFilter | null): Promise<void> {
  await act(() =>
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid: SID, position: "head", ...(filter ? { filter } : {}) },
      sidebar: CLOSED_SIDEBAR,
    }),
  );
}

async function open(options: {
  rows: readonly string[];
  start?: number;
  agent?: AgentRef;
}): Promise<{ root: HTMLElement; store: Store; ws: FakeTranscriptWs }> {
  const store = timelineStore(options.agent !== undefined ? { agent: options.agent } : {});
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(
    store,
    ws.handle,
    h(TimelineOf, { agent: options.agent ?? null }),
  );
  await ws.lastRead().answer(page(options.rows, options.start ?? 0));
  return { root, store, ws };
}

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    root.querySelector(`.tl-lines > [data-timeline-uuid="${uuid}"]`),
    HTMLElement,
    `the item ${uuid}`,
  );
}

function button(root: HTMLElement): HTMLButtonElement {
  return instanceOf(root.querySelector(".tl-latest-prompt"), HTMLButtonElement, "the button");
}

/** The observer watching `target` (and not given up). */
function watching(target: Element): FakeVisibility {
  return defined(
    FakeVisibility.made.findLast((o) => !o.disconnected && o.observed.includes(target)),
    "an observer of the item",
  );
}

async function setInView(root: HTMLElement, uuid: string, visible: boolean): Promise<void> {
  const target = itemOf(root, uuid);
  await act(() => watching(target).set(target, visible));
}

/** Let the replies and their renders settle. */
const drained = () => act(() => new Promise<void>((resolve) => setImmediate(resolve)));

describe("the way back to the newest prompt", () => {
  test("stands last, after the end's marks, at the right", async () => {
    const { root } = await open({ rows: [...exchange(1), ...exchange(2)] });
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, ".tl-lines");
    const children = [...lines.children].filter(
      (el) => !el.matches(".tl-filter-read-all, .tl-filter-back"),
    );
    expect(children.at(-1)).toBe(button(root));
    expect(button(root).textContent).toBe("↑最新のプロンプトへ移動↑");
    expect(button(root).type).toBe("button");
  });

  test("watches the newest prompt in the scroller, below the toolbar", async () => {
    const { root } = await open({ rows: [...exchange(1), ...exchange(2)] });
    const observer = watching(itemOf(root, u(2)));
    expect(observer.root).toBe(root.querySelector(".timeline-view"));
    expect(observer.rootMargin).toMatch(/^-\d+px 0px 0px 0px$/);
    expect(FakeVisibility.made.some((o) => o.observed.includes(itemOf(root, u(1))))).toBe(false);
  });

  test("is hidden until the observer has said, shown while the prompt is out of sight, hidden while it is in sight", async () => {
    const { root } = await open({ rows: [...exchange(1), ...exchange(2)] });
    expect(button(root).hidden).toBe(true);
    await setInView(root, u(2), false);
    expect(button(root).hidden).toBe(false);
    await setInView(root, u(2), true);
    expect(button(root).hidden).toBe(true);
  });

  test("a click moves to the prompt's row, replacing the entry", async () => {
    const { root, ws } = await open({ rows: [...exchange(1), ...exchange(2)] });
    await setInView(root, u(2), false);
    await act(() => button(root).click());
    expect(navigations).toEqual([timelineHref(SID, u(2), null, true)]);
    expect(histories).toEqual(["replace"]);
    // In the window: nothing more is read.
    expect(ws.reads).toHaveLength(1);
  });

  test("a newer prompt is the one watched", async () => {
    const { root, store } = await open({ rows: [...exchange(1)] });
    await setInView(root, u(1), true);
    expect(button(root).hidden).toBe(true);
    const tree = defined(store.getState().sessionTrees.get(SID), "session tree");
    const start = tree.timeline.end;
    const end = endOf(exchange(2), start);
    await act(() =>
      store.dispatch({
        type: "timeline/tail",
        sid: SID,
        lines: exchange(2),
        start,
        end,
        size: end,
      }),
    );
    // The new prompt's observer has not said yet: hidden, not the old answer.
    expect(button(root).hidden).toBe(true);
    await setInView(root, u(2), false);
    expect(button(root).hidden).toBe(false);
  });

  test("under a filter the element stays, hidden; taking it off shows it again", async () => {
    const { root, store } = await open({ rows: [...exchange(1), ...exchange(2)] });
    await setInView(root, u(2), false);
    const before = button(root);
    for (const filter of ["say", "permit", "bookmark", "prompt", "search"] as const) {
      await filterTo(store, filter);
      expect({ filter, hidden: button(root).hidden }).toEqual({ filter, hidden: true });
      expect(button(root)).toBe(before);
    }
    await filterTo(store, null);
    expect(button(root).hidden).toBe(false);
  });

  test("a Timeline with no prompt has none", async () => {
    const answers = [
      jsonl(assistantContentRow([textBlock("only an answer")], { uuid: uuidOf("a", 1) })),
    ];
    const { root, ws } = await open({ rows: answers });
    expect(root.querySelector(".tl-latest-prompt")).toBeNull();
    // Read from the start: nothing outside the window to ask about.
    expect(ws.promptRowsAsked).toEqual([]);
  });

  test("an agent's Timeline has none", async () => {
    const { root, ws } = await open({
      rows: [...exchange(1), ...exchange(2)],
      agent: { agentId: "a0123456789abcdef" },
    });
    expect(root.querySelector(".tl-latest-prompt")).toBeNull();
    expect(ws.promptRowsAsked).toEqual([]);
  });

  test("a prompt not read into the window is not looked for: none with no prompt in the window", async () => {
    const older = exchange(21, "an old prompt");
    const answers = [
      jsonl(assistantContentRow([textBlock("answer without a prompt")], { uuid: uuidOf("a", 1) })),
    ];
    const { root, ws } = await open({ rows: answers, start: endOf(older, 0) });
    await drained();
    expect(root.querySelector(".tl-latest-prompt")).toBeNull();
    expect(ws.promptRowsAsked).toEqual([]);
    expect(ws.reads).toHaveLength(1);
  });
});
