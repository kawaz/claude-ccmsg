// Ring CSS for a session's prompt-cache window, held stable for the life of
// one sweep.
//
// The memo is the point, not an optimization: the ring's start position is a
// negative animation-delay, which the browser resolves against the moment the
// animation began. Recomputing it on an unrelated re-render (a peers push, a
// keystroke) would hand the same running animation a new, larger offset and
// the ring would visibly jump. Keyed on the sweep's two ends, the value
// changes only when the sweep itself does — which is also exactly when the
// alternating animation name restarts the ring.
//
// The sweep, not the request, is what the key is taken from: the ring changes
// colour and span partway through a kept-alive cache, with no new event to
// notice it by, so the phase has to be recomputed each render and compared.
// It is pure arithmetic over numbers the caller already holds.
import { useMemo } from "preact/hooks";
import {
  cacheRingPhase,
  cacheRingProps,
  type CacheRingProps,
  type CacheWindow,
} from "./llm-cache-view.ts";

/** Ring CSS for the window a session's latest request describes, or null when
 * there is none to draw. `window` may be rebuilt every render — only the
 * numbers inside it are read. */
export function useCacheRing(window: CacheWindow | null): CacheRingProps | null {
  const now = Date.now();
  const span = window === null ? null : cacheRingPhase(window, now);
  const phase =
    span === null ? "" : `${span.phase}:${span.start}:${span.end}:${span.ticks.join(",")}`;
  return useMemo(
    () => (window === null ? null : cacheRingProps(window, Date.now())),
    // The sweep identifies itself: two windows producing the same span produce
    // the same ring, and `window` is deliberately not a dependency (a fresh
    // object every render would defeat the memo outright).
    [phase],
  );
}
