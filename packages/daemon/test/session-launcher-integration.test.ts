// session_launch and its sibling ops over the wire (DR-0018 §3.4, §3.5, §3.8):
// what the launch command reads on standard input, what the reply carries,
// who may launch, how many may run at once, what a shutdown does to the ones
// running, and the daemon.log line each launch leaves.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  LaunchCommandInputSchema,
  jsonText,
  parseWith,
  PROTOCOL_VERSION,
  type LaunchCommandInput,
  type LaunchInput,
  type SessionLaunchResponse,
} from "@ccmsg/protocol";
import type { CcmsgConfig } from "../src/config.ts";
import { launchId, LAUNCH_OUTPUT_LIFETIME_MS } from "../src/launch-output.ts";
import {
  connect,
  sessionConn,
  spawnDaemonProc,
  startInProcessDaemon,
  stopInProcessDaemon,
  testConfigDir,
  userConn,
  waitConnectable,
  type InProcessDaemon,
  type TestClient,
} from "./helpers.ts";
import { shutdownDaemon } from "../src/server.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const RESUME_SID = "bbbbbbbb-0000-4000-8000-000000000002";
const RECORD_UUID = "cccccccc-0000-4000-8000-000000000003";

/** A launch command that prints its standard input to stdout and its cwd to
 * stderr, then exits with `exit`. */
function echoCommand(dir: string, exit = 0): string {
  return writeMockBin(
    path.join(dir, "echo-launch"),
    `#!/bin/sh\ncat\npwd -P >&2\nexit ${String(exit)}\n`,
  );
}

/** A launcher config around `launchCommand`, whose cwd tree root is `root`. */
function launcherConfig(
  launchCommand: [string, ...string[]],
  root: string,
  extra: Partial<NonNullable<CcmsgConfig["session_launcher"]>> = {},
): CcmsgConfig {
  return { session_launcher: { launch_command: launchCommand, root_dirs: [root], ...extra } };
}

