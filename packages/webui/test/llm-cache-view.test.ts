// Prompt-cache ring arithmetic (llm-cache-view.ts). Every instant on the wire
// is epoch ms, the CSS animation is positioned by a seconds offset, and the
// whole ring is driven by the values computed here — so this is where the unit
// boundary, the "start mid-animation" offset, and the hand-off from the first
// cache to the chain of kept-alive ones get pinned down.
import { describe, expect, test } from "bun:test";
import { LLM_PROMPT_CACHE_TTL_MS } from "@ccmsg/protocol";
import {
  type CacheWindow,
  cacheKeepaliveTicks,
  cacheRemainingMs,
  cacheRingPhase,
  cacheRingProps,
} from "../src/client/llm-cache-view.ts";

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
  cache_ttl_secs: 3600,
  cache_since: tsAgo(tsAgoMs),
  cache_count: 0,
  next_keepalive_at: NOW + plannedIn,
  cache_until: tsAgo(tsAgoMs) + 9 * INTERVAL_MS + HOUR_MS,
  cache_until_count: 9,
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
  cache_ttl_secs: 3600,
  cache_since: tsAgo(sinceAgo),
  cache_count: count,
  next_keepalive_at: tsAgo(tsAgoMs) + INTERVAL_MS,
  cache_until: tsAgo(sinceAgo) + untilCount * INTERVAL_MS + HOUR_MS,
  cache_until_count: untilCount,
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

describe("cacheKeepaliveTicks", () => {
  test("one tick per marker, at the instant each new cache is built", () => {
    const chain = chained(70 * 60_000, 300_000);
    const ticks = cacheKeepaliveTicks(chain);
    expect(ticks).toHaveLength(9);
    expect(ticks[0]).toBe((chain.cache_since as number) + INTERVAL_MS);
    expect(ticks[8]).toBe((chain.cache_since as number) + 9 * INTERVAL_MS);
  });

  test("the last tick is the marker `cache_until` was measured from", () => {
    // The check that catches an off-by-one: `cache_until` is the last marker
    // PLUS the cache it builds, so the last tick has to land exactly one TTL
    // short of it. Dividing the sweep into 9 would put it 60 minutes early.
    const chain = chained(70 * 60_000, 300_000);
    const ticks = cacheKeepaliveTicks(chain);
    expect(ticks.at(-1)).toBe(
      (chain.cache_until as number) - (chain.cache_ttl_secs as number) * 1000,
    );
    // Spelled out in the units the gateway works in: 9 markers 55 minutes
    // apart plus a 60-minute cache is a 555-minute sweep whose last mark sits
    // at 495 minutes.
    expect((chain.cache_until as number) - (chain.cache_since as number)).toBe(555 * 60_000);
    expect((ticks.at(-1) as number) - (chain.cache_since as number)).toBe(495 * 60_000);
  });

  test("the interval falls back to what the projection implies", () => {
    // No `next_keepalive_at` to state it: backing the last cache out of
    // `cache_until` leaves the span the markers divide, which lands the ticks
    // in the same places.
    const chain = chained(70 * 60_000, 300_000, 2, 9, { next_keepalive_at: undefined });
    expect(cacheKeepaliveTicks(chain)).toEqual(cacheKeepaliveTicks(chained(70 * 60_000, 300_000)));
  });

  test("a chain of one marker still gets its mark", () => {
    // Nothing about one marker makes it unworth marking: the ring still says
    // "one more cache after this one", and the mark is where it starts.
    const chain = chained(70 * 60_000, 300_000, 2, 1);
    const ticks = cacheKeepaliveTicks(chain);
    expect(ticks).toHaveLength(1);
    expect(ticks[0]).toBe((chain.cache_since as number) + INTERVAL_MS);
    expect(ticks[0]).toBe((chain.cache_until as number) - (chain.cache_ttl_secs as number) * 1000);
    // And it reaches the ring rather than being filtered out on the way.
    expect(cacheRingProps(chain, NOW)?.ticks).toBe(1);
  });

  test("no markers planned, no marks", () => {
    expect(cacheKeepaliveTicks(chained(70 * 60_000, 300_000, 2, 0))).toEqual([]);
    expect(
      cacheKeepaliveTicks(chained(70 * 60_000, 300_000, 2, 9, { cache_until_count: undefined })),
    ).toEqual([]);
    expect(cacheKeepaliveTicks(win(300_000, HOUR_MS))).toEqual([]);
  });
});

