// Stopping the main loop's running turn from the web UI (DR-0044): the turn
// the main loop runs now, by the id its turn.start carried, and `turn.abort`,
// which stops it with `$.turn.abort` as Esc in the terminal would. A
// subagent's or teammate's turn is neither held nor stopped: `$.turn.abort`
// takes the main loop's id only.
import * as v from "valibot";
import { errorText, type Output } from "@ccmsg/protocol/parse";
import type { TurnAbortResult } from "@ccmsg/protocol/sidecar";
import type { Engine } from "./engine.ts";

export interface TurnAbortState {
  /** The id of the turn the main loop is running now, from its turn.start to
   * its turn.complete; absent between turns, and for a turn already running
   * when the module was loaded. */
  mainTurnId?: string;
}

export function newTurnAbortState(): TurnAbortState {
  return {};
}

/** A turn event as far as the abort reads it: whose loop it is (absent on the
 * main loop) and the turn's id. */
export const AbortTurnInputSchema = v.looseObject({
  agentId: v.optional(v.string()),
  turnId: v.optional(v.string()),
});

/** The main loop started a turn: it is the one an abort stops. */
export function mainTurnBegan(
  state: TurnAbortState,
  input: Output<typeof AbortTurnInputSchema>,
): void {
  state.mainTurnId = input.turnId;
}

/** The main loop's turn ended: there is nothing to stop until the next. */
export function mainTurnFinished(state: TurnAbortState): void {
  state.mainTurnId = undefined;
}

/** turn.abort: stop the main loop's running turn. With none held, the engine
 * is not asked. The id is let go when the turn's turn.complete comes, not
 * here: the engine ends the turn with one. */
export async function abortMainTurn($: Engine, state: TurnAbortState): Promise<TurnAbortResult> {
  const turnId = state.mainTurnId;
  if (turnId === undefined) return { outcome: "no_turn" };
  try {
    await $.turn.abort({ turnId });
    return { outcome: "aborted" };
  } catch (e) {
    const message = errorText(e);
    $.ui.log(`ccmsg: turn.abort of ${turnId} refused: ${message}`, { to: "debug" });
    return { outcome: "refused", message };
  }
}
