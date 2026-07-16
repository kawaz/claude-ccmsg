// session_launch Phase 1 validation (DR-0018): build the fixed shell argv and
// opaque environment values without executing the configured command yet.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionLaunchRequest, SessionLauncherConfig } from "@ccmsg/protocol";
import { shellArgv, validateSessionLaunch } from "../src/session-launch.ts";

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
  // PROMPT and never evaluate or interpolate it during Phase 1 validation.
  test("shell syntax in prompt remains uninterpreted environment data", () => {
    const prompt = "$(rm -rf /)";
    const result = validateSessionLaunch(config(root), request(cwd, prompt));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.env.PROMPT).toBe(prompt);
  });
});
