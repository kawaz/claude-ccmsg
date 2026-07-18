// session_launch validation and execution contract (DR-0018): fixed shell argv,
// opaque environment values, output capture, and bounded two-stage termination.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionLaunchRequest, SessionLauncherConfig } from "@ccmsg/protocol";
import {
  buildLaunchEnv,
  executeSessionLaunch,
  shellArgv,
  validateSessionLaunch,
} from "../src/session-launch.ts";

function config(root: string, shell: "bash" | "zsh" = "bash"): SessionLauncherConfig {
  return {
    root_dirs: [root],
    default_prompt: "",
    shell,
    command: 'launch "$PROMPT"',
    timeout_seconds: 10,
    dir_tree_depth: 2,
  };
}

function request(cwd: string, prompt = "do the work"): SessionLaunchRequest {
  return {
    op: "session_launch",
    // Correlation id for the 2-phase wire exchange; validate/execute (the
    // units under test here) never read it, only server.ts's ack/event do.
    request_id: "test-request",
    cwd,
    model: "opaque-model",
    effort: "opaque-effort",
    prompt,
  };
}

async function execute(cfg: SessionLauncherConfig, req: SessionLaunchRequest) {
  const validation = validateSessionLaunch(cfg, req);
  if (!validation.ok) throw new Error(validation.msg);
  return executeSessionLaunch(validation, cfg.timeout_seconds);
}

