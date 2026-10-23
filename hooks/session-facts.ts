// The facts of the session's main thread (facts.ts): the model as the
// session names it, `[1m]` kept, the effort, the context window the session
// runs with and its fill, and whether the main thread is answering a turn
// (turn.start / turn.complete, idle from the session's start). The model and
// the window are read at session.start, after /model, /clear and /resume
// (command.run), and the window and the fill again from each session.measure;
// the effort comes with each main-thread request (turn.step). The API error a
// turn ends on is not among them: the daemon reads it, with Claude Code's
// classification, off the transcript (DR-0039 §2).
import * as v from "valibot";
import { errorText, type Output } from "@ccmsg/protocol/parse";
import type { SessionFactsContext, SessionFactsTurn } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";
import { type FactsState, sendFacts } from "./facts.ts";
import { readSubagents } from "./subagents.ts";

export const SessionMeasureInputSchema = v.looseObject({
  context: v.optional(
    v.looseObject({ window: v.optional(v.number()), tokens: v.optional(v.number()) }),
  ),
});
// The engine's turn events name the subagent whose loop they belong to
// (`agentId`), absent on the main thread. A request carries the effort it
// asks for (a level, or a number), absent for a model without effort.
export const TurnStepInputSchema = v.looseObject({
  agentId: v.optional(v.string()),
  effort: v.optional(v.union([v.string(), v.number()])),
});
export const TurnInputSchema = v.looseObject({ agentId: v.optional(v.string()) });

/** The window and the fill as the facts carry them: a fill Claude Code does
 * not report (before the first response, right after a compaction) is left
 * out. */
function contextFacts(
  context: { window: number; tokens?: number },
  at: number,
): SessionFactsContext {
  return {
    window: context.window,
    ...(context.tokens !== undefined ? { tokens: context.tokens } : {}),
    at,
  };
}

/** Take the effort a main-thread request asks for, and send the facts when
 * it moved. A number (an effort given as a budget rather than a level) is
 * carried as its digits. */
function requestEffort($: Engine, state: FactsState, effort: string | number | undefined): void {
  const level = typeof effort === "number" ? String(effort) : effort;
  if (level === undefined || level === "" || level === state.facts.effort) return;
  state.facts = { ...state.facts, effort: level };
  sendFacts($, state);
}

/** Read the model and the context window off the session, and send the
 * facts. Never rejects. */
export async function readModelAndWindow($: Engine, state: FactsState): Promise<void> {
  try {
    const model = await $.session.model();
    const { context } = await $.session.usage();
    const at = Math.floor(await $.clock.now());
    state.facts = { ...state.facts, model, context: contextFacts(context, at) };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the model and the window: ${errorText(e)}`, { to: "debug" });
  }
  sendFacts($, state);
}

/** A session began (its start, or /clear): no turn is running, and the
 * model and the window are read, with the subagents running now, into one
 * send of the facts. Never rejects. */
export async function sessionBegan($: Engine, state: FactsState): Promise<void> {
  try {
    const since = Math.floor(await $.clock.now());
    state.facts = { ...state.facts, turn: { state: "idle", since } };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the clock: ${errorText(e)}`, { to: "debug" });
  }
  await readSubagents($, state);
  await readModelAndWindow($, state);
}

/** The main thread is answering a turn now, or not; the facts are sent.
 * Never rejects. */
async function turnState(
  $: Engine,
  state: FactsState,
  turn: SessionFactsTurn["state"],
): Promise<void> {
  try {
    const since = Math.floor(await $.clock.now());
    state.facts = { ...state.facts, turn: { state: turn, since } };
  } catch (e) {
    $.ui.log(`ccmsg: could not read the clock: ${errorText(e)}`, { to: "debug" });
  }
  sendFacts($, state);
}

/** session.measure says the window and the fill each main-thread turn. */
export async function sessionMeasured(
  $: Engine,
  state: FactsState,
  input: Output<typeof SessionMeasureInputSchema>,
): Promise<void> {
  const window = input.context?.window;
  if (window === undefined) return;
  const at = Math.floor(await $.clock.now());
  const tokens = input.context?.tokens;
  state.facts = {
    ...state.facts,
    context: contextFacts({ window, ...(tokens !== undefined ? { tokens } : {}) }, at),
  };
  sendFacts($, state);
}

/** The main thread made a request: the effort is known before any of its
 * answer. */
export function stepRequested(
  $: Engine,
  state: FactsState,
  input: Output<typeof TurnStepInputSchema>,
): void {
  requestEffort($, state, input.effort);
}

/** The main thread started answering a turn. */
export function turnStarted($: Engine, state: FactsState): void {
  void turnState($, state, "responding");
}

/** The main thread's turn ended. */
export async function turnCompleted($: Engine, state: FactsState): Promise<void> {
  await turnState($, state, "idle");
}
