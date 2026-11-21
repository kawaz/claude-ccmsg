// Prompt-cache ring: turning "this session's cache runs until here" into the
// span the countdown ring sweeps, how far into it the ring is at a given
// instant, how long the ring may wait before its line has moved enough to see,
// and which of its two colours is drawn. CacheRing.tsx writes the progress
// onto the ring at those steps; this module is the arithmetic, which is why it
// is pure and tested directly.
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
  const since = window.cache_since;
  const until = window.cache_until;
  const chained =
    window.cache_paused !== true &&
    (window.cache_count ?? 0) >= 1 &&
    since !== undefined &&
    until !== undefined &&
    until > now &&
    until > since;
  if (chained) return { phase: "extended", start: since, end: until };
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

/** The span a ring sweeps, in epoch ms: full at `start`, gone at `end`. */
export interface CacheRingSpan {
  start: number;
  end: number;
}

export interface CacheRingProps extends CacheRingSpan {
  /** Class list for the ring-bearing element: its colour (the chain's is
   * `cache-ring-extended`). Where the line is comes from the span. */
  class: string;
}

/** What `window` draws, or null when there is nothing to draw (no request at
 * all, or its window already closed). A marker that leaves the chain's span
 * as it was gives an equal value, so the sweep carries on. */
export function cacheRingProps(window: CacheWindow | null, now: number): CacheRingProps | null {
  if (window === null) return null;
  const span = cacheRingPhase(window, now);
  if (span === null || span.end <= span.start) return null;
  const tone = span.phase === "extended" ? " cache-ring-extended" : "";
  return { class: `cache-ring${tone}`, start: span.start, end: span.end };
}

/** The next instant after `now` at which `cacheRingProps` may answer
 * differently for the same `window` with no new event: the sweep's end (the
 * chain's projection running out, the first cache's hand-over) or the live
 * window closing. null once neither is ahead. */
export function cacheRingNextChangeMs(window: CacheWindow, now: number): number | null {
  const ends = [llmCacheWindowEndMs(window), cacheRingPhase(window, now)?.end];
  const ahead = ends.filter((end): end is number => end !== undefined && end > now);
  return ahead.length === 0 ? null : Math.min(...ahead);
}

/** How much of `span` has gone at `now`, 0 (full ring) to 1 (gone). A span
 * stamped in the future (a skewed gateway clock) stays full until it starts. */
export function cacheRingProgress(span: CacheRingSpan, now: number): number {
  return Math.min(1, Math.max(0, (now - span.start) / (span.end - span.start)));
}

/** How far the end of the line moves in one step, in CSS px along the ring.
 * Half a pixel is under what the eye can tell from a continuous sweep: the
 * line's end is anti-aliased, and a step lands seconds apart on a ring of an
 * icon's size. */
export const CACHE_RING_STEP_PX = 0.5;

/** The shortest wait between steps: one frame at 60Hz. A ring short enough
 * to move a step faster than that would only ask for frames the screen does
 * not show. */
const MIN_STEP_MS = 16;

/** The wait before the line of a ring `perimeterPx` long has moved
 * `CACHE_RING_STEP_PX`, sweeping `span` at its constant speed. */
export function cacheRingStepMs(span: CacheRingSpan, perimeterPx: number): number {
  const steps = Math.max(1, perimeterPx / CACHE_RING_STEP_PX);
  return Math.max(MIN_STEP_MS, (span.end - span.start) / steps);
}
