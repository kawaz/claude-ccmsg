// The module's one engine registration per event it observes. Each concern
// (session-lifecycle, sidecar, session-facts, subagents, prompt-send,
// request-override, guidance, tools) states its part in an event here: the fields it reads,
// which inputs concern it, and what it runs ahead of the event and once it
// went through. The hook of the event reads the input for each concern, runs
// their parts in the order listed around one `next`, and passes the event on
// once. What each part does lives in its concern's file.
//
// Design rationale: one engine registration per event, with the concerns
// fanned out from it, rather than one engine registration per concern. All
// measured on 2.1.308 (docs/findings/2026-10-23-mods-duplicate-on-and-nesting.md):
// - The engine refuses to load a module that registers one event twice
//   without a matcher (`on("session.start") is registered twice without a
//   matcher`), by `claude plugin validate` and by its own host in `claude
//   plugin test`.
// - Registrations with a matcher may repeat, even `{}`, which matches every
//   input. Each concern could register its own hook under `{}`, but only by
//   passing the engine's duplicate check: the day the engine takes `{}` for
//   no matcher, the whole module is refused. `{}` is not used.
// - The registrations of a module nest in the order they are made, and a hook
//   that throws keeps the part after `next` of every hook outside it from
//   running, `.catch` or not: concerns with hooks of their own would not be
//   kept apart by the engine either. Here each concern's part is caught on its
//   own: one that throws, or whose input does not read, is logged, and the
//   other concerns' parts run as if it were not there.
// - The engine refuses a module that passes `$` to anything but a function
//   declared at the top of a file, so a concern cannot hand the bus a function
//   to call with `$`. Each part is spelled here as a closure over the hook's
//   `$` that calls its concern's function.
// An engine matcher is used only where it is the event's one registration:
// each tool's tool.call (tools.ts). The engine's `.catch` covers what is
// left, `next` failing or the budget running out.
import type * as v from "valibot";
import { errorText, type Output, parseWith } from "@ccmsg/protocol/parse";
import {
  AnyInputSchema,
  CommandRunInputSchema,
  type Engine,
  type ObservedEvent,
  type On,
} from "./engine.ts";
import type { FactsState } from "./facts.ts";
import { guide, sweepGuided, unguide } from "./guidance.ts";
import { type PromptSendState, PromptSubmitInputSchema, promptSubmitted } from "./prompt-send.ts";
import {
  mainTurnEnded,
  mainTurnMoved,
  overriddenStep,
  overridesDropped,
  OverrideStepInputSchema,
  OverrideTurnInputSchema,
  promptSubmitSettled,
  promptSubmitting,
} from "./request-override.ts";
import {
  readModelAndWindow,
  sessionBegan,
  SessionMeasureInputSchema,
  sessionMeasured,
  stepRequested,
  TurnInputSchema,
  TurnStepInputSchema,
  turnCompleted,
  turnStarted,
} from "./session-facts.ts";
import {
  changesSessionId,
  type LifecycleState,
  sessionBegin,
  SessionEndInputSchema,
  sessionCleared,
  sessionStarted,
  SessionStartInputSchema,
} from "./session-lifecycle.ts";
import { type SidecarState, startSidecar } from "./sidecar.ts";
import {
  SubagentTurnInputSchema,
  subagentTurnCompleted,
  subagentTurnStarted,
} from "./subagents.ts";
import { toolsAtStart } from "./tools.ts";

/** One concern's part in an event: the input read by the concern's schema,
 * what runs ahead of the event and what runs once it went through. */
export interface Concern<R> {
  name: string;
  read<E>(e: E): ReadConcern<R>;
}
type ReadConcern<R> =
  | {
      ok: true;
      before: () => Promise<void> | void;
      after: (result: R) => Promise<void> | void;
    }
  | { ok: false; summary: string };

/** `name`'s part: the fields it uses read with `schema`, each one allowed to
 * be absent and the rest let through (DR-0038 §1), and the part run only for
 * the inputs `when` takes. */