describe("cacheRingPhase", () => {
  test("a series nobody is keeping alive is one sweep of its own window", () => {
    expect(cacheRingPhase(win(300_000, HOUR_MS), NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: tsAgo(300_000) + HOUR_MS,
      ticks: [],
    });
  });

  test("the first cache is swept only up to the marker that takes over", () => {
    // `cache_count` 0: the conversation still owns this cache, and it owns it
    // until the machinery steps in — which is what `next_keepalive_at` says.
    // No marks either: the first ring is one cache, and marking it off into
    // the chain's nine would count caches that do not exist yet.
    expect(cacheRingPhase(firstCache(300_000, INTERVAL_MS), NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: NOW + INTERVAL_MS,
      ticks: [],
    });
  });

  test("with no marker planned, the first cache runs to its own deadline", () => {
    const noPlan: CacheWindow = { ...firstCache(300_000, 0), next_keepalive_at: undefined };
    expect(cacheRingPhase(noPlan, NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: tsAgo(300_000) + HOUR_MS,
      ticks: [],
    });
  });

  test("the first marker turns the ring into one sweep of the whole chain", () => {
    // From `cache_count` 1 on, what is being spent is the chain, so the sweep
    // spans it end to end and starts already partly gone.
    const chain = chained(70 * 60_000, 300_000);
    expect(cacheRingPhase(chain, NOW)).toEqual({
      phase: "extended",
      start: tsAgo(70 * 60_000),
      end: chain.cache_until as number,
      ticks: cacheKeepaliveTicks(chain),
    });
  });

  test("a marker does not restart the chain's sweep", () => {
    // Same chain, one marker later: both ends are the same instants, so the
    // ring carries on from where it was rather than filling up again.
    const second = cacheRingPhase(chained(70 * 60_000, 300_000, 2), NOW);
    const third = cacheRingPhase(chained(70 * 60_000, 60_000, 3), NOW);
    expect(third?.start).toBe(second?.start as number);
    expect(third?.end).toBe(second?.end as number);
    expect(third?.ticks).toEqual(second?.ticks as number[]);
  });

  test("a projection that does not add up costs the marks, not the ring", () => {
    // An interval wide enough to put a marker past the sweep's own end: the
    // dash pattern would wrap it round to a place that means nothing, so the
    // marks are dropped and the countdown is kept.
    const skewed = chained(70 * 60_000, 300_000, 2, 9, { next_keepalive_at: NOW + 20 * HOUR_MS });
    const span = cacheRingPhase(skewed, NOW);
    expect(span?.phase).toBe("extended");
    expect(span?.ticks).toEqual([]);
  });

  test("a paused chain is drawn as the plain window it has become", () => {
    // The markers that would reach `cache_until` are not being sent, so a ring
    // running to it would promise hours nothing is going to deliver.
    const paused = chained(70 * 60_000, 300_000, 2, 9, { cache_paused: true });
    expect(cacheRingPhase(paused, NOW)).toEqual({
      phase: "window",
      start: tsAgo(300_000),
      end: tsAgo(300_000) + HOUR_MS,
      ticks: [],
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
      ticks: [],
    });
  });
});

