// Prompt-cache ring arithmetic (llm-cache-view.ts). The gateway stamps
// seconds, the CSS animation is positioned by a seconds offset, and the whole
// ring is driven by the two values computed here — so this is where the unit
// boundary and the "start mid-animation" offset get pinned down.
import { describe, expect, test } from "bun:test";
import { LLM_PROMPT_CACHE_TTL_MS } from "@ccmsg/protocol";
import {
  type CacheWindow,
  cacheRemainingMs,
  cacheRingProps,
} from "../src/client/llm-cache-view.ts";

const NOW = 1_785_564_745_000;
/** A request that happened `ms` before NOW, in the gateway's seconds. */
const tsAgo = (ms: number): number => (NOW - ms) / 1000;
/** A window opened `ms` before NOW, of the length the gateway stated (or, with
 * `ttlMs` omitted, of the length ccmsg assumes when it stated none). */
const win = (ms: number, ttlMs?: number): CacheWindow =>
  ttlMs === undefined
    ? { ts: tsAgo(ms) }
    : { ts: tsAgo(ms), cache_expires_at: tsAgo(ms) + ttlMs / 1000 };

describe("cacheRemainingMs", () => {
  test("counts down from the full TTL at the instant of the request", () => {
    expect(cacheRemainingMs(win(0), NOW)).toBe(LLM_PROMPT_CACHE_TTL_MS);
    expect(cacheRemainingMs(win(60_000), NOW)).toBe(LLM_PROMPT_CACHE_TTL_MS - 60_000);
  });

  test("counts down to the gateway's own deadline when it states one", () => {
    // An hour-long window five minutes in still has 55 minutes left; the
    // assumed five minutes would have called it expired.
    expect(cacheRemainingMs(win(300_000, 3_600_000), NOW)).toBe(3_300_000);
  });

  test("clamps to 0 rather than going negative once the window closes", () => {
    expect(cacheRemainingMs(win(LLM_PROMPT_CACHE_TTL_MS), NOW)).toBe(0);
    expect(cacheRemainingMs(win(LLM_PROMPT_CACHE_TTL_MS + 60_000), NOW)).toBe(0);
    expect(cacheRemainingMs(win(3_600_000, 3_600_000), NOW)).toBe(0);
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
    const props = cacheRingProps(win(300_000, 3_600_000), NOW);
    expect(props?.style["--cache-ring-duration"]).toBe("3600s");
    expect(props?.style["--cache-ring-delay"]).toBe("-300s");
  });

  test("the animation name alternates so a new request restarts the ring", () => {
    // Same element, consecutive windows: the name must differ, or the browser
    // keeps running the old animation toward its old end time. A keepalive
    // ping arrives as such a window, which is what makes an extended deadline
    // redraw rather than finish on the old one.
    const first = cacheRingProps({ ts: 1_785_564_700 }, NOW);
    const second = cacheRingProps({ ts: 1_785_564_701 }, NOW);
    expect(first?.class).toBe("cache-ring cache-ring-a");
    expect(second?.class).toBe("cache-ring cache-ring-b");
  });

  test("a request that cached nothing draws no ring at all", () => {
    // A gateway that states `origin` states a deadline for everything it
    // cached, so this request cached nothing — an assumed five minutes here
    // would be a countdown on a cache that does not exist.
    expect(cacheRingProps({ ts: tsAgo(1_000), origin: "main" }, NOW)).toBeNull();
    expect(cacheRemainingMs({ ts: tsAgo(1_000), origin: "unknown" }, NOW)).toBe(0);
    // Same event shape minus the origin is a pre-v0.33.0 gateway, which said
    // nothing about caching either way and keeps the assumed window.
    expect(cacheRingProps({ ts: tsAgo(1_000) }, NOW)).not.toBeNull();
  });

  test("returns null when there is no ring to draw", () => {
    expect(cacheRingProps(null, NOW)).toBeNull();
    expect(cacheRingProps(win(LLM_PROMPT_CACHE_TTL_MS), NOW)).toBeNull();
    expect(cacheRingProps(win(LLM_PROMPT_CACHE_TTL_MS + 1_000), NOW)).toBeNull();
    expect(cacheRingProps(win(3_600_000, 3_600_000), NOW)).toBeNull();
  });

  test("a clock-skewed future timestamp yields a positive delay, not a crash", () => {
    // The ring then simply starts a little late rather than the element
    // rendering with a broken animation.
    expect(cacheRingProps(win(-30_000), NOW)?.style["--cache-ring-delay"]).toBe("30s");
  });
});
