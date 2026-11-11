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

/** What a budget that ran out had spent: the budget, the time from its start
 * to the moment it was called late, and how late its timers fired in all. A
 * lateness under STALL_MS says the process ran all along, so the work itself
 * did not finish; more was taken back as time the process did not run. */
export interface BudgetSpent {
  budgetMs: number;
  elapsedMs: number;
  timerLateMs: number;
}

/** `work`'s value, or what `late` makes of the budget spent once the work has
 * been pending `ms` of this process's running time. A timer that fires
 * `STALL_MS` or more after it was due says the process did not run for that
 * long: the budget is extended by it, so that what arrived meanwhile is read
 * before the work is called late. */
export function withinBudget<T, L>(
  work: Promise<T>,
  ms: number,
  late: (spent: BudgetSpent) => L,
): Promise<T | L> {
  const settled = Promise.withResolvers<T | L>();
  const started = Date.now();
  let timerLateMs = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const arm = (wait: number): void => {
    const due = Date.now() + wait;
    timer = setTimeout(() => {
      const overdue = Date.now() - due;
      timerLateMs += overdue;
      if (overdue >= STALL_MS) arm(overdue);
      else settled.resolve(late({ budgetMs: ms, elapsedMs: Date.now() - started, timerLateMs }));
    }, wait);
  };
  arm(ms);
  work.then(settled.resolve, settled.reject);
  return settled.promise.finally(() => clearTimeout(timer));
}

/** How far a read of the files of one directory has got: how many it set out
 * to read (undefined while the directory is still being listed), and how many
 * of them it has read. */
export interface ScanProgress {
  listed: number | undefined;
  read: number;
}

/** A read of the files of `dir` that ran out of its budget, as far as it got. */
export interface LateScan extends ScanProgress, BudgetSpent {
  dir: string;
}

/** A late scan in the words of the daemon's log. */
export function lateScanText(scan: LateScan): string {
  const got =
    scan.listed === undefined
      ? "not listed"
      : `${String(scan.read)} of ${String(scan.listed)} files read`;
  return (
    `${scan.dir}: ${got}, ${String(scan.elapsedMs)} ms into a ${String(scan.budgetMs)} ms budget` +
    ` (its timers fired ${String(scan.timerLateMs)} ms late in all)`
  );
}
