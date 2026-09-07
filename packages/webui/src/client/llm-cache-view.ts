// Prompt-cache ring: turning "this session's cache runs until here" into the
// two CSS values that drive the countdown ring (app.css's `.cache-ring`), and
// into which of its two colours is drawn.
//
// The ring is one linear animation of a registered `--cache-ring-progress`,
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
  /** Epoch ms at which the window opened. */
  ts: number;
  /** Epoch ms at which it closes. Absent means the assumed five minutes on an
   * event that states no `origin`, and "this request cached nothing" on one
   * that does. */
  cache_expires_at?: number;
  /** Present on any event from a gateway that reports it, which is what makes
   * a missing deadline readable as "no cache" rather than "not said". */
  origin?: LlmRequestInfo["origin"];
  /** Start of the keepalive chain: the real request the markers descend from,
   * and the instant the whole chain is measured from once one is running. */
  cache_since?: number;
  /** Position in the chain — 0 on a real request, k on the k-th marker. The
   * one field that says which of the two rings is being drawn. */
  cache_count?: number;
  /** When the gateway plans to send the next marker, which is where the first
   * ring ends: the cache the conversation paid for is only its own until the
   * machinery takes over. */
  next_keepalive_at?: number;
  /** Epoch ms the chain is projected to end at — the second ring's far end. */
  cache_until?: number;
  /** While true the markers are not being sent, so there is no chain to draw
   * and the ring is the plain window again. */
  cache_paused?: boolean;
}

/** Which of the cache's two lives the ring is showing.
 *
 * "window" is the first cache: the one the conversation itself built, drawn
 * from the request that built it. "extended" is the chain of caches the
 * keepalive markers have been rebuilding since, drawn as ONE sweep over the
 * whole chain — it gets its own colour because it is a different thing being
 * spent, and it does not restart per marker: a reader watching it is watching
 * the budget for the chain run down, not each hour of it in turn. */
export type CachePhase = "window" | "extended";

interface RingPhase {
  phase: CachePhase;
  /** Epoch ms bounds of the span this ring sweeps. */
  start: number;
  end: number;
}

/** The span the ring is currently sweeping, or null when the cache is cold.
 *
 * The live window is what decides whether anything is drawn at all, in both
 * phases: `cache_until` is a projection of markers still to be sent, so a
 * gateway that stops sending them must not leave a ring running for the hours
 * that projection reached. The chain is only ever drawn while the cache the
 * last marker built is itself still warm. */
export function cacheRingPhase(window: CacheWindow, now: number): RingPhase | null {
  const windowEnd = llmCacheWindowEndMs(window);
  if (windowEnd <= now) return null;
  const chained =
    window.cache_paused !== true &&
    (window.cache_count ?? 0) >= 1 &&
    window.cache_since !== undefined &&
    window.cache_until !== undefined &&
    window.cache_until > now &&
    window.cache_until > window.cache_since;
  if (chained) {
    return {
      phase: "extended",
      start: window.cache_since as number,
      end: window.cache_until as number,
    };
  }
  // The first cache runs out either when the machinery takes over from the
  // conversation or, with no marker planned, when the cache itself goes cold.
  const planned = window.cache_paused === true ? undefined : window.next_keepalive_at;
  const end = planned !== undefined && planned > window.ts ? planned : windowEnd;
  return { phase: "window", start: window.ts, end };
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
  /** Inline custom properties: where in the animation to start and how long
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
  const span = cacheRingPhase(window, now);
  if (span === null) return null;
  const durationSeconds = (span.end - span.start) / 1000;
  if (durationSeconds <= 0) return null;
  // Not clamped: a request stamped in the future (a skewed gateway clock)
  // yields a positive delay, and the ring simply waits to start rather than
  // rendering a broken animation.
  const elapsedSeconds = (now - span.start) / 1000;
  // Alternating on the second the sweep ENDS in, plus the phase: only a
  // *changed* animation name restarts the ring, and every change of span
  // needs one — keeping the old name would re-map a running timeline onto the
  // new duration and jump the ring. Taking it from the end rather than from
  // `ts` is what leaves the chain's ring alone while markers arrive: the span
  // is unchanged, so the name is too, and the sweep keeps running down.
  const phaseStep = span.phase === "extended" ? 1 : 0;
  const animation =
    RING_ANIMATIONS[(Math.floor(span.end / 1000) + phaseStep) % RING_ANIMATIONS.length];
  const tone = span.phase === "extended" ? " cache-ring-extended" : "";
  return {
    class: `cache-ring ${animation}${tone}`,
    style: {
      "--cache-ring-delay": `${-elapsedSeconds}s`,
      "--cache-ring-duration": `${durationSeconds}s`,
    },
  };
}
