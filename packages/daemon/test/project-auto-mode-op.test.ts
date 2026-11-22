// A project's autoMode over the wire (DR-0063 §4, §5, §7, §8, §10): the three
// ops and who may use them, the push of a change, and the settings file every
// start and btw is handed.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  jsonText,
  LaunchCommandInputSchema,
  type LaunchCommandInput,
  parseWith,
  ProjectAutoModeFileTextSchema,
  type SessionLaunchResponse,
} from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { NOTHING_SET } from "../src/project-auto-mode.ts";
import {
  sessionConn,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
  type TestClient,
} from "./helpers.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const OTHER_SID = "aaaaaaaa-0000-4000-8000-000000000002";
const RESUME_SID = "bbbbbbbb-0000-4000-8000-000000000002";

const DEFAULTS = { environment: ["e"], allow: ["a"], soft_deny: ["s"], hard_deny: ["h"] };

/** The test's world: a cwd no repository is derived from, a config dir whose
 * settings.json writes a soft_deny, a fake claude on the PATH that counts its
 * runs, and a launch command that echoes its input, except a print launch's
 * (a btw's fork, DR-0064), which it records and answers as claude would. */
function world(): {
  dir: string;
  cwd: string;
  configDir: string;
  bin: string;
  claudeRuns: string;
  launchCommand: string;
  btwInput: string;
} {
  const dir = fs.realpathSync(tmp("pam-op-"));
  const cwd = path.join(dir, "work");
  fs.mkdirSync(cwd);
  const configDir = path.join(dir, ".claude-x");
  fs.mkdirSync(configDir);
  fs.writeFileSync(
    path.join(configDir, "settings.json"),
    JSON.stringify({ autoMode: { soft_deny: ["$defaults", "user rule"] } }),
  );
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const claudeRuns = path.join(dir, "claude-runs");
  writeMockBin(
    path.join(bin, "claude"),
    `#!/bin/sh\necho "$*" >> ${JSON.stringify(claudeRuns)}\n` +
      `if [ "$1" = "--version" ]; then echo '2.1.330 (Claude Code)'; exit 0; fi\n` +
      `printf '%s\\n' '${JSON.stringify(DEFAULTS)}'\n`,
  );
  const btwInput = path.join(dir, "btw-input.json");
  const launchCommand = writeMockBin(
    path.join(dir, "echo-launch"),
    `#!/bin/sh\ninput=$(cat)\ncase $input in\n` +
      `  *'"print":true'*) printf '%s' "$input" > ${JSON.stringify(btwInput)}\n` +
      `    printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok"}' ;;\n` +
      `  *) printf '%s\\n' "$input" ;;\nesac\n`,
  );
  return { dir, cwd, configDir, bin, claudeRuns, launchCommand, btwInput };
}

async function withDaemon(
  w: ReturnType<typeof world>,
  run: (ctx: InProcessDaemon) => Promise<void>,
): Promise<void> {
  const ctx = await startInProcessDaemon({
    config: {
      session_launcher: { launch_command: [w.launchCommand], root_dirs: [w.dir] },
    },
    env: { PATH: `${w.bin}:${process.env.PATH ?? ""}` },
  });
  try {
    await run(ctx);
  } finally {
    await stopInProcessDaemon(ctx);
  }
}

const CommandInputText = jsonText(LaunchCommandInputSchema);
function commandInput(reply: SessionLaunchResponse): LaunchCommandInput {
  const read = parseWith(CommandInputText, reply.stdout);
  if (!read.ok) throw new Error(`not a launch command input: ${read.failure.summary}`);
  return read.value;
}

/** What the launch command was handed for a btw, read once the btw has ended
 * (its record is written after the command's output ends). */
async function btwInputAfter(
  viewer: TestClient,
  id: string,
  file: string,
): Promise<LaunchCommandInput> {
  await viewer.readEventUntil("btw", (ev) => ev.btw.id === id && ev.btw.status !== "running");
  const read = parseWith(CommandInputText, fs.readFileSync(file, "utf8"));
  if (!read.ok) throw new Error(`not a launch command input: ${read.failure.summary}`);
  return read.value;
}

/** Say hello as session SID in the world's cwd and config dir, with a
 * transcript, so a tab can follow its btws. */
