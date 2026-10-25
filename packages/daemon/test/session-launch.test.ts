// Running the launch command (DR-0018 §3.5): the environment it inherits, and
// how one run ends — its exit code (a signal as 128 + N), the timeout's
// SIGTERM and SIGKILL to its process group, and output read while it runs
// and after it exits, kept up to its limit.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { LAUNCH_OUTPUT_CAPTURE_LIMIT } from "../src/launch-output.ts";
import { buildLaunchEnv, runLaunchCommand } from "../src/session-launch.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmp = perTestTmpDir();

/** A launch command running `script`, in a directory of its own. */
function command(script: string, dir = tmp("ccmsg-launch-run-")): { bin: string; dir: string } {
  return { bin: writeMockBin(path.join(dir, "launch"), `#!/bin/sh\n${script}\n`), dir };
}

/** A FIFO in a new directory, which the launch command writes to once it got
 * as far as that line; the test reads it to know. */
function readyFifo(): { dir: string; fifo: string } {
  const dir = tmp("ccmsg-launch-run-");
  const fifo = path.join(dir, "ready");
  expect(Bun.spawnSync(["mkfifo", fifo]).exitCode).toBe(0);
  return { dir, fifo };
}

const text = (bytes: Uint8Array): string => Buffer.from(bytes).toString("utf-8");

async function run(
  bin: string,
  cwd: string,
  options: { stdin?: string; deadline?: AbortSignal } = {},
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const result = await runLaunchCommand({
    argv: [bin],
    cwd,
    env: buildLaunchEnv(process.env, [], []),
    stdin: options.stdin ?? "{}",
    deadline: options.deadline ?? new AbortController().signal,
  });
  return {
    exitCode: result.exitCode,
    stdout: text(result.stdout.bytes),
    stderr: text(result.stderr.bytes),
  };
}

/** The pid a command wrote to `file`, read only when it is a pid: a blank or
 * stray text must not reach process.kill, where 0 names the whole group. */
