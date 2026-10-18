// Every temp dir a test makes lives no longer than the run (tmp.ts), and a run
// whose tests left one fails naming it.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LEAKY_FIXTURE = fileURLToPath(new URL("./leaky-tmp.fixture.ts", import.meta.url));

/** The value of the `<key>=` line in `out`. */
function printed(out: string, key: string): string {
  const line = out.split("\n").find((l) => l.startsWith(`${key}=`));
  if (line === undefined) throw new Error(`no ${key}= line in: ${out}`);
  return line.slice(key.length + 1);
}

describe("the test run's temp dir", () => {
  test("os.tmpdir() is this run's own dir", () => {
    expect(os.tmpdir()).toMatch(/^\/tmp\/ccmsg-run-/);
  });

  // What a dir held says who wrote it when its name alone does not (a process
  // the test started may have written into it after the test removed it).
  test("a run whose test timed out before removing its temp dirs removes them, and fails naming them and what they held", async () => {
    const run = Bun.spawn([process.execPath, "test", LEAKY_FIXTURE], {
      cwd: REPO_ROOT,
      stdout: "pipe",
      stderr: "pipe",
    });
    const [out, err, code] = await Promise.all([
      new Response(run.stdout).text(),
      new Response(run.stderr).text(),
      run.exited,
    ]);
    const dir = printed(out, "dir");
    const short = printed(out, "short");

    expect(code).toBe(1);
    expect(err).toContain("2 temp file(s) were not removed by the test that made them");
    expect(err).toContain(`${dir}\n  inner/\n  inner/file.txt\n`);
    expect(err).toContain(`${short}\n  (empty)`);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(short)).toBe(false);
    // The fixture's run dir went with it.
    expect(fs.existsSync(path.dirname(dir))).toBe(false);
  });
});