async function sessionWithTranscript(
  ctx: InProcessDaemon,
  w: ReturnType<typeof world>,
): Promise<TestClient> {
  const transcript = path.join(w.configDir, "projects", "p", `${SID}.jsonl`);
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(
    transcript,
    `${JSON.stringify({ type: "user", uuid: "u-1", timestamp: "2026-11-22T00:00:00.000Z" })}\n`,
  );
  return sessionConn(ctx, SID, {
    cwd: w.cwd,
    config_dir: w.configDir,
    transcript_path: transcript,
  });
}

function writeProjects(ctx: InProcessDaemon, projects: object): void {
  fs.mkdirSync(path.dirname(ctx.daemon.paths.projectAutoMode), { recursive: true });
  fs.writeFileSync(ctx.daemon.paths.projectAutoMode, JSON.stringify({ projects }));
}

describe("who may use the ops (DR-0063 §7)", () => {
  // An agent must not widen its own project's allow, nor run claude through
  // the daemon.
  test("a session is refused all three with bad_request, writes nothing and runs no claude", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      const agent = await sessionConn(ctx, SID, { cwd: w.cwd, config_dir: w.configDir });
      for (const body of [
        { op: "project_auto_mode_read", session_id: SID },
        { op: "project_auto_mode_write", session_id: SID, section: "allow", text: "anything" },
        { op: "auto_mode_defaults_read", version: "v" },
      ] as const) {
        expect((await agent.requestError(body)).error.code).toBe("bad_request");
      }
      expect(fs.existsSync(ctx.daemon.paths.projectAutoMode)).toBe(false);
      expect(fs.existsSync(w.claudeRuns)).toBe(false);
    });
  });
});

describe("project_auto_mode_read / _write (DR-0063 §7)", () => {
  test("reads the project, the user's lists and the builtin version; a change is pushed to the other tabs", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      await sessionConn(ctx, SID, { cwd: w.cwd, config_dir: w.configDir });
      const me = await userConn(ctx);
      const other = await userConn(ctx);
      await other.requestOk({ op: "subscribe" });

      const read = await me.requestOk({ op: "project_auto_mode_read", session_id: SID });
      expect(read).toMatchObject({
        ok: true,
        key: `cwd:${w.cwd}`,
        label: w.cwd,
        project: NOTHING_SET,
        user: {
          config_dir_name: ".claude-x",
          autoMode: { soft_deny: ["user rule"] },
          defaults_dropped: [],
        },
      });
      expect(read.builtin_version).toBeString();

      const written = await me.requestOk({
        op: "project_auto_mode_write",
        session_id: SID,
        section: "soft_deny",
        text: "  never push to main\n",
      });
      expect(written.project.soft_deny).toEqual(["never push to main"]);
      const pushed = await other.readEventUntil("project_auto_mode");
      expect(pushed.ev).toEqual({
        ev: "project_auto_mode",
        key: `cwd:${w.cwd}`,
        project: written.project,
      });
    });
  });

  test("an entry changed elsewhere is file_conflict and the file stays as it was", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      await sessionConn(ctx, SID, { cwd: w.cwd, config_dir: w.configDir });
      const me = await userConn(ctx);
      await me.requestOk({
        op: "project_auto_mode_write",
        session_id: SID,
        section: "allow",
        text: "one",
      });
      const before = fs.readFileSync(ctx.daemon.paths.projectAutoMode, "utf8");
      const refused = await me.requestError({
        op: "project_auto_mode_write",
        session_id: SID,
        section: "allow",
        index: 0,
        before: "uno",
        text: "eins",
      });
      expect(refused.error.code).toBe("file_conflict");
      expect(fs.readFileSync(ctx.daemon.paths.projectAutoMode, "utf8")).toBe(before);
      const halfForm = await me.requestError({
        op: "project_auto_mode_write",
        session_id: SID,
        section: "allow",
        index: 0,
        text: "eins",
      });
      expect(halfForm.error.code).toBe("invalid_args");
      // `$defaults` is the daemon's, not the person's (DR-0063 §1): a write
      // has no form that sets it.
      const withCheck = {
        op: "project_auto_mode_write",
        session_id: SID,
        section: "allow",
        defaults: false,
      } as const;
      const check = await me.requestError(withCheck);
      expect(check.error.code).toBe("invalid_args");
      expect(fs.readFileSync(ctx.daemon.paths.projectAutoMode, "utf8")).toBe(before);
    });
  });

  // DR-0063 §2: what is back to nothing set leaves the file.
  test("an entry saved empty goes, and a project back to nothing set leaves the file", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      await sessionConn(ctx, SID, { cwd: w.cwd, config_dir: w.configDir });
      const me = await userConn(ctx);
      const write = (fields: object): Promise<unknown> =>
        me.requestOk({
          op: "project_auto_mode_write",
          session_id: SID,
          section: "hard_deny",
          ...fields,
        });
      await write({ text: "rm -rf" });
      await write({ text: "dd" });
      await write({ index: 0, before: "rm -rf", text: "" });
      const midway = parseWith(
        ProjectAutoModeFileTextSchema,
        fs.readFileSync(ctx.daemon.paths.projectAutoMode, "utf8"),
      );
      expect(midway.ok && midway.value.projects[`cwd:${w.cwd}`]?.hard_deny).toEqual(["dd"]);
      await write({ index: 0, before: "dd", text: "" });
      expect(JSON.parse(fs.readFileSync(ctx.daemon.paths.projectAutoMode, "utf8"))).toEqual({
        projects: {},
      });
    });
  });

  // A hello that names no cwd leaves it empty: a key made of it would not
  // read, and once written would make every start refuse (DR-0063 §7).
  test("a session whose hello named an empty cwd is session_not_found, and nothing is written", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      await sessionConn(ctx, SID, { cwd: "", config_dir: w.configDir });
      const me = await userConn(ctx);
      for (const body of [
        { op: "project_auto_mode_read", session_id: SID },
        { op: "project_auto_mode_write", session_id: SID, section: "allow", text: "x" },
      ] as const) {
        expect((await me.requestError(body)).error.code).toBe("session_not_found");
      }
      expect(fs.existsSync(ctx.daemon.paths.projectAutoMode)).toBe(false);
    });
  });

  test("a session whose cwd the daemon does not know is session_not_found", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      const me = await userConn(ctx);
      const refused = await me.requestError({
        op: "project_auto_mode_read",
        session_id: OTHER_SID,
      });
      expect(refused.error.code).toBe("session_not_found");
    });
  });
});

