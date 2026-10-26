// What a person overrides the session's main-thread requests with from the
// web UI (DR-0041): the session override, which the daemon hands over whole
// (`request.override`), and the one-shot override that comes with a prompt
// (`prompt.send`). Each main-thread request is
// sent with `one-shot ?? session ?? its own` (turn.step). A subagent's
// request goes as it came: a subagent is started with the model and the
// effort it is meant to run on. The engine's own model and effort stay as
// they are.
//
// The session override's fields that are not set are the session's own: the
// session runs on its own values until a person sets one, and a `/model` or
// `/effort` typed in the terminal moves them. A change of the session
// override updates the one-shot override's fields it changes, so it is in
// force from the next request even while a one-shot override is.
//
// A one-shot override is armed when the composer submits its prompt, ahead
// of the submit (the turn can make its first request before the submit's
// `next` settles), and taken back when the submit is dropped before any
// request carried it. It is bound to the main thread's next turn.start or
// turn.step after that — the turn the prompt starts, or the running turn
// whose next request a queued prompt joins — and goes at that turn's
// turn.complete. What the overrides put on the requests goes to the daemon
// with the facts (facts.ts).
import * as v from "valibot";
import { type Output, parseWith } from "@ccmsg/protocol/parse";
import {
  overrideInForce,
  overrideModel,
  overridesAnything,
  type RequestOverride,
} from "@ccmsg/protocol/request-override";
import type { RequestOverrideResult } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";
import { type FactsState, requestOverrideState, sendFacts } from "./facts.ts";
import { type PromptSendState, PromptSubmitInputSchema, samePrompt } from "./prompt-send.ts";

/** What the overrides read and write: the facts' state, which holds them, and
 * the prompt.send whose submit is awaited, which carries a one-shot
 * override. */
type OverrideHost = FactsState & Pick<PromptSendState, "awaiting">;

/** A request as far as the override reads it: whose loop it is (absent on the
 * main thread), and the model it would be sent with. */
export const OverrideStepInputSchema = v.looseObject({
  agentId: v.optional(v.string()),
  model: v.optional(v.string()),
});
export const OverrideTurnInputSchema = v.looseObject({ agentId: v.optional(v.string()) });

/** Run `change` on the overrides, and send the facts when the values they put
 * on the requests moved. */
function changeOverrides($: Engine, state: FactsState, change: () => void): void {
  const before = JSON.stringify(requestOverrideState(state));
  change();
  if (JSON.stringify(requestOverrideState(state)) !== before) sendFacts($, state);
}

/** `override` without the fields `changed` says moved; undefined when none
 * is left. */
function without(
  override: RequestOverride,
  changed: { model: boolean; effort: boolean },
): RequestOverride | undefined {
  const kept: RequestOverride = {
    ...(override.model !== undefined && !changed.model ? { model: override.model } : {}),
    ...(override.effort !== undefined && !changed.effort ? { effort: override.effort } : {}),
  };
  return overridesAnything(kept) ? kept : undefined;
}

/** `request.override`: the daemon's session override, whole, from the next
 * request on. The fields it changes are taken out of the one-shot override,
 * which would otherwise win the rest of the turn over the change. */
export function requestOverrideSet(
  $: Engine,
  state: FactsState,
  override: RequestOverride,
): RequestOverrideResult {
  changeOverrides($, state, () => {
    const { session, once } = state.overrides;
    const changed = {
      model: override.model !== session.model,
      effort: override.effort !== session.effort,
    };
    const kept = once === undefined ? undefined : without(once.override, changed);
    state.overrides = {
      session: override,
      ...(once !== undefined && kept !== undefined ? { once: { ...once, override: kept } } : {}),
    };
  });
  return { outcome: "applied" };
}

/** A prompt is about to be submitted from the composer: when it is the
 * awaited prompt.send's text and that carries a one-shot override, the
 * override is armed, replacing one still in force. */
export function promptSubmitting(
  $: Engine,
  state: OverrideHost,
  input: Output<typeof PromptSubmitInputSchema>,
): void {
  const awaiting = state.awaiting;
  if (input.text === undefined || awaiting?.override === undefined) return;
  if (!samePrompt(input.text, awaiting.text)) return;
  const override = awaiting.override;
  changeOverrides($, state, () => {
    state.overrides = {
      session: state.overrides.session,
      once: { override, bound: false, text: awaiting.text },
    };
  });
}

/** What a prompt.submit settles on, as far as the override reads it. */
const SubmitResultSchema = v.looseObject({ drop: v.optional(v.string()) });

/** The submit went through, or was dropped: a dropped prompt starts no turn,
 * so its one-shot override goes unless a request has carried it. */
export function promptSubmitSettled<R>(
  $: Engine,
  state: OverrideHost,
  input: Output<typeof PromptSubmitInputSchema>,
  result: R,
): void {
  const once = state.overrides.once;
  if (input.text === undefined || once === undefined || once.bound) return;
  if (!samePrompt(input.text, once.text)) return;
  const settled = parseWith(SubmitResultSchema, result);
  if (settled.ok && settled.value.drop === undefined) return;
  changeOverrides($, state, () => {
    state.overrides = { session: state.overrides.session };
  });
}

/** The session changed its id (/clear, /resume): the daemon holds the session
 * override by id, and the new id has none of the old one's. */
export function overridesDropped($: Engine, state: FactsState): void {
  changeOverrides($, state, () => {
    state.overrides = { session: {} };
  });
}

/** The main thread started a turn or made a request: a one-shot override
 * set since is this turn's from now on. */
export function mainTurnMoved(state: FactsState): void {
  const once = state.overrides.once;
  if (once !== undefined) once.bound = true;
}

/** The main thread's turn ended: the one-shot override it took goes. */
export function mainTurnEnded($: Engine, state: FactsState): void {
  if (state.overrides.once?.bound !== true) return;
  changeOverrides($, state, () => {
    state.overrides = { session: state.overrides.session };
  });
}

/** The request `e` as it is sent: on the main thread, the overrides laid over
 * its model and effort, field by field; a subagent's request, and a
 * main-thread one with no override, as it came. A request that does not read
 * is passed on as received, and logged. */
export function overriddenStep<E>($: Engine, state: FactsState, e: E): E {
  const read = parseWith(OverrideStepInputSchema, e);
  if (!read.ok) {
    $.ui.log(`ccmsg: turn.step not overridden: ${read.failure.summary}`, { to: "debug" });
    return e;
  }
  if (read.value.agentId !== undefined) return e;
  const wanted = overrideInForce({
    session: state.overrides.session,
    ...(state.overrides.once !== undefined ? { once: state.overrides.once.override } : {}),
  });
  if (!overridesAnything(wanted)) return e;
  return {
    ...e,
    ...(wanted.model !== undefined ? { model: overrideModel(read.value.model, wanted.model) } : {}),
    ...(wanted.effort !== undefined ? { effort: wanted.effort } : {}),
  };
}
