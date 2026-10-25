// session_launch and its sibling ops over the wire (DR-0018 §3.4, §3.5, §3.8):
// what the launch command reads on standard input, what the reply carries,
// who may launch, and the daemon.log line each launch leaves.
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
): Promise<void> {
  const ctx = await startInProcessDaemon(config === undefined ? {} : { config });
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

/** The daemon.log lines of the in-process daemon that record launches. */
function launchLogLines(ctx: InProcessDaemon): string[] {
  return fs
    .readFileSync(ctx.daemon.paths.log, "utf8")
    .split("\n")
    .filter((line) => line.includes("session_launch: "));
}

describe("session_launch: what the launch command reads", () => {
  // `new` gets the id the daemon chose, and the reply returns that id once
  // the command exits 0. The cwd the command runs in, and the one it reads,
  // is the realpath of what was asked (here through a symlink).
  test("new carries the new session's id and a realpath cwd", async () => {
    const dir = tmp("ccmsg-launch-");
    const real = fs.realpathSync(dir);
    fs.symlinkSync(real, path.join(real, "link"));
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, {
        type: "new",
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
        type: "new",
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

  test("fork carries the new session's id beside the session it copies", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, {
        type: "fork",
        cwd: dir,
        resume_session_id: RESUME_SID,
        resume_at: RECORD_UUID,
      });
      expect(reply.session_id).toBeDefined();
      expect(reply.session_id).not.toBe(RESUME_SID);
      expect(commandInput(reply)).toEqual({
        type: "fork",
        cwd: fs.realpathSync(dir),
        resume_session_id: RESUME_SID,
        resume_at: RECORD_UUID,
        session_id: reply.session_id ?? "",
      });
    });
  });

  // continue and resume start no new id: the reply has none, and the command
  // reads none (claude refuses --session-id on a resume that does not fork).
  test("continue and resume carry no session id, in or out", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      const cont = await launch(client, { type: "continue", cwd: dir, model: "sonnet" });
      expect(cont.session_id).toBeUndefined();
      expect(commandInput(cont)).toEqual({
        type: "continue",
        cwd: fs.realpathSync(dir),
        model: "sonnet",
      });
      const resume = await launch(client, {
        type: "resume",
        cwd: dir,
        resume_session_id: RESUME_SID,
        prompt: "go on",
      });
      expect(resume.session_id).toBeUndefined();
      expect(commandInput(resume)).toEqual({
        type: "resume",
        cwd: fs.realpathSync(dir),
        resume_session_id: RESUME_SID,
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
      const reply = await launch(client, { type: "new", cwd: dir, model: "haiku", effort: "low" });
      expect(reply.exit_code).toBe(3);
      expect(reply.session_id).toBeUndefined();
      expect(commandInput(reply)).toMatchObject({ type: "new", model: "haiku" });
    });
  });

  // The launch command's arguments are the config's, as written: the daemon
  // adds none.
  test("the configured arguments reach the command and nothing is added", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(path.join(dir, "args"), `#!/bin/sh\nprintf '[%s]' "$@"\n`);
    await withDaemon(launcherConfig([bin, "--flag", "two words"], dir), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { type: "continue", cwd: dir });
      expect(reply.stdout).toBe("[--flag][two words]");
    });
  });
});

