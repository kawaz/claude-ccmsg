// A test's probe of a daemon's async file system operations (fs-probe.ts):
// read from CCMSG_TEST_FS_PROBE, it stats a name that is not there in a dir
// for the time it is given, logs each round whose async stat took the slow
// time or more beside the sync one right after it, between a first line that
// names the size of bun's pool and a summary.
import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { fsProbeSpec, probeFs } from "../src/fs-probe.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmpDir = perTestTmpDir();

function lines(): {
  info: string[];
  warn: string[];
  log: { info(m: string): void; warn(m: string): void };
} {
  const info: string[] = [];
  const warn: string[] = [];
  return { info, warn, log: { info: (m) => info.push(m), warn: (m) => warn.push(m) } };
}

describe("fsProbeSpec", () => {
  test("reads `<duration ms>:<slow ms>`, and nothing else", () => {
    expect(fsProbeSpec("5000:100")).toEqual({ durationMs: 5000, slowMs: 100 });
    for (const raw of [undefined, "", "5000", "5000:", ":100", "a:b", "5000:100:1"]) {
      expect(fsProbeSpec(raw)).toBeUndefined();
    }
  });
});

describe("probeFs", () => {
  test("logs each round at the slow time or more, then the summary", async () => {
    const dir = tmpDir("ccmsg-fs-probe-");
    const got = lines();
    await probeFs(dir, { durationMs: 100, slowMs: 0 }, got.log, () => false);
    const name = RegExp.escape(path.join(dir, ".fs-probe"));
    expect(got.warn.length).toBeGreaterThanOrEqual(1);
    for (const line of got.warn) {
      expect(line).toMatch(
        new RegExp(
          `^fs probe: an async stat of ${name} took \\d+ ms \\(a sync one right after, \\d+ ms\\), \\d+ ms into the probe$`,
        ),
      );
    }
    expect(got.info).toHaveLength(2);
    expect(got.info[0]).toMatch(
      /^fs probe: for 100 ms from the start, a round each 20 ms, slow at 0 ms; pool threads \S/,
    );
    expect(got.info[1]).toMatch(
      new RegExp(
        `^fs probe: ${String(got.warn.length)} rounds over \\d+ ms; the longest async stat \\d+ ms, sync \\d+ ms$`,
      ),
    );
  });

  test("a round under the slow time logs nothing, and stopped() ends the probe", async () => {
    const dir = tmpDir("ccmsg-fs-probe-");
    const got = lines();
    let rounds = 0;
    await probeFs(dir, { durationMs: 60_000, slowMs: 60_000 }, got.log, () => ++rounds > 3);
    expect(got.warn).toEqual([]);
    expect(got.info).toHaveLength(2);
    expect(got.info[1]).toStartWith("fs probe: 3 rounds over ");
  });
});
