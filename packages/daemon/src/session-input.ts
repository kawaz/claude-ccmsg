// session_input (DR-0035 §1, §3, §5): hand what a person wrote to the hooks
// module of a run of the session as a `prompt.send` request, and wait for the
// module to say whether the harness took it as the person's prompt.
//
// The daemon neither resolves the session's terminal nor sends Enter: the
// module fills its own composer and presses Enter on its own terminal. The
// request and its reply go through sidecar-call.ts; what this file owns is
// which run is asked, what a reply means for the person, and the deadline.
import {
  type PromptSendResult,
  SESSION_INPUT_MODULE_REASONS,
  type SessionInputModuleReason,
  type SessionInputReason,
  type SidecarErrorCode,
  type SidecarReply,
} from "@ccmsg/protocol";
import {
  callSidecar,
  liveSidecars,
  productionSidecarDeps,
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
}

/** A `prompt.send` reply as the person's outcome, or `cannot_run` when the
 * module did not run the op at all (another ccmsg version on either side):
 * nothing reached the composer then, so another run may be asked. An op that
 * failed part-way (`internal`) or a result of no known shape says nothing
 * about the composer, and is unconfirmed. */
export function readPromptSendReply(
  reply: SidecarReply,
): PromptSendResult | { outcome: "cannot_run"; code: SidecarErrorCode } {
  if (!reply.ok) {
    return reply.error.code === "internal"
      ? { outcome: "unconfirmed" }
      : { outcome: "cannot_run", code: reply.error.code };
  }
  const result = reply.result as Record<string, unknown> | null;
  if (typeof result !== "object" || result === null) return { outcome: "unconfirmed" };
  if (result.outcome === "accepted") return { outcome: "accepted" };
  if (
    result.outcome === "not_delivered" &&
    (SESSION_INPUT_MODULE_REASONS as readonly unknown[]).includes(result.reason)
  ) {
    return { outcome: "not_delivered", reason: result.reason as SessionInputModuleReason };
  }
  return { outcome: "unconfirmed" };
}

/** Reasons that say the run cannot take a person's input at all, so asking
 * another run of the session cannot put the text in twice. Any other answer —
 * or none — may mean the text is in, or that this run is the one with the
 * composer and simply could not now; trying the next run then risks a second
 * copy, which is what one-at-a-time exists to prevent (DR-0035 §3). */
const TRY_NEXT: ReadonlySet<SessionInputModuleReason> = new Set(["no_composer", "no_terminal"]);

/** What became of one try, for the daemon log. */
export interface SessionInputTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
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
    if (!call.written) {
      tries.push({ id, socket, result: "unwritten" });
      continue;
    }
    if (call.reply === undefined) {
      tries.push({ id, socket, result: "unconfirmed" });
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
  return { outcome: "not_delivered", reason: unable ?? "no_module", tries };
}

export function productionInputDeps(sidecarDir: string, replies: SidecarReplies): SessionInputDeps {
  return {
    ...productionSidecarDeps(sidecarDir, replies),
    deadlineMs: SESSION_INPUT_DEADLINE_MS,
  };
}
