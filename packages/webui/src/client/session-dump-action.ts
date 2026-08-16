// What the Timeline's "dump をファイル出力" action asks the daemon for.
//
// The panel offers one control with two meanings — dump the whole session, or
// dump from the selected record on — and the difference is carried entirely by
// which fields the request has. The daemon reads an absent `since` as "the
// whole session" and an absent `no_thinking`/`no_agent` as "keep it", so a
// field sent with a falsy value is not the same message as a field left off.
// Building the request here keeps that mapping out of the component and under
// test (DR-0005 §1).
import type { SessionDumpFileRequest } from "@ccmsg/protocol";

/** What the panel knows when the button is pressed. */
export interface DumpActionInput {
  sid: string;
  /** The Timeline's selected position: a record uuid, or "head" when nothing
   * is selected — the same value the URL carries. Unlike fork, an off-chain
   * record is still a valid choice: a dump cuts the transcript by record
   * position and never asks `--resume` to reconstruct anything. */
  position: string;
  noThinking: boolean;
  noAgent: boolean;
}

/** The wire request for one press. */
export function sessionDumpRequest(
  input: DumpActionInput,
): Omit<SessionDumpFileRequest, "op" | "request_id"> {
  return {
    sid: input.sid,
    ...(input.position === "head" ? {} : { since: input.position }),
    ...(input.noThinking ? { no_thinking: true } : {}),
    ...(input.noAgent ? { no_agent: true } : {}),
  };
}

/** Whether this press dumps from the selection rather than the whole session.
 * The button and its note both say which, so the user reads the scope before
 * pressing instead of inferring it from the result. */
export function isScopedDump(position: string): boolean {
  return position !== "head";
}