async function withDaemon(
  config: CcmsgConfig | undefined,
  run: (ctx: InProcessDaemon) => Promise<void>,
  env: Record<string, string> = {},
): Promise<void> {
  const ctx = await startInProcessDaemon(config === undefined ? { env } : { config, env });
  try {
    await run(ctx);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

const CommandInputText = jsonText(LaunchCommandInputSchema);

/** What the echo command read on standard input. */
function commandInput(reply: SessionLaunchResponse): LaunchCommandInput {
  const read = parseWith(CommandInputText, reply.stdout);
  if (!read.ok) throw new Error(`not a launch command input: ${read.failure.summary}`);
  return read.value;
}

async function launch(client: TestClient, input: LaunchInput): Promise<SessionLaunchResponse> {
  return client.requestOk({ op: "session_launch", launch: input });
}

/** A FIFO the launch command blocks on until the test writes a line to it,
 * so the test, not a race, decides when the command ends. */
function gate(dir: string, name = "gate"): string {
  const fifo = path.join(dir, name);
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  return fifo;
}

/** A launch command that writes its stdin to `<dir>/started-<n>` once it is
 * running, then waits on `gateFifo` before echoing its stdin. */
function gatedCommand(dir: string, gateFifo: string): string {
  return writeMockBin(
    path.join(dir, "gated"),
    `#!/bin/sh\ninput=$(cat)\nprintf '%s' "$input" > "$(mktemp ${JSON.stringify(path.join(dir, "started-XXXXXX"))})"\n` +
      `read line < ${JSON.stringify(gateFifo)}\nprintf '%s' "$input"\n`,
  );
}

/** How many gated commands have started, once `n` have: a deadline-bound
 * look at the files they wrote (the commands are other processes). */
async function startedCount(dir: string, n: number): Promise<number> {
  const until = Date.now() + 5000;
  for (;;) {
    const count = fs.readdirSync(dir).filter((name) => name.startsWith("started-")).length;
    if (count >= n || Date.now() > until) return count;
    await Bun.sleep(20);
  }
}

/** The daemon.log lines of the in-process daemon that record launches. */
function launchLogLines(ctx: InProcessDaemon): string[] {
  return fs
    .readFileSync(ctx.daemon.paths.log, "utf8")
    .split("\n")
    .filter((line) => line.includes("session_launch: "));
}

describe("session_launch: what the launch command reads", () => {
  // A new session gets the id the daemon chose, and the reply returns that id
  // once the command exits 0. The cwd the command runs in, and the one it
  // reads, is the realpath of what was asked (here through a symlink).
  test("a new session carries its id, a realpath cwd and who asked", async () => {
    const dir = tmp("ccmsg-launch-");
    const real = fs.realpathSync(dir);
    fs.symlinkSync(real, path.join(real, "link"));
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, {
        cwd: path.join(dir, "link"),
        model: "opus",
        effort: "high",
        name: "worker",
        prompt: "do the work",
      });
      expect(reply.exit_code).toBe(0);
      expect(reply.session_id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      expect(commandInput(reply)).toEqual({
        cwd: real,
        model: "opus",
        effort: "high",
        name: "worker",
        prompt: "do the work",
        session_id: reply.session_id ?? "",
      });
      expect(reply.stderr).toBe(`${real}\n`);
    });
  });

  // The command reads one JSON text with no line break after it
  // (launch-command.md): a reader that keeps the last byte sees `}`.
  test("standard input is the JSON text with no trailing line break", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { cwd: dir, continue: true, prompt: "ends with\n" });
      expect(reply.stdout).toBe(
        JSON.stringify({
          cwd: fs.realpathSync(dir),
          continue: true,
          prompt: "ends with\n",
        }),
      );
      expect(reply.stdout.endsWith("}")).toBe(true);
    });
  });

  test("a fork carries the new session's id beside the session it copies", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, {
        cwd: dir,
        resume: RESUME_SID,
        fork_session: true,
        resume_session_at: RECORD_UUID,
      });
      expect(reply.session_id).toBeDefined();
      expect(reply.session_id).not.toBe(RESUME_SID);
      expect(commandInput(reply)).toEqual({
        cwd: fs.realpathSync(dir),
        resume: RESUME_SID,
        fork_session: true,
        resume_session_at: RECORD_UUID,
        session_id: reply.session_id ?? "",
      });
    });
  });

  // A continue or resume that does not fork starts no new id: the reply has
  // none, and the command reads none (claude refuses --session-id there).
  test("a continue or resume that does not fork carries no session id, in or out", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const cont = await launch(client, { cwd: dir, continue: true, model: "sonnet" });
      expect(cont.session_id).toBeUndefined();
      expect(commandInput(cont)).toEqual({
        cwd: fs.realpathSync(dir),
        continue: true,
        model: "sonnet",
      });
      const resume = await launch(client, { cwd: dir, resume: RESUME_SID, prompt: "go on" });
      expect(resume.session_id).toBeUndefined();
      expect(commandInput(resume)).toEqual({
        cwd: fs.realpathSync(dir),
        resume: RESUME_SID,
        prompt: "go on",
      });
    });
  });

  // A non-zero exit means the command started no session (launch-command.md),
  // so no id is returned; the exit code and output are, uninterpreted.
  test("a non-zero exit returns no session id", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir, 3)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { cwd: dir, model: "haiku", effort: "low" });
      expect(reply.exit_code).toBe(3);
      expect(reply.session_id).toBeUndefined();
      expect(commandInput(reply)).toMatchObject({ model: "haiku" });
    });
  });

  // The launch command's arguments are the config's, as written: the daemon
  // adds none.
  test("the configured arguments reach the command and nothing is added", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(path.join(dir, "args"), `#!/bin/sh\nprintf '[%s]' "$@"\n`);
    await withDaemon(launcherConfig([bin, "--flag", "two words"], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { cwd: dir, continue: true });
      expect(reply.stdout).toBe("[--flag][two words]");
    });
  });
});

