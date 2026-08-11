// session_launch validation and execution contract (DR-0018): fixed shell argv,
// opaque environment values, output capture, and bounded two-stage termination.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LauncherParam, SessionLaunchRequest, SessionLauncherConfig } from "@ccmsg/protocol";
import {
  buildLaunchEnv,
  executeSessionLaunch,
  launchPrecode,
  launchShellProgram,
  shellArgv,
  validateSessionLaunch,
} from "../src/session-launch.ts";

/** The parameter set these tests declare on their templates — the legacy
 * vocabulary, which config.ts also derives when normalizing an old config. */
const LAUNCH_PARAM_NAMES = ["CWD", "MODEL", "EFFORT", "PROMPT", "RESUME_SID", "RESUME_AT"];
const LAUNCH_PARAMS: LauncherParam[] = LAUNCH_PARAM_NAMES.map((name) => ({ name, default: "" }));

/** The shell program for a command under the standard parameter set. */
function program(command: string): string {
  return launchShellProgram(LAUNCH_PARAM_NAMES, command);
}

function config(root: string, shell: "bash" | "zsh" = "bash"): SessionLauncherConfig {
  return {
    root_dirs: [root],
    templates: [{ name: "default", command: 'launch "$PROMPT"', params: LAUNCH_PARAMS, shell }],
    timeout_seconds: 10,
    dir_tree_depth: 2,
  };
}

/** Swap the single template's command — each execution test pins the exact
 * script the launcher shell must run. */
function withCommand(cfg: SessionLauncherConfig, command: string): SessionLauncherConfig {
  return { ...cfg, templates: [{ ...cfg.templates[0]!, command }] };
}

