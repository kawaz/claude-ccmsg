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
  | { ok: true; env: Record<string, string>; shellArgv: string[] }
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

/** Execute one validated launch and wait only for this child result. No pid is
 * retained after return and no restart/progress lifecycle is introduced. */
export async function executeSessionLaunch(
  launch: ValidatedSessionLaunch,
  timeoutSeconds: number,
): Promise<SessionLaunchResponse> {
  const proc = Bun.spawn(launch.shellArgv, {
    cwd: launch.env.CWD,
    env: { ...process.env, ...launch.env },
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
