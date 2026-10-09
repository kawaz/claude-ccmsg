// session_input (DR-0035 §1, §3, §5): hand what a person wrote to the hooks
// module of a run of the session as a `prompt.send` request, and wait for the
// module to say whether the harness took it as the person's prompt.
//
// The daemon neither resolves the session's terminal nor sends Enter: the
// module fills its own composer and presses Enter on its own terminal. The
// request and its reply go through sidecar-call.ts; what this file owns is
// which run is asked, what a reply means for the person, and the deadline.
import type {
  Parsed,
  PromptSendResult,
  SessionInputModuleReason,
  SessionInputReason,
  SidecarErrorCode,
  SidecarReplyOf,
} from "@ccmsg/protocol";
import {
  callSidecar,
  liveSidecars,
  productionSidecarDeps,
  runMovedOn,
  type SidecarDeps,
  type SidecarReplies,
} from "./sidecar-call.ts";

/** The longest a session_input takes to answer, every run it tries included.
 *
 * One try on the module's side is at most a `hyoui input` (3 s), the wait for
 * UserPromptSubmit (3 s) and the reply process (3 s) — 9 s — plus the fill and
 * the write, which take milliseconds. The rest of the 12 s leaves room for a
 * second run after a first that answered at once that it cannot take input
 * (no_composer / no_terminal, which needs no Enter and so comes back within a
 * reply's time). Past it the answer is unconfirmed: a person waiting on a
 * send is told it may or may not have landed rather than kept waiting. */
export const SESSION_INPUT_DEADLINE_MS = 12_000;

/** SessionInputResponse without the envelope's `ok`. */
export type SessionInputOutcome =
  | { outcome: "accepted" }
  | { outcome: "not_delivered"; reason: SessionInputReason }
  | { outcome: "unconfirmed" };

export interface SessionInputDeps extends SidecarDeps {
  deadlineMs: number;
  /** The harness pids `sid` has been seen running under (RunPids). */
  pidsOf(sid: string): readonly number[];
}

/** A `prompt.send` reply as the person's outcome, or `cannot_run` when the
 * module did not run the op at all (another ccmsg version on either side):
 * nothing reached the composer then, so another run may be asked. An op that
 * failed part-way (`internal`) or a result not of prompt.send's shape says
 * nothing about the composer, and is unconfirmed. */
export function readPromptSendReply(
  reply: Parsed<SidecarReplyOf<"prompt.send">>,
): PromptSendResult | { outcome: "cannot_run"; code: SidecarErrorCode } {
  if (!reply.ok) return { outcome: "unconfirmed" };
  const answer = reply.value;
  if (answer.ok) return answer.result;
  return answer.error.code === "internal"
    ? { outcome: "unconfirmed" }
    : { outcome: "cannot_run", code: answer.error.code };
}

/** Reasons that say the run cannot take a person's input at all (or, for
 * `session_changed`, is no longer that session and left the text out), so
 * asking another run of the session cannot put the text in twice. Any other answer —
 * or none — may mean the text is in, or that this run is the one with the
 * composer and simply could not now; trying the next run then risks a second
 * copy, which is what one-at-a-time exists to prevent (DR-0035 §3). */
const TRY_NEXT: ReadonlySet<SessionInputModuleReason> = new Set([
  "no_composer",
  "no_terminal",
  "session_changed",
]);

/** What became of one try, for the daemon log. */
export interface SessionInputTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
    | "write_uncertain"
    | "accepted"
    | "unconfirmed"
    | `not_delivered:${SessionInputModuleReason}`
    | `cannot_run:${SidecarErrorCode}`;
}

export async function sessionInput(
  sid: string,
  text: string,
  deps: SessionInputDeps,
): Promise<SessionInputOutcome & { tries: SessionInputTry[] }> {
  const until = deps.now() + deps.deadlineMs;
  const tries: SessionInputTry[] = [];
  let unable: SessionInputModuleReason | undefined;
  for (const socket of await liveSidecars(sid, deps)) {
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
    if (read.outcome === "cannot_run") {
      tries.push({ id, socket, result: `cannot_run:${read.code}` });
      continue;
    }
    if (read.outcome !== "not_delivered") {
      tries.push({ id, socket, result: read.outcome });
      return { outcome: read.outcome, tries };
    }
    tries.push({ id, socket, result: `not_delivered:${read.reason}` });
    if (!TRY_NEXT.has(read.reason)) return { outcome: "not_delivered", reason: read.reason, tries };
    unable = read.reason;
  }
  if (unable !== undefined) return { outcome: "not_delivered", reason: unable, tries };
  // No module of `sid` took it. When the process `sid` ran in now serves
  // another id, the session changed (/clear, /resume) rather than lacks a
  // module, and the person is told so instead of to update the plugin.
  if (await runMovedOn(sid, deps.pidsOf(sid), deps)) {
    return { outcome: "not_delivered", reason: "session_changed", tries };
  }
  return { outcome: "not_delivered", reason: "no_module", tries };
}

export function productionInputDeps(
  sidecarDir: string,
  replies: SidecarReplies,
  pidsOf: (sid: string) => readonly number[] = () => [],
): SessionInputDeps {
  return {
    ...productionSidecarDeps(sidecarDir, replies),
    deadlineMs: SESSION_INPUT_DEADLINE_MS,
    pidsOf,
  };
}
