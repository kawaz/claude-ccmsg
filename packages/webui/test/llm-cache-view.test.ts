// Prompt-cache ring arithmetic (llm-cache-view.ts). Every instant on the wire
// is epoch ms, and the whole ring is driven by the values computed here — the
// span it sweeps, how much of it has gone at an instant, and how long the line
// takes to move a step — so this is where those, and the hand-off from the
// first cache to the chain of kept-alive ones, get pinned down.
import { describe, expect, test } from "bun:test";
import { LLM_PROMPT_CACHE_TTL_MS } from "@ccmsg/protocol";
import {
  type CacheWindow,
  cacheRemainingMs,
  cacheRingNextChangeMs,
  cacheRingPhase,
  CACHE_RING_STEP_PX,
  cacheRingProgress,
  cacheRingProps,
  cacheRingStepMs,
} from "../src/client/llm-cache-view.ts";
import { defined } from "./helpers.ts";

const NOW = 1_785_564_745_000;
const HOUR_MS = 3_600_000;
/** A request that happened `ms` before NOW. */
const tsAgo = (ms: number): number => NOW - ms;
/** A window opened `ms` before NOW, of the length the gateway stated (or, with
 * `ttlMs` omitted, of the length ccmsg assumes when it stated none). */
const win = (ms: number, ttlMs?: number): CacheWindow =>
  ttlMs === undefined ? { ts: tsAgo(ms) } : { ts: tsAgo(ms), cache_expires_at: tsAgo(ms) + ttlMs };

/** The gateway's own spacing: a marker every 55 minutes keeps an hour-long
 * cache warm with five minutes to spare. */
const INTERVAL_MS = 55 * 60_000;

/** The first request of a series the keepalive strategy covers: `cache_count`
 * still 0, one marker planned `plannedIn` ms from NOW. */
const firstCache = (tsAgoMs: number, plannedIn: number): CacheWindow => ({
  ts: tsAgo(tsAgoMs),
  origin: "main",
  cache_expires_at: tsAgo(tsAgoMs) + HOUR_MS,
  cache_since: tsAgo(tsAgoMs),
  cache_count: 0,
  next_keepalive_at: NOW + plannedIn,
  cache_until: tsAgo(tsAgoMs) + 9 * INTERVAL_MS + HOUR_MS,
});

/** A marker's return trip on a chain the gateway states consistently: it
 * started `sinceAgo` ms before NOW, sends `untilCount` markers `INTERVAL_MS`
 * apart, and the last one's cache is what `cache_until` reaches. */
const chained = (
  sinceAgo: number,
  tsAgoMs: number,
  count = 2,
  untilCount = 9,
  over: Partial<CacheWindow> = {},
): CacheWindow => ({
  ts: tsAgo(tsAgoMs),
  origin: "main",
  cache_expires_at: tsAgo(tsAgoMs) + HOUR_MS,
  cache_since: tsAgo(sinceAgo),
  cache_count: count,
  next_keepalive_at: tsAgo(tsAgoMs) + INTERVAL_MS,
  cache_until: tsAgo(sinceAgo) + untilCount * INTERVAL_MS + HOUR_MS,
  ...over,
});

describe("cacheRemainingMs", () => {
  test("counts down from the full TTL at the instant of the request", () => {
    expect(cacheRemainingMs(win(0), NOW)).toBe(LLM_PROMPT_CACHE_TTL_MS);
    expect(cacheRemainingMs(win(60_000), NOW)).toBe(LLM_PROMPT_CACHE_TTL_MS - 60_000);
  });

  test("counts down to the gateway's own deadline when it states one", () => {
    // An hour-long window five minutes in still has 55 minutes left; the
    // assumed five minutes would have called it expired.
    expect(cacheRemainingMs(win(300_000, HOUR_MS), NOW)).toBe(3_300_000);
  });

  test("clamps to 0 rather than going negative once the window closes", () => {
    expect(cacheRemainingMs(win(LLM_PROMPT_CACHE_TTL_MS), NOW)).toBe(0);
    expect(cacheRemainingMs(win(LLM_PROMPT_CACHE_TTL_MS + 60_000), NOW)).toBe(0);
    expect(cacheRemainingMs(win(HOUR_MS, HOUR_MS), NOW)).toBe(0);
  });
});

