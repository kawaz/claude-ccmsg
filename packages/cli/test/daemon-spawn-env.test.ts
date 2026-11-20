// The environment of the daemon the CLI spawns (DR-0002 §2): the caller's,
// with the OS's per-user TMPDIR in place of the caller's own. The CLI runs in
// whichever session called it (a hook, `just push`'s upgrade contact), and that
// session's TMPDIR (`<project>/tmp.local/<sid>/`) is its own temp place: a
// daemon that kept it would put attachments there and hand it to every launch.
//
// Design rationale: the daemon is spawned for real (ensureDaemon, with the
// CCMSG_DAEMON_ENTRY seam version-mismatch.test.ts documents) and its
// environment read from the OS (`ps eww` / /proc), so what is checked is what
// the running daemon has, not what a helper returns.
import { afterEach, beforeEach, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "@ccmsg/protocol";
import { userTempDir } from "@ccmsg/daemon/user-temp-dir";
import { parseEnv } from "../../daemon/src/session-env.ts";
import { ensureDaemon } from "../src/client.ts";
import { connect, testHomeEnv } from "../../daemon/test/helpers.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/src/index.ts", import.meta.url));
const SID = "5a000002-0000-4000-8000-000000000000";
const KEYS = [
  "CCMSG_STATE_DIR",
  "CCMSG_CONFIG_DIR",
  "CCMSG_DATA_DIR",
  "CCMSG_DAEMON_ENTRY",
  "CCMSG_VERSION_OVERRIDE",
  "HOME",
  "CLAUDE_CONFIG_DIR",
  "CCMSG_HTTP_BIND",
  "TMPDIR",
] as const;

let saved: Map<string, string | undefined>;
let stateDir: string;

beforeEach(() => {
  saved = new Map(KEYS.map((k) => [k, process.env[k]]));
  const base = tmp("ccmsg-spawn-env-");
  stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  // spawnDaemon hands the child this process's environment, so the daemon's
  // settings go here (as in version-mismatch.test.ts), restored afterwards.
  process.env.CCMSG_STATE_DIR = stateDir;
  process.env.CCMSG_CONFIG_DIR = path.join(dataDir, "config");
  process.env.CCMSG_DATA_DIR = dataDir;
  process.env.CCMSG_DAEMON_ENTRY = DAEMON_ENTRY;
  process.env.CCMSG_HTTP_BIND = "off";
  delete process.env.CCMSG_VERSION_OVERRIDE;
  const home = testHomeEnv(dataDir);
  process.env.HOME = home.HOME;
  process.env.CLAUDE_CONFIG_DIR = home.CLAUDE_CONFIG_DIR;
});

/** Whether `pid` still names a process. */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait for `pid` to exit, up to about 6 seconds. Design rationale:
 * ensureDaemon spawns the daemon unref'd and keeps no handle to it, so there
 * is no exit to await; looking with a growing delay is the only way to see it
 * go. The run's lifeline check fails a daemon left running. */
async function waitExited(pid: number): Promise<void> {
  for (const delay of [10, 25, 50, 100, 200, 400, 800, 1500, 3000]) {
    if (!alive(pid)) return;
    await Bun.sleep(delay);
  }
}

/** Stop the daemon on `stateDir` and see it exit. Called from the test itself:
 * its dirs (the socket's among them) are removed by perTestTmpDir's afterEach,
 * which runs before this file's. */
async function stopDaemon(pid: number): Promise<void> {
  try {
    const c = await connect(path.join(stateDir, "daemon.sock"));
    await c.request({ op: "shutdown" });
    c.close();
  } catch {
    // already gone
  }
  await waitExited(pid);
}

afterEach(() => {
  for (const [k, v] of saved) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

/** The environment of the running process `pid`, as the OS reports it. */
async function processEnv(pid: number): Promise<Record<string, string>> {
  const raw =
    process.platform === "linux"
      ? await Bun.file(`/proc/${String(pid)}/environ`).text()
      : Bun.spawnSync(["ps", "eww", "-p", String(pid), "-o", "command="]).stdout.toString();
  return parseEnv(raw, process.platform);
}

test("the daemon the CLI spawns has the per-user TMPDIR, not the calling session's", async () => {
  // The calling session's temp place, as a launch wrapper sets it.
  const sessionTmpdir = `${tmp("ccmsg-session-")}/tmp.local/${SID}/`;
  fs.mkdirSync(sessionTmpdir, { recursive: true });
  process.env.TMPDIR = sessionTmpdir;

  const client = await ensureDaemon(resolvePaths(), {
    role: "session",
    sid: SID,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
  });
  const pong = await client.request({ op: "ping" });
  client.close();
  if (!pong.ok) throw new Error(pong.error.msg);

  try {
    const env = await processEnv(pong.pid);
    // Read at all: a process whose environment the OS will not show reads as
    // empty, which would pass the TMPDIR checks below for the wrong reason.
    expect(env.CCMSG_STATE_DIR).toBe(stateDir);
    expect(env.TMPDIR).not.toBe(sessionTmpdir);
    expect(env.TMPDIR).toBe(userTempDir());
  } finally {
    await stopDaemon(pong.pid);
  }
});
