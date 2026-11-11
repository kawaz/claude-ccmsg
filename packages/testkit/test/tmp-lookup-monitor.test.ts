// The run's monitor of the lookups directly under /private/tmp
// (tmp-lookup-monitor.ts) says at the run's end how many entries the dir held
// and each round whose lookups took the slow time or more, with its time,
// then a summary. Here it watches a dir of the test's own, with a slow time of
// 0 (every round is reported) and one no round reaches. Its child runs at
// least one round before it sees its stdin close.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestTmpDir } from "../src/tmp.ts";
import { startTmpLookupMonitor } from "../src/tmp-lookup-monitor.ts";

const tmpDir = perTestTmpDir();

function fixture(): { runDir: string; dir: string; parent: string } {
  const parent = tmpDir("ccmsg-lookups-");
  const dir = path.join(parent, "watched");
  fs.mkdirSync(dir);
  for (const name of ["a", "b", "c"]) fs.writeFileSync(path.join(dir, name), "");
  const runDir = path.join(parent, "run");
  fs.mkdirSync(runDir);
  return { runDir, dir, parent };
}

describe("startTmpLookupMonitor", () => {
  test("reports each round at or over the slow time with its time, and a summary", async () => {
    const { runDir, dir, parent } = fixture();
    const monitor = startTmpLookupMonitor(runDir, { dir, parent, slowMs: 0 });
    const lines = await monitor.stop();
    expect(lines[0]).toBe(
      `${dir} lookups (every 50 ms; ${dir} held 3 entries at the start, 3 at the end):`,
    );
    const slow = lines.slice(1, -1);
    expect(slow.length).toBeGreaterThanOrEqual(1);
    const ms = "\\d+ ms";
    for (const line of slow) {
      expect(line).toMatch(
        new RegExp(
          `^  slow at \\d{4}-\\d\\d-\\d\\dT[\\d:.]+Z: ${RegExp.escape(dir)} ${ms} async, ${ms} sync; ` +
            `${RegExp.escape(parent)} ${ms}; the run dir ${ms}$`,
        ),
      );
    }
    expect(lines.at(-1)).toMatch(
      new RegExp(
        `^  ${String(slow.length)} of ${String(slow.length)} rounds took 0 ms or more; the longest: ` +
          `${RegExp.escape(dir)} ${ms} async, ${ms} sync; ${RegExp.escape(parent)} ${ms}; the run dir ${ms}$`,
      ),
    );
    expect(fs.readdirSync(runDir)).toEqual([monitor.file]);
  });

  test("a run with no round at the slow time says so in its summary alone", async () => {
    const { runDir, dir, parent } = fixture();
    const lines = await startTmpLookupMonitor(runDir, {
      dir,
      parent,
      slowMs: 60_000,
    }).stop();
    expect(lines).toHaveLength(2);
    expect(lines[1]).toMatch(/^ {2}0 of [1-9]\d* rounds took 60000 ms or more; the longest: /);
  });
});
