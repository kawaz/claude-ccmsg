// send_message with an agent id (DR-0039 §3): hand what a session sent with
// `send` for a subagent or teammate of another session (or its own) to the
// hooks module of a run of that session as an `agent.send` request, and wait
// for the module to say whether Claude Code delivered it to the agent.
//
// Which runs are asked and how a missing module reads follow user_message
// (user-message.ts); the request and its reply go through sidecar-call.ts. A
// module of a ccmsg from before agent.send drops the line unanswered, so the
// send to it comes back unconfirmed at the deadline, as session.rename does
// (DR-0047 §3); the session's ccmsg shows in yellow, and restarting it is the
// way out. The wake after an agy response (DR-0066 §7) asks the same runs the
// same way, as an `agent.wake` request.
import type { AgentSendReason, SendMessageReason } from "@ccmsg/protocol";
import { callSidecar, type SidecarCall, type SidecarDeps } from "./sidecar-call.ts";
import type { SessionRunsView } from "./user-prompt.ts";

/** The longest an agent send takes to answer: the write and the module's
 * reply over `POST /op` (Claude Code queues the message in tens of ms), with
 * room for a second run after a first that has no such agent. */
export const AGENT_SEND_DEADLINE_MS = 5_000;

/** Why an agent send did not reach the agent: the module's AgentSendReason,
 * or as for user_message `no_module`, `session_changed` and `ended`. */
export type AgentSendFailure = Extract<
  SendMessageReason,
  AgentSendReason | "no_module" | "session_changed" | "ended"
>;

export type AgentSendOutcome =
  | { outcome: "delivered" }
  | { outcome: "not_delivered"; reason: AgentSendFailure }
  | { outcome: "unconfirmed" };

export interface AgentSendDeps extends SidecarDeps {
  deadlineMs: number;
  runs: SessionRunsView;
  /** Whether the daemon still counts `sid` among the running sessions. */
  isRunning(sid: string): boolean;
}

/** What became of one try, for the daemon log: `message` is what Claude Code
 * said of a send it did not deliver. */
export interface AgentSendTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
    | "write_uncertain"
    | "unconfirmed"
    | "delivered"
    | `not_delivered:${AgentSendReason}`;
  message?: string;
}

/** One text for an agent: `agentId` of session `sid`, from session `from`. */
export interface AgentMessage {
  sid: string;
  agentId: string;
  text: string;
  from: string;
}

/** Ask the runs of the session in turn to send the text to its agent,
 * stopping at the first that delivers it, so it arrives once. */
export async function agentSend(
  message: AgentMessage,
  deps: AgentSendDeps,
): Promise<AgentSendOutcome & { tries: AgentSendTry[] }> {
  const { sid, agentId, text, from } = message;
  return await askAgent(
    sid,
    (socket, ms) => callSidecar(socket, sid, "agent.send", { agentId, from, text }, ms, deps),
    deps,
  );
}

/** Ask the runs of the session in turn to wake its agent `agentId`
 * (agent.wake, DR-0066 §7), as agentSend asks them to send. */
export async function agentWake(
  target: { sid: string; agentId: string },
  deps: AgentSendDeps,
): Promise<AgentSendOutcome & { tries: AgentSendTry[] }> {
  const { sid, agentId } = target;
  return await askAgent(
    sid,
    (socket, ms) => callSidecar(socket, sid, "agent.wake", { agentId }, ms, deps),
    deps,
  );
}

/** Ask the runs of `sid` in turn with `ask` (a run's sidecar socket and the
 * time left), stopping at the first that delivers. */
async function askAgent(
  sid: string,
  ask: (
    socket: string,
    ms: number,
  ) => Promise<SidecarCall<"agent.send"> | SidecarCall<"agent.wake">>,
  deps: AgentSendDeps,
): Promise<AgentSendOutcome & { tries: AgentSendTry[] }> {
  const tries: AgentSendTry[] = [];
  const until = deps.now() + deps.deadlineMs;
  let noAgent = false;
  for (const { socket } of deps.runs.liveOf(sid)) {
    const remaining = until - deps.now();
    if (remaining <= 0) return { outcome: "unconfirmed", tries };
    const call = await ask(socket, remaining);
    const { id } = call;
    if (call.write === "not_written") {
      tries.push({ id, socket, result: "unwritten" });
      continue;
    }
    // No answer (a module of a ccmsg from before the op gives none), or one
    // that is not the op's (a failure, a module of another ccmsg), says
    // nothing of whether the agent got it.
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
    if (answer.outcome === "delivered") {
      tries.push({ id, socket, result: "delivered" });
      return { outcome: "delivered", tries };
    }
    tries.push({ id, socket, result: `not_delivered:${answer.reason}`, message: answer.message });
    // An agent lives in one process of the session: another run may have it.
    // Nothing was delivered, so asking the next cannot deliver it twice. A
    // run that knew the agent and did not deliver to it is the agent's.
    if (answer.reason !== "no_agent") {
      return { outcome: "not_delivered", reason: answer.reason, tries };
    }
    noAgent = true;
  }
  if (noAgent) return { outcome: "not_delivered", reason: "no_agent", tries };
  if (deps.runs.movedOn(sid)) return { outcome: "not_delivered", reason: "session_changed", tries };
  return {
    outcome: "not_delivered",
    reason: deps.isRunning(sid) ? "no_module" : "ended",
    tries,
  };
}
