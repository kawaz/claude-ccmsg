// Prompt-cache ring: turning "this session's cache runs from `ts` to
// `cache_expires_at`" into the two CSS values that drive the countdown ring
// (app.css's `.cache-ring`).
//
// The ring is one linear animation of a registered `--cache-ring-angle`,
// started mid-flight with a NEGATIVE animation-delay rather than ticked from
// JS: the browser then owns every frame, and the page costs nothing per second
// per session. That leaves this module with just the arithmetic — which is why
// it is pure and tested directly.
//
// A full sweep is the whole window, not a fixed five minutes: the gateway asks
// for a 5-minute or a 1-hour cache, and a ring that always drained in 300s
// would read as "expired" for the 55 minutes an hour-long window still has
// left. What the ring says is the FRACTION remaining; the row's other text is
// where an exact duration would belong.
import { type LlmRequestInfo, llmCacheWindowEndMs } from "@ccmsg/protocol";

/** The window one request opened, in the gateway's own units — the fields of
 * `LlmRequestInfo` the ring reads, and nothing else, so a caller can hand over
 * a request or synthesize one. */
export interface CacheWindow {
  /** Epoch SECONDS at which the window opened. */
  ts: number;
  /** Epoch SECONDS at which it closes. Absent means the assumed five minutes
   * on an event that states no `origin`, and "this request cached nothing" on
   * one that does. */
  cache_expires_at?: number;
  /** Present on any event from a gateway that reports it, which is what makes
   * a missing deadline readable as "no cache" rather than "not said". */
  origin?: LlmRequestInfo["origin"];
}

/** Milliseconds left in `window`. 0 once it has closed, so callers can treat
 * "expired" and "never had one" the same way. */
export function cacheRemainingMs(window: CacheWindow, now: number): number {
  return Math.max(0, llmCacheWindowEndMs(window) - now);
}

/** The two animation names alternate so a new request restarts the ring:
 * re-declaring the same animation-name leaves a running animation running, and
 * only a *changed* name restarts it. The alternative — remounting the element
 * — would cost the composer its focus and caret mid-typing. */
const RING_ANIMATIONS = ["cache-ring-a", "cache-ring-b"] as const;

export interface CacheRingProps {
  /** Class list for the ring-bearing element. */
  class: string;
  /** Inline custom properties: where in the animation to start, and how long
   * it runs (kept here so the TTL keeps its single source, the protocol). */
  style: Record<string, string>;
}

/** Ring CSS for `window`, or null when there is nothing to draw (no request
 * at all, or its window already closed).
 *
 * Callers must hold the result stable for as long as the window is unchanged:
 * recomputing the delay on an unrelated re-render would re-map a running
 * animation's timeline and make the ring jump backwards. `useCacheRing` is
 * the memoized wrapper that guarantees it. */
export function cacheRingProps(window: CacheWindow | null, now: number): CacheRingProps | null {
  if (window === null) return null;
  const remaining = cacheRemainingMs(window, now);
  if (remaining <= 0) return null;
  const durationSeconds = (llmCacheWindowEndMs(window) - window.ts * 1000) / 1000;
  const elapsedSeconds = durationSeconds - remaining / 1000;
  // Alternating on the second the request landed in: two requests inside one
  // second would not restart the ring, which is invisible at a 300s scale.
  const animation = RING_ANIMATIONS[Math.floor(window.ts) % RING_ANIMATIONS.length];
  return {
    class: `cache-ring ${animation}`,
    style: {
      "--cache-ring-delay": `${-elapsedSeconds}s`,
      "--cache-ring-duration": `${durationSeconds}s`,
    },
  };
}
