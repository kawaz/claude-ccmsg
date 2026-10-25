// A launch command's long output (DR-0018 §3.6): from 4096 bytes on, written
// to a file only this user reads and answered with where it is; the files are
// removed once more than 7 days old.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type CapturedOutput,
  LAUNCH_OUTPUT_INLINE_LIMIT,
  LAUNCH_OUTPUT_LIFETIME_MS,
  launchId,
  launchOutputTexts,
  pruneLaunchOutputs,
} from "../src/launch-output.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);
/** An output taken in whole: `n` times `c`. */
const whole = (n: number, c = "a"): CapturedOutput => {
  const bytes = Buffer.from(c.repeat(n));
  return { bytes, total: bytes.byteLength };
};

function quietLog(): { warn(msg: string): void; lines: string[] } {
  const lines: string[] = [];
  return { warn: (msg) => lines.push(msg), lines };
}

describe("launchId", () => {
  test("is the UTC time to the second and 8 hex digits", () => {
    expect(launchId(new Date(NOW))).toMatch(/^20261025T120000Z-[0-9a-f]{8}$/);
  });

  test("two launches of one second get two ids", () => {
    expect(launchId(new Date(NOW))).not.toBe(launchId(new Date(NOW)));
  });
});

describe("pruneLaunchOutputs", () => {
  test("removes launch dirs older than 7 days and keeps the rest", async () => {
    const dir = tmp("ccmsg-launches-");
    const old = launchId(new Date(NOW - LAUNCH_OUTPUT_LIFETIME_MS - 1000));
    const exactlyOld = launchId(new Date(NOW - LAUNCH_OUTPUT_LIFETIME_MS));
    const fresh = launchId(new Date(NOW - 1000));
    for (const name of [old, exactlyOld, fresh]) {
      fs.mkdirSync(path.join(dir, name));
      fs.writeFileSync(path.join(dir, name, "stdout"), "x");
    }
    // Not a launch id: not the prune's to remove, whatever its age.
    fs.mkdirSync(path.join(dir, "notes"));
    const log = quietLog();
    await pruneLaunchOutputs(dir, NOW, log);
    expect(fs.readdirSync(dir).toSorted()).toEqual([exactlyOld, fresh, "notes"].toSorted());
    expect(log.lines).toEqual([]);
  });

  test("a missing launches dir is nothing to prune", async () => {
    const log = quietLog();
    await pruneLaunchOutputs(path.join(tmp("ccmsg-launches-"), "absent"), NOW, log);
    expect(log.lines).toEqual([]);
  });
});

describe("launchOutputTexts", () => {
  test("short output is answered with and nothing is written", async () => {
    const dir = path.join(tmp("ccmsg-launches-"), "launches");
    const texts = await launchOutputTexts(
      dir,
      { stdout: whole(LAUNCH_OUTPUT_INLINE_LIMIT - 1), stderr: whole(1, "e") },
      new Date(NOW),
      quietLog(),
    );
    expect(texts).toEqual({ stdout: "a".repeat(LAUNCH_OUTPUT_INLINE_LIMIT - 1), stderr: "e" });
    expect(fs.existsSync(dir)).toBe(false);
  });

  // Each stream is judged on its own: a long one is written, a short one in
  // the same launch is answered with.
  test("a stream of 4096 bytes is written to a 0600 file in a 0700 dir", async () => {
    const dir = path.join(tmp("ccmsg-launches-"), "launches");
    const texts = await launchOutputTexts(
      dir,
      { stdout: whole(1, "o"), stderr: whole(LAUNCH_OUTPUT_INLINE_LIMIT, "é") },
      new Date(NOW),
      quietLog(),
    );
    const [launch] = fs.readdirSync(dir);
    if (launch === undefined) throw new Error("no launch dir");
    const file = path.join(dir, launch, "stderr");
    expect(texts).toEqual({
      stdout: "o",
      stderr: `output is ${String(LAUNCH_OUTPUT_INLINE_LIMIT * 2)} bytes, file: ${file}`,
    });
    expect(fs.readFileSync(file, "utf8")).toBe("é".repeat(LAUNCH_OUTPUT_INLINE_LIMIT));
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, launch)).mode & 0o777).toBe(0o700);
    expect(fs.existsSync(path.join(dir, launch, "stdout"))).toBe(false);
  });

  // Writing a launch's files is when old ones go, as at daemon startup.
  test("old launch dirs are removed before the files are written", async () => {
    const dir = tmp("ccmsg-launches-");
    const old = launchId(new Date(NOW - LAUNCH_OUTPUT_LIFETIME_MS - 1000));
    fs.mkdirSync(path.join(dir, old));
    await launchOutputTexts(
      dir,
      { stdout: whole(LAUNCH_OUTPUT_INLINE_LIMIT), stderr: whole(0) },
      new Date(NOW),
      quietLog(),
    );
    const names = fs.readdirSync(dir);
    expect(names).not.toContain(old);
    expect(names).toHaveLength(1);
  });

  // When the file cannot be written the text is still not answered with.
  test("an output that cannot be saved says so instead of carrying the text", async () => {
    const base = tmp("ccmsg-launches-");
    const dir = path.join(base, "launches");
    // A file where the launches dir has to be.
    fs.writeFileSync(dir, "");
    const texts = await launchOutputTexts(
      dir,
      { stdout: whole(LAUNCH_OUTPUT_INLINE_LIMIT), stderr: whole(1, "e") },
      new Date(NOW),
      quietLog(),
    );
    expect(texts.stdout).toStartWith(
      `output is ${String(LAUNCH_OUTPUT_INLINE_LIMIT)} bytes, not saved: `,
    );
    expect(texts.stderr).toBe("e");
  });

  // Output past the capture limit was cut when it was taken in: the file ends
  // by saying so, and so does the reply.
  test("a cut output says so at the end of its file and in the reply", async () => {
    const dir = path.join(tmp("ccmsg-launches-"), "launches");
    const kept = Buffer.from("k".repeat(LAUNCH_OUTPUT_INLINE_LIMIT));
    const total = LAUNCH_OUTPUT_INLINE_LIMIT * 3;
    const texts = await launchOutputTexts(
      dir,
      { stdout: { bytes: kept, total }, stderr: whole(0) },
      new Date(NOW),
      quietLog(),
    );
    const [launch] = fs.readdirSync(dir);
    if (launch === undefined) throw new Error("no launch dir");
    const file = path.join(dir, launch, "stdout");
    expect(texts.stdout).toBe(
      `output is ${String(total)} bytes, truncated to the first ${String(kept.byteLength)}, file: ${file}`,
    );
    expect(fs.readFileSync(file, "utf8")).toBe(
      `${"k".repeat(LAUNCH_OUTPUT_INLINE_LIMIT)}\n[ccmsg: truncated: the first ${String(kept.byteLength)} of ${String(total)} bytes]\n`,
    );
  });
});
