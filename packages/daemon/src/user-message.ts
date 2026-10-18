// user_message (DR-0039 §6): hand what a person wrote for a running subagent
// of a session to the hooks module of a run of the session as an
// `agent.append` request, and wait for the module to say whether the
// subagent's conversation took it.
//
// Which runs are asked and how a missing module reads follow user_prompt
// (user-prompt.ts); the request and its reply go through sidecar-call.ts.
import type { AgentAppendReason, UserMessageReason } from "@ccmsg/protocol";
import { callSidecar, type SidecarDeps } from "./sidecar-call.ts";
import type { SessionRunsView } from "./user-prompt.ts";

/** The longest an user_message takes to answer: the write and one
 * `ccmsg sidecar reply` (about 0.3 s measured, DR-0035 §3), with room for a
 * second run after a first whose subagent was not its. */
export const USER_MESSAGE_DEADLINE_MS = 5_000;

/** UserMessageResponse without the envelope's `ok`. */
export type UserMessageOutcome =
  | { outcome: "appended" }
  | { outcome: "not_delivered"; reason: UserMessageReason }
  | { outcome: "unconfirmed" };

export interface UserMessageDeps extends SidecarDeps {
  deadlineMs: number;
  runs: SessionRunsView;
  /** Whether the daemon still counts `sid` among the running sessions. */
  isRunning(sid: string): boolean;
}

/** What became of one try, for the daemon log. */
export interface UserMessageTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
    | "write_uncertain"
    | "appended"
    | "unconfirmed"
    | `not_delivered:${AgentAppendReason}`;
}

export async function userMessage(
  sid: string,
  agentId: string,
  text: string,
  deps: UserMessageDeps,
): Promise<UserMessageOutcome & { tries: UserMessageTry[] }> {
  const until = deps.now() + deps.deadlineMs;
  const tries: UserMessageTry[] = [];
  let answered: AgentAppendReason | undefined;
  for (const { socket } of deps.runs.liveOf(sid)) {
    const remaining = until - deps.now();
    if (remaining <= 0) return { outcome: "unconfirmed", tries };
    const call = await callSidecar(socket, sid, "agent.append", { agentId, text }, remaining, deps);
    const { id } = call;
    if (call.write === "not_written") {
      tries.push({ id, socket, result: "unwritten" });
      continue;
    }
    // An answer that is not agent.append's (a failure, a module of another
    // ccmsg) says nothing of the subagent's conversation.
    const answer =
      call.reply?.ok === true && call.reply.value.ok ? call.reply.value.result : undefined;
    if (answer === undefined) {
      tries.push({
        id,
        socket,
        result: call.write === "uncertain" ? "write_uncertain" : "unconfirmed",
      });
      return { outcome: "unconfirmed", tries };
    }
    if (answer.outcome === "appended") {
      tries.push({ id, socket, result: "appended" });
      return { outcome: "appended", tries };
    }
    tries.push({ id, socket, result: `not_delivered:${answer.reason}` });
    // A subagent runs in one process of the session: another run may be its.
    // A refusal added nothing, so asking the next cannot add it twice.
    if (answer.reason !== "not_running")
      return { outcome: "not_delivered", reason: answer.reason, tries };
    answered = answer.reason;
  }
  if (answered !== undefined) return { outcome: "not_delivered", reason: answered, tries };
  if (deps.runs.movedOn(sid)) return { outcome: "not_delivered", reason: "session_changed", tries };
  return {
    outcome: "not_delivered",
    reason: deps.isRunning(sid) ? "no_module" : "ended",
    tries,
  };
}