function request(cwd: string, prompt = "do the work"): SessionLaunchRequest {
  return {
    op: "session_launch",
    // Correlation id for the 2-phase wire exchange; validate/execute (the
    // units under test here) never read it, only server.ts's ack/event do.
    request_id: "test-request",
    cwd,
    params: { MODEL: "opaque-model", EFFORT: "opaque-effort", PROMPT: prompt },
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

  // Request values cross the daemon/command boundary only as opaque
  // environment strings; no template substitution or value rewriting occurs.
  // They ride in the `ccmsg_new_session_param_*` carriers, which the shell
  // prologue converts back to the declared parameter names.
  test("a valid request returns every carrier variable unchanged", () => {
    const req = request(cwd);
    const result = validateSessionLaunch(config(root), req);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.env).toEqual({
      ccmsg_new_session_param_CWD: fs.realpathSync(cwd),
      ccmsg_new_session_param_MODEL: "opaque-model",
      ccmsg_new_session_param_EFFORT: "opaque-effort",
      ccmsg_new_session_param_PROMPT: "do the work",
      // A declared parameter the request left out is defined-but-empty (its
      // default), so a template mentioning $RESUME_AT does not abort under
      // `set -u` when nothing is being forked.
      ccmsg_new_session_param_RESUME_SID: "",
      ccmsg_new_session_param_RESUME_AT: "",
    });
    expect(result.cwd).toBe(fs.realpathSync(cwd));
    expect(result.shellArgv).toEqual([
      "bash",
      "-eu",
      "-o",
      "pipefail",
      "-c",
      program('launch "$PROMPT"'),
    ]);
  });

  // The prologue is fixed text over config-validated identifiers: no request
  // value is interpolated into shell source, so a hostile prompt cannot reach
  // it. Exactly the declared parameters appear — the shell defines nothing a
  // template did not ask for.
  test("the prologue moves every carrier into a plain variable and unsets it", () => {
    expect(launchPrecode(LAUNCH_PARAM_NAMES)).toBe(
      [
        'unset -v CWD; CWD="$ccmsg_new_session_param_CWD"; unset -v ccmsg_new_session_param_CWD',
        'unset -v MODEL; MODEL="$ccmsg_new_session_param_MODEL"; unset -v ccmsg_new_session_param_MODEL',
        'unset -v EFFORT; EFFORT="$ccmsg_new_session_param_EFFORT"; unset -v ccmsg_new_session_param_EFFORT',
        'unset -v PROMPT; PROMPT="$ccmsg_new_session_param_PROMPT"; unset -v ccmsg_new_session_param_PROMPT',
        'unset -v RESUME_SID; RESUME_SID="$ccmsg_new_session_param_RESUME_SID"; unset -v ccmsg_new_session_param_RESUME_SID',
        'unset -v RESUME_AT; RESUME_AT="$ccmsg_new_session_param_RESUME_AT"; unset -v ccmsg_new_session_param_RESUME_AT',
      ].join("\n"),
    );
  });

  // Newline, not `;`: a template opening with a comment or a shell keyword must
  // parse exactly as the administrator wrote it.
  test("the command is appended on its own line after the prologue", () => {
    expect(program("# leading comment\nrun")).toBe(
      `${launchPrecode(LAUNCH_PARAM_NAMES)}\n# leading comment\nrun`,
    );
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

  // Parameter values are opaque to the daemon: any of them may be empty (the
  // template author decides what an empty value means), and a value the
  // request omits falls back to the configured default.
  test("any declared parameter may be empty, and omitted ones take their default", () => {
    expect(validateSessionLaunch(config(root), request(cwd, ""))).toMatchObject({
      ok: true,
      env: { ccmsg_new_session_param_PROMPT: "" },
    });
    const cfg: SessionLauncherConfig = {
      ...config(root),
      templates: [
        {
          name: "default",
          command: "run",
          params: [
            { name: "CWD", default: "" },
            { name: "MODEL", default: "fable" },
          ],
          shell: "bash",
        },
      ],
    };
    expect(validateSessionLaunch(cfg, { ...request(cwd), params: {} })).toMatchObject({
      ok: true,
      env: { ccmsg_new_session_param_MODEL: "fable" },
    });
  });

  // A value for a parameter the template does not declare would reach nothing:
  // the shell only defines declared names. Saying so beats dropping it, since
  // the client and the config then disagree about what the form is.
  test("an undeclared parameter is invalid_args", () => {
    const cfg: SessionLauncherConfig = {
      ...config(root),
      templates: [
        { name: "default", command: "run", params: [{ name: "CWD", default: "" }], shell: "bash" },
      ],
    };
    expect(
      validateSessionLaunch(cfg, { ...request(cwd), params: { BRANCH: "main" } }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
  });

  // CWD is the containment-checked spawn directory, so its value comes from
  // the request's own `cwd` field. Sending it as a parameter too would be two
  // sources for one value; the boundary refuses rather than picking a winner.
  test("CWD sent as a parameter is invalid_args", () => {
    expect(
      validateSessionLaunch(config(root), { ...request(cwd), params: { CWD: "/elsewhere" } }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
  });

  // Wrong wire types are rejected at the daemon boundary rather than reaching
  // spawn (where a non-string would stringify into something nobody asked for).
  test("a non-string parameter value is invalid_args", () => {
    expect(
      validateSessionLaunch(config(root), {
        ...request(cwd),
        params: { MODEL: 7 as unknown as string },
      }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
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
    expect(result.shellArgv).toEqual(["bash", "-eu", "-o", "pipefail", "-c", program(override)]);
  });

  // Absent override falls through to the config template (previous behavior)
  // — the addendum must not regress the no-edit path from the webui.
  test("absent command override keeps the config template", () => {
    const result = validateSessionLaunch(config(root), request(cwd));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.shellArgv).toEqual([
      "bash",
      "-eu",
      "-o",
      "pipefail",
      "-c",
      program('launch "$PROMPT"'),
    ]);
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

  // Template selection picks the whole recipe — its command and its shell —
  // and an absent `template` keeps launching the default (first) one.
  test("template selects the named recipe's command and shell", () => {
    const cfg: SessionLauncherConfig = {
      ...config(root),
      templates: [
        { name: "default", command: "run-default", params: LAUNCH_PARAMS, shell: "bash" },
        {
          name: "fork",
          command: 'run --resume "$RESUME_SID"',
          params: LAUNCH_PARAMS,
          shell: "zsh",
        },
      ],
    };

    const chosen = validateSessionLaunch(cfg, { ...request(cwd), template: "fork" });
    expect(chosen.ok).toBe(true);
    if (!chosen.ok) return;
    expect(chosen.shellArgv).toEqual([
      "zsh",
      "-e",
      "-u",
      "-o",
      "pipefail",
      "-c",
      program('run --resume "$RESUME_SID"'),
    ]);

    const fallback = validateSessionLaunch(cfg, request(cwd));
    expect(fallback.ok).toBe(true);
    if (!fallback.ok) return;
    expect(fallback.shellArgv.at(-1)).toBe(program("run-default"));
  });

  // A name that isn't configured is an error rather than a fallback: launching
  // some other recipe than the one asked for would run the wrong command
  // silently (the webui's picker only ever sends names it was given, so this
  // fires on a stale form after a config edit).
  test("an unknown template name is invalid_args", () => {
    expect(
      validateSessionLaunch(config(root), { ...request(cwd), template: "no-such" }),
    ).toMatchObject({ ok: false, code: "invalid_args" });
  });

  // The fork values are ordinary declared parameters — nothing about them is
  // special-cased — so they pass through verbatim like every other value.
  test("the fork parameters reach the carriers verbatim", () => {
    const result = validateSessionLaunch(config(root), {
      ...request(cwd),
      params: {
        RESUME_SID: "11111111-2222-3333-4444-555555555555",
        RESUME_AT: "66666666-7777-8888-9999-000000000000",
      },
    });
    expect(result).toMatchObject({
      ok: true,
      env: {
        ccmsg_new_session_param_RESUME_SID: "11111111-2222-3333-4444-555555555555",
        ccmsg_new_session_param_RESUME_AT: "66666666-7777-8888-9999-000000000000",
      },
    });
  });

  // The launched command sees the fork values as ordinary shell variables, and
  // sees them empty (not unset) on a plain launch — a fork template running
  // under `set -u` must not abort when nothing is being resumed.
  test("a non-fork launch defines the resume variables as empty", async () => {
    const cfg = withCommand(config(root), `printf 'sid=[%s] at=[%s]' "$RESUME_SID" "$RESUME_AT"`);
    expect(await execute(cfg, request(cwd))).toMatchObject({
      ok: true,
      exit_code: 0,
      stdout: "sid=[] at=[]",
    });
    expect(
      await execute(cfg, {
        ...request(cwd),
        params: { RESUME_SID: "sid-1", RESUME_AT: "uuid-1" },
      }),
    ).toMatchObject({ ok: true, exit_code: 0, stdout: "sid=[sid-1] at=[uuid-1]" });
  });

  // Executing an overridden command proves end-to-end that the shell reaches
  // the override branch (not just shellArgv construction) and that env still
  // flows through the same way — a smoke test for the daemon-side wiring.
  test("executes with the overridden command and same env vars", async () => {
    const cfg = withCommand(config(root), "echo config-value");
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
    expect(result.env.ccmsg_new_session_param_PROMPT).toBe(prompt);
  });

  // A successful child receives the validated real cwd and every declared
  // parameter through env; stdout and stderr remain separate response fields.
  test("executes in the validated cwd with env and captures both output streams", async () => {
    const cfg = withCommand(
      config(root),
      `printf 'cwd=%s\\npwd=%s\\nmodel=%s\\neffort=%s\\nprompt=%s' ` +
        `"$CWD" "$PWD" "$MODEL" "$EFFORT" "$PROMPT"; printf 'stderr-value' >&2`,
    );
    const req = {
      ...request(cwd),
      params: { MODEL: "model/x", EFFORT: "xhigh", PROMPT: 'hello $HOME "quoted"' },
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

  // The whole point of the carrier + prologue design (kawaz r76m15): the launch
  // values are a transport detail, so neither the template names nor the
  // carriers may survive into the process tree the command starts — a claude
  // session must not hand $PROMPT down to every command it later runs. `env`
  // is executed in a grandchild, i.e. exactly what the launched session sees.
  test("no launch variable reaches a grandchild process environment", async () => {
    const cfg = withCommand(
      config(root),
      "residue=$(bash -c env | " +
        "grep -E '^(CWD|MODEL|EFFORT|PROMPT|ccmsg_new_session_param_[A-Z_]+)=' || true); " +
        `printf 'residue=[%s] prompt=[%s]' "$residue" "$PROMPT"`,
    );

    expect(await execute(cfg, request(cwd, "secret prompt"))).toMatchObject({
      ok: true,
      exit_code: 0,
      stdout: "residue=[] prompt=[secret prompt]",
    });
  });

  // Values reach the command through the environment and a quoted assignment,
  // never through shell source, so every metacharacter class survives byte for
  // byte: quotes of both kinds, command substitution, backticks, backslashes,
  // a trailing newline, and leading/trailing whitespace.
  test("quoting-hostile prompt text arrives at the command verbatim", async () => {
    const prompt = `  'single' "double" $(id) \`tick\` \\back $HOME\nsecond line\n`;
    const cfg = withCommand(config(root), `printf '[%s]' "$PROMPT"`);

    expect(await execute(cfg, request(cwd, prompt))).toMatchObject({
      ok: true,
      exit_code: 0,
      stdout: `[${prompt}]`,
    });
  });

  // The daemon may itself be running with PROMPT/CWD/MODEL/EFFORT exported
  // (they are ordinary-looking names). Those no longer get overwritten by an
  // overlay, so the prologue's leading `unset -v` is what guarantees the
  // command sees this launch's value — and that the stale export does not
  // survive into the grandchild either.
  test("a stale same-named variable in the daemon env is replaced, not inherited", async () => {
    process.env.PROMPT = "stale-from-daemon";
    try {
      const cfg = withCommand(
        config(root),
        "leaked=$(bash -c env | grep -E '^PROMPT=' || true); " +
          `printf 'prompt=[%s] leaked=[%s]' "$PROMPT" "$leaked"`,
      );
      expect(await execute(cfg, request(cwd, "fresh"))).toMatchObject({
        ok: true,
        exit_code: 0,
        stdout: "prompt=[fresh] leaked=[]",
      });
    } finally {
      delete process.env.PROMPT;
    }
  });

  // zsh is the second supported shell and parses the same prologue text
  // (`unset -v`, quoted assignment) identically — pinned by execution, since a
  // prologue that only works under bash would silently break zsh admins.
  // Skipped where zsh is not installed (CI's ubuntu runner ships without it);
  // the bash-side coverage above runs everywhere.
  test.skipIf(Bun.which("zsh") === null)("the prologue behaves identically under zsh", async () => {
    const cfg = withCommand(
      config(root, "zsh"),
      "residue=$(zsh -c env | " +
        "grep -E '^(PROMPT|ccmsg_new_session_param_[A-Z_]+)=' || true); " +
        `printf 'residue=[%s] prompt=[%s]' "$residue" "$PROMPT"`,
    );

    expect(await execute(cfg, request(cwd, "zsh prompt"))).toMatchObject({
      ok: true,
      exit_code: 0,
      stdout: "residue=[] prompt=[zsh prompt]",
    });
  });

  // A normal non-zero exit is a completed launch, not a daemon protocol error;
  // its exact code and both output streams are returned to the webui.
  test("returns a normal non-zero exit code", async () => {
    const cfg = withCommand(config(root), "printf 'partial-out'; printf 'partial-err' >&2; exit 7");

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
      ...withCommand(
        config(root),
        "trap 'printf term-received >&2; trap - TERM; kill -TERM $$' TERM; " +
          "printf ready; while :; do :; done",
      ),
      timeout_seconds: 0.05,
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
      ...withCommand(
        config(root),
        "trap 'printf term-ignored >&2' TERM; printf ready; while :; do :; done",
      ),
      timeout_seconds: 0.05,
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
    const cfg = withCommand(config(root), "printf launched; sleep 30 & exit 0");

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
  const launch = {
    ccmsg_new_session_param_CWD: "/w",
    ccmsg_new_session_param_MODEL: "m",
    ccmsg_new_session_param_EFFORT: "e",
    ccmsg_new_session_param_PROMPT: "p",
  };

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
  // one of the four carrier variables cannot remove it — the launched
  // command's contract of always receiving CWD/MODEL/EFFORT/PROMPT holds
  // regardless of what the administrator lists.
  test("launch env wins even when a pattern names a carrier", () => {
    const base = { ccmsg_new_session_param_CWD: "/stale-from-daemon", PATH: "/bin" };
    const env = buildLaunchEnv(base, ["ccmsg_new_session_param_*"], launch);
    expect(env.ccmsg_new_session_param_CWD).toBe("/w");
  });
});

// keep_env (DR-0018 §3.1 addendum 2026-07-18, 2nd): allowlist carving
// exceptions out of a broad clean pattern. Real-world motivation: the admin
// wants `CLAUDE*` cleaned wholesale, but CLAUDE_CONFIG_DIR is required for the
// launched session's config-plane isolation — removing it broke session
// launch entirely. Precedence contract: keep wins over clean.
describe("keep_env allowlist", () => {
  const launch = {
    ccmsg_new_session_param_CWD: "/w",
    ccmsg_new_session_param_MODEL: "m",
    ccmsg_new_session_param_EFFORT: "e",
    ccmsg_new_session_param_PROMPT: "p",
  };

  // The core precedence rule and the motivating incident in one case: a key
  // matched by BOTH a clean pattern and a keep pattern survives
  // (CLAUDE_CONFIG_DIR), while sibling keys matched only by clean are still
  // removed (CLAUDE_CODE_SESSION_ID) — keep is an exception list, not a
  // clean-list disabler.
  test("keep_env wins over clean_env for the matched key only", () => {
    const base = { CLAUDE_CONFIG_DIR: "/c", CLAUDE_CODE_SESSION_ID: "old", PATH: "/bin" };
    const env = buildLaunchEnv(base, ["CLAUDE*"], launch, ["CLAUDE_CONFIG_DIR"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  // keep_env uses the same pattern grammar as clean_env, including `*` as
  // "any substring": one wildcard keep pattern can protect a family of keys
  // while the rest of the clean match is still removed.
  test("keep_env patterns support wildcards", () => {
    const base = {
      CLAUDE_CONFIG_DIR: "/c",
      CLAUDE_CONFIG_EXTRA: "x",
      CLAUDE_CODE_SESSION_ID: "old",
    };
    const env = buildLaunchEnv(base, ["CLAUDE*"], launch, ["CLAUDE_CONFIG*"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
    expect(env.CLAUDE_CONFIG_EXTRA).toBe("x");
    expect(env.CLAUDE_CODE_SESSION_ID).toBeUndefined();
  });

  // A keep pattern matching a key that no clean pattern removes is a no-op:
  // the key would have survived anyway, and unrelated keys are untouched.
  // Pins that keep_env can never REMOVE anything (it only protects).
  test("keep_env matching an un-cleaned key changes nothing", () => {
    const base = { PATH: "/bin", HOME: "/home" };
    const env = buildLaunchEnv(base, ["CLAUDE*"], launch, ["PATH"]);
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home");
  });

  // The other quadrant of "keep only protects": with NO clean patterns at
  // all, a keep list (even a wildcard one matching every key in base) is
  // pure dead weight — nothing was going to be removed, so nothing changes.
  // Distinct from the case above, where clean_env was non-empty but merely
  // unmatched: here the removal machinery is entirely absent, pinning that
  // keep_env has no effect of its own on any code path.
  test("keep_env alone with empty clean_env removes and changes nothing", () => {
    const base = { CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" };
    const env = buildLaunchEnv(base, [], launch, ["CLAUDE*", "PATH"]);
    expect(env.CLAUDE_CONFIG_DIR).toBe("/c");
    expect(env.PATH).toBe("/bin");
  });

  // Empty keep list = the pre-keep_env contract exactly: clean_env removes
  // its matches unimpeded. (The omitted-argument default is also pinned by
  // every case in the clean_env describe above, which calls the 3-arg form.)
  test("empty keep_env leaves clean_env behavior unchanged", () => {
    const base = { CLAUDE_CONFIG_DIR: "/c", PATH: "/bin" };
    const env = buildLaunchEnv(base, ["CLAUDE*"], launch, []);
    expect(env.CLAUDE_CONFIG_DIR).toBeUndefined();
    expect(env.PATH).toBe("/bin");
  });

  // keep_env protects only against cleaning, not against the launch overlay:
  // the carriers are layered on AFTER the keep/clean decision, so even a kept
  // stale carrier from the daemon env is overwritten by this launch's value —
  // the launched command's four-variable contract stays absolute.
  test("launch env still wins over a kept key", () => {
    const base = { ccmsg_new_session_param_CWD: "/stale-from-daemon" };
    const env = buildLaunchEnv(base, ["ccmsg_new_session_param_CWD"], launch, [
      "ccmsg_new_session_param_CWD",
    ]);
    expect(env.ccmsg_new_session_param_CWD).toBe("/w");
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
        templates: [
          {
            name: "default",
            command:
              'printf "clean=%s keep=%s" "${CCMSG_TEST_CLEAN_ME:-absent}" "$CCMSG_TEST_KEEP_ME"',
            params: LAUNCH_PARAMS,
            shell: "bash",
          },
        ],
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

  // Proves the keep_env wiring from config through validateSessionLaunch to
  // the spawned child (the CLAUDE_CONFIG_DIR incident shape): both variables
  // match the broad clean pattern, but the keep-listed one reaches the child
  // while its sibling is removed.
  test("spawned child sees keep_env-protected variable despite a matching clean pattern", async () => {
    process.env.CCMSG_TEST_KE_CONFIG = "protected";
    process.env.CCMSG_TEST_KE_SESSION = "leaked";
    try {
      const cfg: SessionLauncherConfig = {
        root_dirs: [root],
        templates: [
          {
            name: "default",
            command:
              'printf "cfg=%s sess=%s" "${CCMSG_TEST_KE_CONFIG:-absent}" "${CCMSG_TEST_KE_SESSION:-absent}"',
            params: LAUNCH_PARAMS,
            shell: "bash",
          },
        ],
        timeout_seconds: 10,
        dir_tree_depth: 2,
        clean_env: ["CCMSG_TEST_KE_*"],
        keep_env: ["CCMSG_TEST_KE_CONFIG"],
      };
      const result = await execute(cfg, request(cwd));
      expect(result).toMatchObject({ ok: true, exit_code: 0, stdout: "cfg=protected sess=absent" });
    } finally {
      delete process.env.CCMSG_TEST_KE_CONFIG;
      delete process.env.CCMSG_TEST_KE_SESSION;
    }
  });
});
