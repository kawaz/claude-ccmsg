// A session's hello that takes long is logged with what it spent the time on
// (server.ts slowHelloText): a hooks module hellos with every request it
// makes, so a slow hello holds the session up, and the line says which of the
// hello's reads it was, down to each read of the location's derivation, and
// whether the event loop turned meanwhile.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { deriveLocation, type LocationRead, timedLocationIo } from "../src/repo-derive.ts";
import { HELLO_SLOW_MS, type HelloReads, slowHelloText } from "../src/server.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmpDir = perTestTmpDir();

const SID = "aaaaaaaa-2222-4333-8444-555555555555";
const READS: HelloReads = {
  transcript: 0.2,
  cwd: 82.4,
  repoRoot: 0.2,
  location: 1124.3,
  locationReads: [
    { op: "stat", path: "/private/tmp/.jj", ms: 1100.4 },
    { op: "stat", path: "/private/tmp/.git", ms: 3.6 },
  ],
  timerLateMs: 1.2,
};

describe("slowHelloText", () => {
  test("a hello of HELLO_SLOW_MS or more: the whole, each read, and the timer's lateness, in whole ms", () => {
    expect(slowHelloText(SID, 1208.2, READS)).toBe(
      `hello ${SID} took 1208 ms: transcript search 0 ms, cwd 82 ms, repo root 0 ms, location 1124 ms ` +
        "(stat /private/tmp/.jj 1100 ms, stat /private/tmp/.git 4 ms); a 0 ms timer set as it began fired 1 ms late",
    );
    expect(slowHelloText(SID, HELLO_SLOW_MS, READS)).toStartWith(
      `hello ${SID} took ${String(HELLO_SLOW_MS)} ms: `,
    );
  });

  test("a hello under HELLO_SLOW_MS says nothing", () => {
    expect(slowHelloText(SID, HELLO_SLOW_MS - 1, READS)).toBeUndefined();
  });
});

// Outside any checkout the derivation looks for `.jj` then `.git` in the dir
// and each of its ancestors up to `/`: the timed reads list them in that order.
describe("timedLocationIo", () => {
  test("records each read of a derivation, in order, with the time it took", async () => {
    const dir = fs.realpathSync(tmpDir("ccmsg-derive-"));
    const reads: LocationRead[] = [];
    expect(await deriveLocation(dir, timedLocationIo(reads))).toEqual({
      repo: "",
      ws: "",
      repo_url: "",
    });
    const ancestors: string[] = [];
    for (let d = dir; ; d = path.dirname(d)) {
      ancestors.push(d);
      if (path.dirname(d) === d) break;
    }
    expect(reads.map((r) => `${r.op} ${r.path}`)).toEqual(
      ancestors.flatMap((d) => [`stat ${path.join(d, ".jj")}`, `stat ${path.join(d, ".git")}`]),
    );
    for (const r of reads) expect(r.ms).toBeGreaterThanOrEqual(0);
  });
});
