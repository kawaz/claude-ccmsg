// The built-in launch command (DR-0018 §3.1, docs/design/launch-command.md):
// each field of its input becomes the claude option of the same name, the
// prompt last after `--`, and it runs `hyoui run --detached -- claude …` as
// it is, ending with hyoui's exit code. What it refuses it refuses before
// claude starts.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { LaunchCommandInput } from "@ccmsg/protocol";
import { DEFAULT_LAUNCH_COMMAND_SCRIPT } from "../src/config.ts";
import { claudeArgv, forkAtRecordArgv } from "../src/default-launch-command.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();
/** The system's directories: no hyoui or claude there. */
const SYSTEM_PATH = "/usr/bin:/bin";
const SID = "aaaaaaaa-0000-4000-8000-000000000001";
const NEW_SID = "bbbbbbbb-0000-4000-8000-000000000002";
const AT = "cccccccc-0000-4000-8000-000000000003";

describe("claudeArgv: each field as the claude option of its name", () => {
  test("a new session: its id, model, effort, name, and the prompt after --", () => {
    expect(
      claudeArgv({
        cwd: "/w",
        model: "opus",
        effort: "high",
        name: "n",
        prompt: "-p hi\n",
        session_id: NEW_SID,
      }),
    ).toEqual([
      "--session-id",
      NEW_SID,
      "--model",
      "opus",
      "--effort",
      "high",
      "--name",
      "n",
      "--",
      "-p hi\n",
    ]);
  });

  test("continue, resume and a fork: an option without an argument only when true", () => {
    expect(claudeArgv({ cwd: "/w", continue: true })).toEqual(["--continue"]);
    expect(claudeArgv({ cwd: "/w", resume: SID, fork_session: false })).toEqual(["--resume", SID]);
    expect(claudeArgv({ cwd: "/w", resume: SID, fork_session: true, session_id: NEW_SID })).toEqual(
      ["--resume", SID, "--fork-session", "--session-id", NEW_SID],
    );
  });
});

describe("forkAtRecordArgv: a fork at a record is two steps", () => {
  // --resume-session-at takes effect only with -p (findings
  // 2026-10-25-fork-with-session-id): the first step cuts the fork, the
  // second resumes it interactively, without --fork-session or --session-id.
  test("the -p fork cut at the record, then the interactive resume of it", () => {
    const input: LaunchCommandInput = {
      cwd: "/w",
      resume: SID,
      fork_session: true,
      resume_session_at: AT,
      session_id: NEW_SID,
      model: "haiku",
      prompt: "p",
    };
    expect(forkAtRecordArgv(input)).toEqual({
      first: [
        "-p",
        "--resume",
        SID,
        "--fork-session",
        "--session-id",
        NEW_SID,
        "--resume-session-at",
        AT,
        "--output-format",
        "json",
        "/exit",
      ],
      second: ["--resume", NEW_SID, "--model", "haiku", "--", "p"],
    });
  });

  test("any other launch is one step", () => {
    expect(
      forkAtRecordArgv({ cwd: "/w", resume: SID, fork_session: true, session_id: NEW_SID }),
    ).toBe(undefined);
  });
});

/** A PATH holding a `hyoui` (and, when asked, a `claude`) that write their
 * argv to a file, one `[arg]` each, and exit `exit`, ahead of the system's
 * directories (the mocks run through /bin/sh). */
function mockPath(options: { hyouiExit?: number; claudeExit?: number } = {}): {
  bin: string;
  hyouiArgs: string;
  claudeArgs: string;
} {
  const dir = tmp("ccmsg-default-launch-");
  const bin = path.join(dir, "bin");
  fs.mkdirSync(bin);
  const hyouiArgs = path.join(dir, "hyoui.args");
  const claudeArgs = path.join(dir, "claude.args");
  const recorder = (file: string, exit: number): string =>
    `#!/bin/sh\nfor a in "$@"; do printf '[%s]' "$a"; done > ${JSON.stringify(file)}\nexit ${String(exit)}\n`;
  writeMockBin(path.join(bin, "hyoui"), recorder(hyouiArgs, options.hyouiExit ?? 0));
  if (options.claudeExit !== undefined) {
    writeMockBin(path.join(bin, "claude"), recorder(claudeArgs, options.claudeExit));
  }
  return { bin: `${bin}:${SYSTEM_PATH}`, hyouiArgs, claudeArgs };
}