describe("session_launch: how the run ends", () => {
  // timeout_seconds sends SIGTERM; a command ended by it answers 143.
  test("a command past timeout_seconds is ended and answers 143", async () => {
    const dir = tmp("ccmsg-launch-");
    const bin = writeMockBin(path.join(dir, "slow"), "#!/bin/sh\nexec sleep 30\n");
    await withDaemon(launcherConfig([bin], dir, { timeout_seconds: 1 }), async (ctx) => {
      const client = await userConn(ctx);
      const reply = await launch(client, { type: "new", cwd: dir, model: "opus", effort: "low" });
      expect(reply).toEqual({ ok: true, exit_code: 143, stdout: "", stderr: "" });
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
      const reply = await launch(client, { type: "continue", cwd: dir });
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
      await launch(client, { type: "continue", cwd: dir });
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
    process.env.CCMSG_TEST_LE_KEEP = "k";
    process.env.CCMSG_TEST_LE_DROP = "d";
    process.env.CCMSG_TEST_OTHER = "o";
    try {
      await withDaemon(
        launcherConfig([bin], dir, {
          clean_env: ["CCMSG_TEST_LE_*"],
          keep_env: ["CCMSG_TEST_LE_KEEP"],
        }),
        async (ctx) => {
          const client = await userConn(ctx);
          const reply = await launch(client, { type: "continue", cwd: dir });
          expect(reply.stdout).toBe("kept=k cleaned=absent other=o");
        },
      );
    } finally {
      delete process.env.CCMSG_TEST_LE_KEEP;
      delete process.env.CCMSG_TEST_LE_DROP;
      delete process.env.CCMSG_TEST_OTHER;
    }
  });

  // The reply waits for the command; other requests of the same connection
  // do not wait for the reply. The command holds until the test opens its
  // gate, so the order is the test's, not a race.
  test("a launch still running holds back no other reply on its connection", async () => {
    const dir = tmp("ccmsg-launch-");
    const gate = path.join(dir, "gate");
    expect(Bun.spawnSync(["mkfifo", gate]).exitCode).toBe(0);
    const bin = writeMockBin(
      path.join(dir, "gated"),
      `#!/bin/sh\nread line < ${JSON.stringify(gate)}\nprintf "released-%s" "$line"\n`,
    );
    await withDaemon(launcherConfig([bin], dir), async (ctx) => {
      const client = await userConn(ctx);
      const launching = launch(client, { type: "continue", cwd: dir });
      expect(await client.requestOk({ op: "ping" })).toMatchObject({ pong: true });
      await fs.promises.writeFile(gate, "go\n");
      expect((await launching).stdout).toBe("released-go");
    });
  });
});

describe("session_launch: refusals", () => {
  test("no session_launcher in the config is launcher_not_configured", async () => {
    await withDaemon(undefined, async (ctx) => {
      const client = await userConn(ctx);
      for (const op of ["session_launch", "session_launcher_config"] as const) {
        const response =
          op === "session_launch"
            ? await client.requestError({ op, launch: { type: "continue", cwd: "/" } })
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
          launch: { type: "continue", cwd },
        });
        expect(response.error).toEqual({
          code: "invalid_args",
          msg: `launch.cwd is not an existing directory: ${cwd}`,
        });
      }
      const elsewhere = await launch(client, { type: "continue", cwd: outside });
      expect(elsewhere.exit_code).toBe(0);
    });
  });

  // The launch is read by its schema: a field its type does not have is
  // refused with where it is, and nothing runs.
  test("a launch that does not read is invalid_args, and nothing runs", async () => {
    const dir = tmp("ccmsg-launch-");
    const marker = path.join(dir, "ran");
    const bin = writeMockBin(path.join(dir, "mark"), `#!/bin/sh\n: > ${JSON.stringify(marker)}\n`);
    await withDaemon(launcherConfig([bin], dir), async (ctx) => {
      const client = await userConn(ctx);
      const response = await client.requestRefusal({
        op: "session_launch",
        launch: { type: "continue", cwd: dir, resume_session_id: RESUME_SID },
      });
      expect(response.error.code).toBe("invalid_args");
      expect(response.error.msg).toContain("launch.resume_session_id");
      expect(fs.existsSync(marker)).toBe(false);
    });
  });

  // A command that cannot be started has no exit code to answer with.
  test("a launch command that cannot be started is launch_command_unavailable", async () => {
    const dir = tmp("ccmsg-launch-");
    const notExecutable = path.join(dir, "plain");
    fs.writeFileSync(notExecutable, "#!/bin/sh\n", { mode: 0o644 });
    const cases: [string, string][] = [
      [path.join(dir, "missing"), "ENOENT"],
      [notExecutable, "EACCES"],
      ["ccmsg-no-such-launch-command", "ccmsg-no-such-launch-command is not found in PATH"],
    ];
    for (const [program, why] of cases) {
      await withDaemon(launcherConfig([program], dir), async (ctx) => {
        const client = await userConn(ctx);
        const response = await client.requestError({
          op: "session_launch",
          launch: { type: "continue", cwd: dir },
        });
        expect(response.error.code).toBe("launch_command_unavailable");
        expect(response.error.msg).toContain(why);
        const lines = launchLogLines(ctx);
        expect(lines).toHaveLength(1);
        expect(lines[0]).toContain(`launch_command_unavailable: ${response.error.msg}`);
      });
    }
  });
});

