// The live runs send_message and peer_list match (DR-0039 §3), read from Claude
// Code's state files. The files name live pids (this test process and a child
// it starts) where a run has to be running.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { perTestLivePid } from "../../testkit/src/live-pid.ts";
import { liveRuns, readSessionsDir } from "../src/session-runs.ts";

const A = "aaaaaaaa-2222-4333-8444-555555555555";
const B = "bbbbbbbb-2222-4333-8444-555555555555";
const C = "cccccccc-2222-4333-8444-555555555555";
/** This test process, and a second process each test that needs one starts:
 * both run for as long as the test does. */
const LIVE_PID = process.pid;
const otherLivePid = perTestLivePid();

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
  // A record that does not read adds no run, which a send tells as a session
  // that is not running: leftOut.unread says which record, and why. A dir
  // that has no sessions/ at all is a dir with no sessions, and says nothing.
  test("a record that does not read adds no run, and leftOut.unread says which and why", async () => {
    const c1 = tempDir("sr-cfg-");
    const sessionsDir = path.join(c1, "sessions");
    fs.mkdirSync(sessionsDir);
    fs.writeFileSync(
      path.join(sessionsDir, `${LIVE_PID}.json`),
      JSON.stringify({ pid: LIVE_PID, sessionId: A }),
    );
    fs.writeFileSync(path.join(sessionsDir, "77.json"), "not json");
    const unread: { dir: string; reasons: readonly string[] }[] = [];
    const late: unknown[] = [];
    const runs = await liveRuns([c1, path.join(c1, "missing")], (pid) => pid === LIVE_PID, 1000, {
      late: (scan) => late.push(scan),
      unread: (dir, reasons) => unread.push({ dir, reasons }),
    });
    expect(runs).toEqual([{ configDir: c1, sid: A, pid: LIVE_PID }]);
    expect(late).toEqual([]);
    expect(unread.map((u) => u.dir)).toEqual([sessionsDir]);
    expect(unread[0]?.reasons).toHaveLength(1);
    expect(unread[0]?.reasons[0]).toStartWith(`${path.join(sessionsDir, "77.json")}: `);
  });

  test("the state files of running processes, across config dirs", async () => {
    const c1 = tempDir("sr-cfg-");
    const c2 = tempDir("sr-cfg-");
    const other = otherLivePid();
    const write = (dir: string, name: string, body: string) => {
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sessions", name), body);
    };
    write(c1, `${LIVE_PID}.json`, JSON.stringify({ pid: LIVE_PID, sessionId: A, cwd: "/w" }));
    write(c1, "424242.json", JSON.stringify({ pid: 424242, sessionId: B, cwd: "/w" }));
    write(c1, "77.json", "not json");
    write(c1, `${LIVE_PID}.abc.key`, JSON.stringify({ peerToken: "t" }));
    write(c2, `${other}.json`, JSON.stringify({ pid: other, sessionId: C }));
    const alive = (pid: number) => pid === LIVE_PID || pid === other;
    expect(await liveRuns([c1, c2, path.join(c1, "missing")], alive)).toEqual([
      { configDir: c1, sid: A, pid: LIVE_PID, cwd: "/w" },
      { configDir: c2, sid: C, pid: other },
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

// What the agents rows are read from (agents.ts): a dir that is not read
// whole says so, since a session missing from a dir read whole has ended.
describe("readSessionsDir", () => {
  test("the records of running processes, and which records did not read", async () => {
    const c1 = tempDir("sr-cfg-");
    fs.mkdirSync(path.join(c1, "sessions"));
    const write = (name: string, body: string) =>
      fs.writeFileSync(path.join(c1, "sessions", name), body);
    write(`${LIVE_PID}.json`, JSON.stringify({ pid: LIVE_PID, sessionId: A, status: "shell" }));
    write("424242.json", JSON.stringify({ pid: 424242, sessionId: B }));
    write(`${LIVE_PID}.abc.key`, "not a record");
    const alive = (pid: number) => pid === LIVE_PID;
    expect(await readSessionsDir(c1, alive)).toEqual({
      live: [{ pid: LIVE_PID, sessionId: A, status: "shell" }],
    });

    write("77.json", "not json");
    const read = await readSessionsDir(c1, alive);
    expect(read.live).toEqual([{ pid: LIVE_PID, sessionId: A, status: "shell" }]);
    expect(read.unread).toHaveLength(1);
    expect(read.unread?.[0]).toContain("77.json");
  });

  test("a config dir without sessions/ has no sessions; one that cannot be listed is not read", async () => {
    const c1 = tempDir("sr-cfg-");
    expect(await readSessionsDir(c1, () => true)).toEqual({ live: [] });
    fs.writeFileSync(path.join(c1, "sessions"), "a file, not a dir");
    const read = await readSessionsDir(c1, () => true);
    expect(read.live).toEqual([]);
    expect(read.unread).toHaveLength(1);
  });
});
