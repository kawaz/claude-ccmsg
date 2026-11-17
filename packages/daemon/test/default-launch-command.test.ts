// The built-in launch command (DR-0018 §3.1, docs/design/launch-command.md),
// run as the daemon runs it: `zsh -f <script>` with the input on standard
// input. Each field becomes the claude option of its name, the prompt goes to
// claude's standard input and never to its argv, and it runs
// `hyoui run --detached -- claude …`, ending with hyoui's exit code. Without
// jq, hyoui or claude it refuses before claude starts. A continue starts as
// the `--resume` of the session `ccmsg launch-context` names (a `--continue`
// still when it says `--resume` would refuse that session), and a continue or
// a resume without a model or an effort takes the session's.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LAUNCH_COMMAND_SCRIPT } from "../src/config.ts";
import { projectSlug } from "../src/launch-context.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
/** The system's directories: no hyoui, claude or direnv there. */
const SYSTEM_PATH = "/usr/bin:/bin";
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_SID = "bbbbbbbb-0000-4000-8000-000000000002";
const OTHER_SID = "cccccccc-0000-4000-8000-000000000003";

function which(name: string): string {
  const found = Bun.which(name);
  if (found === null) throw new Error(`${name} is not found in PATH: the built-in needs it`);
  return found;
}

interface Mock {
  /** The PATH the script runs with: the mocks and jq, then the system's. */
  PATH: string;
  /** The cwd of the launch, a fresh directory. */
  cwd: string;
  /** An empty config dir for the launch (CLAUDE_CONFIG_DIR). */
  cfg: string;
  hyouiArgs: string;
  hyouiStdin: string;
  hyouiEnv: string;
  direnvArgs: string;
}

/** A PATH holding jq, bun (the plugin's CLI runs on it), a `claude` (the
 * program hyoui would start), and a
 * `hyoui` that writes its argv (one `[arg]` each), its standard input, and its
 * environment's CLAUDE* / ANTHROPIC* / CCMSG* / HYOUI* keys to files, prints a
 * terminal id and exits `hyouiExit`. With `direnv`, a `direnv` that writes its
 * argv and runs what follows `exec .`. */
