// Hooks module (Claude Mods, DR-0035): the plugin's one tie to Claude Code
// (DR-0039 §1). It hooks no classic event.
//
// The module is split by concern, each in its own file, each reading and
// writing only its part of the module's state:
//
//   session-lifecycle.ts  whether the session has a composer, the id it runs
//                         under and its generation, its state file
//   sidecar.ts            the run's sidecar and the requests through it
//   session-facts.ts      the main thread's facts: model, effort, window, turn
//   subagents.ts          the running subagents, and agent.append
//   prompt-send.ts        a person's text from the web UI put in as a prompt
//   request-override.ts   the model and effort a person overrides the
//                         requests with from the web UI
//   turn-abort.ts         the main loop's running turn, and turn.abort,
//                         which stops it from the web UI
//   transcript-push.ts    the rows that go into the conversation, passed on
//                         to the daemon (DR-0045 §2)
//   guidance.ts           what the model is told of ccmsg before its first turn
//   tools.ts              the send / say / peers / launch tools
//
// bus.ts registers the events they observe, once per event, and runs each
// concern's part of it; engine.ts is the engine as the module uses it, and
// facts.ts the facts and their sending.
//
// Claude Code's module loader allows no imports that run, so this file is not
// what hooks.json names: `just build-hooks` bundles it, with the files it
// imports, valibot and the protocol's sidecar schemas it reads requests by,
// into the one file register.bundle.js, and `just check-hooks-bundle`
// (in `just ci` and GitHub CI) fails while that file is not this source's
// bundle. Every line from the sidecar is read once by the protocol's schema
// (`readSidecarRequest`) into a typed request or a failure, and every engine
// input a hook uses by a schema of the fields it reads. The module loader and
// `claude plugin validate` read the bundle statically: each call is spelled
// out as `$.noun.method(...)` with literal arguments where the engine
// requires them, each hook is a function literal, and `$` is passed only to
// functions declared at the top of a file, which the bundle keeps at its top.
import { registerBus } from "./bus.ts";
import type { On } from "./engine.ts";
import { type FactsState, newFactsState } from "./facts.ts";
import { newPromptSendState, type PromptSendState } from "./prompt-send.ts";
import { type LifecycleState, newLifecycleState } from "./session-lifecycle.ts";
import { newSidecarState, type SidecarState } from "./sidecar.ts";
import { registerToolCalls } from "./tools.ts";
import { newTranscriptPushState, type TranscriptPushState } from "./transcript-push.ts";
import { newTurnAbortState, type TurnAbortState } from "./turn-abort.ts";

/** The module's state for one load: one object, each concern's part
 * declared by that concern, and each concern given the parts it reads.
 *
 * Design rationale: one object rather than one per concern. The parts meet
 * where a request crosses concerns (a prompt.send is checked against the
 * session's id and generation; a new generation drops the awaited
 * prompt.send), and each concern's functions are typed by the parts they
 * read, so what a concern touches is still stated by its types. */
export type ModuleState = LifecycleState &
  SidecarState &
  PromptSendState &
  FactsState &
  TurnAbortState &
  TranscriptPushState;

export function newState(): ModuleState {
  return {
    ...newLifecycleState(),
    ...newSidecarState(),
    ...newPromptSendState(),
    ...newFactsState(),
    ...newTurnAbortState(),
    ...newTranscriptPushState(),
  };
}

/** Register the module's hooks: the events the concerns observe (bus.ts) and
 * the tools' calls. */
export function register(on: On): ModuleState {
  const state = newState();
  registerBus(on, state);
  registerToolCalls(on);
  return state;
}