describe("cacheRingPhase", () => {
  test("a series nobody is keeping alive is one sweep of its own window", () => {
    expect(cacheRingPhase(win(300_000, HOUR_MS), NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: tsAgo(300_000) + HOUR_MS,
    });
  });

  test("the first cache is swept only up to the marker that takes over", () => {
    // `cache_count` 0: the conversation still owns this cache, and it owns it
    // until the machinery steps in — which is what `next_keepalive_at` says.
    expect(cacheRingPhase(firstCache(300_000, INTERVAL_MS), NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: NOW + INTERVAL_MS,
    });
  });

  test("with no marker planned, the first cache runs to its own deadline", () => {
    const noPlan: CacheWindow = { ...firstCache(300_000, 0), next_keepalive_at: undefined };
    expect(cacheRingPhase(noPlan, NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: tsAgo(300_000) + HOUR_MS,
    });
  });

  test("the first marker turns the ring into one sweep of the whole chain", () => {
    // From `cache_count` 1 on, what is being spent is the chain, so the sweep
    // spans it end to end and starts already partly gone.
    const chain = chained(70 * 60_000, 300_000);
    expect(cacheRingPhase(chain, NOW)).toEqual({
      phase: "extended",
      start: tsAgo(70 * 60_000),
      end: defined(chain.cache_until, "the chain's cache_until"),
    });
  });

  test("a marker does not restart the chain's sweep", () => {
    // Same chain, one marker later: both ends are the same instants, so the
    // ring carries on from where it was rather than filling up again.
    const second = cacheRingPhase(chained(70 * 60_000, 300_000, 2), NOW);
    const third = cacheRingPhase(chained(70 * 60_000, 60_000, 3), NOW);
    expect(third?.start).toBe(defined(second, "the ring phase").start);
    expect(third?.end).toBe(defined(second, "the ring phase").end);
  });

  test("a paused chain is drawn as the plain window it has become", () => {
    // The markers that would reach `cache_until` are not being sent, so a ring
    // running to it would promise hours nothing is going to deliver.
    const paused = chained(70 * 60_000, 300_000, 2, 9, { cache_paused: true });
    expect(cacheRingPhase(paused, NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: tsAgo(300_000) + HOUR_MS,
    });
  });

  test("the live window decides whether anything is drawn, in both phases", () => {
    // `cache_until` is a projection of markers still to come. When the last
    // cache built has itself gone cold, the chain is over however far that
    // projection reached, and the row goes dark.
    expect(cacheRingPhase(chained(3 * HOUR_MS, HOUR_MS + 60_000), NOW)).toBeNull();
  });

  test("a projection that has already run out falls back to the last cache", () => {
    // Back on the first ring's terms: it ends where the next marker is due.
    const stale = chained(3 * HOUR_MS, 300_000, 2, 9, { cache_until: NOW - 60_000 });
    expect(cacheRingPhase(stale, NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: tsAgo(300_000) + INTERVAL_MS,
    });
  });
});

/** How far into the sweep `props` is at NOW (0 = full ring, 1 = gone). */
const progressNow = (props: ReturnType<typeof cacheRingProps>): number =>
  cacheRingProgress(defined(props, "the ring props"), NOW);

describe("cacheRingProps", () => {
  test("a request that just landed starts the sweep from the full ring", () => {
    const props = defined(cacheRingProps(win(0), NOW), "the ring props");
    expect(progressNow(props)).toBe(0);
    // The length comes from the protocol constant, not a literal, so the ring
    // and the daemon's pruning can never disagree about the assumed TTL.
    expect(props.end - props.start).toBe(LLM_PROMPT_CACHE_TTL_MS);
  });

  test("an in-flight window is already partly gone", () => {
    // Half the TTL gone: half the ring is gone.
    expect(progressNow(cacheRingProps(win(150_000), NOW))).toBe(0.5);
    expect(progressNow(cacheRingProps(win(48_000), NOW))).toBe(0.16);
  });

  test("a stated window drives both the sweep length and how much is gone", () => {
    // One sweep is the whole hour, so five minutes in the ring is 1/12 gone —
    // the fraction a reader takes off it means "how much is left", whatever
    // the window's length.
    const props = defined(cacheRingProps(win(300_000, HOUR_MS), NOW), "the ring props");
    expect(props.end - props.start).toBe(HOUR_MS);
    expect(progressNow(props)).toBeCloseTo(1 / 12, 12);
  });

  test("a new window is a new sweep", () => {
    // Same element, consecutive windows: the span moves, and the ring is
    // drawn from the new one (full again).
    const first = defined(cacheRingProps({ ts: tsAgo(45_000) }, NOW), "the first ring");
    const second = defined(cacheRingProps({ ts: NOW }, NOW), "the second ring");
    expect(second.start).not.toBe(first.start);
    expect(progressNow(second)).toBe(0);
  });

  test("the chain is a different colour, one sweep end to end", () => {
    const first = cacheRingProps(firstCache(300_000, INTERVAL_MS), NOW);
    const chain = defined(cacheRingProps(chained(70 * 60_000, 300_000), NOW), "the chain");
    expect(first?.class).toBe("cache-ring");
    expect(chain.class).toBe("cache-ring cache-ring-extended");
    // 555 minutes of chain, 70 of them already spent.
    expect(chain.end - chain.start).toBe(555 * 60_000);
    expect(progressNow(chain)).toBeCloseTo(70 / 555, 12);
  });

  test("a marker leaves the running ring alone", () => {
    // Same span, one marker later: an equal value, so the ring keeps the
    // sweep it is already running.
    const second = cacheRingProps(chained(70 * 60_000, 300_000, 2), NOW);
    const third = cacheRingProps(chained(70 * 60_000, 60_000, 3), NOW);
    expect(third).toEqual(defined(second, "the ring props"));
  });

  test("a request that cached nothing draws no ring at all", () => {
    // An event that states `origin` states a deadline for everything it
    // cached, so this request cached nothing — an assumed five minutes here
    // would be a countdown on a cache that does not exist.
    expect(cacheRingProps({ ts: tsAgo(1_000), origin: "main" }, NOW)).toBeNull();
    expect(cacheRemainingMs({ ts: tsAgo(1_000), origin: "unknown" }, NOW)).toBe(0);
    // Same event shape minus the origin says nothing about caching either way
    // and keeps the assumed window.
    expect(cacheRingProps({ ts: tsAgo(1_000) }, NOW)).not.toBeNull();
  });

  test("returns null when there is no ring to draw", () => {
    expect(cacheRingProps(null, NOW)).toBeNull();
    expect(cacheRingProps(win(LLM_PROMPT_CACHE_TTL_MS), NOW)).toBeNull();
    expect(cacheRingProps(win(LLM_PROMPT_CACHE_TTL_MS + 1_000), NOW)).toBeNull();
    expect(cacheRingProps(win(HOUR_MS, HOUR_MS), NOW)).toBeNull();
  });

  test("a clock-skewed future timestamp keeps the ring full until it starts", () => {
    // The ring then simply starts a little late rather than drawing a sweep
    // that runs backwards.
    const props = defined(cacheRingProps(win(-30_000), NOW), "the ring props");
    expect(props.start).toBe(NOW + 30_000);
    expect(progressNow(props)).toBe(0);
  });
});