describe("session_launch: who launches", () => {
  // A session may launch (§3.8): what runs is still the one configured
  // command. The log line names the session that asked, and carries the
  // prompt's length, never its text.
  test("a session launches, and the log line names it without the prompt", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await sessionConn(ctx, SID, { cwd: dir });
      const prompt = "a secret plan";
      const reply = await launch(client, {
        type: "fork",
        cwd: dir,
        resume_session_id: RESUME_SID,
        prompt,
      });
      expect(reply.exit_code).toBe(0);
      const lines = launchLogLines(ctx);
      expect(lines).toHaveLength(1);
      const [line] = lines;
      expect(line).toContain(
        `session_launch: by=${SID} type=fork cwd=${fs.realpathSync(dir)}` +
          ` resume_session_id=${RESUME_SID} session_id=${reply.session_id ?? ""}` +
          ` prompt_bytes=${String(Buffer.byteLength(prompt))} exit_code=0` +
          ` stdout_bytes=${String(Buffer.byteLength(reply.stdout))}` +
          ` stderr_bytes=${String(Buffer.byteLength(reply.stderr))}`,
      );
      expect(line).not.toContain(prompt);
    });
  });

  test("a launch by the user is logged as by=user", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      await launch(client, { type: "continue", cwd: dir });
      const lines = launchLogLines(ctx);
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(
        `session_launch: by=user type=continue cwd=${fs.realpathSync(dir)}`,
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

  test("session_launcher_config answers the user with root_dirs", async () => {
    const dir = tmp("ccmsg-launch-");
    await withDaemon(launcherConfig([echoCommand(dir)], dir), async (ctx) => {
      const client = await userConn(ctx);
      expect(await client.requestOk({ op: "session_launcher_config" })).toEqual({
        ok: true,
        root_dirs: [path.resolve(dir)],
      });
    });
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

  // A launcher config of another shape (templates, a shell) does not read:
  // the daemon stops at startup, saying where, rather than starting without
  // a launcher.
  test("a launcher config without launch_command stops the daemon", async () => {
    const root = tmp("ccmsg-launch-root-");
    const { stateDir, dataDir, proc } = spawnWith({
      session_launcher: {
        root_dirs: [root],
        templates: [{ name: "default", command: "run", params: {} }],
      },
    });
    expect(await proc.exited).toBe(1);
    const file = path.join(testConfigDir(dataDir), "config.json");
    const log = fs.readFileSync(path.join(stateDir, "daemon.log"), "utf8");
    expect(log).toContain(`config: ${file}: session_launcher.launch_command: `);
    expect(log).toContain(`config: ${file}: session_launcher.templates: `);
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
      JSON.stringify(launcherConfig(["launch"], root)),
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
    fs.writeFileSync(legacy, JSON.stringify(launcherConfig(["launch"], root)));
    const proc = spawnDaemonProc(stateDir, dataDir);
    try {
      await waitConnectable(path.join(stateDir, "daemon.sock"));
      const client = await userConn({ sock: path.join(stateDir, "daemon.sock") });
      expect(await client.requestOk({ op: "session_launcher_config" })).toEqual({
        ok: true,
        root_dirs: [path.resolve(root)],
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
    await withDaemon(launcherConfig(["launch"], root), async (ctx) => {
      const client = await userConn(ctx);
      fs.writeFileSync(
        ctx.daemon.paths.config,
        JSON.stringify(launcherConfig(["replacement"], replacement)),
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
