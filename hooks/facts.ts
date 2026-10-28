// What the module knows of its session through Claude Code itself and the
// transcript cannot tell (`session.facts`), and how it hands that to the
// daemon. Each time a part changes, it sends the whole of what it knows with
// the op `session_facts` (daemon-op.ts, DR-0046), which starts no daemon. A
// daemon that comes up later asks for them with the `session.facts` request
// when the run's sidecar names the run. Sessions without a composer send them too: they
// have no sidecar, but the daemon still shows them. The parts are read by
// session-facts.ts (the main thread), subagents.ts and request-override.ts
// (the overrides in force).
import * as v from "valibot";
import { errorText, jsonText, parseWith } from "@ccmsg/protocol/parse";
import type {
  SessionFacts,
  SessionFactsContext,
  SessionFactsSubagent,
  SessionFactsTurn,
} from "@ccmsg/protocol/sidecar";
import type { RequestOverride, RequestOverrideState } from "@ccmsg/protocol/request-override";
import { daemonOp } from "./daemon-op.ts";
import type { Engine } from "./engine.ts";

export interface FactsState {
  /** What the module knows of the session through Claude Code (session.facts):
   * each part once it has been read. */
  facts: {
    model?: string;
    effort?: string;
    context?: SessionFactsContext;
    turn?: SessionFactsTurn;
    subagents?: SessionFactsSubagent[];
  };
  /** The overrides of the main thread's requests (request-override.ts,
   * DR-0041): the session override's fields a person set, and the one-shot
   * override with whether a main-thread turn has taken it. The facts carry
   * the values they put on the requests (requestOverrideState).
   *
   * Design rationale: kept here, beside the facts, rather than in
   * request-override.ts: the session override's values are the facts' own
   * model and effort wherever a person set none, so the facts are put
   * together from both, and request-override.ts sends the facts. */
  overrides: {
    session: RequestOverride;
    /** The one-shot override, the prompt it came with, and whether a
     * main-thread turn has taken it. */
    once?: { override: RequestOverride; bound: boolean; text: string };
  };
  /** Facts are sent one at a time; `queued` is whether a send waits its turn,
   * which then sends what the module knows when it starts, so any number of
   * changes meanwhile cost one send. */
  factsSend: { chain: Promise<void>; queued: boolean };
}

export function newFactsState(): FactsState {
  return {
    facts: {},
    overrides: { session: {} },
    factsSend: { chain: Promise.resolve(), queued: false },
  };
}

/** The values the overrides put on the main thread's requests: the session
 * override's fields over the session's own model and effort, and the
 * one-shot override's. */
export function requestOverrideState(state: FactsState): RequestOverrideState {
  const { session, once } = state.overrides;
  return {
    session: {
      model: session.model ?? state.facts.model ?? null,
      effort: session.effort ?? state.facts.effort ?? null,
    },
    once: { model: once?.override.model ?? null, effort: once?.override.effort ?? null },
  };
}

/** The facts as the module knows them now. */
export async function currentFacts($: Engine, state: FactsState): Promise<SessionFacts> {
  return {
    at: Math.floor(await $.clock.now()),
    ...state.facts,
    request_override: requestOverrideState(state),
  };
}

/** session_facts' reply, as far as the module reads it: whether the daemon
 * took the facts. */
const TakenTextSchema = jsonText(v.object({ ok: v.literal(true) }));

/** Send the facts to the daemon, behind any send still running. A send that
 * waits its turn already sends what the module will know by then, so no
 * second one is queued behind it. Never rejects: a failed send is logged, and
 * the next change or the daemon's `session.facts` request makes up for it. No
 * daemon running is not a failure: the next one asks. */
export function sendFacts($: Engine, state: FactsState): void {
  const send = state.factsSend;
  if (send.queued) return;
  send.queued = true;
  send.chain = send.chain
    .then(async () => {
      send.queued = false;
      const facts = await currentFacts($, state);
      const asked = await daemonOp($, { op: "session_facts", facts });
      if (asked.kind === "answered" && !parseWith(TakenTextSchema, asked.text).ok) {
        $.ui.log(`ccmsg: facts refused: ${asked.text}`, { to: "debug" });
      } else if (asked.kind === "outdated" || asked.kind === "unanswered") {
        $.ui.log(
          `ccmsg: facts not sent: ${asked.kind === "outdated" ? "the daemon is older than this plugin" : asked.reason}`,
          { to: "debug" },
        );
      }
    })
    .catch((e: unknown) => {
      send.queued = false;
      $.ui.log(`ccmsg: facts not sent: ${errorText(e)}`, { to: "debug" });
    });
}
