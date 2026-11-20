// Cooperative scheduling primitive shared by the daemon's long walks and scans.
/** Hand the event loop a full turn. A microtask (`await Promise.resolve()`)
 * drains before any pending IO or timer callback runs, so it cannot let a
 * concurrent WebSocket delivery through; `setImmediate` re-enters the loop and
 * does. DR-0029 requires every IO-bearing request to be interruptible this way,
 * and a scan can walk hundreds of megabytes or tens of thousands of dirents. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise<void>((resolve) => {
    setImmediate(resolve);
  });
}

/** How long a long walk may hold the event loop before it hands it a turn
 * (DR-0029 「長い走査は時間で譲る」, where the value is measured). */
export const TURN_SLICE_MS = 8;

/** A long walk's hold on the event loop, measured in time rather than in
 * bytes or entries, whose cost per unit varies by orders of magnitude (a
 * short line against a large row folded five ways). The walk asks `spent()`
 * after each unit of work and, when it says so, awaits `pass()`. */
export interface TurnSlice {
  /** Whether the walk has held the loop for the slice since the last pass
   * (since the slice was made, before the first). */
  spent(): boolean;
  /** Hand the loop a turn, then start the next slice. */
  pass(): Promise<void>;
}

/** A slice of `sliceMs` on the clock `now` (performance.now; a test passes a
 * clock of its own). The time a walk spends awaiting IO counts against the
 * slice as well: the walk then passes sooner, never later. */
export function turnSlice(
  sliceMs: number = TURN_SLICE_MS,
  now: () => number = () => performance.now(),
): TurnSlice {
  let started = now();
  return {
    spent: () => now() - started >= sliceMs,
    pass: async () => {
      await yieldToEventLoop();
      started = now();
    },
  };
}
