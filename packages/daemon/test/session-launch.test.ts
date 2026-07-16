// session_launch validation and execution contract (DR-0018): fixed shell argv,
// opaque environment values, output capture, and bounded two-stage termination.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionLaunchRequest, SessionLauncherConfig } from "@ccmsg/protocol";
import { executeSessionLaunch, shellArgv, validateSessionLaunch } from "../src/session-launch.ts";

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
