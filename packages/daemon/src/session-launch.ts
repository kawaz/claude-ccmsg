// Starting a session through the configured launch command (DR-0018 §3.5).
// The daemon checks the launch, chooses the new session's id, hands the launch
// command the launch as JSON on standard input, waits for it to end, and
// answers with what it did. How claude is started is the command's
// (docs/design/launch-command.md); the daemon does not read its exit code.
import * as crypto from "node:crypto";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import {
  ErrorCode,
  errorText,
  type LaunchCommandInput,
  type LaunchInput,
  type SessionLaunchResponse,
} from "@ccmsg/protocol";
import type { SessionLauncherConfig } from "./config.ts";
import { launchOutputTexts } from "./launch-output.ts";

/** After the timeout's SIGTERM, how long the command has before SIGKILL. */
export const FORCE_KILL_GRACE_MS = 500;

/** After the command exits, how long to wait for its stdout / stderr to reach
 * EOF. A grandchild the command detached can hold the pipes' write ends, and
 * then EOF does not come while it lives; the reply carries what arrived by
 * then. On an ordinary exit EOF comes first and this adds nothing. */
export const PIPE_DRAIN_GRACE_MS = 500;

/** Collect a pipe from the moment the child starts, so a full pipe never
 * stops it. `finish` waits for EOF up to `graceMs`, then stops reading and
 * returns the bytes that arrived. */
function collectStream(stream: ReadableStream<Uint8Array>): {
  finish: (graceMs: number) => Promise<Uint8Array>;
} {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
    }
  })();
  return {
    finish: async (graceMs: number): Promise<Uint8Array> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        drained.catch(() => {}),
        new Promise((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
      await drained.catch(() => {});
      return Buffer.concat(chunks);
    },
  };
}

/** Compile one clean_env / keep_env pattern into an anchored RegExp: every
 * regex metacharacter is escaped first so only `*` carries meaning (any
 * substring of the key name), then anchored so a pattern without `*` is an
 * exact, case-sensitive key match. The `\*` → `.*` rewrite cannot collide
 * with an escaped literal backslash: escaping maps a source `\` to `\\` and a
 * source `*` to `\*`, so every `\*` digram in the escaped text (scanning
 * left-to-right in non-overlapping steps, exactly how replaceAll matches)
 * comes from a source `*`. */
function envPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`);
}

/** The launch command's environment: `baseEnv` without the keys a clean_env
 * pattern matches, except those a keep_env pattern also matches (keep wins:
 * a broad `CLAUDE*` must not remove CLAUDE_CONFIG_DIR). Nothing is added. */
export function buildLaunchEnv(
  baseEnv: Readonly<Record<string, string | undefined>>,
  cleanEnv: readonly string[],
  keepEnv: readonly string[],
): Record<string, string> {
  const cleanRes = cleanEnv.map(envPatternToRegExp);
  const keepRes = keepEnv.map(envPatternToRegExp);
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (value === undefined) continue;
    if (!keepRes.some((re) => re.test(key)) && cleanRes.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return env;
}

/** How a run of the launch command ended. */
export interface LaunchCommandRun {
  /** The exit code, or `128 + <signal number>` for a signal. */
  exitCode: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface LaunchCommandSpawn {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  /** Once aborted, SIGTERM, and SIGKILL FORCE_KILL_GRACE_MS later if the
   * command is still alive. The daemon's is `AbortSignal.timeout` of
   * timeout_seconds. */
  deadline: AbortSignal;
}

/** Run the launch command once and wait for it to end. Throws only when the
 * command could not be started (spawn's ENOENT / EACCES …). No pid is kept
 * after it returns. */
export async function runLaunchCommand(spawn: LaunchCommandSpawn): Promise<LaunchCommandRun> {
  const proc = Bun.spawn([...spawn.argv], {
    cwd: spawn.cwd,
    env: spawn.env,
    // Bun writes the whole text and closes the pipe; a command that exits
    // without reading it does not fail the launch.
    stdin: new Blob([spawn.stdin]),
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout = collectStream(proc.stdout);
  const stderr = collectStream(proc.stderr);
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const terminate = (): void => {
    proc.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (proc.exitCode === null && proc.signalCode === null) proc.kill("SIGKILL");
    }, FORCE_KILL_GRACE_MS);
  };
  if (spawn.deadline.aborted) terminate();
  else spawn.deadline.addEventListener("abort", terminate, { once: true });
  try {
    const code = await proc.exited;
    spawn.deadline.removeEventListener("abort", terminate);
    clearTimeout(forceKillTimer);
    const [out, err] = await Promise.all([
      stdout.finish(PIPE_DRAIN_GRACE_MS),
      stderr.finish(PIPE_DRAIN_GRACE_MS),
    ]);
    const signal = proc.signalCode;
    return {
      exitCode: signal === null ? code : 128 + os.constants.signals[signal],
      stdout: out,
      stderr: err,
    };
  } finally {
    spawn.deadline.removeEventListener("abort", terminate);
    clearTimeout(forceKillTimer);
  }
}

/** The program `argv[0]` names, as spawn is given it: a path as written, a
 * bare name looked up in the daemon's PATH. Undefined when the name is not
 * found there. */
function resolveProgram(program: string, daemonPath: string | undefined): string | undefined {
  if (program.includes("/")) return program;
  return Bun.which(program, { PATH: daemonPath ?? "" }) ?? undefined;
}

/** `dir` resolved to its realpath, or undefined when it is not an existing
 * directory. */
async function realDirectory(dir: string): Promise<string | undefined> {
  try {
    const real = await fs.realpath(dir);
    return (await fs.stat(real)).isDirectory() ? real : undefined;
  } catch {
    return undefined;
  }
}

/** The launch as the launch command reads it: `cwd` the realpath, and on
 * `new` / `fork` the new session's id. */
function commandInputOf(
  launch: LaunchInput,
  cwd: string,
): { input: LaunchCommandInput; sessionId?: string } {
  switch (launch.type) {
    case "new":
    case "fork": {
      const sessionId = crypto.randomUUID();
      return { input: { ...launch, cwd, session_id: sessionId }, sessionId };
    }
    case "continue":
    case "resume":
      return { input: { ...launch, cwd } };
  }
}

export interface SessionLaunchDeps {
  /** `session_launcher` of the config; undefined when there is none. */
  launcher: SessionLauncherConfig | undefined;
  /** Who asked, for the log line: `user`, or the asking session's sid. */
  requester: string;
  /** The daemon's environment, which the launch command inherits cleaned. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** `<state dir>/launches`. */
  launchesDir: string;
  log: { info(msg: string): void; warn(msg: string): void };
}

export type SessionLaunchOutcome =
  | { ok: true; response: SessionLaunchResponse }
  | { ok: false; code: ErrorCode; msg: string };

/** One launch, DR-0018 §3.5 steps 1 and 3–10 (step 2, reading the launch, is
 * the request schema's). */
export async function launchSession(
  deps: SessionLaunchDeps,
  launch: LaunchInput,
): Promise<SessionLaunchOutcome> {
  const { launcher, log } = deps;
  if (launcher === undefined) {
    return {
      ok: false,
      code: ErrorCode.launcher_not_configured,
      msg: "session launcher is not configured",
    };
  }

  const cwd = await realDirectory(launch.cwd);
  if (cwd === undefined) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: `launch.cwd is not an existing directory: ${launch.cwd}`,
    };
  }

  const { input, sessionId } = commandInputOf(launch, cwd);
  const logFields = [
    `by=${deps.requester}`,
    `type=${launch.type}`,
    `cwd=${cwd}`,
    ...("resume_session_id" in launch ? [`resume_session_id=${launch.resume_session_id}`] : []),
    ...(sessionId !== undefined ? [`session_id=${sessionId}`] : []),
    ...(launch.prompt !== undefined ? [`prompt_bytes=${Buffer.byteLength(launch.prompt)}`] : []),
  ].join(" ");

  const unavailable = (why: string): SessionLaunchOutcome => {
    const msg = `the launch command could not be started: ${why}`;
    log.warn(`session_launch: ${logFields} ${ErrorCode.launch_command_unavailable}: ${msg}`);
    return { ok: false, code: ErrorCode.launch_command_unavailable, msg };
  };
  const [program, ...args] = launcher.launch_command;
  const resolved = resolveProgram(program, deps.baseEnv.PATH);
  if (resolved === undefined) return unavailable(`${program} is not found in PATH`);
  let run: LaunchCommandRun;
  try {
    run = await runLaunchCommand({
      argv: [resolved, ...args],
      cwd,
      env: buildLaunchEnv(deps.baseEnv, launcher.clean_env, launcher.keep_env),
      stdin: JSON.stringify(input),
      deadline: AbortSignal.timeout(launcher.timeout_seconds * 1000),
    });
  } catch (e) {
    return unavailable(errorText(e));
  }

  const texts = await launchOutputTexts(deps.launchesDir, run, new Date(), log);
  log.info(
    `session_launch: ${logFields} exit_code=${String(run.exitCode)}` +
      ` stdout_bytes=${String(run.stdout.byteLength)} stderr_bytes=${String(run.stderr.byteLength)}`,
  );
  return {
    ok: true,
    response: {
      ok: true,
      ...(sessionId !== undefined && run.exitCode === 0 ? { session_id: sessionId } : {}),
      exit_code: run.exitCode,
      stdout: texts.stdout,
      stderr: texts.stderr,
    },
  };
}
