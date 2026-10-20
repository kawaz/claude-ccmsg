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
import { withinBudget } from "../src/time-budget.ts";

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
    const within = withinBudget(read, 100, "late");
    busy(300);
    expect(await within).toBe("{}");
  });

  test("work that does not finish is late once the budget is spent", async () => {
    const started = Date.now();
    expect(await withinBudget(new Promise<string>(() => {}), 100, "late")).toBe("late");
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
  });

  test("a failure of the work is the failure, before the budget", async () => {
    const failing = Promise.reject(new Error("boom"));
    expect(withinBudget(failing, 100, "late")).rejects.toThrow("boom");
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
    const runs = liveRuns([dir], (pid) => pid === process.pid, 100);
    busy(300);
    expect(await runs).toEqual([{ configDir: dir, sid, pid: process.pid }]);
  });
});