describe("auto_mode_defaults_read (DR-0063 §7)", () => {
  test("answers the PATH's claude's defaults and version, running it once for its version", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      await sessionConn(ctx, SID, { cwd: w.cwd, config_dir: w.configDir });
      const me = await userConn(ctx);
      const read = await me.requestOk({ op: "project_auto_mode_read", session_id: SID });
      const version = read.builtin_version ?? "";
      const body = { op: "auto_mode_defaults_read", version } as const;
      expect(await me.requestOk(body)).toEqual({
        ok: true,
        version,
        label: "2.1.330 (Claude Code)",
        defaults: DEFAULTS,
      });
      await me.requestOk(body);
      expect(fs.readFileSync(w.claudeRuns, "utf8")).toBe("auto-mode defaults\n--version\n");
      const stale = await me.requestError({ op: "auto_mode_defaults_read", version: "other" });
      expect(stale.error.code).toBe("invalid_args");
    });
  });
});

describe("the settings file a start is handed (DR-0063 §4, §5)", () => {
  test("every way to start carries the daemon's file; the same content is the same path", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      writeProjects(ctx, { [`cwd:${w.cwd}`]: { allow: ["run the tests"] } });
      const me = await userConn(ctx);
      const inputs: LaunchCommandInput[] = [];
      for (const launch of [
        { cwd: w.cwd, model: "opus", effort: "high" },
        { cwd: w.cwd, continue: true },
        { cwd: w.cwd, resume: RESUME_SID, model: "opus", effort: "high" },
        { cwd: w.cwd, resume: RESUME_SID, fork_session: true, model: "opus", effort: "high" },
      ] as const) {
        inputs.push(commandInput(await me.requestOk({ op: "session_launch", launch })));
      }
      const settings = inputs.map((input) => input.settings);
      const [first] = settings;
      expect(first).toStartWith(`${ctx.daemon.paths.launchSettingsDir}/`);
      expect(settings).toEqual([first, first, first, first]);
      expect(JSON.parse(fs.readFileSync(first ?? "", "utf8"))).toEqual({
        autoMode: { allow: ["$defaults", "run the tests"] },
      });
      const log = fs.readFileSync(ctx.daemon.paths.log, "utf8");
      expect(log).toContain("auto_mode_entries=1");
      expect(log).not.toContain("run the tests");

      // A session's `launch` tool is handed the same file.
      const agent = await sessionConn(ctx, SID, { cwd: w.cwd });
      const told = await agent.requestOk({
        op: "launch_tool",
        launch: { cwd: w.cwd, continue: true },
      });
      expect(told.outcome === "done" ? commandInput(told).settings : undefined).toBe(first);
    });
  });

  test("a project with nothing to write is started without settings", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      writeProjects(ctx, { [`cwd:${w.cwd}`]: { allow: [] } });
      const me = await userConn(ctx);
      const reply = await me.requestOk({
        op: "session_launch",
        launch: { cwd: w.cwd, continue: true },
      });
      expect(commandInput(reply)).toEqual({ cwd: w.cwd, continue: true });
      expect(fs.readFileSync(ctx.daemon.paths.log, "utf8")).toContain("auto_mode_entries=0");
    });
  });

  // `settings` is the daemon's alone: the asker's launch has no such field.
  test("a launch or a launch tool naming settings is invalid_args, and nothing runs", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      const me = await userConn(ctx);
      const launch = { cwd: w.cwd, continue: true, settings: "/tmp/mine.json" };
      const refused = await me.requestError({ op: "session_launch", launch });
      expect(refused.error.code).toBe("invalid_args");
      const agent = await sessionConn(ctx, SID, { cwd: w.cwd });
      expect((await agent.requestError({ op: "launch_tool", launch })).error.code).toBe(
        "invalid_args",
      );
      expect(fs.existsSync(ctx.daemon.paths.launches)).toBe(false);
    });
  });

  // DR-0063 §4: starting without the file would drop the person's soft_deny.
  test("a project-auto-mode.json that does not read refuses the start and the btw, running neither", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      fs.mkdirSync(path.dirname(ctx.daemon.paths.projectAutoMode), { recursive: true });
      fs.writeFileSync(ctx.daemon.paths.projectAutoMode, "{ not json");
      const me = await userConn(ctx);
      const refused = await me.requestError({
        op: "session_launch",
        launch: { cwd: w.cwd, continue: true },
      });
      expect(refused.error.code).toBe("project_auto_mode_unreadable");
      await sessionConn(ctx, SID, { cwd: w.cwd, config_dir: w.configDir });
      const btw = await me.requestError({ op: "btw_ask", session_id: SID, prompt: "q" });
      expect(btw.error.code).toBe("project_auto_mode_unreadable");
      expect(fs.existsSync(w.btwInput)).toBe(false);
      const read = await me.requestError({ op: "project_auto_mode_read", session_id: SID });
      expect(read.error.code).toBe("project_auto_mode_unreadable");
    });
  });
});

