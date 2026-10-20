// A time budget for work that must not hold a request up for ever (a read of
// a config dir on a file system that hangs), counted in the time this process
// runs.
//
// A plain race against a timer counts the time the process did not run as
// well: when the process is not scheduled past the deadline (a busy machine,
// a stopped process), the timer and the work's completion are both ready once
// it runs again, and the timer is looked at first, so work that finished
// meanwhile is reported as not finished in time (measured with Bun 1.4.2: a
// readdir and a readFile raced against 1000 ms with the process kept busy for
// 1500 ms right after starting them came out late 5 times of 5).

/** How late a timer has to fire to say the process was not running: below
 * it, the lateness is the timer's own jitter. */
const STALL_MS = 50;

/** `work`'s value, or `late` once it has been pending `ms` of this process's
 * running time. A timer that fires `STALL_MS` or more after it was due says
 * the process did not run for that long: the budget is extended by it, so
 * that what arrived meanwhile is read before the work is called late. */
export function withinBudget<T, L>(work: Promise<T>, ms: number, late: L): Promise<T | L> {
  const settled = Promise.withResolvers<T | L>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (wait: number): void => {
    const due = Date.now() + wait;
    timer = setTimeout(() => {
      const overdue = Date.now() - due;
      if (overdue >= STALL_MS) arm(overdue);
      else settled.resolve(late);
    }, wait);
  };
  arm(ms);
  work.then(settled.resolve, settled.reject);
  return settled.promise.finally(() => clearTimeout(timer));
}
