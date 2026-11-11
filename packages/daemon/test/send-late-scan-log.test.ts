// A send that reads the session's files too late says so in daemon.log
// (DR-0039 §3): a config dir whose `sessions/` is not read within its budget
// adds no run, which the sender is told as a session that ended, and a peer
// socket whose files are not read in time is no_peer_socket: scan_timed_out.
// Both read alike to the sender as something else, so the log line is what
// says it was the read, and how far it got. A FIFO no one writes to stands in
// for a file whose read does not finish: the daemon's real budgets run out.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  type DaemonCtx,
  sessionConn,
  startTestDaemon,
  stopTestDaemon,
  type TestClient,
} from "./helpers.ts";
import { fakeHarness, sessionWithConfig } from "./peer-harness.ts";

const SENDER = "aaaaaaaa-3333-4333-8444-555555555555";
const PEER = "bbbbbbbb-3333-4333-8444-555555555555";
/** Each test waits out a real budget (RUNS_SCAN_MS or INJECT_SCAN_MS, a
 * second) besides starting a daemon. */
const T = 15_000;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

/** Let a read blocked opening `fifo` finish: open it for writing, then close
 * it (the reader sees an empty file). Without a reader, opening it for
 * writing without waiting fails (ENXIO), and there is nothing to let go. Run
 * before the daemon is stopped, whose read it is. */
function releaseFifo(fifo: string): void {
  let fd: number;
  try {
    fd = fs.openSync(fifo, fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  } catch {
    return;
  }
  fs.closeSync(fd);
}

/** A daemon serving the config dir of a harness of PEER that runs in this
 * process, with PEER's module named, and a session to send from. A FIFO
 * named `fifo` is made in the harness's `sessions/` first. */
async function servedPeer(fifo: string): Promise<{
  serving: DaemonCtx;
  sender: TestClient;
  sessionsDir: string;
}> {
  const hb = fakeHarness(PEER, { pid: process.pid });
  cleanups.push(() => hb.dispose());
  const sessionsDir = path.join(fs.realpathSync(hb.configDir), "sessions");
  const fifoPath = path.join(sessionsDir, fifo);
  expect(Bun.spawnSync(["mkfifo", fifoPath]).exitCode).toBe(0);
  const serving = await startTestDaemon({ CCMSG_CLAUDE_CONFIG_DIRS: hb.configDir });
  cleanups.push(() => stopTestDaemon(serving));
  cleanups.push(() => releaseFifo(fifoPath));
  const run = await sessionConn(serving, PEER);
  await run.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
  cleanups.push(() => run.close());
  const sender = await sessionWithConfig(serving, SENDER);
  cleanups.push(() => sender.close());
  return { serving, sender, sessionsDir };
}

async function send(from: TestClient) {
  return (await from.requestOk({ op: "send_message", to: { session_id: PEER }, text: "hi" }))
    .results;
}

function daemonLog(ctx: DaemonCtx): string {
  return fs.readFileSync(path.join(ctx.stateDir, "daemon.log"), "utf8");
}

/** `<dir>: <read> of <listed> files read, <n> ms into a 1000 ms budget (its
 * timers fired <n> ms late in all)`, the late scan of lateScanText. */
function lateScan(dir: string, read: number, listed: number): string {
  return (
    `${RegExp.escape(dir)}: ${String(read)} of ${String(listed)} files read, ` +
    `\\d+ ms into a 1000 ms budget \\(its timers fired \\d+ ms late in all\\)`
  );
}

describe("a send whose read of the session's files ran out of time", () => {
  test(
    "a sessions/ not read in time: the sender is told ended, and the log says it was the read",
    async () => {
      // `99.json` is a state file name, so the runs' read waits on it.
      const { serving, sender, sessionsDir } = await servedPeer("99.json");
      expect(await send(sender)).toEqual([
        { sid: PEER, outcome: "not_delivered", reason: "ended" },
      ]);
      expect(daemonLog(serving)).toMatch(
        new RegExp(
          `\\[warn\\] session runs: not read in time, left out: ${lateScan(sessionsDir, 1, 2)}\\n`,
        ),
      );
    },
    T,
  );

  test(
    "a key not read in time: no_peer_socket: scan_timed_out, with how far the read got",
    async () => {
      // A key name for this process, so the runs' read (state files only)
      // finds PEER and the peer socket's read of the keys waits on it.
      const { serving, sender, sessionsDir } = await servedPeer(`${String(process.pid)}.ffff.key`);
      expect(await send(sender)).toEqual([
        { sid: PEER, outcome: "not_delivered", reason: "no_peer_socket" },
      ]);
      const log = daemonLog(serving);
      expect(log).toMatch(
        new RegExp(
          `\\[info\\] peer-inject \\S+ -> ${PEER}\\.${String(process.pid)} \\(send_message\\): ` +
            `unavailable \\(no_peer_socket: scan_timed_out; ${lateScan(sessionsDir, 1, 2)}\\)\\n`,
        ),
      );
      expect(log).not.toContain("session runs: not read in time");
    },
    T,
  );
});
