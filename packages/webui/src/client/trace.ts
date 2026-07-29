// Browser half of the transcript latency trace. The daemon times the file-side
// boundaries (detect -> read -> wire write); the three that only exist in the
// tab (ws_receive -> store_dispatch -> dom_commit) are collected here and posted
// back with `client_trace`, so one trace.jsonl holds the whole file-to-DOM path.
// Correlation key is (sid, start, end): the byte range the daemon put on the wire.
//
// See docs/runbooks/transcript-latency-trace.md for the jq recipes that join them.
import type { ClientTracePoint, ClientTraceRequest } from "@ccmsg/protocol";

/** A delivery slower than this always reports. This is the trace's reason for
 * existing — a timeline that lags by a second is exactly what we want a record
 * of, so sampling must never be what loses it. */
export const SLOW_DELIVERY_MS = 1000;

/** Of the deliveries that were NOT slow, report 1 in this many. A streaming
 * assistant turn can push tens of tails per second and each report costs a WS
 * round trip; tracing every one of them would measurably add to the latency the
 * trace is supposed to observe. A 1/20 baseline keeps steady-state overhead near
 * the noise floor while still building a healthy-case distribution to compare a
 * slow delivery against. */
export const HEALTHY_SAMPLE_EVERY = 20;

/** Deliveries still waiting for their DOM commit. Bounded because a hidden or
 * unmounted Timeline never commits, and an unbounded map would grow for as long
 * as that tab stays open. */
const MAX_PENDING = 64;

/** `seq` is the count of completed deliveries so far, so the healthy-case sample
 * is spread evenly instead of clustering. */
export function shouldReportTrace(
  elapsedMs: number,
  seq: number,
  slowMs = SLOW_DELIVERY_MS,
  every = HEALTHY_SAMPLE_EVERY,
): boolean {
  if (elapsedMs > slowMs) return true;
  return seq % every === 0;
}

interface Pending {
  sid: string;
  start: number;
  end: number;
  size: number;
  receivedAtMs: number;
  points: ClientTracePoint[];
}

export interface TraceCollectorOptions {
  /** Posts the batch to the daemon. Failures are ignored by the caller: tracing
   * must never break the timeline it observes. */
  post: (req: ClientTraceRequest) => void;
  /** Injectable for tests. Wall clock, because these timestamps are compared
   * against the daemon's ISO timestamps in the same file. */
  now?: () => number;
  slowMs?: number;
  sampleEvery?: number;
}

export interface TraceCollector {
  noteWsReceive(sid: string, start: number, end: number, size: number): void;
  noteStoreDispatch(sid: string, end: number): void;
  /** Called from the Timeline once the appended lines are in the document.
   * `end` is the timeline's cumulative end offset, so it completes every
   * still-pending delivery up to that offset — consecutive tails that the
   * renderer coalesced into one commit share that commit's timestamp. */
  noteDomCommit(sid: string, end: number): void;
  /** Test/diagnostic view of deliveries awaiting their DOM commit. */
  pendingCount(): number;
}

export function createTraceCollector(opts: TraceCollectorOptions): TraceCollector {
  const now = opts.now ?? (() => Date.now());
  const slowMs = opts.slowMs ?? SLOW_DELIVERY_MS;
  const sampleEvery = opts.sampleEvery ?? HEALTHY_SAMPLE_EVERY;
  const pending = new Map<string, Pending>();
  let seq = 0;

  const key = (sid: string, end: number): string => `${sid} ${end}`;
  const point = (
    kind: ClientTracePoint["kind"],
    edge: ClientTracePoint["edge"],
  ): ClientTracePoint => ({
    ts: new Date(now()).toISOString(),
    comp: "webui",
    edge,
    kind,
  });

  return {
    noteWsReceive(sid, start, end, size) {
      if (pending.size >= MAX_PENDING) {
        // insertion order: the oldest entry is the one least likely to ever commit
        const oldest = pending.keys().next();
        if (!oldest.done) pending.delete(oldest.value);
      }
      pending.set(key(sid, end), {
        sid,
        start,
        end,
        size,
        receivedAtMs: now(),
        points: [point("ws_receive", "in")],
      });
    },

    noteStoreDispatch(sid, end) {
      pending.get(key(sid, end))?.points.push(point("store_dispatch", "in"));
    },

    noteDomCommit(sid, end) {
      const committed = point("dom_commit", "in");
      const at = now();
      for (const [k, entry] of pending) {
        if (entry.sid !== sid || entry.end > end) continue;
        pending.delete(k);
        const elapsedMs = at - entry.receivedAtMs;
        const sampled = shouldReportTrace(elapsedMs, seq++, slowMs, sampleEvery);
        if (!sampled) continue;
        opts.post({
          op: "client_trace",
          sid: entry.sid,
          start: entry.start,
          end: entry.end,
          size: entry.size,
          sampled,
          elapsed_ms: elapsedMs,
          points: [...entry.points, committed],
        });
      }
    },

    pendingCount: () => pending.size,
  };
}

/** The app has one WS connection and one document, so the collector is reached
 * as a module singleton rather than threaded through the component tree: the
 * receive side lives in ws.ts and the commit side in Timeline.tsx, with no
 * shared owner between them. Stays null until ws.ts installs one, so nothing
 * is collected in tests or before connect. */
let active: TraceCollector | null = null;

export function setActiveTraceCollector(collector: TraceCollector | null): void {
  active = collector;
}

export function activeTraceCollector(): TraceCollector | null {
  return active;
}
