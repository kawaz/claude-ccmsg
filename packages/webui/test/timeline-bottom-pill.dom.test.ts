// The 「↓先頭に移動↓」 floating at the bottom of the Timeline (DR-0054 §11),
// mounted:
// - it is in the DOM after the list, and shown only while the list's end (a
//   zero-height mark watched by an IntersectionObserver on the scroller) is out
//   of sight; before the observer has said anything it is hidden
// - a click does what ⤓ does (the same scroll, with the same smooth flag)
// - it is there under a filter and in an agent's Timeline, as ⤓ is
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import type { AgentRef, TimelineFilter } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
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
} from "./timeline-harness.ts";

withDom();

/** Every IntersectionObserver the Timeline makes, driven by the test. */
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
    const box = new DOMRect(0, 0, 100, 0);
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
let scrollTos: string[] = [];

beforeEach(() => {
  FakeVisibility.made = [];
  scrollTos = [];
  restores = [
    stubGlobal("IntersectionObserver", FakeVisibility),
    stubGlobal("navigation", { navigate() {} }),
    stubProperty(HTMLElement.prototype, "scrollHeight", {
      configurable: true,
      get(this: HTMLElement) {
        return this.classList.contains("timeline-view") ? 1000 : 0;
      },
    }),
    stubProperty(HTMLElement.prototype, "scrollTo", {
      configurable: true,
      value(this: HTMLElement, options: ScrollToOptions) {
        if (this.classList.contains("timeline-view")) scrollTos.push(JSON.stringify(options));
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

async function open(agent?: AgentRef): Promise<{ root: HTMLElement; store: Store }> {
  const store = timelineStore(agent !== undefined ? { agent } : {});
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, { agent: agent ?? null }));
  await ws.lastRead().answer(page([...exchange(1), ...exchange(2)], 0));
  return { root, store };
}

function pill(root: HTMLElement): HTMLButtonElement {
  return instanceOf(root.querySelector(".tl-bottom-pill"), HTMLButtonElement, "the pill");
}

function tail(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-tail"), HTMLElement, "the end's mark");
}

function toolbarButton(root: HTMLElement, title: string): HTMLButtonElement {
  return instanceOf(
    root.querySelector(`.tl-toolbar-end button[title="${title}"]`),
    HTMLButtonElement,
    title,
  );
}

async function setTailInView(root: HTMLElement, visible: boolean): Promise<void> {
  const target = tail(root);
  const observer = defined(
    FakeVisibility.made.findLast((o) => !o.disconnected && o.observed.includes(target)),
    "an observer of the end's mark",
  );
  await act(() => observer.set(target, visible));
}

describe("the pill at the bottom", () => {
  test("is a button of its own words, after the list", async () => {
    const { root } = await open();
    expect(pill(root).textContent).toBe("↓先頭に移動↓");
    expect(pill(root).type).toBe("button");
    const view = instanceOf(root.querySelector(".timeline-view"), HTMLElement, "scroller");
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, ".tl-lines");
    expect(tail(root).parentElement).toBe(view);
    expect(lines.compareDocumentPosition(tail(root)) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(
      0,
    );
  });

  test("watches the list's end in the scroller", async () => {
    const { root } = await open();
    const observer = defined(
      FakeVisibility.made.findLast((o) => !o.disconnected && o.observed.includes(tail(root))),
      "an observer",
    );
    expect(observer.root).toBe(root.querySelector(".timeline-view"));
    expect(observer.rootMargin).toBe("-0px 0px 2px 0px");
  });

  test("is hidden until the observer has said, shown while the end is out of sight, hidden while it is in sight", async () => {
    const { root } = await open();
    expect(pill(root).hidden).toBe(true);
    await setTailInView(root, false);
    expect(pill(root).hidden).toBe(false);
    await setTailInView(root, true);
    expect(pill(root).hidden).toBe(true);
  });

  test("a click scrolls as ⤓ does", async () => {
    const { root } = await open();
    scrollTos = [];
    await act(() => toolbarButton(root, "最下部へ").click());
    const byToolbar = [...scrollTos];
    expect(byToolbar.length).toBeGreaterThan(0);
    scrollTos = [];
    await setTailInView(root, false);
    await act(() => pill(root).click());
    expect(scrollTos).toEqual(byToolbar);
  });

  test("is judged the same under a filter, and the element stays", async () => {
    const { root, store } = await open();
    await setTailInView(root, false);
    const before = pill(root);
    for (const filter of ["say", "permit", "bookmark", "prompt", "comment", "search"] as const) {
      const to: TimelineFilter = filter;
      await act(() =>
        store.dispatch({
          type: "locator/changed",
          locator: { view: "timeline", sid: SID, position: "head", filter: to },
          sidebar: CLOSED_SIDEBAR,
        }),
      );
      expect({ filter, hidden: pill(root).hidden }).toEqual({ filter, hidden: false });
      expect(pill(root)).toBe(before);
    }
  });

  test("a row appended keeps watching the same mark", async () => {
    const { root, store } = await open();
    await setTailInView(root, false);
    const tree = defined(store.getState().sessionTrees.get(SID), "session tree");
    const start = tree.timeline.end;
    const end = endOf(exchange(3), start);
    await act(() =>
      store.dispatch({
        type: "timeline/tail",
        sid: SID,
        lines: exchange(3),
        start,
        end,
        size: end,
      }),
    );
    await setTailInView(root, true);
    expect(pill(root).hidden).toBe(true);
    await setTailInView(root, false);
    expect(pill(root).hidden).toBe(false);
  });

  test("is in an agent's Timeline, as ⤓ is", async () => {
    const { root } = await open({ agentId: "a1" });
    expect(toolbarButton(root, "最下部へ")).toBeDefined();
    await setTailInView(root, false);
    expect(pill(root).hidden).toBe(false);
  });
});