describe("the settings file a btw is handed (DR-0063 §8)", () => {
  test("the fork of a session in the project gets the daemon's file, not the asker's", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      writeProjects(ctx, { [`cwd:${w.cwd}`]: { soft_deny: ["never push"] } });
      await sessionWithTranscript(ctx, w);
      const me = await userConn(ctx);
      await me.requestOk({ op: "transcript_subscribe", sid: SID });
      const asked = await me.requestOk({
        op: "btw_ask",
        session_id: SID,
        prompt: "q",
        // Not a field of btw_ask: its schema drops it.
        settings: "/tmp/mine.json",
      });
      const input = await btwInputAfter(me, asked.btw.id, w.btwInput);
      expect(input.settings).toStartWith(`${ctx.daemon.paths.launchSettingsDir}/`);
      expect(JSON.parse(fs.readFileSync(input.settings ?? "", "utf8"))).toEqual({
        autoMode: { soft_deny: ["$defaults", "never push"] },
      });
    });
  });

  test("a btw of a project with nothing set is handed no settings", async () => {
    const w = world();
    await withDaemon(w, async (ctx) => {
      await sessionWithTranscript(ctx, w);
      const me = await userConn(ctx);
      await me.requestOk({ op: "transcript_subscribe", sid: SID });
      const asked = await me.requestOk({ op: "btw_ask", session_id: SID, prompt: "q" });
      expect((await btwInputAfter(me, asked.btw.id, w.btwInput)).settings).toBeUndefined();
    });
  });
});
