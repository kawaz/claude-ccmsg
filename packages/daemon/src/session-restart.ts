// Restarting a session (DR-0028 「restart」): stop its process as session_kill
// does and, once it is seen gone, resume the same id through the launch
// command (DR-0018 §3.5). Every reason to refuse is checked before the process
// is stopped, so a restart never stops a session it then declines to start.
// The daemon follows the resumed session no further than the launch does.
import {
  ErrorCode,
  LaunchInputSchema,
  launchEffortFromTranscript,
  launchModelFromTranscript,
  parseWith,
  type LaunchInput,
  type SessionRestartResponse,
} from "@ccmsg/protocol";
import type { SessionLauncherConfig } from "./config.ts";
import { normalizeConfigDir } from "./config-dir.ts";
import { claudeConfigDir } from "./default-effort.ts";
import { killSession, resolveRecord, verifyPid, type SessionKillDeps } from "./session-kill.ts";
import { buildLaunchEnv, type SessionLaunchOutcome } from "./session-launch.ts";

/** The prompt the resumed session starts with: a fixed text (DR-0028
 * 「restart」). Whether the session had cron / schedule jobs is not looked
 * at; the line asks the session to put back whatever it had. */
export const RESTART_PROMPT =
  "プロセス再起動 (resume) しました。バックグラウンドプロセスとチームメートは停止され再利用不可。サブエージェントは作業中は中断されたかもだが再開指示などアクセスは可能。cron/schedule があるなら貼り直してください。";

/** The config dir the launch command starts claude in, as a realpath: that of
 * the environment it inherits (`baseEnv` cleaned by clean_env / keep_env,
 * DR-0018 §3.5). A launch command of one's own may switch it; the daemon
 * cannot see that, and goes by this. */
export function launchConfigDir(
  launcher: SessionLauncherConfig,
  baseEnv: Readonly<Record<string, string | undefined>>,
): string | undefined {
  return normalizeConfigDir(
    claudeConfigDir(buildLaunchEnv(baseEnv, launcher.clean_env, launcher.keep_env)),
  );
}

export interface SessionRestartDeps {
  /** `session_launcher` of the config; undefined when there is none. */
  launcher: SessionLauncherConfig | undefined;
  /** The daemon's environment, which the launch command inherits cleaned. */
  baseEnv: Readonly<Record<string, string | undefined>>;
  /** The config dir the session runs under, as the registry has it. */
  sessionConfigDir: string | undefined;
  /** Where the session's process is looked up and how it is stopped. */
  kill: SessionKillDeps;
  /** What the session runs as, in the transcript's spellings: the hooks
   * module's model / effort over those of the transcript's newest
   * main-context assistant row, as the Status tab's CTX shows them. */
  runsAs(): Promise<{ model?: string; effort?: string }>;
  /** Once the process is seen gone, before the launch. */
  stopped(): void;
  /** Run the launch command (DR-0018 §3.5 steps 4–11). */
  launch(launch: LaunchInput): Promise<SessionLaunchOutcome>;
  log: { info(msg: string): void };
}

export type SessionRestartOutcome =
  | { ok: true; response: SessionRestartResponse }
  | { ok: false; code: ErrorCode; msg: string };

/** The launch that resumes `sessionId` where its process ran, as what it runs
 * as. A model or effort the launch cannot name is left to the command. */
async function resumeLaunch(
  sessionId: string,
  record: { cwd?: string; name?: string },
  deps: SessionRestartDeps,
): Promise<{ ok: true; launch: LaunchInput } | { ok: false; code: ErrorCode; msg: string }> {
  if (record.cwd === undefined) {
    return {
      ok: false,
      code: ErrorCode.restart_unavailable,
      msg: `the process of session ${sessionId} records no cwd to resume it in`,
    };
  }
  const runsAs = await deps.runsAs();
  const model = runsAs.model === undefined ? undefined : launchModelFromTranscript(runsAs.model);
  const effort =
    runsAs.effort === undefined ? undefined : launchEffortFromTranscript(runsAs.effort);
  const read = parseWith(LaunchInputSchema, {
    cwd: record.cwd,
    resume: sessionId,
    ...(model !== undefined ? { model } : {}),
    ...(effort !== undefined ? { effort } : {}),
    ...(record.name !== undefined && record.name !== "" ? { name: record.name } : {}),
    prompt: RESTART_PROMPT,
  });
  if (!read.ok) {
    return { ok: false, code: ErrorCode.invalid_args, msg: read.failure.summary };
  }
  return { ok: true, launch: read.value };
}

/** One restart, DR-0028 「restart」 steps 2–8 (the role, the launcher's
 * shutdown and in-flight bound are the caller's). */
export async function restartSession(
  sessionId: string,
  deps: SessionRestartDeps,
): Promise<SessionRestartOutcome> {
  const fields: string[] = [`session_id=${sessionId}`];
  const refuse = (code: ErrorCode, msg: string): SessionRestartOutcome => {
    deps.log.info(`session_restart: ${fields.join(" ")} error=${code}`);
    return { ok: false, code, msg };
  };

  const { launcher } = deps;
  if (launcher === undefined) {
    return refuse(ErrorCode.launcher_not_configured, "session launcher is not configured");
  }
  const launchDir = launchConfigDir(launcher, deps.baseEnv);
  if (deps.sessionConfigDir === undefined || deps.sessionConfigDir !== launchDir) {
    return refuse(
      ErrorCode.restart_unavailable,
      `session ${sessionId} runs in ${deps.sessionConfigDir ?? "an unknown config dir"}, ` +
        `and the launch command starts claude in ${launchDir ?? "an unknown config dir"}`,
    );
  }
  const record = await resolveRecord(sessionId, deps.kill);
  if (record === null || !(await verifyPid(record.pid, deps.kill))) {
    return refuse(ErrorCode.not_found, `no process for session ${sessionId}`);
  }
  fields.push(`pid=${String(record.pid)}`);
  const resume = await resumeLaunch(sessionId, record, deps);
  if (!resume.ok) return refuse(resume.code, resume.msg);

  const { terminated } = await killSession(record.pid, deps.kill);
  fields.push(`terminated=${String(terminated)}`);
  if (!terminated) {
    return refuse(
      ErrorCode.restart_timeout,
      `the process of session ${sessionId} (pid ${String(record.pid)}) was not seen gone ` +
        "after the signals; it was not resumed",
    );
  }
  deps.stopped();

  const launched = await deps.launch(resume.launch);
  if (!launched.ok) return refuse(launched.code, launched.msg);
  deps.log.info(
    `session_restart: ${fields.join(" ")} exit_code=${String(launched.response.exit_code)}`,
  );
  const { session_id: _new, ...run } = launched.response;
  return { ok: true, response: { ...run, restarted: true, session_id: sessionId } };
}
