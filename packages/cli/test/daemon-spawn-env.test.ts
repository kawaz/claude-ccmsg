// The environment of the daemon the CLI spawns (DR-0002 §2): the caller's,
// without a Claude Code session's variables (CLAUDE_CONFIG_DIR kept) and with
// the OS's per-user TMPDIR in place of the caller's own. The CLI runs in
// whichever session called it (a hook, `just push`'s upgrade contact), and that
// session's identity and TMPDIR (`<project>/tmp.local/<sid>/`) are its own: a
// daemon that kept them would hand them to every launch and put attachments in
// that session's temp place.
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
import { connect, testHomeEnv, watchDaemonExit } from "../../daemon/test/helpers.ts";
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
  "CLAUDECODE",
  "CLAUDE_CODE_SESSION_ID",
  "CLAUDE_CODE_MESSAGING_TOKEN",
  "CLAUDE_CODE_CHILD_SESSION",
  "ANTHROPIC_BASE_URL",
  "AI_AGENT",
  "CCMSG_TEST_SPAWN_OTHER",
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

/** Stop the daemon on `stateDir` and see it exit. Called from the test itself:
 * its dirs (the socket's among them) are removed by perTestTmpDir's afterEach,
 * which runs before this file's. Design rationale: ensureDaemon spawns the
 * daemon unref'd and keeps no handle to it, so there is no exit to await; a
 * connection opened before the shutdown is closed by the kernel when the
 * process ends, which is the exit made visible. */
async function stopDaemon(): Promise<void> {
  const sock = path.join(stateDir, "daemon.sock");
  let gone: Promise<void>;
  try {
    gone = (await watchDaemonExit(sock)).gone;
  } catch {
    return; // already gone
  }
  try {
    const c = await connect(sock);
    await c.request({ op: "shutdown" });
    c.close();
  } catch {
    // already gone
  }
  await gone;
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
    await stopDaemon();
  }
});

test("the daemon the CLI spawns has none of the calling session's CLAUDE* / ANTHROPIC_* / AI_AGENT but CLAUDE_CONFIG_DIR", async () => {
  // What a session's Claude Code puts in its children's environment, as seen
  // in docs/findings/2026-11-25-daemon-inherited-env.md.
  process.env.CLAUDECODE = "1";
  process.env.CLAUDE_CODE_SESSION_ID = SID;
  process.env.CLAUDE_CODE_MESSAGING_TOKEN = "token";
  process.env.CLAUDE_CODE_CHILD_SESSION = "1";
  process.env.ANTHROPIC_BASE_URL = "http://127.0.0.1:9";
  process.env.AI_AGENT = "agent";
  process.env.CCMSG_TEST_SPAWN_OTHER = "other";
  const configDir = process.env.CLAUDE_CONFIG_DIR;

  const client = await ensureDaemon(resolvePaths(), {
    role: "session",
    sid: SID,
    cwd: "/tmp",
  });
  const pong = await client.request({ op: "ping" });
  client.close();
  if (!pong.ok) throw new Error(pong.error.msg);

  try {
    const env = await processEnv(pong.pid);
    // Read at all, as in the test above.
    expect(env.CCMSG_STATE_DIR).toBe(stateDir);
    for (const key of [
      "CLAUDECODE",
      "CLAUDE_CODE_SESSION_ID",
      "CLAUDE_CODE_MESSAGING_TOKEN",
      "CLAUDE_CODE_CHILD_SESSION",
      "ANTHROPIC_BASE_URL",
      "AI_AGENT",
    ]) {
      expect(env[key]).toBeUndefined();
    }
    expect(env.CLAUDE_CONFIG_DIR).toBe(configDir);
    expect(env.CCMSG_TEST_SPAWN_OTHER).toBe("other");
  } finally {
    await stopDaemon();
  }
});
