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
