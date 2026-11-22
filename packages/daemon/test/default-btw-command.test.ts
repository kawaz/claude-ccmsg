// The built-in btw command (DR-0060 §2, docs/design/btw-command.md), run as
// the daemon runs it: `zsh -f <script>` with the btw on standard input. It
// forks the session with `claude -p --resume <sid> --fork-session
// --no-session-persistence`, the model as the daemon names it and the
// effort given, asks for stream-json, gives claude the prompt on standard
// input (never in its argv) and the session's config dir, through direnv when
// there is one. Without jq or claude it refuses before claude starts.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { DEFAULT_BTW_COMMAND_SCRIPT } from "../src/config.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
/** The system's directories: no claude or direnv there. */
const SYSTEM_PATH = "/usr/bin:/bin";
const SID = "aaaaaaaa-0000-4000-8000-000000000001";

function which(name: string): string {
  const found = Bun.which(name);
  if (found === null) throw new Error(`${name} is not found in PATH: the built-in needs it`);
  return found;
}

interface Mock {
  PATH: string;
  cwd: string;
  /** What the mock claude wrote: its argv (`[arg]` each), its standard input,
   * its cwd, and its CLAUDE* / ANTHROPIC* / CCMSG* / HYOUI* keys. */
  args: string;
  stdin: string;
  pwd: string;
  env: string;
  direnvArgs: string;
}

function mockPath(options: { claude?: boolean; direnv?: boolean } = {}): Mock {
  const dir = fs.realpathSync(tmp("ccmsg-default-btw-"));
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const cwd = path.join(dir, "cwd");
  fs.mkdirSync(cwd);
  const file = (name: string): string => path.join(dir, name);
  const recordArgs = (name: string): string =>
    `for a in "$@"; do printf '[%s]' "$a"; done > ${JSON.stringify(file(name))}\n`;
  fs.symlinkSync(which("jq"), path.join(bin, "jq"));
  if (options.claude !== false) {
    writeMockBin(
      path.join(bin, "claude"),
      `#!/bin/sh\n${recordArgs("claude.args")}cat > ${JSON.stringify(file("claude.stdin"))}\n` +
        `pwd -P > ${JSON.stringify(file("claude.pwd"))}\n` +
        `env | grep -E '^(CLAUDE|ANTHROPIC|CCMSG|HYOUI)' | sort > ${JSON.stringify(file("claude.env"))}\n` +
        `printf '%s\\n' '{"type":"result","subtype":"success","is_error":false,"result":"ok"}'\n`,
    );
  }
  if (options.direnv === true) {
    writeMockBin(
      path.join(bin, "direnv"),
      `#!/bin/sh\n${recordArgs("direnv.args")}shift 2\n` +
        `export CLAUDE_CONFIG_DIR=/elsewhere/from-envrc\nexec "$@"\n`,
    );
  }
  return {
    PATH: `${bin}:${SYSTEM_PATH}`,
    cwd,
    args: file("claude.args"),
    stdin: file("claude.stdin"),
    pwd: file("claude.pwd"),
    env: file("claude.env"),
    direnvArgs: file("direnv.args"),
  };
}

async function runDefault(
  input: object,
  env: Record<string, string>,
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([which("zsh"), "-f", DEFAULT_BTW_COMMAND_SCRIPT], {
    stdin: new Blob([JSON.stringify(input)]),
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

describe("the built-in btw command", () => {
  test("forks the session with claude -p, the model spelled whole, stream-json out and the prompt on stdin", async () => {
    const mock = mockPath();
    const run = await runDefault(
      {
        cwd: mock.cwd,
        config_dir: "/h/.claude-x",
        resume: SID,
        model: "opus[1m]",
        effort: "high",
        prompt: "<btw>\n...\n</btw>\n\n--model を書いても argv にならない",
      },
      { PATH: mock.PATH, CLAUDECODE: "1", CLAUDE_CODE_SESSION_ID: "other", CCMSG_SID: "x" },
    );
    expect(run.code).toBe(0);
    expect(run.stdout).toContain('"type":"result"');
    expect(read(mock.args)).toBe(
      `[-p][--resume][${SID}][--fork-session][--no-session-persistence][--model][opus[1m]]` +
        "[--effort][high][--permission-prompts][none][--output-format][stream-json]" +
        "[--verbose][--include-partial-messages]",
    );
    expect(read(mock.stdin)).toBe("<btw>\n...\n</btw>\n\n--model を書いても argv にならない\n");
    expect(read(mock.pwd).trim()).toBe(mock.cwd);
    // Other sessions' variables go; the session's config dir is set.
    expect(read(mock.env)).toBe("CLAUDE_CONFIG_DIR=/h/.claude-x\n");
  });

  test("without a model or an effort, none is given to claude", async () => {
    const mock = mockPath();
    const run = await runDefault(
      { cwd: mock.cwd, config_dir: "/h/.claude-x", resume: SID, prompt: "q" },
      { PATH: mock.PATH },
    );
    expect(run.code).toBe(0);
    expect(read(mock.args)).not.toContain("--model");
    expect(read(mock.args)).not.toContain("--effort");
  });

  test("through direnv when there is one, the session's config dir winning over the .envrc's", async () => {
    const mock = mockPath({ direnv: true });
    const run = await runDefault(
      { cwd: mock.cwd, config_dir: "/h/.claude-x", resume: SID, prompt: "q" },
      { PATH: mock.PATH },
    );
    expect(run.code).toBe(0);
    expect(read(mock.direnvArgs)).toStartWith("[exec][.][env][CLAUDE_CONFIG_DIR=/h/.claude-x]");
    expect(read(mock.env)).toBe("CLAUDE_CONFIG_DIR=/h/.claude-x\n");
  });

  test("without claude in PATH it refuses before anything runs (exit 2)", async () => {
    const mock = mockPath({ claude: false });
    const run = await runDefault(
      { cwd: mock.cwd, config_dir: "/h/.claude-x", resume: SID, prompt: "q" },
      { PATH: mock.PATH },
    );
    expect(run.code).toBe(2);
    expect(run.stderr).toContain("claude is not found in PATH");
  });

  test("an input without its cwd, config_dir or resume is refused (exit 2)", async () => {
    const mock = mockPath();
    const run = await runDefault({ cwd: mock.cwd, prompt: "q" }, { PATH: mock.PATH });
    expect(run.code).toBe(2);
    expect(read(mock.args)).toBe("");
  });
});