async function runDefault(stdin: string, PATH: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([process.execPath, DEFAULT_LAUNCH_COMMAND_SCRIPT], {
    stdin: new Blob([stdin]),
    stdout: "ignore",
    stderr: "pipe",
    env: { PATH },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  return { code, stderr };
}

const read = (file: string): string => (fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "");

describe("the built-in launch command, run as the daemon runs it", () => {
  test("runs hyoui run --detached -- claude with the options, and ends with hyoui's code", async () => {
    for (const [input, claude] of [
      [
        { cwd: "/w", model: "opus", effort: "low", session_id: NEW_SID, prompt: "a b" },
        "[--session-id][" + NEW_SID + "][--model][opus][--effort][low][--][a b]",
      ],
      [{ cwd: "/w", continue: true }, "[--continue]"],
      [{ cwd: "/w", resume: SID, name: "n" }, `[--resume][${SID}][--name][n]`],
      [
        { cwd: "/w", resume: SID, fork_session: true, session_id: NEW_SID },
        `[--resume][${SID}][--fork-session][--session-id][${NEW_SID}]`,
      ],
    ] as const) {
      const mock = mockPath({ hyouiExit: 3 });
      const run = await runDefault(JSON.stringify(input), mock.bin);
      expect({ input, code: run.code }).toEqual({ input, code: 3 });
      expect(read(mock.hyouiArgs)).toBe(`[run][--detached][--][claude]${claude}`);
    }
  });

  test("a fork at a record runs the -p fork first, then hyoui with the resume of it", async () => {
    const mock = mockPath({ claudeExit: 0 });
    const input = {
      cwd: "/w",
      resume: SID,
      fork_session: true,
      resume_session_at: AT,
      session_id: NEW_SID,
    };
    const run = await runDefault(JSON.stringify(input), mock.bin);
    expect(run.code).toBe(0);
    expect(read(mock.claudeArgs)).toBe(
      `[-p][--resume][${SID}][--fork-session][--session-id][${NEW_SID}][--resume-session-at][${AT}][--output-format][json][/exit]`,
    );
    expect(read(mock.hyouiArgs)).toBe(`[run][--detached][--][claude][--resume][${NEW_SID}]`);
  });

  // Refused before claude starts: non-zero, the reason on stderr, hyoui not run.
  test("an input that does not read, no hyoui, or a failed first step is refused", async () => {
    const mock = mockPath({ claudeExit: 1 });
    const bad = await runDefault('{"cwd":"/w","type":"new"}', mock.bin);
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain("the input does not read");
    const noHyoui = await runDefault(JSON.stringify({ cwd: "/w", continue: true }), SYSTEM_PATH);
    expect(noHyoui.code).toBe(2);
    expect(noHyoui.stderr).toContain("hyoui is not found in PATH");
    const forkFailed = await runDefault(
      JSON.stringify({
        cwd: "/w",
        resume: SID,
        fork_session: true,
        resume_session_at: AT,
        session_id: NEW_SID,
      }),
      mock.bin,
    );
    expect(forkFailed.code).toBe(2);
    expect(forkFailed.stderr).toContain("claude -p exited 1");
    const unhandled = await runDefault(
      JSON.stringify({ cwd: "/w", resume: SID, resume_session_at: AT }),
      mock.bin,
    );
    expect(unhandled.code).toBe(2);
    expect(read(mock.hyouiArgs)).toBe("");
  });
});