describe("session_launch: how the run ends", () => {
  // launch_timeout_seconds sends SIGTERM; a command ended by it answers 143, and the
  // log line says the deadline did it.
  test("a command past launch_timeout_seconds is ended, answers 143, and is logged timed_out", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(path.join(dir, "slow"), "#!/bin/sh\nexec sleep 30\n");
    await withDaemon(launcherConfig([bin], dir, { launch_timeout_seconds: 1 }), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { cwd: dir, model: "opus", effort: "low" });
      expect(reply).toEqual({ ok: true, exit_code: 143, stdout: "", stderr: "" });
      expect(launchLogLines(ctx)[0]).toContain(" exit_code=143 timed_out=true ");
    });
  });

  // A command that ignores the SIGTERM is killed LAUNCH_KILL_GRACE_MS later;
  // the reply is SIGKILL's 137, with what it printed before.
  test("a command that ignores the timeout's SIGTERM answers 137", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(
      path.join(dir, "stubborn"),
      // No child to wait on: the SIGTERM to the group would end it, and the
      // shell would report that on stderr.
      "#!/bin/sh\ntrap 'printf term-ignored >&2' TERM\nprintf started\nwhile :; do :; done\n",
    );
    await withDaemon(launcherConfig([bin], dir, { launch_timeout_seconds: 1 }), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { cwd: dir, continue: true });
      expect(reply).toEqual({
        ok: true,
        exit_code: 137,
        stdout: "started",
        stderr: "term-ignored",
      });
    });
  });

  // A command that leaves a child holding the pipes is answered
  // LAUNCH_PIPE_DRAIN_GRACE_MS after it exits, with what arrived by then: the
  // reply does not wait for the child.
  test("a child left holding the pipes does not hold back the reply", async () => {
    const dir = tmp("ccmsg-launch-");
    const pidFile = path.join(dir, "child.pid");
    const bin = writeMockBin(
      path.join(dir, "leaves-child"),
      `#!/bin/sh\nprintf before\nsleep 30 &\nprintf '%s' $! > ${JSON.stringify(pidFile)}\nexit 0\n`,
    );
    await withDaemon(launcherConfig([bin], dir), async (ctx) => {
      const client = await userConn(ctx);
      const started = Date.now();
      try {
        const reply = await launch(client, { cwd: dir, continue: true });
        expect(reply).toEqual({ ok: true, exit_code: 0, stdout: "before", stderr: "" });
        expect(Date.now() - started).toBeLessThan(5000);
      } finally {
        const written = fs.existsSync(pidFile) ? fs.readFileSync(pidFile, "utf8").trim() : "";
        if (/^\d+$/.test(written)) process.kill(Number(written), "SIGKILL");
      }
    });
  });

  // Output of 4096 bytes or more is written to <state dir>/launches/<id>/ and
  // answered with where it is; each stream on its own.
  test("output from 4096 bytes on is answered with the file it was written to", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(
      path.join(dir, "loud"),
      "#!/bin/sh\nhead -c 4096 /dev/zero | tr '\\0' o\nhead -c 4095 /dev/zero | tr '\\0' e >&2\n",
    );
    await withDaemon(launcherConfig([bin], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { cwd: dir, continue: true });
      const launches = ctx.daemon.paths.launches;
      const [id] = fs.readdirSync(launches);
      if (id === undefined) throw new Error("no launch dir");
      const file = path.join(launches, id, "stdout");
      expect(reply.stdout).toBe(`output is 4096 bytes, file: ${file}`);
      expect(reply.stderr).toBe("e".repeat(4095));
      expect(fs.readFileSync(file, "utf8")).toBe("o".repeat(4096));
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.statSync(path.join(launches, id)).mode & 0o777).toBe(0o700);
    });
  });

  // Short output writes nothing, not even the launches dir.
  test("short output leaves no launch dir", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      await launch(client, { cwd: dir, continue: true });
      expect(fs.existsSync(ctx.daemon.paths.launches)).toBe(false);
    });
  });

  // The environment is the daemon's, without clean_env's keys unless keep_env
  // keeps them.
  test("clean_env keys are not inherited unless keep_env keeps them", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(
      path.join(dir, "env"),
      '#!/bin/sh\nprintf "kept=%s cleaned=%s other=%s" "${CCMSG_TEST_LE_KEEP-absent}" ' +
        '"${CCMSG_TEST_LE_DROP-absent}" "${CCMSG_TEST_OTHER-absent}"\n',
    );
    await withDaemon(
      launcherConfig([bin], dir, {
        clean_env: ["CCMSG_TEST_LE_*"],
        keep_env: ["CCMSG_TEST_LE_KEEP"],
      }),
      async (ctx) => {
        const client = await userConn(ctx);
        const reply = await launch(client, { cwd: dir, continue: true });
        expect(reply.stdout).toBe("kept=k cleaned=absent other=o");
      },
      { CCMSG_TEST_LE_KEEP: "k", CCMSG_TEST_LE_DROP: "d", CCMSG_TEST_OTHER: "o" },
    );
  });

  // Who asked arrives in CCMSG_LAUNCH_REQUESTED_BY, put over the cleaned
  // environment: a clean_env pattern that matches it does not remove it.
  test("who asked arrives in CCMSG_LAUNCH_REQUESTED_BY even past clean_env", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(
      path.join(dir, "who"),
      '#!/bin/sh\nprintf "%s" "${CCMSG_LAUNCH_REQUESTED_BY-absent}"\n',
    );
    await withDaemon(launcherConfig([bin], dir, { clean_env: ["CCMSG_*"] }), async (ctx) => {
      const user = await userConn(ctx);
      expect((await launch(user, { cwd: dir, continue: true })).stdout).toBe("user");
      const session = await sessionConn(ctx, SID, { cwd: dir });
      expect((await launch(session, { cwd: dir, continue: true })).stdout).toBe(SID);
    });
  });

  // The reply waits for the command; other requests of the same connection
  // do not wait for the reply. The command holds until the test opens its
  // gate, so the order is the test's, not a race.
  test("a launch still running holds back no other reply on its connection", async () => {
    const dir = tmp("ccmsg-launch-");
    const fifo = gate(dir);
    const bin = writeMockBin(
      path.join(dir, "gated"),
      `#!/bin/sh\nread line < ${JSON.stringify(fifo)}\nprintf "released-%s" "$line"\n`,
    );
    await withDaemon(launcherConfig([bin], dir), async (ctx) => {
      const client = await userConn(ctx);
      const launching = launch(client, { cwd: dir, continue: true });
      expect(await client.requestOk({ op: "ping" })).toMatchObject({ pong: true });
      await fs.promises.writeFile(fifo, "go\n");
      expect((await launching).stdout).toBe("released-go");
    });
  });

  // Two launches running at once each get their own id, and each reply is
  // its own command's.
  test("two launches at once get two ids and their own replies", async () => {
    const dir = tmp("ccmsg-launch-");
    const fifo = gate(dir);
    await withDaemon(launcherConfig([gatedCommand(dir, fifo)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const first = launch(client, { cwd: dir, model: "opus", effort: "low", name: "first" });
      const second = launch(client, { cwd: dir, model: "haiku", effort: "high", name: "second" });
      expect(await startedCount(dir, 2)).toBe(2);
      await fs.promises.writeFile(fifo, "go\ngo\n");
      const [a, b] = await Promise.all([first, second]);
      expect(a.session_id).toBeDefined();
      expect(b.session_id).toBeDefined();
      expect(a.session_id).not.toBe(b.session_id);
      expect(commandInput(a)).toMatchObject({ name: "first", session_id: a.session_id ?? "" });
      expect(commandInput(b)).toMatchObject({ name: "second", session_id: b.session_id ?? "" });
    });
  });
});

