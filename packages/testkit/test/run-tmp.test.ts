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

  test("a run whose test timed out before removing its temp dirs removes them, and fails naming them", async () => {
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
    expect(err).toContain(dir);
    expect(err).toContain(short);
    expect(fs.existsSync(dir)).toBe(false);
    expect(fs.existsSync(short)).toBe(false);
    // The fixture's run dir went with it.
    expect(fs.existsSync(path.dirname(dir))).toBe(false);
  });
});
