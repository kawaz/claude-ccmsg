// Prompt-cache ring arithmetic (llm-cache-view.ts). The gateway stamps
// seconds, the CSS animation is positioned by a seconds offset, and the whole
// ring is driven by the two values computed here — so this is where the unit
// boundary and the "start mid-animation" offset get pinned down.
import { describe, expect, test } from "bun:test";
import { LLM_PROMPT_CACHE_TTL_MS } from "@ccmsg/protocol";
import { cacheRemainingMs, cacheRingProps } from "../src/client/llm-cache-view.ts";

const NOW = 1_785_564_745_000;
/** A request that happened `ms` before NOW, in the gateway's seconds. */
const tsAgo = (ms: number): number => (NOW - ms) / 1000;

describe("cacheRemainingMs", () => {
  test("counts down from the full TTL at the instant of the request", () => {
    expect(cacheRemainingMs(tsAgo(0), NOW)).toBe(LLM_PROMPT_CACHE_TTL_MS);
    expect(cacheRemainingMs(tsAgo(60_000), NOW)).toBe(LLM_PROMPT_CACHE_TTL_MS - 60_000);
  });

  test("clamps to 0 rather than going negative once the window closes", () => {
    expect(cacheRemainingMs(tsAgo(LLM_PROMPT_CACHE_TTL_MS), NOW)).toBe(0);
    expect(cacheRemainingMs(tsAgo(LLM_PROMPT_CACHE_TTL_MS + 60_000), NOW)).toBe(0);
  });
});

describe("cacheRingProps", () => {
  test("a request that just landed starts the animation from the beginning", () => {
    const props = cacheRingProps(tsAgo(0), NOW);
    expect(props?.style["--cache-ring-delay"]).toBe("0s");
    // The duration comes from the protocol constant, not a CSS literal, so
    // the ring and the daemon's pruning can never disagree about the TTL.
    expect(props?.style["--cache-ring-duration"]).toBe("300s");
  });

  test("an in-flight window starts mid-animation via a negative delay", () => {
    // Half the TTL gone: the animation must already be half done, which is
    // exactly what a delay of minus-half-the-duration expresses.
    expect(cacheRingProps(tsAgo(150_000), NOW)?.style["--cache-ring-delay"]).toBe("-150s");
    expect(cacheRingProps(tsAgo(48_000), NOW)?.style["--cache-ring-delay"]).toBe("-48s");
  });

  test("the animation name alternates so a new request restarts the ring", () => {
    // Same element, consecutive windows: the name must differ, or the browser
    // keeps running the old animation toward its old end time.
    const first = cacheRingProps(1_785_564_700, NOW);
    const second = cacheRingProps(1_785_564_701, NOW);
    expect(first?.class).toBe("cache-ring cache-ring-a");
    expect(second?.class).toBe("cache-ring cache-ring-b");
  });

  test("returns null when there is no ring to draw", () => {
    expect(cacheRingProps(null, NOW)).toBeNull();
    expect(cacheRingProps(tsAgo(LLM_PROMPT_CACHE_TTL_MS), NOW)).toBeNull();
    expect(cacheRingProps(tsAgo(LLM_PROMPT_CACHE_TTL_MS + 1_000), NOW)).toBeNull();
  });

  test("a clock-skewed future timestamp yields a positive delay, not a crash", () => {
    // The ring then simply starts a little late rather than the element
    // rendering with a broken animation.
    expect(cacheRingProps(tsAgo(-30_000), NOW)?.style["--cache-ring-delay"]).toBe("30s");
  });
});
