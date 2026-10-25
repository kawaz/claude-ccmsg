// session_restart (DR-0028 「restart」): stop a session's process as
// session_kill does and, once it is seen gone, resume the same id through the
// launch command — with where it ran, what it runs as, its name and the
// restart prompt. Every reason to refuse is checked before the stop; a
// process not seen gone is not resumed; a session in a config dir the launch
// command does not start claude in is not stopped.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LaunchCommandInputSchema,
  jsonText,
  parseWith,
  type LaunchCommandInput,
  type LaunchInput,
  type SessionRestartResponse,
} from "@ccmsg/protocol";
import { assistantMessage, assistantRow, line } from "../../protocol/test/transcript-rows.ts";
import type { SessionLauncherConfig } from "../src/config.ts";
import type { SessionKillDeps } from "../src/session-kill.ts";
import { RESTART_PROMPT, restartSession, type SessionRestartDeps } from "../src/session-restart.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  connect,
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
} from "./helpers.ts";

const tmp = perTestTmpDir();
const SID = "dddddddd-0000-4000-8000-000000000004";

const CommandInputText = jsonText(LaunchCommandInputSchema);

/** What a launch command that prints its standard input read. */
function commandInput(stdout: string): LaunchCommandInput {
  const read = parseWith(CommandInputText, stdout);
  if (!read.ok) throw new Error(`not a launch command input: ${read.failure.summary}`);
  return read.value;
}

/** A process whose command line reads as claude's (`ps` shows argv[0]
 * `<dir>/claude`), standing in for the session's: it must never be a real
 * one. It is the running bun under a symlink named `claude`, holding a timer:
 * bun does not pick its program by argv[0] (a multi-call coreutils such as
 * uutils does, and dies on `claude`), and a `#!/bin/sh` script would show
 * the interpreter as argv[0], which the pid check refuses. */
