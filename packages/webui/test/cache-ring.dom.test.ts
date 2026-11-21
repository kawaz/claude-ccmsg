// The prompt-cache ring's clock (CacheRing.tsx): how much of the span has gone
// is on the line from the first frame, moves a half-pixel step at a time while
// the ring can be seen, is not written while it cannot (folded away, scrolled
// out, hidden), and is the time's own when the ring comes back into sight.
// The arithmetic of the steps is llm-cache-view.test.ts's.
import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import { CacheRing, type CacheRingShape } from "../src/client/components/CacheRing.tsx";
import type { CacheRingSpan } from "../src/client/llm-cache-view.ts";
import { defined, instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

const NOW = 1_785_564_745_000;
/** Five minutes, half gone at NOW. */
const HALF_GONE: CacheRingSpan = { start: NOW - 150_000, end: NOW + 150_000 };

/** The one IntersectionObserver a ring makes, driven by the test: the ring
 * comes into sight or leaves it when the test says so. */
class FakeVisibility implements IntersectionObserver {
  static last: FakeVisibility | null = null;
  readonly root = null;
  readonly rootMargin = "0px";
  readonly scrollMargin = "0px";
  readonly thresholds = [0];
  readonly #callback: IntersectionObserverCallback;
  observed: Element | null = null;
  disconnected = false;
  constructor(callback: IntersectionObserverCallback) {
    this.#callback = callback;
    FakeVisibility.last = this;
  }
  observe(target: Element): void {
    this.observed = target;
  }
  unobserve(): void {}
  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }
  disconnect(): void {
    this.disconnected = true;
  }
  set(visible: boolean): void {
    const target = defined(this.observed, "the observed ring");
    const box = new DOMRect(0, 0, 20, 20);
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

let restores: (() => void)[] = [];
let root: HTMLElement | null = null;

beforeEach(() => {
  jest.useFakeTimers();
  setSystemTime(NOW);
  FakeVisibility.last = null;
  restores.push(stubGlobal("IntersectionObserver", FakeVisibility));
  // An icon's ring: 20 × 20, so 80px of line and 160 half-pixel steps.
  restores.push(
    stubProperty(SVGSVGElement.prototype, "getBoundingClientRect", {
      configurable: true,
      value: () => new DOMRect(0, 0, 20, 20),
    }),
  );
});

afterEach(async () => {
  if (root !== null) {
    const r = root;
    root = null;
    await act(() => render(null, r));
    r.remove();
  }
  for (const restore of restores.reverse()) restore();
  restores = [];
  jest.useRealTimers();
  setSystemTime();
});

async function mount(span: CacheRingSpan, shape: CacheRingShape = "rect"): Promise<SVGElement> {
  const r = document.createElement("div");
  document.body.append(r);
  root = r;
  await act(() => render(h(CacheRing, { shape, span }), r));
  return instanceOf(r.querySelector(".cache-ring-shape"), SVGElement, "the ring's line");
}

const progressOf = (line: SVGElement): number =>
  Number(line.style.getPropertyValue("--cache-ring-progress"));

async function setVisible(visible: boolean): Promise<void> {
  await act(() => defined(FakeVisibility.last, "the ring's observer").set(visible));
}

async function advance(ms: number): Promise<void> {
  await act(() => {
    jest.advanceTimersByTime(ms);
  });
}

describe("CacheRing", () => {
  test("the line shows how much has gone from the first frame", async () => {
    // Written before the browser draws, so a ring half gone is never seen full.
    expect(progressOf(await mount(HALF_GONE))).toBe(0.5);
  });

  test("in sight, the line moves one half-pixel step at a time", async () => {
    const line = await mount(HALF_GONE);
    await setVisible(true);
    // 300s over 160 steps: the next write is 1875ms on, and none before it.
    await advance(1874);
    expect(progressOf(line)).toBe(0.5);
    await advance(1);
    expect(progressOf(line)).toBe((150_000 + 1875) / 300_000);
    expect(jest.getTimerCount()).toBe(1);
  });

  test("out of sight, nothing is written and no clock runs", async () => {
    const line = await mount(HALF_GONE);
    await setVisible(true);
    await setVisible(false);
    expect(jest.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(progressOf(line)).toBe(0.5);
  });

  test("back in sight, the line shows the time now, not where it stopped", async () => {
    const line = await mount(HALF_GONE);
    await setVisible(false);
    await advance(75_000);
    await setVisible(true);
    expect(progressOf(line)).toBe(0.75);
  });

  test("the clock stops once the ring has gone", async () => {
    const line = await mount({ start: NOW - 299_000, end: NOW + 1_000 });
    await setVisible(true);
    await advance(5_000);
    expect(progressOf(line)).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("a ring stamped in the future stays full and starts on time", async () => {
    const line = await mount({ start: NOW + 10_000, end: NOW + 310_000 });
    await setVisible(true);
    expect(progressOf(line)).toBe(0);
    await advance(10_000);
    expect(progressOf(line)).toBe(0);
    await advance(1875);
    expect(progressOf(line)).toBe(1875 / 300_000);
  });

  test("a new span is drawn from its own start, on the same line", async () => {
    const r = document.createElement("div");
    document.body.append(r);
    root = r;
    await act(() => render(h(CacheRing, { shape: "rect", span: HALF_GONE }), r));
    const line = instanceOf(r.querySelector(".cache-ring-shape"), SVGElement, "the line");
    const first = defined(FakeVisibility.last, "the first observer");
    await act(() =>
      render(h(CacheRing, { shape: "rect", span: { start: NOW, end: NOW + 300_000 } }), r),
    );
    expect(r.querySelector(".cache-ring-shape")).toBe(line);
    expect(first.disconnected).toBe(true);
    expect(progressOf(line)).toBe(0);
  });

  test("unmounting stops the clock", async () => {
    await mount(HALF_GONE);
    await setVisible(true);
    const observer = defined(FakeVisibility.last, "the observer");
    const r = defined(root, "the root");
    await act(() => render(null, r));
    expect(observer.disconnected).toBe(true);
    expect(jest.getTimerCount()).toBe(0);
  });

  test("with reduced motion the line stays where it was first drawn", async () => {
    restores.push(
      stubGlobal("matchMedia", (query: string) => ({ matches: query.includes("reduced-motion") })),
    );
    const line = await mount(HALF_GONE, "circle");
    expect(progressOf(line)).toBe(0.5);
    expect(FakeVisibility.last).toBeNull();
    await advance(60_000);
    expect(progressOf(line)).toBe(0.5);
  });
});
