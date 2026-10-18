// The live runs peer_send and peer_list match (DR-0039 §3), read from Claude
// Code's state files. The files name live pids (this test process and its
// parent) where a run has to be running.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { liveRuns } from "../src/session-runs.ts";

const A = "aaaaaaaa-2222-4333-8444-555555555555";
const B = "bbbbbbbb-2222-4333-8444-555555555555";
const C = "cccccccc-2222-4333-8444-555555555555";
/** Two processes that run for as long as the test does. */
const LIVE_PID = process.pid;
const OTHER_LIVE_PID = process.ppid;

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const f of cleanups.splice(0).reverse()) f();
});

function tempDir(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe("liveRuns", () => {
  test("the state files of running processes, across config dirs", async () => {
    const c1 = tempDir("sr-cfg-");
    const c2 = tempDir("sr-cfg-");
    const write = (dir: string, name: string, body: string) => {
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sessions", name), body);
    };
    write(c1, `${LIVE_PID}.json`, JSON.stringify({ pid: LIVE_PID, sessionId: A, cwd: "/w" }));
    write(c1, "424242.json", JSON.stringify({ pid: 424242, sessionId: B, cwd: "/w" }));
    write(c1, "77.json", "not json");
    write(c1, `${LIVE_PID}.abc.key`, JSON.stringify({ peerToken: "t" }));
    write(c2, `${OTHER_LIVE_PID}.json`, JSON.stringify({ pid: OTHER_LIVE_PID, sessionId: C }));
    const alive = (pid: number) => pid === LIVE_PID || pid === OTHER_LIVE_PID;
    expect(await liveRuns([c1, c2, path.join(c1, "missing")], alive)).toEqual([
      { configDir: c1, sid: A, pid: LIVE_PID, cwd: "/w" },
      { configDir: c2, sid: C, pid: OTHER_LIVE_PID },
    ]);
  });

  // Seen on a real machine: the poll's $HOME/.claude-* through /tmp and the
  // registry's realpath through /private/tmp named one config dir twice, and
  // each run was sent the message twice.
  test("a config dir named twice, through a symlink and by its realpath, lists each run once", async () => {
    const c1 = tempDir("sr-cfg-");
    fs.mkdirSync(path.join(c1, "sessions"));
    fs.writeFileSync(
      path.join(c1, "sessions", `${LIVE_PID}.json`),
      JSON.stringify({ pid: LIVE_PID, sessionId: A }),
    );
    const link = path.join(tempDir("sr-link-"), "cfg");
    fs.symlinkSync(c1, link);
    expect(await liveRuns([link, c1], (pid) => pid === LIVE_PID)).toEqual([
      { configDir: link, sid: A, pid: LIVE_PID },
    ]);
  });
});