export function concern<S extends v.GenericSchema, R>(
  name: string,
  schema: S,
  parts: {
    /** Which inputs concern it; every input when absent. */
    when?: (input: Output<S>) => boolean;
    before?: (input: Output<S>) => Promise<void> | void;
    after?: (input: Output<S>, result: R) => Promise<void> | void;
  },
): Concern<R> {
  return {
    name,
    read: (e) => {
      const read = parseWith(schema, e);
      if (!read.ok) return { ok: false, summary: read.failure.summary };
      const input = read.value;
      if (parts.when !== undefined && !parts.when(input))
        return { ok: true, before: () => {}, after: () => {} };
      return {
        ok: true,
        before: () => parts.before?.(input),
        after: (result) => parts.after?.(input, result),
      };
    },
  };
}

type ReadPart<R> = { name: string; part: Extract<ReadConcern<R>, { ok: true }> };

/** Each concern's reading of `e`; one that does not read is logged and takes
 * no part in the event. */
function readAll<E, R>(
  $: Engine,
  e: E,
  event: ObservedEvent | "turn.step",
  concerns: readonly Concern<R>[],
): ReadPart<R>[] {
  return concerns.flatMap((c) => {
    const read = c.read(e);
    if (read.ok) return [{ name: c.name, part: read }];
    $.ui.log(`ccmsg: ${event} not read (${c.name}): ${read.summary}`, { to: "debug" });
    return [];
  });
}

/** Run each concern's part in order, each caught on its own. */
async function runAll<R>(
  $: Engine,
  event: ObservedEvent | "turn.step",
  when: "before" | "after",
  parts: readonly ReadPart<R>[],
  run: (part: ReadPart<R>["part"]) => Promise<void> | void,
): Promise<void> {
  for (const { name, part } of parts) {
    try {
      await run(part);
    } catch (error) {
      $.ui.log(`ccmsg: ${event} failed ${when} the event (${name}): ${errorText(error)}`, {
        to: "debug",
      });
    }
  }
}

/** The body of a hook that observes `event` for `concerns`: pass it on
 * exactly once, as received. A concern's failure, in reading the input or in
 * its part, is logged and neither stops the other concerns nor reaches the
 * engine as a failed hook, so the only thing that can make the hook throw is
 * `next` itself. */
export async function fanOut<E, R>(
  $: Engine,
  e: E,
  next: (e: E) => Promise<R>,
  event: ObservedEvent,
  concerns: readonly Concern<R>[],
): Promise<R> {
  const parts = readAll($, e, event, concerns);
  await runAll($, event, "before", parts, (part) => part.before());
  const result = await next(e);
  await runAll($, event, "after", parts, (part) => part.after(result));
  return result;
}

/** What the concerns observing the events read and write. */
type BusState = LifecycleState & SidecarState & PromptSendState & FactsState;

const mainThread = (input: { agentId?: string }): boolean => input.agentId === undefined;
const subagent = (input: { agentId?: string }): boolean => input.agentId !== undefined;

