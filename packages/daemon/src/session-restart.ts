// Restarting a session (DR-0028 「restart」): stop its process as session_kill
// does and, once it is seen gone, resume the same id through the launch
// command (DR-0018 §3.5). Every reason to refuse is checked before the process
// is stopped, so a restart never stops a session it then declines to start.
// The daemon follows the resumed session no further than the launch does.
import {
  ErrorCode,
  LaunchInputSchema,
  RESTART_PROMPT,
  launchEffortFromTranscript,
  launchModelFromTranscript,
  parseWith,
  type LaunchInput,
  type SessionRestartResponse,
} from "@ccmsg/protocol";
import type { SessionLauncherConfig } from "./config.ts";
import { killSession, resolveRecord, verifyPid, type SessionKillDeps } from "./session-kill.ts";
import type { SessionLaunchOutcome } from "./session-launch.ts";

export interface SessionRestartDeps {
  /** `session_launcher` of the config; undefined when there is none. */
  launcher: SessionLauncherConfig | undefined;
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
 * as, starting with `prompt`. A model or effort the launch cannot name is left
 * to the command. */
async function resumeLaunch(
  sessionId: string,
  prompt: string,
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
    prompt,
  });
  if (!read.ok) {
    return { ok: false, code: ErrorCode.invalid_args, msg: read.failure.summary };
  }
  return { ok: true, launch: read.value };
}

/** One restart, DR-0028 「restart」 steps 2–8 (the role, the launcher's
 * shutdown and in-flight bound are the caller's). The resumed session starts
 * with `prompt`, or RESTART_PROMPT when the request names none. */
export async function restartSession(
  sessionId: string,
  prompt: string | undefined,
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
  const record = await resolveRecord(sessionId, deps.kill);
  if (record === null || !(await verifyPid(record.pid, deps.kill))) {
    return refuse(ErrorCode.not_found, `no process for session ${sessionId}`);
  }
  fields.push(`pid=${String(record.pid)}`);
  const resume = await resumeLaunch(sessionId, prompt ?? RESTART_PROMPT, record, deps);
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