describe("session_launch: how many run at once", () => {
  // launch_max_concurrency bounds the launch commands the daemon holds: one more is
  // refused without running, and a launch is taken again once one ends.
  test("a launch past launch_max_concurrency is launch_busy, and is taken once one ends", async () => {
    const dir = tmp("ccmsg-launch-");
    const fifo = gate(dir);
    await withDaemon(
      launcherConfig([gatedCommand(dir, fifo)], dir, { launch_max_concurrency: 1 }),
      async (ctx) => {
        const client = await userConn(ctx);
        const running = launch(client, { cwd: dir, continue: true });
        expect(await startedCount(dir, 1)).toBe(1);
        const busy = await client.requestError({
          op: "session_launch",
          launch: { cwd: dir, continue: true },
        });
        expect(busy.error.code).toBe("launch_busy");
        expect(busy.error.msg).toContain("launch_max_concurrency");
        // Refused before it ran: still the one command started.
        expect(await startedCount(dir, 1)).toBe(1);
        await fs.promises.writeFile(fifo, "go\n");
        expect((await running).exit_code).toBe(0);
        const next = launch(client, { cwd: dir, continue: true });
        expect(await startedCount(dir, 2)).toBe(2);
        await fs.promises.writeFile(fifo, "go\n");
        expect((await next).exit_code).toBe(0);
      },
    );
  });

  // A shutdown takes no more launches, and waits for the ones running so
  // their askers are answered.
  test("a shutdown refuses a new launch and answers the one running", async () => {
    const dir = tmp("ccmsg-launch-");
    const fifo = gate(dir);
    const ctx = await startInProcessDaemon({
      config: launcherConfig([gatedCommand(dir, fifo)], dir),
    });
    let stopped = false;
    try {
      const client = await userConn(ctx);
      const other = await userConn(ctx);
      const running = launch(client, { cwd: dir, continue: true });
      expect(await startedCount(dir, 1)).toBe(1);
      const stopping = shutdownDaemon(ctx.daemon, "test").then(() => {
        stopped = true;
      });
      const refused = await other.requestError({
        op: "session_launch",
        launch: { cwd: dir, continue: true },
      });
      expect(refused.error.code).toBe("launch_busy");
      expect(refused.error.msg).toContain("shutting down");
      // Still waiting for the launch: nothing has stopped yet.
      expect(stopped).toBe(false);
      await fs.promises.writeFile(fifo, "go\n");
      expect((await running).exit_code).toBe(0);
      await stopping;
      expect(stopped).toBe(true);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});

describe("session_launch: refusals", () => {
  test("no session_launcher in the config is launcher_not_configured", async () => {
    await withDaemon(undefined, async (ctx) => {
      const client = await userConn(ctx);
      for (const op of ["session_launch", "session_launcher_config"] as const) {
        const response =
          op === "session_launch"
            ? await client.requestError({ op, launch: { cwd: "/", continue: true } })
            : await client.requestError({ op });
        expect(response.error).toEqual({
          code: "launcher_not_configured",
          msg: "session launcher is not configured",
        });
      }
    });
  });

  // The cwd has to be a directory that exists; whether it may be launched in
  // is the launch command's call, so a cwd outside root_dirs is not refused.
  test("a cwd that is not an existing directory is invalid_args", async () => {
    const dir = tmp("ccmsg-launch-");
    const file = path.join(dir, "file");
    fs.writeFileSync(file, "");
    const outside = tmp("ccmsg-launch-outside-");
    const root = path.join(dir, "root");
    fs.mkdirSync(root);
    await withDaemon(launcherConfig([echoCommand(dir)], root), async (ctx) => {
      const client = await userConn(ctx);
      for (const cwd of [path.join(dir, "missing"), file]) {
        const response = await client.requestError({
          op: "session_launch",
          launch: { cwd, continue: true },
        });
        expect(response.error).toEqual({
          code: "invalid_args",
          msg: `launch.cwd is not an existing directory: ${cwd}`,
        });
      }
      const elsewhere = await launch(client, { cwd: outside, continue: true });
      expect(elsewhere.exit_code).toBe(0);
    });
  });

  // The launch is read by its schema: a field it does not have, or a
  // combination claude refuses, is refused with where it is, and nothing
  // runs.
  test("a launch that does not read is invalid_args, and nothing runs", async () => {
    const dir = tmp("ccmsg-launch-");
    const marker = path.join(dir, "ran");
    const bin = writeMockBin(path.join(dir, "mark"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    await withDaemon(launcherConfig([bin], dir), async (ctx) => {
      const client = await userConn(ctx);
      for (const [launchValue, where] of [
        [{ cwd: dir, continue: true, resume_session_id: RESUME_SID }, "launch.resume_session_id"],
        [{ cwd: dir, continue: true, resume: RESUME_SID }, "launch.resume"],
        [{ cwd: dir, model: "opus" }, "launch.effort"],
      ] as const) {
        const response = await client.requestRefusal({ op: "session_launch", launch: launchValue });
        expect(response.error.code).toBe("invalid_args");
        expect(response.error.msg).toContain(where);
      }
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  // The program is checked when the config is read; one that goes away
  // afterwards cannot be started, and there is no exit code to answer with.
  test("a launch command that cannot be started is launch_command_unavailable", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(path.join(dir, "vanishing"), "#!/bin/sh\n");
    await withDaemon(launcherConfig([bin], dir), async (ctx) => {
      fs.rmSync(bin);
      const client = await userConn(ctx);
      const response = await client.requestError({
        op: "session_launch",
        launch: { cwd: dir, continue: true },
      });
      expect(response.error.code).toBe("launch_command_unavailable");
      expect(response.error.msg).toContain(`${bin} in ${fs.realpathSync(dir)}: `);
      expect(response.error.msg).toContain("ENOENT");
      const lines = launchLogLines(ctx);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `launch_command_unavailable: ${JSON.stringify(response.error.msg)}`,
      );
    });
  });
});

describe("session_launch: who launches", () => {
  // A session may launch (§3.8): what runs is still the one configured
  // command. The log line names the session that asked and carries the
  // prompt's length, never its text.
  test("a session launches, and the log line names it without the prompt", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await sessionConn(ctx, SID, { cwd: dir });
      const prompt = "a secret plan";
      const reply = await launch(client, {
        cwd: dir,
        resume: RESUME_SID,
        fork_session: true,
        prompt,
      });
      expect(reply.exit_code).toBe(0);
      const lines = launchLogLines(ctx);
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toContain(
        `session_launch: by=${SID} cwd=${JSON.stringify(fs.realpathSync(dir))}` +
          ` resume=${RESUME_SID} fork_session=true session_id=${reply.session_id ?? ""}` +
          ` prompt_bytes=${String(Buffer.byteLength(prompt))} exit_code=0` +
          ` stdout_bytes=${String(Buffer.byteLength(reply.stdout))}` +
          ` stderr_bytes=${String(Buffer.byteLength(reply.stderr))}`,
      );
      expect(line).not.toContain(prompt);
    });
  });

  // The cwd is the asker's text: written as a JSON string, a line break or a
  // `key=value` in it cannot pose as a field of the line.
  test("a cwd in the log line is a JSON string", async () => {
    const base = tmp("ccmsg-launch-");
    const dir = path.join(base, "a exit_code=0\nsession_launch: by=user");
    fs.mkdirSync(dir);
    await withDaemon(launcherConfig([echoCommand(base)], base), async (ctx) => {
      const client = await userConn(ctx);
      await launch(client, { cwd: dir, continue: true });
      const lines = launchLogLines(ctx);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `session_launch: by=user cwd=${JSON.stringify(fs.realpathSync(dir))} continue=true exit_code=0`,
      );
    });
  });

  // The form's material and the cwd tree are the person's, not a session's.
  test("a session cannot read session_launcher_config or dir_tree", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await sessionConn(ctx, SID, { cwd: dir });
      for (const response of [
        await client.requestError({ op: "session_launcher_config" }),
        await client.requestError({ op: "dir_tree", roots: [dir] }),
      ]) {
        expect(response.error.code).toBe("bad_request");
      }
    });
  });

  // default_effort is read from the daemon's own CLAUDE_CONFIG_DIR when
  // asked: a model whose effortLevel is not one a launch names is left out.
  test("session_launcher_config answers root_dirs and the settings' default efforts", async () => {
    const dir = tmp("ccmsg-launch-");
    const claudeConfig = tmp("ccmsg-launch-claude-");
    fs.writeFileSync(
      path.join(claudeConfig, "settings.json"),
      JSON.stringify({
        theme: "dark",
        modelSettings: {
          fable: { effortLevel: "xhigh" },
          opus: { effortLevel: "ultra" },
          sonnet: { other: 1 },
          haiku: { effortLevel: "low", extra: true },
          "gpt-x": { effortLevel: "high" },
        },
      }),
    );
    await withDaemon(
      launcherConfig([echoCommand(dir)], dir),
      async (ctx) => {
        const client = await userConn(ctx);
        expect(await client.requestOk({ op: "session_launcher_config" })).toEqual({
          ok: true,
          root_dirs: [path.resolve(dir)],
          default_effort: { fable: "xhigh", haiku: "low" },
        });
      },
      { CLAUDE_CONFIG_DIR: claudeConfig },
    );
  });

  test("no settings.json, or one that does not read, is no default efforts", async () => {
    const dir = tmp("ccmsg-launch-");
    const claudeConfig = tmp("ccmsg-launch-claude-");
    await withDaemon(
      launcherConfig([echoCommand(dir)], dir),
      async (ctx) => {
        const client = await userConn(ctx);
        expect(await client.requestOk({ op: "session_launcher_config" })).toMatchObject({
          default_effort: {},
        });
        fs.writeFileSync(path.join(claudeConfig, "settings.json"), "{ not json");
        expect(await client.requestOk({ op: "session_launcher_config" })).toMatchObject({
          default_effort: {},
        });
      },
      { CLAUDE_CONFIG_DIR: claudeConfig },
    );
  });

  // launch_available is for the user's webui, and only where a launch can
  // be made.
  test("hello reports launch_available to the user where a launcher is configured", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const user = await connect(ctx.sock);
      const hello = await user.requestOk({ op: "hello", protocol: PROTOCOL_VERSION, role: "user" });
      expect(hello.launch_available).toBe(true);
      const session = await connect(ctx.sock);
      const sessionHello = await session.requestOk({
        op: "hello",
        protocol: PROTOCOL_VERSION,
        role: "session",
        sid: SID,
        repo: "r",
        ws: "w",
        cwd: dir,
      });
      expect(sessionHello.launch_available).toBeUndefined();
    });
    await withDaemon(undefined, async (ctx) => {
      const user = await connect(ctx.sock);
      const hello = await user.requestOk({ op: "hello", protocol: PROTOCOL_VERSION, role: "user" });
      expect(hello.launch_available).toBeUndefined();
    });
  });
});

