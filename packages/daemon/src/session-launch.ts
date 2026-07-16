// DR-0018 session launch Phase 1: validate the administrator-defined boundary
// and construct opaque env + explicit shell argv. Process execution, timeout,
// signal handling, and output capture are Phase 2 responsibilities.
import { ErrorCode, type SessionLaunchRequest, type SessionLauncherConfig } from "@ccmsg/protocol";
import { containedInRoots } from "./launcher-paths.ts";

export type SessionLaunchValidation =
  | { ok: true; env: Record<string, string>; shellArgv: string[] }
  | { ok: false; code: ErrorCode; msg: string };

export function shellArgv(shell: "bash" | "zsh", command: string): string[] {
  if (shell === "bash") return ["bash", "-eu", "-o", "pipefail", "-c", command];
  return ["zsh", "-e", "-u", "-o", "pipefail", "-c", command];
}

export function validateSessionLaunch(
  cfg: SessionLauncherConfig | undefined,
  req: SessionLaunchRequest,
): SessionLaunchValidation {
  if (!cfg) {
    return {
      ok: false,
      code: ErrorCode.launcher_not_configured,
      msg: "session launcher is not configured",
    };
  }

  const cwd = containedInRoots(cfg.root_dirs, req.cwd, "session_launch cwd");
  if (!cwd.ok) return cwd;
  if (typeof req.model !== "string" || req.model === "") {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "session_launch model must be non-empty",
    };
  }
  if (typeof req.effort !== "string" || req.effort === "") {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "session_launch effort must be non-empty",
    };
  }
  if (typeof req.prompt !== "string") {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "session_launch prompt must be a string",
    };
  }

  // Model and effort intentionally remain opaque strings: the UI may offer a
  // curated dropdown, but daemon enums would couple every new launcher choice
  // to a daemon release. Prompt is allowed to be empty because the DR defines
  // no non-empty constraint. None of the values is substituted or interpreted.
  const env = {
    CWD: cwd.data.realPath,
    MODEL: req.model,
    EFFORT: req.effort,
    PROMPT: req.prompt,
  };
  return { ok: true, env, shellArgv: shellArgv(cfg.shell, cfg.command) };
}
