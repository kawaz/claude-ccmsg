// Ring CSS for a session's prompt-cache window, held stable for the life of
// one window.
//
// The memo is the point, not an optimization: the ring's start position is a
// negative animation-delay, which the browser resolves against the moment the
// animation began. Recomputing it on an unrelated re-render (a peers push, a
// keystroke) would hand the same running animation a new, larger offset and
// the ring would visibly jump. Keyed on `ts`, the value changes only when the
// window itself does — which is also exactly when the alternating animation
// name restarts the ring.
import { useMemo } from "preact/hooks";
import { cacheRingProps, type CacheRingProps } from "./llm-cache-view.ts";

/** `ts` is LlmRequestInfo.ts (epoch seconds), or null when this session has no
 * live window. Returns null when there is no ring to draw. */
export function useCacheRing(ts: number | null): CacheRingProps | null {
  return useMemo(() => cacheRingProps(ts, Date.now()), [ts]);
}