describe("cacheRingProps", () => {
  test("a request that just landed starts the animation from the beginning", () => {
    const props = cacheRingProps(win(0), NOW);
    expect(props?.style["--cache-ring-delay"]).toBe("0s");
    // The duration comes from the protocol constant, not a CSS literal, so
    // the ring and the daemon's pruning can never disagree about the assumed
    // TTL either.
    expect(props?.style["--cache-ring-duration"]).toBe("300s");
  });

  test("an in-flight window starts mid-animation via a negative delay", () => {
    // Half the TTL gone: the animation must already be half done, which is
    // exactly what a delay of minus-half-the-duration expresses.
    expect(cacheRingProps(win(150_000), NOW)?.style["--cache-ring-delay"]).toBe("-150s");
    expect(cacheRingProps(win(48_000), NOW)?.style["--cache-ring-delay"]).toBe("-48s");
  });

  test("a stated window drives both the sweep length and the offset", () => {
    // One sweep is the whole hour, so five minutes in the ring is 1/12 gone —
    // the fraction a reader takes off it means "how much is left", whatever
    // the window's length.
    const props = cacheRingProps(win(300_000, HOUR_MS), NOW);
    expect(props?.style["--cache-ring-duration"]).toBe("3600s");
    expect(props?.style["--cache-ring-delay"]).toBe("-300s");
  });

  test("the animation name alternates so a new sweep restarts the ring", () => {
    // Same element, consecutive windows: the name must differ, or the browser
    // keeps running the old animation toward its old end time.
    const first = cacheRingProps({ ts: 1_785_564_700_000 }, NOW);
    const second = cacheRingProps({ ts: 1_785_564_701_000 }, NOW);
    expect(first?.class).toBe("cache-ring cache-ring-a");
    expect(second?.class).toBe("cache-ring cache-ring-b");
  });

  test("the chain is a different colour and carries one mark per marker", () => {
    const first = cacheRingProps(firstCache(300_000, INTERVAL_MS), NOW);
    const chain = cacheRingProps(chained(70 * 60_000, 300_000), NOW);
    expect(first?.class).not.toContain("cache-ring-extended");
    expect(first?.ticks).toBe(0);
    expect(first?.tickDash).toBeNull();
    expect(chain?.class).toContain("cache-ring-extended");
    expect(chain?.ticks).toBe(9);
    // 555 minutes of chain, 70 of them already spent.
    expect(chain?.style["--cache-ring-duration"]).toBe(`${555 * 60}s`);
    expect(chain?.style["--cache-ring-delay"]).toBe("-4200s");
  });

  test("the marks land on the markers, as a pattern that spans the ring once", () => {
    const dash = cacheRingProps(chained(70 * 60_000, 300_000), NOW)?.tickDash as string;
    // One gap + one mark per marker, plus the opening zero dash and the
    // closing gap: the pattern covers the perimeter exactly once, so it never
    // repeats a mark into the final cache's stretch.
    const widths = dash.split(", ");
    expect(widths).toHaveLength(2 * 9 + 2);
    expect(widths[0]).toBe("0");
    // First mark at 55/555 of the sweep, last at 495/555.
    expect(widths[1]).toContain((55 / 555).toFixed(6));
    expect(widths.at(-1)).toContain((60 / 555).toFixed(6));
    // Every mark itself is one line width, whatever the shape's perimeter.
    expect(widths.filter((w) => w === "var(--cache-ring-tick-width)")).toHaveLength(9);
  });

  test("a marker leaves the running ring alone", () => {
    // Same span, one marker later: identical animation name, offset and
    // marks, so the browser keeps the sweep it is already running.
    const second = cacheRingProps(chained(70 * 60_000, 300_000, 2), NOW);
    const third = cacheRingProps(chained(70 * 60_000, 60_000, 3), NOW);
    expect(third?.class).toBe(second?.class);
    expect(third?.style).toEqual(second?.style as Record<string, string>);
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

  test("a clock-skewed future timestamp yields a positive delay, not a crash", () => {
    // The ring then simply starts a little late rather than the element
    // rendering with a broken animation.
    expect(cacheRingProps(win(-30_000), NOW)?.style["--cache-ring-delay"]).toBe("30s");
  });
});