describe("cacheRingNextChangeMs", () => {
  test("a plain window changes when it closes", () => {
    expect(cacheRingNextChangeMs(win(60_000), NOW)).toBe(NOW + 240_000);
  });

  test("the first cache changes at the hand-over, then at its own close", () => {
    const first = firstCache(300_000, 60_000);
    expect(cacheRingNextChangeMs(first, NOW)).toBe(NOW + 60_000);
    // Past the hand-over with no marker come back: the window's close is next.
    expect(cacheRingNextChangeMs(first, NOW + 60_000)).toBe(tsAgo(300_000) + HOUR_MS);
  });

  test("the chain changes when the live window closes, if that is before the chain's end", () => {
    const chain = chained(70 * 60_000, 300_000);
    expect(cacheRingNextChangeMs(chain, NOW)).toBe(tsAgo(300_000) + HOUR_MS);
  });

  test("nothing is ahead once the window has closed", () => {
    expect(cacheRingNextChangeMs(win(LLM_PROMPT_CACHE_TTL_MS), NOW)).toBeNull();
  });
});

describe("cacheRingProgress", () => {
  const span = { start: NOW, end: NOW + 300_000 };

  test("runs from 0 at the start to 1 at the end, at a constant speed", () => {
    expect(cacheRingProgress(span, NOW)).toBe(0);
    expect(cacheRingProgress(span, NOW + 75_000)).toBe(0.25);
    expect(cacheRingProgress(span, NOW + 300_000)).toBe(1);
  });

  test("stays full before the start and gone after the end", () => {
    expect(cacheRingProgress(span, NOW - 10_000)).toBe(0);
    expect(cacheRingProgress(span, NOW + 400_000)).toBe(1);
  });
});

describe("cacheRingStepMs", () => {
  test("waits for the line to move half a pixel along the ring", () => {
    // An icon's ring of 80px over five minutes: 160 steps, 1.875s apart.
    expect(CACHE_RING_STEP_PX).toBe(0.5);
    expect(cacheRingStepMs({ start: 0, end: 300_000 }, 80)).toBe(1875);
    // The same ring over an hour moves twelve times slower.
    expect(cacheRingStepMs({ start: 0, end: HOUR_MS }, 80)).toBe(22_500);
    // A longer ring takes shorter steps in time for the same half pixel.
    expect(cacheRingStepMs({ start: 0, end: 300_000 }, 800)).toBe(187.5);
  });

  test("never asks for steps closer than one frame", () => {
    expect(cacheRingStepMs({ start: 0, end: 1_000 }, 2_000)).toBe(16);
  });

  test("a ring with no size yet still takes one step over the sweep", () => {
    expect(cacheRingStepMs({ start: 0, end: 300_000 }, 0)).toBe(300_000);
  });
});
