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
  LAUNCH_KILL_GRACE_MS,
  LAUNCH_PIPE_DRAIN_GRACE_MS,
  LAUNCH_REQUESTED_BY_ENV,
  launchErrorText,
  launchMakesSession,
  type LaunchCommandInput,
  type LaunchInput,
  type SessionLaunchResponse,
} from "@ccmsg/protocol";
import type { SessionLauncherConfig } from "./config.ts";
import {
  type CapturedOutput,
  LAUNCH_OUTPUT_CAPTURE_LIMIT,
  launchOutputTexts,
} from "./launch-output.ts";
import type { LaunchSettingsOutcome } from "./project-auto-mode.ts";
import { withoutEnvPatterns } from "./env-patterns.ts";
import { userTempDir, withTmpdir } from "./user-temp-dir.ts";

/** Collect a pipe from the moment the child starts, so a full pipe never
 * stops it. The first LAUNCH_OUTPUT_CAPTURE_LIMIT bytes are kept and the rest
 * only counted. `finish` waits for EOF up to `graceMs`, then stops reading and
 * returns what arrived. */
function collectStream(stream: ReadableStream<Uint8Array>): {
  finish: (graceMs: number) => Promise<CapturedOutput>;
} {
  const chunks: Uint8Array[] = [];
  let kept = 0;
  let total = 0;
  const reader = stream.getReader();
  // A read that fails ends the collection with what arrived; the catch is
  // here, where the promise is made, so the failure is never unhandled.
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      const room = LAUNCH_OUTPUT_CAPTURE_LIMIT - kept;
      if (room > 0) {
        const part = value.byteLength <= room ? value : value.subarray(0, room);
        chunks.push(part);
        kept += part.byteLength;
      }
    }
  })().catch(() => {});
  return {
    finish: async (graceMs: number): Promise<CapturedOutput> => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        drained,
        new Promise((resolve) => {
          timer = setTimeout(resolve, graceMs);
        }),
      ]);
      clearTimeout(timer);
      await reader.cancel().catch(() => {});
      await drained;
      return { bytes: Buffer.concat(chunks), total };
    },
  };
}

/** How a run of the launch command ended. */
export interface LaunchCommandRun {
  /** The exit code, or `128 + <signal number>` for a signal. */
  exitCode: number;
  /** Whether the deadline stopped it (SIGTERM, and SIGKILL if it outlived the
   * grace). An exit code of 143 alone cannot say: the command may exit 143
   * itself. */
  timedOut: boolean;
  stdout: CapturedOutput;
  stderr: CapturedOutput;
}

export interface LaunchCommandSpawn {
  argv: readonly string[];
  cwd: string;
  env: Record<string, string>;
  stdin: string;
  /** Once aborted, SIGTERM to the command's process group, SIGKILL to it
   * LAUNCH_KILL_GRACE_MS later, and LAUNCH_KILL_GRACE_MS more to see the
   * command exit. The daemon's is `AbortSignal.timeout` of launch_timeout_seconds. */
  deadline: AbortSignal;
}

/** Send `signal` to the command's process group: the command and what it
 * started without leaving the group, which the command does not outlive
 * holding the pipes. A group that is already gone is nothing to stop. */
function signalGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch {
    // ESRCH: every member has exited.
  }
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
    // Its own process group (setsid), so the deadline stops what it started
    // along with it.
    detached: true,
  });
  const stdout = collectStream(proc.stdout);
  const stderr = collectStream(proc.stderr);
  let timedOut = false;
  const timers: ReturnType<typeof setTimeout>[] = [];
  /** Settles LAUNCH_KILL_GRACE_MS after SIGKILL: the command did not exit
   * even then, and is answered as killed. */
  let gaveUp: (() => void) | undefined;
  const givenUp = new Promise<"gave-up">((resolve) => {
    gaveUp = () => resolve("gave-up");
  });
  const terminate = (): void => {
    timedOut = true;
    signalGroup(proc.pid, "SIGTERM");
    timers.push(
      setTimeout(() => {
        signalGroup(proc.pid, "SIGKILL");
        timers.push(setTimeout(() => gaveUp?.(), LAUNCH_KILL_GRACE_MS));
      }, LAUNCH_KILL_GRACE_MS),
    );
  };
  if (spawn.deadline.aborted) terminate();
  else spawn.deadline.addEventListener("abort", terminate, { once: true });
  try {
    const ended = await Promise.race([proc.exited, givenUp]);
    spawn.deadline.removeEventListener("abort", terminate);
    for (const timer of timers) clearTimeout(timer);
    // Stopped by the deadline: what the command started in its group goes
    // with it, even a process that outlived the SIGTERM.
    if (timedOut) signalGroup(proc.pid, "SIGKILL");
    const [out, err] = await Promise.all([
      stdout.finish(LAUNCH_PIPE_DRAIN_GRACE_MS),
      stderr.finish(LAUNCH_PIPE_DRAIN_GRACE_MS),
    ]);
    const signal = proc.signalCode;
    const exitCode =
      ended === "gave-up"
        ? 128 + os.constants.signals.SIGKILL
        : signal === null
          ? ended
          : 128 + os.constants.signals[signal];
    return { exitCode, timedOut, stdout: out, stderr: err };
  } finally {
    spawn.deadline.removeEventListener("abort", terminate);
    for (const timer of timers) clearTimeout(timer);
  }
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

