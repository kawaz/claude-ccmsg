// Prompt-cache ring: turning "this session's cache started at `ts`" into the
// two CSS values that drive the countdown ring (app.css's `.cache-ring`).
//
// The ring is one 300s linear animation of a registered `--cache-ring-angle`,
// started mid-flight with a NEGATIVE animation-delay rather than ticked from
// JS: the browser then owns every frame, and the page costs nothing per second
// per session. That leaves this module with just the arithmetic — which is why
// it is pure and tested directly.
import { LLM_PROMPT_CACHE_TTL_MS } from "@ccmsg/protocol";

/** Milliseconds left in the prompt cache window that started at `ts` (epoch
 * SECONDS, the gateway's unit). 0 once the window has closed, so callers can
 * treat "expired" and "never had one" the same way. */
export function cacheRemainingMs(ts: number, now: number): number {
  const deadline = ts * 1000 + LLM_PROMPT_CACHE_TTL_MS;
  return Math.max(0, deadline - now);
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

/** Ring CSS for a window that started at `ts`, or null when there is nothing
 * to draw (no request at all, or its window already closed).
 *
 * Callers must hold the result stable for as long as `ts` is unchanged:
 * recomputing the delay on an unrelated re-render would re-map a running
 * animation's timeline and make the ring jump backwards. `useCacheRing` is
 * the memoized wrapper that guarantees it. */
export function cacheRingProps(ts: number | null, now: number): CacheRingProps | null {
  if (ts === null) return null;
  const remaining = cacheRemainingMs(ts, now);
  if (remaining <= 0) return null;
  const elapsedSeconds = (LLM_PROMPT_CACHE_TTL_MS - remaining) / 1000;
  // Alternating on the second the request landed in: two requests inside one
  // second would not restart the ring, which is invisible at a 300s scale.
  const animation = RING_ANIMATIONS[Math.floor(ts) % RING_ANIMATIONS.length];
  return {
    class: `cache-ring ${animation}`,
    style: {
      "--cache-ring-delay": `${-elapsedSeconds}s`,
      "--cache-ring-duration": `${LLM_PROMPT_CACHE_TTL_MS / 1000}s`,
    },
  };
}
