// DR-0018 session launch boundary: validate administrator-controlled roots and
// command selection, construct opaque env + explicit shell argv, then execute
// with bounded output capture and two-stage timeout termination.
import {
  ErrorCode,
  type SessionLaunchRequest,
  type SessionLauncherConfig,
  type SessionLaunchResponse,
} from "@ccmsg/protocol";
import { containedInRoots } from "./launcher-paths.ts";

export type SessionLaunchValidation =
  | {
      ok: true;
      env: Record<string, string>;
      shellArgv: string[];
      cleanEnv: string[];
      keepEnv: string[];
    }
  | { ok: false; code: ErrorCode; msg: string };

type ValidatedSessionLaunch = Extract<SessionLaunchValidation, { ok: true }>;

const FORCE_KILL_GRACE_MS = 500;

/** After the direct child exits, wait at most this long for the stdout/stderr
 * pipes to reach EOF before returning what was captured so far. A launcher
 * command that backgrounds/detaches a grandchild (the DR-0018 template does
 * exactly this via `hyoui run --dettach`) can leave that grandchild holding
 * the inherited pipe write end, so EOF may never arrive — without this bound
 * the reply would stall until the grandchild dies. On a clean exit every fd
 * is closed at exit time, EOF races ahead of the timer, and this grace adds
 * zero latency. */
const PIPE_DRAIN_GRACE_MS = 500;

/** Accumulate a spawned pipe without `Response.text()` — that helper resolves
 * only at EOF, which an orphaned grandchild can postpone forever (see
 * PIPE_DRAIN_GRACE_MS). `finish` waits for EOF up to `graceMs`, then cancels
 * the reader and returns whatever bytes arrived. */
function collectStream(stream: ReadableStream<Uint8Array>): {
  finish: (graceMs: number) => Promise<string>;
} {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  })();
  return {
    finish: async (graceMs: number): Promise<string> => {
      await Promise.race([
        drained.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, graceMs)),
      ]);
      await reader.cancel().catch(() => {});
      await drained.catch(() => {});
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

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
  // DR-0018 §3.2 addendum (2026-07-17): user role may override the shell
  // command template. Absent = use config's command verbatim (previous
  // behavior). Present but empty = invalid_args (an empty template runs
  // nothing meaningful and would mask a client bug). Present and non-empty =
  // use it as-is; still no variable substitution, same env vars are exposed.
  // The user-role gate is enforced upstream in server.ts's session_launch
  // handler — session role never reaches this override at all.
  if (req.command !== undefined) {
    if (typeof req.command !== "string" || req.command === "") {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: "session_launch command override must be a non-empty string",
      };
    }
  }
  const command = req.command ?? cfg.command;

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
  return {
    ok: true,
    env,
    shellArgv: shellArgv(cfg.shell, command),
    cleanEnv: cfg.clean_env ?? [],
    keepEnv: cfg.keep_env ?? [],
  };
}

/** Compile one clean_env wildcard pattern (DR-0018 §3.1 addendum 2026-07-18)
 * into an anchored RegExp: every regex metacharacter is escaped first so only
 * `*` carries meaning (any substring of the key name), then anchored so a
 * pattern without `*` is an exact, case-sensitive key match. The `\*` → `.*`
 * rewrite cannot collide with an escaped literal backslash: escaping maps a
 * source `\` to `\\` and a source `*` to `\*`, so every `\*` digram in the
 * escaped text (scanning left-to-right in non-overlapping steps, exactly how
 * replaceAll matches) comes from a source `*`. */
function cleanEnvPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`);
}

/** Build the child environment: daemon env minus clean_env matches (except
 * keys a keep_env pattern also matches — keep wins over clean, DR-0018 §3.1
 * addendum: a broad `CLAUDE*` clean must not remove CLAUDE_CONFIG_DIR), with
 * the launch's own CWD/MODEL/EFFORT/PROMPT layered on top afterwards — so
 * those four always win even if a pattern names them. Exported for tests. */
export function buildLaunchEnv(
  baseEnv: Record<string, string | undefined>,
  cleanEnv: string[],
  launchEnv: Record<string, string>,
  keepEnv: string[] = [],
): Record<string, string | undefined> {
  const cleanRes = cleanEnv.map(cleanEnvPatternToRegExp);
  const keepRes = keepEnv.map(cleanEnvPatternToRegExp);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!keepRes.some((re) => re.test(key)) && cleanRes.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return { ...env, ...launchEnv };
}

/** Execute one validated launch and wait only for this child result. No pid is
 * retained after return and no restart/progress lifecycle is introduced. */
export async function executeSessionLaunch(
  launch: ValidatedSessionLaunch,
  timeoutSeconds: number,
): Promise<SessionLaunchResponse> {
  const proc = Bun.spawn(launch.shellArgv, {
    cwd: launch.env.CWD,
    env: buildLaunchEnv(process.env, launch.cleanEnv, launch.env, launch.keepEnv),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let settled = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    if (settled || proc.exitCode !== null || proc.signalCode !== null) return;
    timedOut = true;
    proc.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (settled || proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGKILL");
    }, FORCE_KILL_GRACE_MS);
  }, timeoutSeconds * 1000);

  const exited = proc.exited.then((code) => {
    settled = true;
    return code;
  });

  // Start draining both pipes before waiting for exit so output larger than a
  // pipe buffer cannot deadlock the child. After exit, wait only a bounded
  // grace for pipe EOF (see PIPE_DRAIN_GRACE_MS) — a detached grandchild
  // holding the write end must not stall the reply.
  const stdoutCollector = collectStream(proc.stdout);
  const stderrCollector = collectStream(proc.stderr);
  try {
    const exitCode = await exited;
    const [stdout, stderr] = await Promise.all([
      stdoutCollector.finish(PIPE_DRAIN_GRACE_MS),
      stderrCollector.finish(PIPE_DRAIN_GRACE_MS),
    ]);
    return {
      ok: true,
      stdout,
      stderr,
      exit_code: proc.signalCode === null ? exitCode : null,
      timed_out: timedOut,
    };
  } finally {
    settled = true;
    clearTimeout(timeoutTimer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  }
}