async function pidIn(file: string): Promise<number | undefined> {
  const written = (await fs.readFile(file, "utf8").catch(() => "")).trim();
  return /^\d+$/.test(written) ? Number(written) : undefined;
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Whether `pid` is gone within 5 s: a killed process the test did not start
 * is reaped by its new parent, which the test cannot await. */
async function goneWithin5s(pid: number): Promise<boolean> {
  const until = Date.now() + 5000;
  while (alive(pid)) {
    if (Date.now() > until) return false;
    await Bun.sleep(20);
  }
  return true;
}

describe("runLaunchCommand", () => {
  // A non-zero exit is the command's answer, returned with both streams.
  test("returns the exit code and both output streams", async () => {
    const { bin, dir } = command("printf partial-out; printf partial-err >&2; exit 7");
    expect(await run(bin, dir)).toEqual({
      exitCode: 7,
      stdout: "partial-out",
      stderr: "partial-err",
    });
  });

  // The input reaches the command byte for byte: no shell sees it on the way.
  test("standard input carries the text unchanged and is closed", async () => {
    const { bin, dir } = command("cat");
    const stdin = JSON.stringify({ prompt: `it's "quoted" $HOME \`date\` \\ \n; rm -rf /` });
    expect((await run(bin, dir, { stdin })).stdout).toBe(stdin);
  });

  // An input larger than a pipe holds reaches a command that reads it, and a
  // command that exits without reading it still ends normally.
  test("a large input is delivered, and an unread one does not fail the run", async () => {
    const stdin = "x".repeat(300_000);
    const counting = command("wc -c | tr -d ' '");
    expect((await run(counting.bin, counting.dir, { stdin })).stdout).toBe("300000\n");
    const ignoring = command("exit 0");
    expect((await run(ignoring.bin, ignoring.dir, { stdin })).exitCode).toBe(0);
  });

  // Output larger than a pipe buffer is read while the command runs, so the
  // command does not stop on a full pipe.
  test("output larger than a pipe buffer is read whole", async () => {
    const { bin, dir } = command(
      "head -c 200000 /dev/zero | tr '\\0' a; head -c 70000 /dev/zero >&2",
    );
    const result = await run(bin, dir);
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("a".repeat(200_000));
    expect(result.stderr).toHaveLength(70_000);
  });

  // The deadline sends SIGTERM; a command that ends by it reads as 128 + 15.
  // The command's own TERM trap leaves a mark that it was the one signalled.
  test("the deadline sends SIGTERM, and a run ended by it is 143", async () => {
    const { dir, fifo } = readyFifo();
    const { bin } = command(
      `trap 'printf term-received >&2; trap - TERM; kill -TERM $$' TERM\n` +
        `printf ready > ${JSON.stringify(fifo)}\nwhile :; do :; done`,
      dir,
    );
    const deadline = new AbortController();
    const running = run(bin, dir, { deadline: deadline.signal });
    expect(await fs.readFile(fifo, "utf8")).toBe("ready");
    deadline.abort();
    expect(await running).toEqual({ exitCode: 143, stdout: "", stderr: "term-received" });
  });

  // A command that ignores SIGTERM is killed LAUNCH_KILL_GRACE_MS later: the
  // mark shows the SIGTERM arrived, and 137 that SIGKILL ended it.
  test("a command that ignores SIGTERM is killed, and the run is 137", async () => {
    const { dir, fifo } = readyFifo();
    const { bin } = command(
      `trap 'printf term-ignored >&2' TERM\n` +
        `printf ready > ${JSON.stringify(fifo)}\nwhile :; do :; done`,
      dir,
    );
    const deadline = new AbortController();
    const running = run(bin, dir, { deadline: deadline.signal });
    expect(await fs.readFile(fifo, "utf8")).toBe("ready");
    deadline.abort();
    expect(await running).toEqual({ exitCode: 137, stdout: "", stderr: "term-ignored" });
  });

  // A grandchild the command left running keeps the pipes' write ends, so
  // EOF does not come while it lives. The run returns after the command
  // exits, with the output so far, instead of waiting for the grandchild. The
  // daemon does not manage the survivor (DR-0018 §2.3); the test stops it.
  test("returns after the command exits while a grandchild holds the pipes", async () => {
    const dir = tmp("ccmsg-launch-run-");
    const pidFile = path.join(dir, "grandchild.pid");
    const { bin } = command(`sleep 30 & printf '%s' $! > ${JSON.stringify(pidFile)}; exit 0`, dir);
    const started = Date.now();
    try {
      const result = await run(bin, dir);
      const elapsedMs = Date.now() - started;
      expect(result.exitCode).toBe(0);
      // Well under the grandchild's 30 s: the run did not wait for EOF.
      expect(elapsedMs).toBeLessThan(5000);
      // A normal exit stops nothing the command started.
      const grandchild = await pidIn(pidFile);
      expect(grandchild === undefined ? false : alive(grandchild)).toBe(true);
    } finally {
      const grandchild = await pidIn(pidFile);
      if (grandchild !== undefined) process.kill(grandchild, "SIGKILL");
    }
  }, 10000);

  // The deadline stops the command's process group, so what the command
  // started and left in it does not outlive the timeout holding the pipes.
  test("the deadline stops what the command started in its group", async () => {
    const { dir, fifo } = readyFifo();
    const pidFile = path.join(dir, "grandchild.pid");
    const { bin } = command(
      `sleep 30 & printf '%s' $! > ${JSON.stringify(pidFile)}\n` +
        `printf ready > ${JSON.stringify(fifo)}\nwait`,
      dir,
    );
    const deadline = new AbortController();
    try {
      const running = runLaunchCommand({
        argv: [bin],
        cwd: dir,
        env: buildLaunchEnv(process.env, [], []),
        stdin: "{}",
        deadline: deadline.signal,
      });
      expect(await fs.readFile(fifo, "utf8")).toBe("ready");
      deadline.abort();
      const result = await running;
      expect({ exitCode: result.exitCode, timedOut: result.timedOut }).toEqual({
        exitCode: 143,
        timedOut: true,
      });
      const grandchild = await pidIn(pidFile);
      expect(grandchild).toBeDefined();
      expect(grandchild === undefined ? false : await goneWithin5s(grandchild)).toBe(true);
    } finally {
      const grandchild = await pidIn(pidFile);
      if (grandchild !== undefined && alive(grandchild)) process.kill(grandchild, "SIGKILL");
    }
  }, 10000);

  // A run the deadline did not touch says so: 143 of its own is not a timeout.
  test("a command that exits 143 by itself is not timed out", async () => {
    const { bin, dir } = command("exit 143");
    const result = await runLaunchCommand({
      argv: [bin],
      cwd: dir,
      env: {},
      stdin: "{}",
      deadline: new AbortController().signal,
    });
    expect({ exitCode: result.exitCode, timedOut: result.timedOut }).toEqual({
      exitCode: 143,
      timedOut: false,
    });
  });

  // Past the capture limit the output is read on (the pipe never fills) and
  // counted, but not kept.
  test("output past the capture limit is counted and not kept", async () => {
    const over = LAUNCH_OUTPUT_CAPTURE_LIMIT + 70_000;
    const { bin, dir } = command(`head -c ${String(over)} /dev/zero | tr '\\0' a`);
    const result = await runLaunchCommand({
      argv: [bin],
      cwd: dir,
      env: buildLaunchEnv(process.env, [], []),
      stdin: "{}",
      deadline: new AbortController().signal,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout.total).toBe(over);
    expect(result.stdout.bytes.byteLength).toBe(LAUNCH_OUTPUT_CAPTURE_LIMIT);
    expect(text(result.stdout.bytes)).toBe("a".repeat(LAUNCH_OUTPUT_CAPTURE_LIMIT));
  });

  // A program that cannot be started has no exit code: the run throws.
  test("a program that cannot be started rejects", async () => {
    const dir = tmp("ccmsg-launch-run-");
    expect(
      runLaunchCommand({
        argv: [path.join(dir, "missing")],
        cwd: dir,
        env: {},
        stdin: "{}",
        deadline: new AbortController().signal,
      }),
    ).rejects.toThrow("ENOENT");
  });
});

// clean_env / keep_env (DR-0018 §3.1): the daemon is usually started from
// inside a Claude session's shell, so its own env carries that session's
// CLAUDE_* / ANTHROPIC_* variables. These pin the pattern semantics (literal
// keys, `*` = any substring, regex metachars inert) and that keep wins.
describe("buildLaunchEnv: clean_env", () => {
  // Trailing-* prefix pattern removes every key sharing the prefix, while an
  // unrelated key survives — the primary real-world use ("CLAUDE_*").
  test("CLAUDE_* removes prefix-matching keys and keeps others", () => {
    const base = { CLAUDE_CODE_SESSION_ID: "old", CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" };
    expect(buildLaunchEnv(base, ["CLAUDE_*"], [])).toEqual({ PATH: "/bin" });
  });

  // A pattern without `*` is an exact, case-sensitive key match: it removes
  // exactly that key and does NOT act as a prefix (CLAUDECODE_EXTRA stays).
  test("literal pattern matches the whole key only", () => {
    const base = { CLAUDECODE: "1", CLAUDECODE_EXTRA: "x", claudecode: "lower" };
    expect(buildLaunchEnv(base, ["CLAUDECODE"], [])).toEqual({
      CLAUDECODE_EXTRA: "x",
      // case-sensitive: lowercase variant is a different key and survives
      claudecode: "lower",
    });
  });

  // A literal pattern that matches nothing removes nothing — no substring or
  // fuzzy semantics sneak in.
  test("non-matching literal pattern removes nothing", () => {
    const base = { ANTHROPIC_BASE_URL: "u", PATH: "/bin" };
    expect(buildLaunchEnv(base, ["ANTHROPIC"], [])).toEqual(base);
  });

  // `*` may appear mid-pattern and matches any substring of the key name
  // (there is no separator concept in env key names to stop at).
  test("mid-pattern * matches any substring", () => {
    const base = { CLAUDE_CODE_MODEL: "a", CLAUDE_OTHER_MODEL: "b", CLAUDE_MODELS: "c" };
    // Anchored match: the key must END with "_MODEL"; the trailing "S" in
    // "CLAUDE_MODELS" makes it a non-match, proving the `$` anchor works.
    expect(buildLaunchEnv(base, ["CLAUDE_*_MODEL"], [])).toEqual({ CLAUDE_MODELS: "c" });
  });

  // `^` anchor: the pattern must match from the very first character of the
  // key, so a key carrying an extra prefix before the pattern text survives.
  test("pattern does not match a key with an extra prefix", () => {
    const base = { XCLAUDE_CODE_MODEL: "pre", MY_AI_AGENT: "pre2" };
    expect(buildLaunchEnv(base, ["CLAUDE_*_MODEL", "AI_AGENT"], [])).toEqual(base);
  });

  // `*` matches the empty substring too: the real-world pattern "CLAUDE*"
  // must remove a key that is exactly the prefix ("CLAUDE") as well as
  // longer keys — "any substring" includes zero length.
  test("* matches zero characters", () => {
    expect(buildLaunchEnv({ CLAUDE: "bare", CLAUDECODE: "long" }, ["CLAUDE*"], [])).toEqual({});
  });

  // Regex metacharacters in a pattern are literal text, not regex syntax: a
  // "." must not act as "any character" and "$"/"(" must not blow up.
  test("regex metacharacters are treated literally", () => {
    const base = { "A.B": "dot", AXB: "x", "WEIRD$(KEY)": "w" };
    // "." is literal, so it cannot match the "X" in AXB
    expect(buildLaunchEnv(base, ["A.B", "WEIRD$(KEY)"], [])).toEqual({ AXB: "x" });
  });

  // A backslash immediately before `*`: the backslash is literal text and
  // the `*` is still the wildcard — there is NO escape syntax in patterns,
  // `*` always means "any substring". This is the trickiest compile case
  // (the escape step turns `\` into `\\` right next to the `\*` rewrite),
  // so pin it from both sides: the wildcard expands across the backslash
  // AND the backslash itself stays required.
  test("backslash before * stays literal while * stays a wildcard", () => {
    const base = { "A\\B": "bs-only", "A\\XYZB": "bs-then-text", AXB: "no-bs" };
    // no backslash in the key = the literal `\` in the pattern has no match
    expect(buildLaunchEnv(base, ["A\\*B"], [])).toEqual({ AXB: "no-bs" });
  });

  // Line breaks are part of a key name like any other character to `*`.
  test("* matches across a line break in a key", () => {
    expect(buildLaunchEnv({ "A\nB": "x", C: "y" }, ["A*B"], [])).toEqual({ C: "y" });
  });

  // Empty pattern list = no cleaning: the base env passes through.
  test("empty clean_env leaves the base env untouched", () => {
    const base = { CLAUDECODE: "1", PATH: "/bin" };
    expect(buildLaunchEnv(base, [], [])).toEqual(base);
  });

  // The daemon adds nothing of its own to what the command inherits.
  test("nothing is added to the base env", () => {
    expect(buildLaunchEnv({ PATH: "/bin" }, [], [])).toEqual({ PATH: "/bin" });
  });
});

// keep_env (DR-0018 §3.1): exceptions carved out of a broad clean pattern.
// The admin wants `CLAUDE*` cleaned wholesale, but CLAUDE_CONFIG_DIR is what
// the launched session's config-plane isolation needs. Keep wins over clean.
describe("buildLaunchEnv: keep_env", () => {
  // A key matched by BOTH a clean pattern and a keep pattern survives
  // (CLAUDE_CONFIG_DIR), while sibling keys matched only by clean are still
  // removed (CLAUDE_CODE_SESSION_ID) — keep is an exception list, not a
  // clean-list disabler.
  test("keep_env wins over clean_env for the matched key only", () => {
    const base = { CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_SESSION_ID: "old", PATH: "/bin" };
    expect(buildLaunchEnv(base, ["CLAUDE*"], ["CLAUDE_CONFIG_DIR"])).toEqual({
      CLAUDE_CONFIG_DIR: "/c",
      PATH: "/bin",
    });
  });

  // keep_env uses the same pattern grammar as clean_env, including `*`.
  test("keep_env patterns support wildcards", () => {
    const base = {
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CONFIG_EXTRA: "x",
      CLAUDE_CODE_SESSION_ID: "old",
    };
    expect(buildLaunchEnv(base, ["CLAUDE*"], ["CLAUDE_CONFIG*"])).toEqual({
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CONFIG_EXTRA: "x",
    });
  });

  // A keep pattern matching a key that no clean pattern removes is a no-op:
  // keep_env can never REMOVE anything (it only protects).
  test("keep_env matching an un-cleaned key changes nothing", () => {
    const base = { PATH: "/bin", HOME: "/home" };
    expect(buildLaunchEnv(base, ["CLAUDE*"], ["PATH"])).toEqual(base);
  });

  // With NO clean patterns at all, a keep list (even a wildcard one matching
  // every key) has no effect of its own.
  test("keep_env alone with empty clean_env removes and changes nothing", () => {
    const base = { CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" };
    expect(buildLaunchEnv(base, [], ["CLAUDE*", "PATH"])).toEqual(base);
  });

  // Empty keep list: clean_env removes its matches unimpeded.
  test("empty keep_env leaves clean_env behavior unchanged", () => {
    const base = { CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" };
    expect(buildLaunchEnv(base, ["CLAUDE*"], [])).toEqual({ PATH: "/bin" });
  });
});
