// user_prompt (DR-0035 §1, §3, §5): hand what a person wrote to the hooks
// module of a run of the session as a `prompt.send` request, and wait for the
// module to say whether the harness took it as the person's prompt.
//
// The daemon neither resolves the session's terminal nor sends Enter: the
// module fills its own composer and presses Enter on its own terminal. The
// runs come from what their sidecars named (sidecar-runs.ts), and the request
// and its reply go through sidecar-call.ts; what this file owns is which run
// is asked, what a reply means for the person, and the deadline.
import {
  type Parsed,
  type PromptSendResult,
  type UserPromptModuleReason,
  type SessionInputReadiness,
  type UserPromptReason,
  type SidecarReplyOf,
} from "@ccmsg/protocol";
import {
  callSidecar,
  productionSidecarDeps,
  type SidecarDeps,
  type SidecarReplies,
} from "./sidecar-call.ts";
import type { SidecarRuns } from "./sidecar-runs.ts";

/** The longest a user_prompt takes to answer, every run it tries included.
 *
 * One try on the module's side is at most a `hyoui input` (3 s), the wait for
 * the filled text's prompt.submit (3 s) and the reply process (3 s) — 9 s — plus the fill and
 * the write, which take milliseconds. The rest of the 12 s leaves room for a
 * second run after a first that answered at once that it cannot take input
 * (no_composer / no_terminal, which needs no Enter and so comes back within a
 * reply's time). Past it the answer is unconfirmed: a person waiting on a
 * send is told it may or may not have landed rather than kept waiting. */
export const USER_PROMPT_DEADLINE_MS = 12_000;

/** UserPromptResponse without the envelope's `ok`. */
export type UserPromptOutcome =
  | { outcome: "accepted" }
  | { outcome: "not_delivered"; reason: UserPromptReason }
  | { outcome: "unconfirmed" };

/** The runs of each session, as user_prompt and readiness read them. */
export type SessionRunsView = Pick<SidecarRuns, "liveOf" | "movedOn">;

export interface UserPromptDeps extends SidecarDeps {
  deadlineMs: number;
  runs: SessionRunsView;
}

/** A `prompt.send` reply as the person's outcome. An op that failed
 * part-way (`internal`) or a result not of prompt.send's shape says nothing
 * about the composer, and is unconfirmed. */
export function readPromptSendReply(
  reply: Parsed<SidecarReplyOf<"prompt.send">>,
): PromptSendResult {
  if (!reply.ok) return { outcome: "unconfirmed" };
  const answer = reply.value;
  return answer.ok ? answer.result : { outcome: "unconfirmed" };
}

/** Reasons that say the run cannot take a person's input at all (or, for
 * `session_changed`, is no longer that session and left the text out), so
 * asking another run of the session cannot put the text in twice. Any other answer —
 * or none — may mean the text is in, or that this run is the one with the
 * composer and simply could not now; trying the next run then risks a second
 * copy, which is what one-at-a-time exists to prevent (DR-0035 §3). */
const TRY_NEXT: ReadonlySet<UserPromptModuleReason> = new Set([
  "no_composer",
  "no_terminal",
  "session_changed",
]);

/** What became of one try, for the daemon log. */
export interface UserPromptTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
    | "write_uncertain"
    | "accepted"
    | "unconfirmed"
    | `not_delivered:${UserPromptModuleReason}`;
}

export async function userPrompt(
  sid: string,
  text: string,
  deps: UserPromptDeps,
): Promise<UserPromptOutcome & { tries: UserPromptTry[] }> {
  const until = deps.now() + deps.deadlineMs;
  const tries: UserPromptTry[] = [];
  let unable: UserPromptModuleReason | undefined;
  for (const { socket } of deps.runs.liveOf(sid)) {
    const remaining = until - deps.now();
    if (remaining <= 0) return { outcome: "unconfirmed", tries };
    const call = await callSidecar(socket, sid, "prompt.send", { text }, remaining, deps);
    const { id } = call;
    // Only a line the sidecar has none of may go to the next run. One that
    // went in part-way (`uncertain`) and got no reply may still have reached
    // the module, and the next run would put the text in a second time.
    if (call.write === "not_written") {
      tries.push({ id, socket, result: "unwritten" });
      continue;
    }
    if (call.reply === undefined) {
      tries.push({
        id,
        socket,
        result: call.write === "uncertain" ? "write_uncertain" : "unconfirmed",
      });
      return { outcome: "unconfirmed", tries };
    }
    const read = readPromptSendReply(call.reply);
    if (read.outcome !== "not_delivered") {
      tries.push({ id, socket, result: read.outcome });
      return { outcome: read.outcome, tries };
    }
    tries.push({ id, socket, result: `not_delivered:${read.reason}` });
    if (!TRY_NEXT.has(read.reason)) return { outcome: "not_delivered", reason: read.reason, tries };
    unable = read.reason;
  }
  if (unable !== undefined) return { outcome: "not_delivered", reason: unable, tries };
  return { outcome: "not_delivered", reason: withoutModule(sid, deps.runs), tries };
}

/** Why no module of `sid` can take the input when none of its runs has one.
 * When the run `sid` was now serves another id, the session changed (/clear,
 * /resume) rather than lacks a module, and the person is told so instead of
 * to update the plugin. */
function withoutModule(sid: string, runs: SessionRunsView): "session_changed" | "no_module" {
  return runs.movedOn(sid) ? "session_changed" : "no_module";
}

export interface InputReadinessDeps {
  runs: SessionRunsView;
  /** Whether the daemon still counts `sid` among the running sessions. */
  isRunning(sid: string): boolean;
}

/** Whether a person's input can reach `sid` now (SessionInputReadiness), from
 * what userPrompt depends on: the live runs, and for each the terminal its
 * module would press Enter on, as its sidecar named it (the module reads the
 * same HYOUI_SESSION_ID through `$.env.get` and answers `no_terminal`
 * without one). Ready when one run has a terminal, as userPrompt moves past
 * runs that answer `no_terminal` to the next. */
export function inputReadiness(sid: string, deps: InputReadinessDeps): SessionInputReadiness {
  const runs = deps.runs.liveOf(sid);
  if (runs.length > 0) {
    return runs.some((run) => run.hyouiSessionId !== undefined)
      ? { kind: "ready" }
      : { kind: "no_terminal" };
  }
  if (withoutModule(sid, deps.runs) === "session_changed") return { kind: "session_changed" };
  return deps.isRunning(sid) ? { kind: "no_module" } : { kind: "ended" };
}

export function productionInputDeps(
  replies: SidecarReplies,
  runs: SessionRunsView,
): UserPromptDeps {
  return {
    ...productionSidecarDeps(replies),
    deadlineMs: USER_PROMPT_DEADLINE_MS,
    runs,
  };
}