function mockPath(
  options: { hyouiExit?: number; direnv?: boolean; bun?: boolean; direnvConfigDir?: string } = {},
): Mock {
  const dir = fs.realpathSync(tmp("ccmsg-default-launch-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd);
  const cfg = path.join(dir, "cfg");
  fs.mkdirSync(cfg);
  const file = (name: string): string => path.join(dir, name);
  const recordArgs = (name: string): string =>
    `for a in "$@"; do printf '[%s]' "$a"; done > ${JSON.stringify(file(name))}\n`;
  fs.symlinkSync(which("jq"), path.join(bin, "jq"));
  if (options.bun !== false) fs.symlinkSync(which("bun"), path.join(bin, "bun"));
  writeMockBin(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n");
  writeMockBin(
    path.join(bin, "hyoui"),
    `#!/bin/sh\n${recordArgs("hyoui.args")}cat > ${JSON.stringify(file("hyoui.stdin"))}\n` +
      `env | grep -E '^(CLAUDE|ANTHROPIC|CCMSG|HYOUI)' | sort > ${JSON.stringify(file("hyoui.env"))}\n` +
      `echo terminal-1\nexit ${String(options.hyouiExit ?? 0)}\n`,
  );
  if (options.direnv === true) {
    writeMockBin(
      path.join(bin, "direnv"),
      `#!/bin/sh\n${recordArgs("direnv.args")}shift 2\n` +
        (options.direnvConfigDir === undefined
          ? ""
          : `export CLAUDE_CONFIG_DIR=${JSON.stringify(options.direnvConfigDir)}\n`) +
        `exec "$@"\n`,
    );
  }
  return {
    PATH: `${bin}:${SYSTEM_PATH}`,
    cwd,
    cfg,
    hyouiArgs: file("hyoui.args"),
    hyouiStdin: file("hyoui.stdin"),
    hyouiEnv: file("hyoui.env"),
    direnvArgs: file("direnv.args"),
  };
}

async function runDefault(
  stdin: string,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([which("zsh"), "-f", DEFAULT_LAUNCH_COMMAND_SCRIPT], {
    stdin: new Blob([stdin]),
    stdout: "pipe",
    stderr: "pipe",
    env,
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

/** Writes a session of `cwd` into `cfg` as claude would keep it, whose last
 * main-context turn ran as claude-opus-4-1 at effort high, with the mtime
 * `minute` minutes past a fixed time. */
function writeSession(cfg: string, cwd: string, sid: string, minute: number): void {
  const rows = [
    {
      type: "user",
      parentUuid: null,
      isSidechain: false,
      entrypoint: "cli",
      cwd,
      uuid: "u",
      timestamp: "2026-11-17T00:00:00.000Z",
      message: { role: "user", content: "hi" },
    },
    {
      type: "assistant",
      parentUuid: "u",
      isSidechain: false,
      uuid: "a",
      timestamp: "2026-11-17T00:00:01.000Z",
      message: { model: "claude-opus-4-1", content: [{ type: "text", text: "ok" }] },
      effort: "high",
    },
  ];
  writeTranscript(cfg, cwd, sid, minute, rows.map((row) => `${JSON.stringify(row)}\n`).join(""));
}

/** Writes the transcript `sid` of `cwd` into `cfg` with `text` as it is,
 * with the mtime `minute` minutes past a fixed time. */
function writeTranscript(
  cfg: string,
  cwd: string,
  sid: string,
  minute: number,
  text: string,
): void {
  const dir = path.join(cfg, "projects", projectSlug(fs.realpathSync(cwd)));
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, text);
  const at = new Date(Date.UTC(2026, 10, 17, 0, minute));
  fs.utimesSync(file, at, at);
}

/** The claude options of the hyoui argv a launch of `input` (with the mock's
 * cwd and config dir, `sessions` written into it first) runs. */
async function claudeArgsOf(
  input: Record<string, unknown>,
  sessions: readonly string[] = [],
): Promise<string> {
  const mock = mockPath();
  sessions.forEach((sid, i) => writeSession(mock.cfg, mock.cwd, sid, i));
  const run = await runDefault(JSON.stringify({ cwd: mock.cwd, ...input }), {
    PATH: mock.PATH,
    CLAUDE_CONFIG_DIR: mock.cfg,
  });
  expect(run.code).toBe(0);
  const args = read(mock.hyouiArgs);
  const head = "[run][--detached][--][claude]";
  expect(args.startsWith(head)).toBe(true);
  return args.slice(head.length);
}

describe("the built-in launch command, run as the daemon runs it", () => {
  test("each field as the claude option of its name, ending with hyoui's code and output", async () => {
    const mock = mockPath({ hyouiExit: 3 });
    const run = await runDefault(
      JSON.stringify({
        cwd: mock.cwd,
        model: "opus",
        effort: "high",
        name: "n",
        session_id: NEW_SID,
      }),
      { PATH: mock.PATH, CLAUDE_CONFIG_DIR: mock.cfg },
    );
    expect(run.code).toBe(3);
    expect(run.stdout).toBe("terminal-1\n");
    expect(read(mock.hyouiArgs)).toBe(
      `[run][--detached][--][claude][--model][opus][--effort][high][--name][n][--session-id][${NEW_SID}]`,
    );
  });

  // A leading `-`, line breaks: the prompt as one block on standard input,
  // nowhere in the argv. The here-string ends it with one newline.
  test("the prompt goes to claude's standard input, not to its argv", async () => {
    const mock = mockPath();
    const prompt = "-p hi\n  two lines";
    const run = await runDefault(
      JSON.stringify({ cwd: mock.cwd, model: "haiku", effort: "low", session_id: NEW_SID, prompt }),
      { PATH: mock.PATH, CLAUDE_CONFIG_DIR: mock.cfg },
    );
    expect(run.code).toBe(0);
    expect(read(mock.hyouiStdin)).toBe(`${prompt}\n`);
    expect(read(mock.hyouiArgs)).not.toContain("two lines");
  });

  test("no prompt: the default one", async () => {
    const mock = mockPath();
    await runDefault(JSON.stringify({ cwd: mock.cwd, continue: true }), {
      PATH: mock.PATH,
      CLAUDE_CONFIG_DIR: mock.cfg,
    });
    expect(read(mock.hyouiStdin)).toBe(".\n");
  });

  test("no effort: each model's default; no model: neither option", async () => {
    for (const [model, effort] of [
      ["mythos", "low"],
      ["fable", "low"],
      ["opus", "medium"],
      ["sonnet", "medium"],
      ["haiku", "low"],
    ] as const) {
      expect(await claudeArgsOf({ resume: SID, model })).toBe(
        `[--model][${model}][--effort][${effort}][--resume][${SID}]`,
      );
    }
    expect(await claudeArgsOf({ resume: SID })).toBe(`[--resume][${SID}]`);
  });

  test("continue, resume and a fork", async () => {
    expect(await claudeArgsOf({ continue: true })).toBe("[--continue]");
    expect(await claudeArgsOf({ resume: SID, name: "x" })).toBe(`[--name][x][--resume][${SID}]`);
    expect(await claudeArgsOf({ resume: SID, fork_session: true, session_id: NEW_SID })).toBe(
      `[--resume][${SID}][--fork-session][--session-id][${NEW_SID}]`,
    );
  });

  // Another session's variables do not reach claude; the config dir does.
  test("CLAUDE*, ANTHROPIC_*, HYOUI_* and CCMSG_* are cleaned, CLAUDE_CONFIG_DIR is kept", async () => {
    const mock = mockPath();
    await runDefault(JSON.stringify({ cwd: mock.cwd, continue: true }), {
      PATH: mock.PATH,
      CLAUDE_CONFIG_DIR: "/cfg",
      CLAUDE_CODE_SESSION_ID: SID,
      CLAUDECODE: "1",
      ANTHROPIC_BASE_URL: "http://x",
      CCMSG_LAUNCH_REQUESTED_BY: "user",
      HYOUI_SESSION_ID: "t",
    });
    expect(read(mock.hyouiEnv)).toBe("CLAUDE_CONFIG_DIR=/cfg\n");
  });

  test("nothing to clean is not a failure", async () => {
    expect(await claudeArgsOf({ continue: true })).toBe("[--continue]");
  });

  test("through direnv exec . when direnv is in PATH", async () => {
    const mock = mockPath({ direnv: true });
    const run = await runDefault(JSON.stringify({ cwd: mock.cwd, continue: true }), {
      PATH: mock.PATH,
      CLAUDE_CONFIG_DIR: mock.cfg,
    });
    expect(run.code).toBe(0);
    expect(read(mock.direnvArgs)).toMatch(/^\[exec\]\[\.\]\[hyoui\]\[run\]/);
    expect(read(mock.hyouiArgs)).toBe("[run][--detached][--][claude][--continue]");
  });

  // Refused before claude starts: 2, the reason on stderr, hyoui not run.
  test("no jq, hyoui or claude in PATH is refused", async () => {
    const mock = mockPath();
    const bin = tmp("ccmsg-default-launch-");
    const refusal = async (): Promise<string> => {
      const run = await runDefault(JSON.stringify({ cwd: mock.cwd, continue: true }), {
        PATH: bin,
      });
      expect(run.code).toBe(2);
      return run.stderr;
    };
    expect(await refusal()).toContain("jq is not found in PATH");
    fs.symlinkSync(which("jq"), path.join(bin, "jq"));
    expect(await refusal()).toContain("hyoui is not found in PATH");
    writeMockBin(path.join(bin, "hyoui"), "#!/bin/sh\nexit 0\n");
    expect(await refusal()).toContain("claude is not found in PATH");
    expect(read(mock.hyouiArgs)).toBe("");
  });
});

// The session a continue or a resume carries on from, as `ccmsg
// launch-context` of this plugin names it in the config dir claude gets.
describe("the built-in launch command, a continue and a resume", () => {
  test("a continue starts as the --resume of the session it would carry on", async () => {
    expect(await claudeArgsOf({ continue: true, model: "haiku", effort: "low" }, [SID])).toBe(
      `[--model][haiku][--effort][low][--resume][${SID}]`,
    );
    // the newest of two
    expect(await claudeArgsOf({ continue: true, model: "haiku" }, [OTHER_SID, SID])).toBe(
      `[--model][haiku][--effort][low][--resume][${SID}]`,
    );
  });

  test("a continue with none to carry on stays --continue, for claude to say so", async () => {
    expect(await claudeArgsOf({ continue: true, model: "opus" })).toBe(
      "[--model][opus][--effort][medium][--continue]",
    );
  });

  test("a continue or a resume without a model or an effort takes the session's", async () => {
    const opusHigh = "[--model][opus][--effort][high]";
    expect(await claudeArgsOf({ continue: true }, [SID])).toBe(`${opusHigh}[--resume][${SID}]`);
    expect(await claudeArgsOf({ resume: SID }, [SID])).toBe(`${opusHigh}[--resume][${SID}]`);
    // one of the two given: the other is the session's
    expect(await claudeArgsOf({ resume: SID, effort: "max" }, [SID])).toBe(
      `[--model][opus][--effort][max][--resume][${SID}]`,
    );
    expect(await claudeArgsOf({ resume: SID, model: "opus" }, [SID])).toBe(
      `${opusHigh}[--resume][${SID}]`,
    );
    // another model: its own effort, not the session's
    expect(await claudeArgsOf({ resume: SID, model: "haiku" }, [SID])).toBe(
      `[--model][haiku][--effort][low][--resume][${SID}]`,
    );
    // both given: as they are
    expect(await claudeArgsOf({ resume: SID, model: "sonnet", effort: "xhigh" }, [SID])).toBe(
      `[--model][sonnet][--effort][xhigh][--resume][${SID}]`,
    );
    // a session the config dir does not hold names none
    expect(await claudeArgsOf({ resume: OTHER_SID }, [SID])).toBe(`[--resume][${OTHER_SID}]`);
  });

  test("a fork of a continue forks the session it would carry on", async () => {
    expect(
      await claudeArgsOf({ continue: true, fork_session: true, session_id: NEW_SID }, [SID]),
    ).toBe(
      `[--model][opus][--effort][high][--resume][${SID}][--fork-session][--session-id][${NEW_SID}]`,
    );
  });

  // A session with no conversation claude reads (here an empty transcript):
  // --resume refuses it, --continue carries it on under its id.
  test("a continue whose session --resume would refuse stays --continue", async () => {
    const launch = async (input: Record<string, unknown>): Promise<string> => {
      const mock = mockPath();
      writeSession(mock.cfg, mock.cwd, OTHER_SID, 0);
      writeTranscript(mock.cfg, mock.cwd, SID, 5, "");
      const run = await runDefault(JSON.stringify({ cwd: mock.cwd, ...input }), {
        PATH: mock.PATH,
        CLAUDE_CONFIG_DIR: mock.cfg,
      });
      expect(run.code).toBe(0);
      return read(mock.hyouiArgs);
    };
    const head = "[run][--detached][--][claude]";
    expect(await launch({ continue: true, model: "haiku" })).toBe(
      `${head}[--model][haiku][--effort][low][--continue]`,
    );
    expect(await launch({ continue: true, fork_session: true, session_id: NEW_SID })).toBe(
      `${head}[--continue][--fork-session][--session-id][${NEW_SID}]`,
    );
  });

  test("chosen in the config dir the cwd's .envrc names, through direnv", async () => {
    // the daemon's config dir holds nothing; the one direnv names holds SID
    const envrcCfg = tmp("ccmsg-envrc-cfg-");
    const mock = mockPath({ direnv: true, direnvConfigDir: envrcCfg });
    writeSession(envrcCfg, mock.cwd, SID, 0);
    const run = await runDefault(JSON.stringify({ cwd: mock.cwd, continue: true }), {
      PATH: mock.PATH,
      CLAUDE_CONFIG_DIR: mock.cfg,
    });
    expect(run.code).toBe(0);
    expect(read(mock.hyouiArgs)).toBe(
      `[run][--detached][--][claude][--model][opus][--effort][high][--resume][${SID}]`,
    );
  });

  test("no launch context (the CLI does not run) is refused before claude starts", async () => {
    const mock = mockPath({ bun: false });
    const run = await runDefault(JSON.stringify({ cwd: mock.cwd, continue: true }), {
      PATH: mock.PATH,
      CLAUDE_CONFIG_DIR: mock.cfg,
    });
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("ccmsg launch-context did not answer");
    expect(read(mock.hyouiArgs)).toBe("");
  });
});
