// The built-in launch command (DR-0018 §3.1, docs/design/launch-command.md),
// run as the daemon runs it: `zsh -f <script>` with the input on standard
// input. Each field becomes the claude option of its name, the prompt goes to
// claude's standard input and never to its argv, and it runs
// `hyoui run --detached -- claude …`, ending with hyoui's exit code. Without
// jq, hyoui or claude it refuses before claude starts.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_LAUNCH_COMMAND_SCRIPT } from "../src/config.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
/** The system's directories: no hyoui, claude or direnv there. */
const SYSTEM_PATH = "/usr/bin:/bin";
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_SID = "bbbbbbbb-0000-4000-8000-000000000002";

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
  hyouiArgs: string;
  hyouiStdin: string;
  hyouiEnv: string;
  direnvArgs: string;
}

/** A PATH holding jq, a `claude` (the program hyoui would start), and a
 * `hyoui` that writes its argv (one `[arg]` each), its standard input, and its
 * environment's CLAUDE* / ANTHROPIC* / CCMSG* / HYOUI* keys to files, prints a
 * terminal id and exits `hyouiExit`. With `direnv`, a `direnv` that writes its
 * argv and runs what follows `exec .`. */
function mockPath(options: { hyouiExit?: number; direnv?: boolean } = {}): Mock {
  const dir = fs.realpathSync(tmp("ccmsg-default-launch-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd);
  const file = (name: string): string => path.join(dir, name);
  const recordArgs = (name: string): string =>
    `for a in "$@"; do printf '[%s]' "$a"; done > ${JSON.stringify(file(name))}\n`;
  fs.symlinkSync(which("jq"), path.join(bin, "jq"));
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
      `#!/bin/sh\n${recordArgs("direnv.args")}shift 2\nexec "$@"\n`,
    );
  }
  return {
    PATH: `${bin}:${SYSTEM_PATH}`,
    cwd,
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

/** The claude options of the hyoui argv a launch of `input` (with the mock's
 * cwd) runs. */
async function claudeArgsOf(input: Record<string, unknown>): Promise<string> {
  const mock = mockPath();
  const run = await runDefault(JSON.stringify({ cwd: mock.cwd, ...input }), { PATH: mock.PATH });
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
      { PATH: mock.PATH },
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
      { PATH: mock.PATH },
    );
    expect(run.code).toBe(0);
    expect(read(mock.hyouiStdin)).toBe(`${prompt}\n`);
    expect(read(mock.hyouiArgs)).not.toContain("two lines");
  });

  test("no prompt: the default one", async () => {
    const mock = mockPath();
    await runDefault(JSON.stringify({ cwd: mock.cwd, continue: true }), { PATH: mock.PATH });
    expect(read(mock.hyouiStdin)).toBe(".\n");
  });

  test("no effort: each model's default; no model: neither option", async () => {
    for (const [model, effort] of [
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
