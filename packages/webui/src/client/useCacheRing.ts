// What a session's prompt-cache window draws as its ring, held as one value
// for the life of one sweep.
//
// The sweep, not the request, is what the key is taken from: the ring changes
// colour and span partway through a kept-alive cache, and goes when the
// window closes, with no new event to notice either by. So the phase is
// recomputed each render and compared, and the hook renders its component
// again at the next instant the phase can change (cacheRingNextChangeMs) —
// nothing else is relied on to render it then. While the sweep is the same,
// so is the value, and the ring keeps the clock it is running (CacheRing.tsx
// starts one per span).
import { useEffect, useState } from "preact/hooks";
import {
  cacheRingNextChangeMs,
  cacheRingPhase,
  cacheRingProps,
  type CacheRingProps,
  type CacheWindow,
} from "./llm-cache-view.ts";
import { useKeyedValue } from "./useKeyedState.ts";

/** The ring for the window a session's latest request describes, or null
 * when there is none to draw. `window` may be rebuilt every render — only the
 * numbers inside it are read. */
export function useCacheRing(window: CacheWindow | null): CacheRingProps | null {
  const now = Date.now();
  const span = window === null ? null : cacheRingPhase(window, now);
  const phase = span === null ? "" : `${span.phase}:${span.start}:${span.end}`;
  const next = window === null ? null : cacheRingNextChangeMs(window, now);
  // Counts the renders the timer below asked for, so each of them looks for
  // the change after it (a hand-over that changes nothing still has the
  // window's close ahead).
  const [passed, setPassed] = useState(0);
  useEffect(() => {
    if (next === null) return;
    const id = setTimeout(() => setPassed((n) => n + 1), next - Date.now());
    return () => clearTimeout(id);
  }, [next, passed]);
  // The sweep identifies itself: two windows producing the same span produce
  // the same ring, so the ring is built once per phase from that render's
  // window.
  return useKeyedValue([phase], () =>
    window === null ? null : cacheRingProps(window, Date.now()),
  );
}