function fakeClaude(): Bun.Subprocess {
  const bin = path.join(tmp("fake-claude-"), "claude");
  fs.symlinkSync(process.execPath, bin);
  return Bun.spawn([bin, "-e", "setTimeout(() => {}, 600_000)"]);
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** A Claude config dir holding the session's `sessions/<pid>.json` and its
 * transcript, whose newest main-context assistant row ran as `model` /
 * `effort`. */
function claudeConfigDir(
  pid: number,
  cwd: string,
  record: { name?: string } = {},
): { dir: string; transcript: string } {
  const dir = fs.realpathSync(tmp("claude-config-"));
  fs.mkdirSync(path.join(dir, "sessions"));
  fs.writeFileSync(
    path.join(dir, "sessions", `${String(pid)}.json`),
    JSON.stringify({ pid, sessionId: SID, cwd, kind: "interactive", ...record }),
  );
  const project = path.join(dir, "projects", "-w");
  fs.mkdirSync(project, { recursive: true });
  const transcript = path.join(project, `${SID}.jsonl`);
  fs.writeFileSync(
    transcript,
    line(
      assistantRow({
        effort: "high",
        message: assistantMessage({ model: "claude-opus-5-5[1m]" }),
      }),
    ) + "\n",
  );
  return { dir, transcript };
}

/** A launch command that prints its standard input, and on stderr whether
 * `pid` was still there when it ran. */
function launchCommand(dir: string, pid: number, exit = 0): string {
  return writeMockBin(
    path.join(dir, "resume-launch"),
    `#!/bin/sh\ncat\nif kill -0 ${String(pid)} 2>/dev/null; then echo alive >&2; else echo gone >&2; fi\nexit ${String(exit)}\n`,
  );
}

/** A launch command for a test that never reaches the launch. */
function noLaunch(): string {
  return writeMockBin(path.join(tmp("restart-bin-"), "no-launch"), "#!/bin/sh\nexit 99\n");
}

/** A daemon whose launch command is `launchCommand` (none: no launcher), and
 * whose own CLAUDE_CONFIG_DIR is `claudeConfig`. */
async function withDaemon(
  launchCommand: string | undefined,
  claudeConfig: string,
  run: (ctx: InProcessDaemon) => Promise<void>,
): Promise<void> {
  const ctx = await startInProcessDaemon({
    ...(launchCommand !== undefined
      ? {
          config: {
            session_launcher: { launch_command: [launchCommand], root_dirs: [claudeConfig] },
          },
        }
      : {}),
    env: { CLAUDE_CONFIG_DIR: claudeConfig },
  });
  try {
    await run(ctx);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

function launcher(command: string, root: string): SessionLauncherConfig {
  return {
    launch_command: [command],
    root_dirs: [root],
    dir_tree_depth: 2,
    launch_timeout_seconds: 10,
    launch_max_concurrency: 4,
    clean_env: [],
    keep_env: [],
  };
}

function restartLogLines(ctx: InProcessDaemon): string[] {
  return fs
    .readFileSync(ctx.daemon.paths.log, "utf8")
    .split("\n")
    .filter((text) => text.includes("session_restart: "));
}

describe("session_restart over the wire", () => {
  test("stops the process, then resumes the same id where it ran, as what it runs as, with the restart prompt", async () => {
    const proc = fakeClaude();
    try {
      const cwd = fs.realpathSync(tmp("restart-cwd-"));
      const config = claudeConfigDir(proc.pid, cwd, { name: "🤖restart-test" });
      const command = launchCommand(tmp("restart-bin-"), proc.pid);
      await withDaemon(command, config.dir, async (ctx) => {
        const session = await sessionConn(ctx, SID, {
          cwd,
          config_dir: config.dir,
          transcript_path: config.transcript,
        });
        const user = await userConn(ctx);
        const reply: SessionRestartResponse = await user.requestOk({
          op: "session_restart",
          session_id: SID,
        });
        expect(reply.restarted).toBe(true);
        expect(reply.session_id).toBe(SID);
        expect(reply.exit_code).toBe(0);
        // The launch command ran only after the process was gone.
        expect(reply.stderr.trim()).toBe("gone");
        expect(commandInput(reply.stdout)).toEqual({
          cwd,
          resume: SID,
          model: "opus",
          effort: "high",
          name: "🤖restart-test",
          prompt: RESTART_PROMPT,
        });
        await proc.exited;
        const logged = restartLogLines(ctx);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain(
          `session_restart: session_id=${SID} pid=${String(proc.pid)} terminated=true exit_code=0`,
        );
        // The stopped session is forgotten: the resumed one comes back with
        // its own hello.
        expect(ctx.daemon.sessions.has(SID)).toBe(false);
        session.close();
        user.close();
      });
    } finally {
      proc.kill("SIGKILL");
    }
  });

  test("a non-zero launch command is answered as such: stopped, not resumed", async () => {
    const proc = fakeClaude();
    try {
      const cwd = fs.realpathSync(tmp("restart-cwd-"));
      const config = claudeConfigDir(proc.pid, cwd);
      const command = launchCommand(tmp("restart-bin-"), proc.pid, 2);
      await withDaemon(command, config.dir, async (ctx) => {
        const session = await sessionConn(ctx, SID, { cwd, config_dir: config.dir });
        const user = await userConn(ctx);
        const reply: SessionRestartResponse = await user.requestOk({
          op: "session_restart",
          session_id: SID,
        });
        expect(reply.exit_code).toBe(2);
        expect(reply.session_id).toBe(SID);
        expect(commandInput(reply.stdout).name).toBeUndefined();
        await proc.exited;
        session.close();
        user.close();
      });
    } finally {
      proc.kill("SIGKILL");
    }
  });

  test("a session in another config dir than the launch command starts claude in is refused, and not stopped", async () => {
    const proc = fakeClaude();
    try {
      const cwd = fs.realpathSync(tmp("restart-cwd-"));
      const config = claudeConfigDir(proc.pid, cwd);
      const daemonConfig = fs.realpathSync(tmp("daemon-claude-config-"));
      const command = launchCommand(tmp("restart-bin-"), proc.pid);
      await withDaemon(command, daemonConfig, async (ctx) => {
        const session = await sessionConn(ctx, SID, { cwd, config_dir: config.dir });
        const user = await userConn(ctx);
        const reply = await user.requestError({ op: "session_restart", session_id: SID });
        expect(reply.error.code).toBe("restart_unavailable");
        expect(isAlive(proc.pid)).toBe(true);
        const logged = restartLogLines(ctx);
        expect(logged).toHaveLength(1);
        expect(logged[0]).toContain(`session_restart: session_id=${SID} error=restart_unavailable`);
        session.close();
        user.close();
      });
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  test("without a launcher it is refused before anything, and the process stays", async () => {
    const proc = fakeClaude();
    try {
      const cwd = fs.realpathSync(tmp("restart-cwd-"));
      const config = claudeConfigDir(proc.pid, cwd);
      await withDaemon(undefined, config.dir, async (ctx) => {
        const session = await sessionConn(ctx, SID, { cwd, config_dir: config.dir });
        const user = await userConn(ctx);
        const reply = await user.requestError({ op: "session_restart", session_id: SID });
        expect(reply.error.code).toBe("launcher_not_configured");
        expect(isAlive(proc.pid)).toBe(true);
        session.close();
        user.close();
      });
    } finally {
      proc.kill("SIGKILL");
      await proc.exited;
    }
  });

  test("a session with no process is not_found", async () => {
    const cwd = fs.realpathSync(tmp("restart-cwd-"));
    const config = fs.realpathSync(tmp("claude-config-"));
    await withDaemon(noLaunch(), config, async (ctx) => {
      const session = await sessionConn(ctx, SID, { cwd, config_dir: config });
      const user = await userConn(ctx);
      const reply = await user.requestError({ op: "session_restart", session_id: SID });
      expect(reply.error.code).toBe("not_found");
      session.close();
      user.close();
    });
  });

  test("a session role is refused with bad_request", async () => {
    const cwd = fs.realpathSync(tmp("restart-cwd-"));
    const config = fs.realpathSync(tmp("claude-config-"));
    await withDaemon(noLaunch(), config, async (ctx) => {
      const session = await sessionConn(ctx, SID, { cwd, config_dir: config });
      const reply = await session.requestError({ op: "session_restart", session_id: SID });
      expect(reply.error.code).toBe("bad_request");
      session.close();
    });
  });

  test("hello names the config dir the launch command starts claude in, only with a launcher", async () => {
    const config = fs.realpathSync(tmp("claude-config-"));
    await withDaemon(noLaunch(), config, async (ctx) => {
      const user = await connect(ctx.sock);
      expect((await user.hello({ role: "user" })).launch_config_dir).toBe(config);
      user.close();
    });
    await withDaemon(undefined, config, async (ctx) => {
      const user = await connect(ctx.sock);
      expect((await user.hello({ role: "user" })).launch_config_dir).toBeUndefined();
      user.close();
    });
  });
});

/** Inert kill effects for restartSession's own branches: the process is
 * found and verified, and `alive` decides whether it outlives the signals. */
function fakeKill(alive: boolean, signals: string[]): SessionKillDeps {
  return {
    configDirs: () => ["/fake/.claude"],
    sessionsIn: () => Promise.resolve([{ sessionId: SID, pid: 4242, cwd: "/w", name: "n" }]),
    runPs: () => Promise.resolve("claude\n"),
    sendSignal: (_pid, sig) => {
      signals.push(sig);
    },
    isAlive: () => alive,
    sleep: () => Promise.resolve(),
    timing: { secondSignalAfterMs: 100, pollIntervalMs: 20, totalGraceMs: 300 },
  };
}

function restartDeps(
  kill: SessionKillDeps,
  calls: { launches: LaunchInput[]; stopped: number },
): SessionRestartDeps {
  return {
    launcher: launcher("/bin/true", "/w"),
    baseEnv: { CLAUDE_CONFIG_DIR: "/fake/.claude" },
    sessionConfigDir: "/fake/.claude",
    kill,
    runsAs: () => Promise.resolve({ model: "claude-sonnet-5-5", effort: "low" }),
    stopped: () => {
      calls.stopped += 1;
    },
    launch: (launch) => {
      calls.launches.push(launch);
      return Promise.resolve({
        ok: true,
        response: { ok: true, exit_code: 0, stdout: "", stderr: "" },
      });
    },
    log: { info: () => {} },
  };
}

describe("restartSession", () => {
  test("a process not seen gone after the signals is restart_timeout, and is not resumed", async () => {
    const signals: string[] = [];
    const calls: { launches: LaunchInput[]; stopped: number } = { launches: [], stopped: 0 };
    const outcome = await restartSession(SID, restartDeps(fakeKill(true, signals), calls));
    if (outcome.ok) throw new Error("a process not seen gone was restarted");
    expect(outcome.code).toBe("restart_timeout");
    expect(outcome.msg).toContain("was not seen gone");
    // The kill's two SIGTERMs, never SIGKILL (DR-0028).
    expect(signals).toEqual(["SIGTERM", "SIGTERM"]);
    expect(calls).toEqual({ launches: [], stopped: 0 });
  });

  test("the resume carries the fixed restart prompt", async () => {
    const calls: { launches: LaunchInput[]; stopped: number } = { launches: [], stopped: 0 };
    const outcome = await restartSession(SID, restartDeps(fakeKill(false, []), calls));
    expect(outcome.ok).toBe(true);
    expect(calls.stopped).toBe(1);
    expect(calls.launches).toEqual([
      { cwd: "/w", resume: SID, model: "sonnet", effort: "low", name: "n", prompt: RESTART_PROMPT },
    ]);
    expect(RESTART_PROMPT).toBe(
      "プロセス再起動 (resume) しました。バックグラウンドプロセスとチームメートは停止され再利用不可。サブエージェントは作業中は中断されたかもだが再開指示などアクセスは可能。cron/schedule があるなら貼り直してください。",
    );
  });

  test("a record without a cwd is restart_unavailable, before any signal", async () => {
    const signals: string[] = [];
    const kill = {
      ...fakeKill(false, signals),
      sessionsIn: () => Promise.resolve([{ sessionId: SID, pid: 4242 }]),
    };
    const calls: { launches: LaunchInput[]; stopped: number } = { launches: [], stopped: 0 };
    const outcome = await restartSession(SID, restartDeps(kill, calls));
    expect(outcome.ok ? undefined : outcome.code).toBe("restart_unavailable");
    expect(signals).toEqual([]);
  });

  test("a model or effort the launch cannot name is left to the launch command", async () => {
    const calls: { launches: LaunchInput[]; stopped: number } = { launches: [], stopped: 0 };
    const deps = {
      ...restartDeps(fakeKill(false, []), calls),
      runsAs: () => Promise.resolve({ model: "<synthetic>", effort: "turbo" }),
    };
    await restartSession(SID, deps);
    expect(calls.launches).toEqual([{ cwd: "/w", resume: SID, name: "n", prompt: RESTART_PROMPT }]);
  });
});
