// What the module knows of its session through Claude Code itself and the
// transcript cannot tell (`session.facts`), and how it hands that to the
// daemon. Each time a part changes, it sends the whole of what it knows
// through `ccmsg sidecar facts`, which starts no daemon. A daemon that comes
// up later asks for them with the `session.facts` request when the run's
// sidecar names the run. Sessions without a composer send them too: they
// have no sidecar, but the daemon still shows them. The parts are read by
// session-facts.ts (the main thread) and subagents.ts.
import { errorText } from "@ccmsg/protocol/parse";
import type {
  SessionFacts,
  SessionFactsContext,
  SessionFactsSubagent,
  SessionFactsTurn,
} from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";

/** A `ccmsg` command that is one process and one round trip to the daemon (a
 * reply, the facts), measured at about 0.3 s. */
export const REPLY_TIMEOUT_MS = 3_000;

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
  /** Facts are sent one at a time; `queued` is whether a send waits its turn,
   * which then sends what the module knows when it starts, so any number of
   * changes meanwhile cost one send. */
  factsSend: { chain: Promise<void>; queued: boolean };
}

export function newFactsState(): FactsState {
  return { facts: {}, factsSend: { chain: Promise.resolve(), queued: false } };
}

/** `ccmsg sidecar facts` for session `sid`. The facts go on standard input,
 * for the reason a reply does (sidecar.ts). */
export function factsArgv(root: string, sid: string): string[] {
  return [`${root}/bin/ccmsg`, "sidecar", "facts", "--sid", sid];
}

/** The facts as the module knows them now. */
export async function currentFacts($: Engine, state: FactsState): Promise<SessionFacts> {
  return { at: Math.floor(await $.clock.now()), ...state.facts };
}

/** Send the facts to the daemon, behind any send still running. A send that
 * waits its turn already sends what the module will know by then, so no
 * second one is queued behind it. Never rejects: a failed send is logged, and
 * the next change or the daemon's `session.facts` request makes up for it. */
export function sendFacts($: Engine, state: FactsState): void {
  const send = state.factsSend;
  if (send.queued) return;
  send.queued = true;
  send.chain = send.chain
    .then(async () => {
      send.queued = false;
      const facts = await currentFacts($, state);
      const sid = await $.session.id();
      const done = await $.process.run(factsArgv($.plugin.root, sid), {
        stdin: JSON.stringify(facts),
        timeoutMs: REPLY_TIMEOUT_MS,
      });
      if (done.exitCode !== 0) {
        $.ui.log(`ccmsg: facts exited ${done.exitCode}: ${done.stderr.trim()}`, { to: "debug" });
      }
    })
    .catch((e: unknown) => {
      send.queued = false;
      $.ui.log(`ccmsg: facts not sent: ${errorText(e)}`, { to: "debug" });
    });
}
