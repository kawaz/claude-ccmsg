// Ring CSS for a session's prompt-cache window, held stable for the life of
// one window.
//
// The memo is the point, not an optimization: the ring's start position is a
// negative animation-delay, which the browser resolves against the moment the
// animation began. Recomputing it on an unrelated re-render (a peers push, a
// keystroke) would hand the same running animation a new, larger offset and
// the ring would visibly jump. Keyed on the window's two ends, the value
// changes only when the window itself does — which is also exactly when the
// alternating animation name restarts the ring.
//
// The window's fields are passed apart rather than as one object because a
// caller reading them off a fresh request object every render would defeat the
// memo: primitives compare equal, an object never does.
import type { LlmRequestInfo } from "@ccmsg/protocol";
import { useMemo } from "preact/hooks";
import { cacheRingProps, type CacheRingProps } from "./llm-cache-view.ts";

/** `ts` is LlmRequestInfo.ts (epoch seconds), or null when this session has no
 * live window; `expiresAt` and `origin` are the same request's
 * `cache_expires_at` and `origin`. Returns null when there is no ring to
 * draw. */
export function useCacheRing(
  ts: number | null,
  expiresAt?: number,
  origin?: LlmRequestInfo["origin"],
): CacheRingProps | null {
  return useMemo(
    () =>
      cacheRingProps(ts === null ? null : { ts, cache_expires_at: expiresAt, origin }, Date.now()),
    [ts, expiresAt, origin],
  );
}