export interface SessionLaunchDeps {
  /** `session_launcher` of the config; undefined when there is none. */
  launcher: SessionLauncherConfig | undefined;
  /** Who asked: `user`, or the asking session's sid. The log line names it,
   * and the launch command reads it in LAUNCH_REQUESTED_BY_ENV. */
  requester: string;
  /** The daemon's environment, which the launch command inherits cleaned. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** `<state dir>/launches`. */
  launchesDir: string;
  /** The settings file of the project of `cwd` (a realpath) to hand the
   * launch command (DR-0063 §4, project-auto-mode.ts' prepareLaunchSettings). */
  launchSettings(cwd: string): Promise<LaunchSettingsOutcome>;
  log: { info(msg: string): void; warn(msg: string): void };
}

export type SessionLaunchOutcome =
  | { ok: true; response: SessionLaunchResponse }
  | { ok: false; code: ErrorCode; msg: string };

/** The log line's fields for a launch: what it asked for, never the prompt's
 * text (its length only). Text that comes from the asker (`cwd`) is written
 * as a JSON string, so it cannot pose as another field of the line. */
function logFieldsOf(
  requester: string,
  input: LaunchCommandInput,
  autoModeEntries: number,
): string {
  return [
    `by=${requester}`,
    `cwd=${JSON.stringify(input.cwd)}`,
    ...(input.continue === true ? ["continue=true"] : []),
    ...(input.resume !== undefined ? [`resume=${input.resume}`] : []),
    ...(input.fork_session === true ? ["fork_session=true"] : []),
    ...(input.session_id !== undefined ? [`session_id=${input.session_id}`] : []),
    ...(input.prompt !== undefined ? [`prompt_bytes=${Buffer.byteLength(input.prompt)}`] : []),
    `auto_mode_entries=${String(autoModeEntries)}`,
  ].join(" ");
}

/** One launch, DR-0018 §3.5 steps 1 and 3–10 (step 2, reading the launch, is
 * the request schema's; the in-flight bound is the caller's). `prepared` is
 * the settings file a caller made beforehand (a restart makes it before it
 * stops the session, DR-0063 §5); without it the launch makes its own. */
export async function launchSession(
  deps: SessionLaunchDeps,
  launch: LaunchInput,
  prepared?: LaunchSettingsOutcome,
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

  const made = prepared ?? (await deps.launchSettings(cwd));
  if (!made.ok) {
    log.warn(
      `session_launch: by=${deps.requester} cwd=${JSON.stringify(cwd)} ${ErrorCode.project_auto_mode_unreadable}: ${JSON.stringify(made.msg)}`,
    );
    return { ok: false, code: ErrorCode.project_auto_mode_unreadable, msg: made.msg };
  }

  const sessionId = launchMakesSession(launch) ? crypto.randomUUID() : undefined;
  const input: LaunchCommandInput = {
    ...launch,
    cwd,
    ...(sessionId !== undefined ? { session_id: sessionId } : {}),
    ...(made.settings !== undefined ? { settings: made.settings.path } : {}),
  };
  const logFields = logFieldsOf(deps.requester, input, made.settings?.entries ?? 0);

  // launch_command[0] is an absolute path, fixed when the config was read.
  const [program] = launcher.launch_command;
  let run: LaunchCommandRun;
  try {
    run = await runLaunchCommand({
      argv: launcher.launch_command,
      cwd,
      // Who asked and the TMPDIR go over the cleaned environment, so no
      // clean_env / keep_env pattern removes or keeps them. The daemon's
      // TMPDIR is the temp place of whoever started it (a session's own, when
      // a session's shell spawned it), nothing of the session about to start.
      env: {
        ...withTmpdir(
          withoutEnvPatterns(deps.baseEnv, launcher.clean_env, launcher.keep_env),
          userTempDir(),
        ),
        [LAUNCH_REQUESTED_BY_ENV]: deps.requester,
      },
      stdin: JSON.stringify(input),
      deadline: AbortSignal.timeout(launcher.launch_timeout_seconds * 1000),
    });
  } catch (e) {
    const msg = `the launch command could not be started: ${program} in ${cwd}: ${errorText(e)}`;
    log.warn(
      `session_launch: ${logFields} ${ErrorCode.launch_command_unavailable}: ${JSON.stringify(msg)}`,
    );
    return { ok: false, code: ErrorCode.launch_command_unavailable, msg };
  }

  const texts = await launchOutputTexts(deps.launchesDir, run, new Date(), log);
  log.info(
    `session_launch: ${logFields} exit_code=${String(run.exitCode)}` +
      (run.timedOut ? " timed_out=true" : "") +
      ` stdout_bytes=${String(run.stdout.total)} stderr_bytes=${String(run.stderr.total)}`,
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

/** What a launch that ended after the `launch` tool's reply came to, as the
 * notice put into the asking conversation (DR-0018 §3.7): the same words the
 * tool answers with when the launch ends in time (the reply's fields as
 * JSON, or launchErrorText), after which launch they are. */
export function launchOutcomeNotice(cwd: string, outcome: SessionLaunchOutcome): string {
  const head = `ccmsg の launch (cwd: ${cwd}) が終わった`;
  if (outcome.ok) {
    const { ok: _ok, ...result } = outcome.response;
    return `${head}: ${JSON.stringify(result)}`;
  }
  const failed = launchErrorText(outcome);
  return `${head}: ${failed.text}${failed.started === "no" ? "" : "。`peers` で確かめる"}`;
}
