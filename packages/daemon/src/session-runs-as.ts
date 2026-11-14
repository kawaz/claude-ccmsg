// What a resumed session is started with (DR-0018 §3.2, DR-0028 「restart」):
// a resume goes on on the model and effort the session runs as now, since
// claude resumes without `--model` on the settings' model, dropping the
// thinking and writing the cache anew (findings
// 2026-11-15-resume-model-without-flag). What a session runs as is
// `launchRunsAs` over what the daemon knows of it: the hooks module's facts
// (the session override's values, the session's own) and the transcript's
// tail.
import { errorText, launchRunsAs, type LaunchRunsAs, type SessionFacts } from "@ccmsg/protocol";
import { readSessionLaunchContext, type SessionLaunchContext } from "./session-search.ts";

/** What a session runs as now (`launchRunsAs`): the module's `facts` the
 * daemon holds for it, over the newest main-context assistant row of its
 * `transcript`. Neither (a session the daemon has no facts of and whose
 * transcript it cannot find or read) names nothing. */
export async function sessionRunsAs(
  facts: SessionFacts | undefined,
  transcript: string | undefined,
  log: { warn(msg: string): void },
): Promise<LaunchRunsAs> {
  let answered: SessionLaunchContext = {};
  if (transcript !== undefined) {
    try {
      answered = await readSessionLaunchContext(transcript);
    } catch (e) {
      log.warn(`runs-as: the tail of ${transcript} was not read: ${errorText(e)}`);
    }
  }
  return launchRunsAs({ session: facts?.request_override?.session, own: facts, answered });
}

/** A field of a resume's model and effort. */
export type RunsAsField = "model" | "effort";

/** The model and effort a resume of a session that runs as `runsAs` is
 * started with, when it was asked for `ask` (`carried`): each field the ask
 * names as it is, and each it leaves out as the session runs it. An effort is
 * carried only onto the model it ran with: an ask that names another model
 * leaves the effort it does not name to the launch command, which chooses
 * that model's (DR-0018 §3.9: a model chosen anew takes its own effort).
 * `unread` are the fields left to the launch command because what the
 * session runs as names none of them (for the log), the effort left for a
 * model chosen anew aside. */
export function carriedRunsAs(
  ask: LaunchRunsAs,
  runsAs: LaunchRunsAs,
): { carried: LaunchRunsAs; unread: RunsAsField[] } {
  const model = ask.model ?? runsAs.model;
  const sameModel = ask.model === undefined || ask.model === runsAs.model;
  const effort = ask.effort ?? (sameModel ? runsAs.effort : undefined);
  return {
    carried: {
      ...(model !== undefined ? { model } : {}),
      ...(effort !== undefined ? { effort } : {}),
    },
    unread: [
      ...(model === undefined ? (["model"] as const) : []),
      ...(effort === undefined && sameModel ? (["effort"] as const) : []),
    ],
  };
}