describe("session launch validation", () => {
  let base: string;
  let root: string;
  let cwd: string;
  let outside: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-session-launch-"));
    root = path.join(base, "root");
    cwd = path.join(root, "repo");
    outside = path.join(base, "outside");
    fs.mkdirSync(cwd, { recursive: true });
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // The four request values cross the daemon/command boundary only as opaque
  // environment strings; no template substitution or value rewriting occurs.
  test("a valid request returns the four environment variables unchanged", () => {
    const req = request(cwd);
    const result = validateSessionLaunch(config(root), req);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.env).toEqual({
      CWD: fs.realpathSync(cwd),
      MODEL: req.model,
      EFFORT: req.effort,
      PROMPT: req.prompt,
    });
    expect(result.shellArgv).toEqual(["bash", "-eu", "-o", "pipefail", "-c", 'launch "$PROMPT"']);
  });

  // Bash's exact strict option sequence is part of the administrator-visible
  // command contract, not an implementation detail that may drift to sh -c.
  test("bash argv uses -eu and pipefail before the command", () => {
    expect(shellArgv("bash", "run")).toEqual(["bash", "-eu", "-o", "pipefail", "-c", "run"]);
  });

  // zsh is the second explicit built-in choice and receives equivalent strict
  // error/unset-variable/pipe-failure behavior.
  test("zsh argv uses equivalent strict options", () => {
    expect(shellArgv("zsh", "run")).toEqual(["zsh", "-e", "-u", "-o", "pipefail", "-c", "run"]);
  });

  // Launch cwd has the same realpath containment boundary as directory browsing;
  // arbitrary existing directories outside configured roots are forbidden.
  test("cwd outside configured roots is path_forbidden", () => {
    expect(validateSessionLaunch(config(root), request(outside))).toMatchObject({
      ok: false,
      code: "path_forbidden",
    });
  });

  // Without administrator configuration there is no fixed command or root set,
  // so session launch remains closed rather than accepting client authority.
  test("an unconfigured launcher returns launcher_not_configured", () => {
    expect(validateSessionLaunch(undefined, request(cwd))).toMatchObject({
      ok: false,
      code: "launcher_not_configured",
    });
  });

  // model and effort must name a selection, while prompt is allowed to be empty.
  // Wrong wire types are rejected at the daemon boundary rather than reaching spawn.
  test("model and effort reject empty values while prompt accepts empty string", () => {
    expect(validateSessionLaunch(config(root), { ...request(cwd), model: "" })).toMatchObject({
      ok: false,
      code: "invalid_args",
    });
    expect(validateSessionLaunch(config(root), { ...request(cwd), effort: "" })).toMatchObject({
      ok: false,
      code: "invalid_args",
    });
    expect(validateSessionLaunch(config(root), request(cwd, ""))).toMatchObject({
      ok: true,
      env: { PROMPT: "" },
    });
  });

  // DR-0018 §3.2 addendum 2026-07-17: user role may override the command
  // template. When present and non-empty, the daemon uses it verbatim in
  // shellArgv (still no variable substitution, still same env). The user-role
  // gate is enforced upstream in server.ts, so validate*() itself doesn't
  // re-check it — this test only pins the override -> shellArgv wiring.
  test("command override replaces the config template verbatim in shellArgv", () => {
    const override = 'echo "override $PROMPT"';
    const result = validateSessionLaunch(config(root), { ...request(cwd), command: override });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shellArgv).toEqual(["bash", "-eu", "-o", "pipefail", "-c", override]);
  });

  // Absent override falls through to the config template (previous behavior)
  // — the addendum must not regress the no-edit path from the webui.
  test("absent command override keeps the config template", () => {
    const result = validateSessionLaunch(config(root), request(cwd));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shellArgv).toEqual(["bash", "-eu", "-o", "pipefail", "-c", 'launch "$PROMPT"']);
  });

  // Empty string is deliberately invalid_args rather than a silent fallback to
  // the config template: silent fallback would mask a client bug (an empty
  // textarea sent verbatim); the webui's build helper never omits `command`
  // when the form differs from the default, so the boundary catches it here.
  test("empty command override is invalid_args", () => {
    expect(validateSessionLaunch(config(root), { ...request(cwd), command: "" })).toMatchObject({
      ok: false,
      code: "invalid_args",
    });
  });

  // Executing an overridden command proves end-to-end that the shell reaches
  // the override branch (not just shellArgv construction) and that env still
  // flows through the same way — a smoke test for the daemon-side wiring.
  test("executes with the overridden command and same env vars", async () => {
    const cfg = { ...config(root), command: "echo config-value" };
    const req = { ...request(cwd, "prompt-value"), command: 'echo "override:$PROMPT"' };
    expect(await execute(cfg, req)).toEqual({
      ok: true,
      stdout: "override:prompt-value\n",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });
  });

  // Shell-looking prompt text is data. The daemon must preserve it literally in
  // PROMPT and never evaluate or interpolate it during validation.
  test("shell syntax in prompt remains uninterpreted environment data", () => {
    const prompt = "$(rm -rf /)";
    const result = validateSessionLaunch(config(root), request(cwd, prompt));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.PROMPT).toBe(prompt);
  });

  // A successful child receives the validated real cwd and all four opaque
  // request values through env; stdout and stderr remain separate response fields.
  test("executes in the validated cwd with env and captures both output streams", async () => {
    const cfg = {
      ...config(root),
      command:
        `printf 'cwd=%s\\npwd=%s\\nmodel=%s\\neffort=%s\\nprompt=%s' ` +
        `"$CWD" "$PWD" "$MODEL" "$EFFORT" "$PROMPT"; printf 'stderr-value' >&2`,
    };
    const req = {
      ...request(cwd, 'hello $HOME "quoted"'),
      model: "model/x",
      effort: "xhigh",
    };

    expect(await execute(cfg, req)).toEqual({
      ok: true,
      stdout:
        `cwd=${fs.realpathSync(cwd)}\n` +
        `pwd=${fs.realpathSync(cwd)}\n` +
        `model=model/x\n` +
        `effort=xhigh\n` +
        `prompt=hello $HOME "quoted"`,
      stderr: "stderr-value",
      exit_code: 0,
      timed_out: false,
    });
  });

  // A normal non-zero exit is a completed launch, not a daemon protocol error;
  // its exact code and both output streams are returned to the webui.
  test("returns a normal non-zero exit code", async () => {
    const cfg = {
      ...config(root),
      command: "printf 'partial-out'; printf 'partial-err' >&2; exit 7",
    };

    expect(await execute(cfg, request(cwd))).toEqual({
      ok: true,
      stdout: "partial-out",
      stderr: "partial-err",
      exit_code: 7,
      timed_out: false,
    });
  });

  // Once the configured deadline expires, SIGTERM is sent. The child records
  // receipt, restores the default disposition, and terminates itself by SIGTERM,
  // proving signal termination maps to a null exit code and timed_out=true.
  test("times out with SIGTERM and reports signal termination", async () => {
    const cfg = {
      ...config(root),
      timeout_seconds: 0.05,
      command:
        "trap 'printf term-received >&2; trap - TERM; kill -TERM $$' TERM; " +
        "printf ready; while :; do :; done",
    };

    expect(await execute(cfg, request(cwd))).toEqual({
      ok: true,
      stdout: "ready",
      stderr: "term-received",
      exit_code: null,
      timed_out: true,
    });
  });

  // A child that handles but ignores SIGTERM must still finish: the captured
  // marker proves the first signal arrived, and completion proves the 500 ms
  // fallback sent SIGKILL rather than leaving an untracked process behind.
  test("escalates to SIGKILL when the child ignores SIGTERM", async () => {
    const cfg = {
      ...config(root),
      timeout_seconds: 0.05,
      command: "trap 'printf term-ignored >&2' TERM; printf ready; while :; do :; done",
    };

    expect(await execute(cfg, request(cwd))).toEqual({
      ok: true,
      stdout: "ready",
      stderr: "term-ignored",
      exit_code: null,
      timed_out: true,
    });
  }, 5000);

  // DR-0018's very command template detaches a grandchild (`hyoui run
  // --dettach`). That grandchild inherits the stdout/stderr pipe write ends, so
  // EOF never arrives while it lives — the reply must still return promptly
  // after the direct child exits, carrying the output captured so far, instead
  // of stalling on pipe EOF for the grandchild's whole lifetime. The launcher
  // deliberately does NOT manage or kill the survivor (DR-0018 §2.3 "プロセス
  // 管理はしない"): detaching a long-lived session is the feature.
  test("returns promptly when a detached grandchild keeps the pipes open", async () => {
    const cfg = {
      ...config(root),
      command: "printf launched; sleep 30 & exit 0",
    };

    const started = Date.now();
    const result = await execute(cfg, request(cwd));
    const elapsedMs = Date.now() - started;
    expect(result).toEqual({
      ok: true,
      stdout: "launched",
      stderr: "",
      exit_code: 0,
      timed_out: false,
    });
    // Well under the sleeping grandchild's 30 s: proves we did not wait for
    // pipe EOF. Bound generous enough for a loaded CI runner (exit + one
    // 500 ms drain grace + slack).
    expect(elapsedMs).toBeLessThan(5000);
  }, 10000);
});

