// The two pills at the end of the session's Timeline (DR-0054 §10, §11) settle
// whatever the reader's position near the end, mounted with a layout the test
// gives:
// - the 「↑最新のプロンプトへ移動↑」 floats at the end of the row list and
//   moves nothing (app.css), so the status lines' box (`.tl-bottom-controls`)
//   stands where the reader's scroll puts it, the button shown or not
// - at each position, the button shows while the box is in sight, the
//   「↓先頭に移動↓」 while it is not (the end being out of sight), never both,
//   and no further frame changes either
//
// Each frame stands for the browser's intersection step: every observer the
// Timeline keeps is told of each element it watches whose answer changed (and
// of each it has not told of yet), with its rootMargin applied to the layout.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { useStoreState } from "../src/client/useStore.ts";
import { instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  exchange,
  FakeTranscriptWs,
  Mounted,
  page,
  SID,
  timelineStore,
} from "./timeline-harness.ts";

withDom();

/** Where the top of the status lines' box stands below the bottom edge of the
 * view (px; negative is inside the view). The test moves it as the reader's
 * scroll would. */
let boxTop = 0;

/** Whether `target` is in sight with the view's bottom edge moved out by
 * `bottomMargin`: the box by where it stands now, the newest prompt and the
 * end's mark never (the reader is near the end of a long Timeline). */
function intersecting(target: Element, bottomMargin: number): boolean {
  if (!target.classList.contains("tl-bottom-controls")) return false;
  return boxTop <= bottomMargin;
}

class FakeLayoutObserver implements IntersectionObserver {
  static made: FakeLayoutObserver[] = [];
  readonly root: Element | Document | null;
  readonly rootMargin: string;
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  readonly #callback: IntersectionObserverCallback;
  readonly #told = new Map<Element, boolean>();
  observed: Element[] = [];
  disconnected = false;
  constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
    this.#callback = callback;
    this.root = options?.root ?? null;
    this.rootMargin = options?.rootMargin ?? "0px";
    FakeLayoutObserver.made.push(this);
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
  /** One frame's intersection step for this observer. */
  frame(): void {
    if (this.disconnected) return;
    const bottomMargin = Number.parseFloat(this.rootMargin.split(" ")[2] ?? "0");
    const entries: IntersectionObserverEntry[] = [];
    for (const target of this.observed) {
      const now = intersecting(target, bottomMargin);
      if (this.#told.get(target) === now) continue;
      this.#told.set(target, now);
      const box = new DOMRect(0, 0, 100, 20);
      entries.push({
        time: 0,
        rootBounds: null,
        boundingClientRect: box,
        intersectionRect: now ? box : new DOMRect(),
        isIntersecting: now,
        intersectionRatio: now ? 1 : 0,
        target,
      });
    }
    if (entries.length > 0) this.#callback(entries, this);
  }
}

const mounted = new Mounted();
let restores: Array<() => void> = [];

beforeEach(() => {
  FakeLayoutObserver.made = [];
  boxTop = 0;
  restores = [
    stubGlobal("IntersectionObserver", FakeLayoutObserver),
    stubGlobal("navigation", { navigate() {} }),
  ];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

function TimelineOf() {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent: null,
    active: true,
    visible: true,
  });
}

async function open(): Promise<HTMLElement> {
  const store = timelineStore({});
  const ws = new FakeTranscriptWs(store);
  const root = await mounted.mount(store, ws.handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...exchange(1), ...exchange(2)], 0));
  return root;
}

interface Pills {
  latest: boolean;
  bottom: boolean;
}

function pills(root: HTMLElement): Pills {
  const latest = instanceOf(
    root.querySelector(".tl-latest-prompt"),
    HTMLButtonElement,
    "the way back to the newest prompt",
  );
  const bottom = instanceOf(
    root.querySelector(".tl-bottom-pill"),
    HTMLButtonElement,
    "the way to the bottom",
  );
  return { latest: !latest.hidden, bottom: !bottom.hidden };
}

/** Run `n` frames and say which pills were shown after each. */
async function frames(root: HTMLElement, n: number): Promise<Pills[]> {
  const seen: Pills[] = [];
  for (let i = 0; i < n; i++) {
    await act(() => {
      for (const observer of FakeLayoutObserver.made) observer.frame();
    });
    seen.push(pills(root));
  }
  return seen;
}

describe("the pills at the end of the Timeline", () => {
  test("with the box just in sight, the button comes and stays", async () => {
    const root = await open();
    boxTop = -8;
    const seen = await frames(root, 12);
    // Shown from the frame the answers came in on, and the same on every
    // frame after it.
    expect(seen.slice(2)).toEqual(
      Array.from({ length: 10 }, () => ({ latest: true, bottom: false })),
    );
  });

  test("with the box just out of sight, the 「↓先頭に移動↓」 comes and stays", async () => {
    const root = await open();
    boxTop = 5;
    const seen = await frames(root, 12);
    expect(seen.slice(2)).toEqual(
      Array.from({ length: 10 }, () => ({ latest: false, bottom: true })),
    );
  });

  test("at each position, scrolled to from above and from below, one answer that the next frames keep", async () => {
    const root = await open();
    const positions = Array.from({ length: 91 }, (_, i) => 45 - i);
    for (const at of [...positions, ...positions.toReversed()]) {
      boxTop = at;
      await frames(root, 3);
      const settled = await frames(root, 5);
      const expected = { latest: at <= 0, bottom: at > 0 };
      expect({ at, settled }).toEqual({ at, settled: Array.from({ length: 5 }, () => expected) });
    }
  });
});