describe("session_launcher config at daemon startup", () => {
  /** A daemon spawned on `config` (as config.json), with its dirs. */
  function spawnWith(config: object): {
    stateDir: string;
    dataDir: string;
    proc: Bun.Subprocess;
  } {
    const base = tmp("ccmsg-launch-daemon-");
    const stateDir = path.join(base, "s");
    const dataDir = path.join(base, "d");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(testConfigDir(dataDir), { recursive: true });
    fs.writeFileSync(path.join(testConfigDir(dataDir), "config.json"), JSON.stringify(config));
    return { stateDir, dataDir, proc: spawnDaemonProc(stateDir, dataDir) };
  }

  // The keys an older ccmsg's launcher reads are ignored while its sessions
  // still read this config (DR-0018 §3.1): the daemon starts, the new keys
  // take effect, and daemon.log names what has no effect.
  test("a launcher config with the legacy keys starts, the new keys in effect", async () => {
    const root = tmp("ccmsg-launch-root-");
    const bin = writeMockBin(path.join(root, "slow"), "#!/bin/sh\nexec sleep 30\n");
    const { stateDir, dataDir, proc } = spawnWith({
      session_launcher: {
        root_dirs: [root],
        shell: "bash",
        templates: [{ name: "default", command: "run", params: {} }],
        timeout_seconds: 30,
        launch_command: [bin],
        launch_timeout_seconds: 1,
      },
    });
    try {
      await waitConnectable(path.join(stateDir, "daemon.sock"));
      const file = path.join(testConfigDir(dataDir), "config.json");
      const log = fs.readFileSync(path.join(stateDir, "daemon.log"), "utf8");
      expect(log).toContain(
        `config: ${file}: session_launcher: ignoring legacy keys: shell, templates, timeout_seconds`,
      );
      // launch_timeout_seconds (1), not the legacy timeout_seconds (30).
      const client = await userConn({ sock: path.join(stateDir, "daemon.sock") });
      const reply = await launch(client, { cwd: root, continue: true });
      expect(reply.exit_code).toBe(143);
      client.close();
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  // Any other unknown key still stops the daemon at startup, saying where.
  test("an unknown launcher key other than the legacy ones stops the daemon", async () => {
    const root = tmp("ccmsg-launch-root-");
    const { stateDir, dataDir, proc } = spawnWith({
      session_launcher: { root_dirs: [root], templates: [], recipes: [] },
    });
    expect(await proc.exited).toBe(1);
    const file = path.join(testConfigDir(dataDir), "config.json");
    const log = fs.readFileSync(path.join(stateDir, "daemon.log"), "utf8");
    expect(log).toContain(`config: ${file}: session_launcher.recipes: `);
    expect(fs.existsSync(path.join(stateDir, "daemon.sock"))).toBe(false);
  });

  // Startup removes launch outputs past their 7 days before it listens.
  test("startup removes launch outputs older than 7 days", async () => {
    const root = tmp("ccmsg-launch-root-");
    const base = tmp("ccmsg-launch-daemon-");
    const stateDir = path.join(base, "s");
    const dataDir = path.join(base, "d");
    const launches = path.join(stateDir, "launches");
    const old = launchId(new Date(Date.now() - LAUNCH_OUTPUT_LIFETIME_MS - 60_000));
    const fresh = launchId(new Date());
    fs.mkdirSync(path.join(launches, old), { recursive: true });
    fs.mkdirSync(path.join(launches, fresh));
    fs.mkdirSync(testConfigDir(dataDir), { recursive: true });
    fs.writeFileSync(
      path.join(testConfigDir(dataDir), "config.json"),
      JSON.stringify(launcherConfig(["sh"], root)),
    );
    const proc = spawnDaemonProc(stateDir, dataDir);
    try {
      await waitConnectable(path.join(stateDir, "daemon.sock"));
      expect(fs.readdirSync(launches)).toEqual([fresh]);
    } finally {
      proc.kill();
      await proc.exited;
    }
  });

  // Installs that predate the config/ split still have their config.json in
  // data/; the daemon moves it on startup, so the launcher they configured
  // keeps working across the upgrade with no user action.
  test("a config.json left in the legacy data dir is migrated and takes effect", async () => {
    const root = tmp("ccmsg-launch-root-");
    const base = tmp("ccmsg-launch-legacy-");
    const stateDir = path.join(base, "s");
    const dataDir = path.join(base, "d");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(dataDir);
    const legacy = path.join(dataDir, "config.json");
    fs.writeFileSync(legacy, JSON.stringify(launcherConfig(["sh"], root)));
    const proc = spawnDaemonProc(stateDir, dataDir);
    try {
      await waitConnectable(path.join(stateDir, "daemon.sock"));
      const client = await userConn({ sock: path.join(stateDir, "daemon.sock") });
      expect(await client.requestOk({ op: "session_launcher_config" })).toEqual({
        ok: true,
        root_dirs: [path.resolve(root)],
        default_effort: {},
      });
      client.close();
      expect(fs.existsSync(legacy)).toBe(false);
      expect(fs.existsSync(path.join(testConfigDir(dataDir), "config.json"))).toBe(true);
    } finally {
      // Wait for the exit before the dirs go: a daemon still shutting down
      // writes into them, and outlives the test if the run ends first.
      proc.kill();
      await proc.exited;
    }
  }, 15000);

  // LN-Q4 makes config a startup snapshot: editing config.json cannot
  // silently widen or replace launcher roots until an explicit restart.
  test("config changes are not reloaded while the daemon is running", async () => {
    const root = tmp("ccmsg-launch-root-");
    const replacement = tmp("ccmsg-launch-replacement-");
    await withDaemon(launcherConfig(["sh"], root), async (ctx) => {
      const client = await userConn(ctx);
      fs.writeFileSync(
        ctx.daemon.paths.config,
        JSON.stringify(launcherConfig(["sh"], replacement)),
      );
      expect((await client.request({ op: "dir_tree", roots: [root], depth: 1 })).ok).toBe(true);
      const newlyWritten = await client.requestError({
        op: "dir_tree",
        roots: [replacement],
        depth: 1,
      });
      expect(newlyWritten.error.code).toBe("path_forbidden");
    });
  });
});