// clean_env (DR-0018 §3.1 addendum 2026-07-18): the daemon is usually started
// from inside a Claude session's shell, so its own env carries that origin
// session's CLAUDE_*/ANTHROPIC_* variables. These tests pin the pattern
// semantics (literal keys, `*` = any substring, regex metachars inert) and the
// layering rule (launch env always wins over the cleaned base).
describe("clean_env pattern matching", () => {
  const launch = { CWD: "/w", MODEL: "m", EFFORT: "e", PROMPT: "p" };

  // Trailing-* prefix pattern removes every key sharing the prefix, while an
  // unrelated key survives — the primary real-world use ("CLAUDE_*").
  test("CLAUDE_* removes prefix-matching keys and keeps others", () => {
    const base = { CLAUDE_CODE_SESSION_ID: "old", CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" };
    const env = buildLaunchEnv(base, ["CLAUDE_*"], launch);
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  // A pattern without `*` is an exact, case-sensitive key match: it removes
  // exactly that key and does NOT act as a prefix (CLAUDECODE_EXTRA stays).
  test("literal pattern matches the whole key only", () => {
    const base = { CLAUDECODE: "1", CLAUDECODE_EXTRA: "x", claudecode: "lower" };
    const env = buildLaunchEnv(base, ["CLAUDECODE"], launch);
    expect(env.CLAUDECODE).toBeUndefined();
    expect(env.CLAUDECODE_EXTRA).toBe("x");
    // case-sensitive: lowercase variant is a different key and survives
    expect(env.claudecode).toBe("lower");
  });

  // A literal pattern that matches nothing removes nothing — no substring or
  // fuzzy semantics sneak in.
  test("non-matching literal pattern removes nothing", () => {
    const base = { ANTHROPIC_BASE_URL: "u", PATH: "/bin" };
    const env = buildLaunchEnv(base, ["ANTHROPIC"], launch);
    expect(env.ANTHROPIC_BASE_URL).toBe("u");
    expect(env.PATH).toBe("/bin");
  });

  // `*` may appear mid-pattern and matches any substring of the key name
  // (there is no separator concept in env key names to stop at).
  test("mid-pattern * matches any substring", () => {
    const base = { CLAUDE_CODE_MODEL: "a", CLAUDE_OTHER_MODEL: "b", CLAUDE_MODELS: "c" };
    const env = buildLaunchEnv(base, ["CLAUDE_*_MODEL"], launch);
    expect(env.CLAUDE_CODE_MODEL).toBeUndefined();
    expect(env.CLAUDE_OTHER_MODEL).toBeUndefined();
    // Anchored match: the key must END with "_MODEL"; the trailing "S" in
    // "CLAUDE_MODELS" makes it a non-match, proving the `$` anchor works.
    expect(env.CLAUDE_MODELS).toBe("c");
  });

  // `^` anchor: the pattern must match from the very first character of the
  // key, so a key carrying an extra prefix before the pattern text survives.
  // (The literal and mid-pattern cases above prove the `$` side; this pins
  // the `^` side so anchoring cannot silently regress to substring search.)
  test("pattern does not match a key with an extra prefix", () => {
    const base = { XCLAUDE_CODE_MODEL: "pre", MY_AI_AGENT: "pre2" };
    const env = buildLaunchEnv(base, ["CLAUDE_*_MODEL", "AI_AGENT"], launch);
    expect(env.XCLAUDE_CODE_MODEL).toBe("pre");
    expect(env.MY_AI_AGENT).toBe("pre2");
  });

  // `*` matches the empty substring too: the real-world pattern "CLAUDE*"
  // must remove a key that is exactly the prefix ("CLAUDE") as well as
  // longer keys — "any substring" includes zero length.
  test("* matches zero characters", () => {
    const base = { CLAUDE: "bare", CLAUDECODE: "long" };
    const env = buildLaunchEnv(base, ["CLAUDE*"], launch);
    expect(env.CLAUDE).toBeUndefined();
    expect(env.CLAUDECODE).toBeUndefined();
  });

  // Regex metacharacters in a pattern are literal text, not regex syntax: a
  // "." must not act as "any character" and "$"/"(" must not blow up.
  test("regex metacharacters are treated literally", () => {
    const base = { "A.B": "dot", AXB: "x", "WEIRD$(KEY)": "w" };
    const env = buildLaunchEnv(base, ["A.B", "WEIRD$(KEY)"], launch);
    expect(env["A.B"]).toBeUndefined();
    // "." is literal, so it cannot match the "X" in AXB
    expect(env.AXB).toBe("x");
    expect(env["WEIRD$(KEY)"]).toBeUndefined();
  });

  // A backslash immediately before `*`: the backslash is literal text and
  // the `*` is still the wildcard — there is NO escape syntax in patterns,
  // `*` always means "any substring". This is the trickiest compile case
  // (the escape step turns `\` into `\\` right next to the `\*` rewrite),
  // so pin it from both sides: the wildcard expands across the backslash
  // AND the backslash itself stays required.
  test("backslash before * stays literal while * stays a wildcard", () => {
    const base = { "A\\B": "bs-only", "A\\XYZB": "bs-then-text", AXB: "no-bs" };
    const env = buildLaunchEnv(base, ["A\\*B"], launch);
    // `*` matched zero chars / "XYZ" across the literal backslash
    expect(env["A\\B"]).toBeUndefined();
    expect(env["A\\XYZB"]).toBeUndefined();
    // no backslash in the key = the literal `\` in the pattern has no match
    expect(env.AXB).toBe("no-bs");
  });

  // Empty pattern list = no cleaning (the pre-addendum contract): the base env
  // passes through byte-identical apart from the launch overlay.
  test("empty clean_env leaves the base env untouched", () => {
    const base = { CLAUDECODE: "1", PATH: "/bin" };
    const env = buildLaunchEnv(base, [], launch);
    expect(env.CLAUDECODE).toBe("1");
    expect(env.PATH).toBe("/bin");
  });

  // Layering rule: launch.env is applied AFTER cleaning, so a pattern naming
  // one of the four launcher variables (here CWD) cannot remove it — the
  // launched command's contract of always receiving CWD/MODEL/EFFORT/PROMPT
  // holds regardless of what the administrator lists.
  test("launch env wins even when a pattern names CWD", () => {
    const base = { CWD: "/stale-from-daemon", PATH: "/bin" };
    const env = buildLaunchEnv(base, ["CWD"], launch);
    expect(env.CWD).toBe("/w");
  });
});

describe("clean_env end-to-end launch", () => {
  let base: string;
  let root: string;
  let cwd: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-clean-env-"));
    root = path.join(base, "root");
    cwd = path.join(root, "repo");
    fs.mkdirSync(cwd, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // Proves the wiring from config.clean_env through validateSessionLaunch to
  // the spawned child's actual environment: a daemon-side CLAUDE_* variable is
  // invisible to the child while an unmatched variable still flows through.
  test("spawned child does not see cleaned variables", async () => {
    process.env.CCMSG_TEST_CLEAN_ME = "leaked";
    process.env.CCMSG_TEST_KEEP_ME = "kept";
    try {
      const cfg: SessionLauncherConfig = {
        root_dirs: [root],
        default_prompt: "",
        shell: "bash",
        command: 'printf "clean=%s keep=%s" "${CCMSG_TEST_CLEAN_ME:-absent}" "$CCMSG_TEST_KEEP_ME"',
        timeout_seconds: 10,
        dir_tree_depth: 2,
        clean_env: ["CCMSG_TEST_CLEAN_*"],
      };
      const result = await execute(cfg, request(cwd));
      expect(result).toMatchObject({ ok: true, exit_code: 0, stdout: "clean=absent keep=kept" });
    } finally {
      delete process.env.CCMSG_TEST_CLEAN_ME;
      delete process.env.CCMSG_TEST_KEEP_ME;
    }
  });
});