/** Register the module's hooks on the events it observes, one each. */
export function registerBus(on: On, state: BusState): void {
  // session.start also runs on a hot reload, with the session as it was:
  // begin is idempotent, and the sidecar of the same id is kept. Whether the
  // session has a composer is known first: the sidecar and the tools go by
  // it. The tools are awaited, so they are listed by the first turn.
  on("session.start", async ($, e, next) =>
    fanOut($, e, next, "session.start", [
      concern("session-lifecycle", SessionStartInputSchema, {
        after: (input) => sessionStarted($, state, input),
      }),
      concern("sidecar", AnyInputSchema, { after: () => startSidecar($, state) }),
      concern("session-facts", AnyInputSchema, {
        after: () => {
          void sessionBegan($, state);
        },
      }),
      concern("guidance", AnyInputSchema, {
        after: () => {
          void sweepGuided($);
        },
      }),
      concern("tools", AnyInputSchema, { after: () => toolsAtStart($, state) }),
    ]),
  ).catch(async (_$, e, next) => next(e));
  // The old id's requests go no further from here: the session after /clear
  // or /resume is another.
  on("session.end", async ($, e, next) =>
    fanOut($, e, next, "session.end", [
      concern("session-lifecycle", SessionEndInputSchema, {
        when: (input) => changesSessionId(input.reason),
        before: () => sessionCleared(state),
      }),
      concern("request-override", SessionEndInputSchema, {
        when: (input) => changesSessionId(input.reason),
        before: () => overridesDropped($, state),
      }),
    ]),
  ).catch(async (_$, e, next) => next(e));
  // /clear and /resume start no session.start: once the command went
  // through, the session's id is the new one (DR-0039 §2). /model raises no
  // session.measure, so the model and the window are read again after it.
  on("command.run", async ($, e, next) =>
    fanOut($, e, next, "command.run", [
      concern("session-lifecycle", CommandRunInputSchema, {
        when: (input) => changesSessionId(input.command),
        after: () => {
          void sessionBegin($);
        },
      }),
      concern("sidecar", CommandRunInputSchema, {
        when: (input) => changesSessionId(input.command),
        after: () => startSidecar($, state),
      }),
      concern("session-facts", CommandRunInputSchema, {
        when: (input) => changesSessionId(input.command),
        after: () => {
          void sessionBegan($, state);
        },
      }),
      concern("session-facts", CommandRunInputSchema, {
        when: (input) => input.command === "model",
        after: () => {
          void readModelAndWindow($, state);
        },
      }),
    ]),
  ).catch(async (_$, e, next) => next(e));
  on("session.compact", async ($, e, next) =>
    fanOut($, e, next, "session.compact", [
      concern("guidance", AnyInputSchema, { after: () => unguide($) }),
    ]),
  ).catch(async (_$, e, next) => next(e));
  on("session.measure", async ($, e, next) =>
    fanOut($, e, next, "session.measure", [
      concern("session-facts", SessionMeasureInputSchema, {
        after: (input) => sessionMeasured($, state, input),
      }),
    ]),
  ).catch(async (_$, e, next) => next(e));
  // A streaming event: the parts run before the stream beneath is passed on,
  // and they read the request as it came. A subagent's request is not the
  // session's. A main-thread request goes on with the overrides laid over it
  // (DR-0041 §1).
  on("turn.step", async function* ($, e, next) {
    const parts = readAll($, e, "turn.step", [
      concern("session-facts", TurnStepInputSchema, {
        when: mainThread,
        before: (input) => stepRequested($, state, input),
      }),
      concern("request-override", OverrideStepInputSchema, {
        when: mainThread,
        before: () => mainTurnMoved(state),
      }),
    ]);
    await runAll($, "turn.step", "before", parts, (part) => part.before());
    return yield* next(overriddenStep($, state, e));
  }).catch(async function* (_$, e, next) {
    return yield* next(e);
  });
  // The engine names the subagent whose loop a turn belongs to (`agentId`),
  // absent on the main thread.
  on("turn.start", async ($, e, next) =>
    fanOut($, e, next, "turn.start", [
      concern("session-facts", TurnInputSchema, {
        when: mainThread,
        before: () => turnStarted($, state),
      }),
      concern("request-override", OverrideTurnInputSchema, {
        when: mainThread,
        before: () => mainTurnMoved(state),
      }),
      concern("subagents", SubagentTurnInputSchema, {
        when: subagent,
        before: (input) => subagentTurnStarted($, state, input),
      }),
    ]),
  ).catch(async (_$, e, next) => next(e));
  on("turn.complete", async ($, e, next) =>
    fanOut($, e, next, "turn.complete", [
      concern("session-facts", TurnInputSchema, {
        when: mainThread,
        after: () => turnCompleted($, state),
      }),
      concern("request-override", OverrideTurnInputSchema, {
        when: mainThread,
        after: () => mainTurnEnded($, state),
      }),
      concern("subagents", SubagentTurnInputSchema, {
        when: subagent,
        after: (input) => subagentTurnCompleted($, state, input),
      }),
    ]),
  ).catch(async (_$, e, next) => next(e));
  on("prompt.submit", async ($, e, next) =>
    fanOut($, e, next, "prompt.submit", [
      // Before the prompt goes in, so its request carries the guidance.
      concern("guidance", AnyInputSchema, { before: () => guide($, state) }),
      // Ahead of the submit, so the turn's first request, which may come
      // before the submit settles, carries the one-shot override; taken back
      // when the submit is dropped.
      concern("request-override", PromptSubmitInputSchema, {
        when: (input) => input.origin?.kind === "composer",
        before: (input) => promptSubmitting($, state, input),
        after: (input, result) => promptSubmitSettled($, state, input, result),
      }),
      // A filled prompt is accepted once its submit from the composer went
      // through; the person gets their draft back then.
      concern("prompt-send", PromptSubmitInputSchema, {
        when: (input) => input.origin?.kind === "composer",
        after: (input, result) => promptSubmitted($, state, input, result),
      }),
    ]),
  ).catch(async (_$, e, next) => next(e));
}
