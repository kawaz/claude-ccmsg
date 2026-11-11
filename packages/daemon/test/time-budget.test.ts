// The time budget for a read that must not hold a request up for ever
// (time-budget.ts) counts the time this process runs. What it guards against
// is the event loop's own ordering after the process did not run past the
// deadline (the timer is looked at before the read's completion), so these
// tests run real timers and keep the process busy instead of injecting a
// clock, which has no such ordering.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import * as path from "node:path";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { liveRuns } from "../src/session-runs.ts";
import { type BudgetSpent, type LateScan, lateScanText, withinBudget } from "../src/time-budget.ts";

const tmpDir = perTestTmpDir();

/** Keep this process running JavaScript, so nothing else in it runs. */
function busy(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // the event loop does not turn
  }
}

describe("withinBudget", () => {
  test("a read that finished while the process did not run past the budget is not late", async () => {
    const dir = tmpDir("ccmsg-budget-");
    fs.writeFileSync(path.join(dir, "f.json"), "{}");
    const read = (async () => {
      await readdir(dir);
      return await readFile(path.join(dir, "f.json"), "utf8");
    })();
    const within = withinBudget(read, 100, () => "late");
    busy(300);
    expect(await within).toBe("{}");
  });

  test("work that does not finish is late once the budget is spent", async () => {
    const started = Date.now();
    expect(await withinBudget(new Promise<string>(() => {}), 100, () => "late")).toBe("late");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  // What a late budget says it spent tells a process that ran all along
  // (its timers on time: the work itself did not finish) from one that did
  // not run (its timers late, by about the time it did not run).
  test("a late budget says what it spent, and how late its timers fired", async () => {
    const spentOf = (within: Promise<BudgetSpent | "done">): Promise<BudgetSpent> =>
      within.then((got) => {
        if (got === "done") throw new Error("work that never finishes came out done");
        return got;
      });
    const running = await spentOf(
      withinBudget(new Promise<"done">(() => {}), 100, (spent) => spent),
    );
    expect(running.budgetMs).toBe(100);
    expect(running.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(running.timerLateMs).toBeLessThan(50);

    const stopped = spentOf(withinBudget(new Promise<"done">(() => {}), 100, (spent) => spent));
    busy(300);
    const late = await stopped;
    expect(late.timerLateMs).toBeGreaterThanOrEqual(200);
    expect(late.elapsedMs).toBeGreaterThanOrEqual(300);
  });

  test("a failure of the work is the failure, before the budget", async () => {
    const failing = Promise.reject(new Error("boom"));
    expect(withinBudget(failing, 100, () => "late")).rejects.toThrow("boom");
  });
});

// DR-0039 §3: a send names a session as ended when no run of it is read. A
// process that did not run past the scan budget must not make a running
// session read as ended.
describe("liveRuns within its budget", () => {
  test("the runs are read when the process did not run past the budget", async () => {
    const dir = tmpDir("ccmsg-budget-cfg-");
    fs.mkdirSync(path.join(dir, "sessions"));
    const sid = "aaaaaaaa-2222-4333-8444-555555555555";
    fs.writeFileSync(
      path.join(dir, "sessions", `${String(process.pid)}.json`),
      JSON.stringify({ pid: process.pid, sessionId: sid }),
    );
    const late: LateScan[] = [];
    const runs = liveRuns([dir], (pid) => pid === process.pid, 100, {
      late: (scan) => late.push(scan),
      unread: () => {},
    });
    busy(300);
    expect(await runs).toEqual([{ configDir: dir, sid, pid: process.pid }]);
    expect(late).toEqual([]);
  });

  // A dir whose files are not all read in time adds no run, which a send
  // tells as a session that is not running: leftOut.late says it was the
  // read, and how far it got (here a FIFO no one writes to is never read
  // through).
  test("a dir not read in time adds no run, and leftOut.late says how far its read got", async () => {
    const dir = tmpDir("ccmsg-budget-cfg-");
    const sessionsDir = path.join(dir, "sessions");
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(
      path.join(sessionsDir, `${String(process.pid)}.json`),
      JSON.stringify({ pid: process.pid, sessionId: "aaaaaaaa-2222-4333-8444-555555555555" }),
    );
    const fifo = path.join(sessionsDir, "99.json");
    expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
    const late: LateScan[] = [];
    try {
      expect(
        await liveRuns([dir], (pid) => pid === process.pid, 100, {
          late: (scan) => late.push(scan),
          unread: () => {},
        }),
      ).toEqual([]);
    } finally {
      // Opening the FIFO for writing lets the blocked read finish.
      fs.writeFileSync(fifo, "");
    }
    expect(late.map(({ elapsedMs: _e, timerLateMs: _t, ...got }) => got)).toEqual([
      { dir: sessionsDir, listed: 2, read: 1, budgetMs: 100 },
    ]);
    expect(late[0]?.elapsedMs).toBeGreaterThanOrEqual(100);
    expect(late[0]?.timerLateMs).toBeLessThan(50);
  });
});

describe("lateScanText", () => {
  test("names the dir, how far the read got, the time into the budget and the timers' lateness", () => {
    const spent = { budgetMs: 1000, elapsedMs: 1003, timerLateMs: 3 };
    expect(lateScanText({ dir: "/c/sessions", listed: 2, read: 1, ...spent })).toBe(
      "/c/sessions: 1 of 2 files read, 1003 ms into a 1000 ms budget (its timers fired 3 ms late in all)",
    );
    expect(lateScanText({ dir: "/c/sessions", listed: undefined, read: 0, ...spent })).toBe(
      "/c/sessions: not listed, 1003 ms into a 1000 ms budget (its timers fired 3 ms late in all)",
    );
  });
});
