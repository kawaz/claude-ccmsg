// The subagents a person can add a message to from the web UI (DR-0039 §6):
// which of them are running, as a part of the facts, and `agent.append`,
// which adds a message to a running one's conversation.
import * as v from "valibot";
import { errorText, type Output } from "@ccmsg/protocol/parse";
import type { AgentAppendResult, SessionFactsSubagent } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";
import { type FactsState, sendFacts } from "./facts.ts";

// The engine's turn events name the subagent whose loop they belong to
// (`agentId`), absent on the main thread.
export const SubagentTurnInputSchema = v.looseObject({ agentId: v.optional(v.string()) });

/** Read the subagents running now off the session (`$.agent.list()`): what
 * the module knows when it has seen none start (it was loaded meanwhile, or
 * the session changed its id). When their turns started is not known, so it
 * is left out. Sends nothing; never rejects. */
export async function readSubagents($: Engine, state: FactsState): Promise<void> {
  try {
    const running = (await $.agent.list()).filter((agent) => agent.status === "running");
    state.facts = {
      ...state.facts,
      subagents: running.map((agent) => subagentFacts(agent.id, agent)),
    };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the subagents: ${errorText(e)}`, { to: "debug" });
  }
}

function subagentFacts(
  id: string,
  agent: { description: string; type: string } | undefined,
  since?: number,
): SessionFactsSubagent {
  return {
    id,
    ...(agent !== undefined && agent.description !== "" ? { description: agent.description } : {}),
    ...(agent !== undefined && agent.type !== "" ? { type: agent.type } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}

/** A subagent's loop started a turn: it is running, and a message can be
 * added to its conversation until the turn ends. Never rejects. */
async function subagentStarted($: Engine, state: FactsState, id: string): Promise<void> {
  try {
    const since = Math.floor(await $.clock.now());
    const agent = (await $.agent.list()).find((a) => a.id === id);
    const others = (state.facts.subagents ?? []).filter((a) => a.id !== id);
    state.facts = { ...state.facts, subagents: [...others, subagentFacts(id, agent, since)] };
  } catch (e) {
    $.ui.log(`ccmsg: could not take the subagent ${id}: ${errorText(e)}`, { to: "debug" });
  }
  sendFacts($, state);
}

/** A subagent's turn ended: nothing can be added to its conversation now. */
function subagentEnded($: Engine, state: FactsState, id: string): void {
  const held = state.facts.subagents;
  if (held === undefined || !held.some((a) => a.id === id)) return;
  state.facts = { ...state.facts, subagents: held.filter((a) => a.id !== id) };
  sendFacts($, state);
}

/** What a subagent reads of a message: marked as the person's through ccmsg,
 * or as from the session `from` that sent it with `send` (DR-0039 §3), so the
 * model takes it as a word from outside its task, not a tool's output. */
export function agentMessage(text: string, from?: string): string {
  const mark = from !== undefined ? `ccmsg:${from} から:` : "ユーザから (ccmsg 経由):";
  return `${mark}\n${text}`;
}

/** agent.append: add the text to the running subagent's conversation.
 * Claude Code refuses an id no loop runs under with "no running loop is
 * <id>". */
export async function appendToAgent(
  $: Engine,
  args: { agentId: string; from?: string; text: string },
): Promise<AgentAppendResult> {
  try {
    await $.session.append({
      message: {
        type: "user",
        content: [{ type: "text", text: agentMessage(args.text, args.from) }],
      },
      agentId: args.agentId,
    });
    return { outcome: "appended" };
  } catch (e) {
    const why = errorText(e);
    $.ui.log(`ccmsg: agent.append to ${args.agentId} refused: ${why}`, { to: "debug" });
    return {
      outcome: "not_delivered",
      reason: why.includes("no running loop") ? "not_running" : "refused",
    };
  }
}

/** A subagent's loop started a turn (the engine names the loop by `agentId`;
 * the main thread's turns are session-facts.ts's). */
export function subagentTurnStarted(
  $: Engine,
  state: FactsState,
  input: Output<typeof SubagentTurnInputSchema>,
): void {
  if (input.agentId !== undefined) void subagentStarted($, state, input.agentId);
}

/** A subagent's loop ended its turn. */
export function subagentTurnCompleted(
  $: Engine,
  state: FactsState,
  input: Output<typeof SubagentTurnInputSchema>,
): void {
  if (input.agentId !== undefined) subagentEnded($, state, input.agentId);
}
