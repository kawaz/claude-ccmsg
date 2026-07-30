/**
 * Wall-clock bound on a hook process's lifetime.
 *
 * What a hook costs the user is how long its *process* lives, not how long its
 * work takes — and in bun those diverge badly, because pending timers and open
 * subprocess pipes keep the event loop alive after main() already has its
 * answer. Both divergences are real here (measured on this repo):
 *
 *   - `getRepoWsFromVcs` returned in 87ms and the process exited at 1003ms,
 *     held by the deadline timer `raceExit` never cleared.
 *   - With a `bump-semver` stand-in that ignores SIGTERM, `raceExit` returned
 *     at its 1000ms deadline and the process exited at 8328ms, held by the
 *     abandoned read of the killed child's stdout.
 *
 * UserPromptSubmit runs before every single turn, so it pays that lifetime
 * every turn. Two halves, and both are needed:
 *
 *   - `armHookDeadline` is the backstop for hangs we cannot enumerate (stdin
 *     that is never closed, a subprocess that outlives its kill()). It cannot
 *     interrupt a synchronous section, so blocking calls still need their own
 *     timeout — `Bun.spawnSync`'s `timeout` option is honoured (verified).
 *   - `exitHook` is the normal path: finish, flush, leave. Without it a healthy
 *     run waits out the watchdog instead of the work.
 *
 * Both exit 0 unconditionally. A hook whose only job is advisory output must
 * never turn a slow moment into a broken turn — dropping one turn's message is
 * cheaper than delaying every turn, and UserPromptSubmit's nag repeats on the
 * next turn anyway.
 */

/**
 * Force-exits 0 once `ms` has elapsed. Unref'd, so it never extends the process
 * itself — it only fires when something *else* is still holding the loop.
 * Call this first thing in a hook, before any work that could hang.
 */
export function armHookDeadline(ms: number): void {
  setTimeout(() => process.exit(0), ms).unref();
}

/**
 * Writes `output` (when non-empty) and exits 0 without waiting for the event
 * loop to drain.
 *
 * `Bun.write` rather than `process.stdout.write`: the latter can still hold
 * buffered bytes when `process.exit` cuts the process down, and this output is
 * the hook's entire product.
 */
export async function exitHook(output = ""): Promise<never> {
  if (output !== "") {
    try {
      await Bun.write(Bun.stdout, output);
    } catch {
      // Nothing useful to do if stdout is gone; still exit cleanly.
    }
  }
  process.exit(0);
}
