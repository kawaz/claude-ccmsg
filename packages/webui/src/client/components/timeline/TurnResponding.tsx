// The end of the session's Timeline while its main loop answers a turn: the
// 応答中 row, with the 中断 button that stops the turn (DR-0044 §4), and what
// the press came to.
import type { ErrorBody, ErrorResponse, TurnAbortResponse } from "@ccmsg/protocol";
import { useEffect, useState } from "preact/hooks";
import { TurnRespondingRow } from "../TimelineItem.tsx";

/** How long 「中断しました」 stays: the row it answers goes with the turn's
 * end, so the line only has to say the press worked. */
export const TURN_ABORTED_NOTICE_MS = 4_000;

/** What the press of 中断 came to, for the turn (its start, `since`) it was
 * pressed on. */
type AbortState =
  | { kind: "idle" }
  | { kind: "pending"; turn: string }
  | { kind: "aborted"; turn: string }
  | { kind: "failed"; turn: string; text: string };

/** What a turn_abort error says to the person. */
export function turnAbortFailureText(error: ErrorBody): string {
  switch (error.code) {
    case "no_turn":
      return "中断する応答がありませんでした (既に終わっていた)";
    case "no_module":
      return "このセッションには hooks module が無いので中断できません";
    case "session_not_found":
      return "セッションが見つかりません";
    default:
      return `中断できませんでした: ${error.msg}`;
  }
}

/** `since` is when the main loop started the turn it answers now, null when
 * it answers none. The result of a press is this tab's only: kept nowhere,
 * and gone with the view. A failure stays until the next press, while the
 * turn it was pressed on (or none) is the one shown. */
export function TurnResponding({
  since,
  onAbort,
}: {
  since: string | null;
  onAbort: () => Promise<TurnAbortResponse | ErrorResponse>;
}) {
  const [state, setState] = useState<AbortState>({ kind: "idle" });

  // 「中断しました」 goes after a while: a timer, synchronised with the
  // aborted state it belongs to and cleared with it.
  useEffect(() => {
    if (state.kind !== "aborted") return;
    const shown = state;
    const timer = setTimeout(() => {
      setState((current) => (current === shown ? { kind: "idle" } : current));
    }, TURN_ABORTED_NOTICE_MS);
    return () => clearTimeout(timer);
  }, [state]);

  const press = async (turn: string): Promise<void> => {
    setState({ kind: "pending", turn });
    // The request is refused before it is sent when the connection is not
    // open; every other failure is the reply's error.
    await onAbort().then(
      (reply) =>
        setState(
          reply.ok
            ? { kind: "aborted", turn }
            : { kind: "failed", turn, text: turnAbortFailureText(reply.error) },
        ),
      (e: unknown) =>
        setState({
          kind: "failed",
          turn,
          text:
            e instanceof Error
              ? `中断を依頼できませんでした: ${e.message}`
              : "中断を依頼できませんでした",
        }),
    );
  };

  const pressedHere = state.kind !== "idle" && state.turn === since;
  const failure =
    state.kind === "failed" && (since === null || state.turn === since) ? state.text : null;
  return (
    <>
      {since !== null ? (
        <TurnRespondingRow
          since={since}
          abort={{
            disabled: pressedHere && state.kind !== "failed",
            onPress: () => void press(since),
          }}
        />
      ) : null}
      {state.kind === "aborted" ? (
        <div class="tl-turn-abort-result" role="status">
          中断しました
        </div>
      ) : null}
      {failure !== null ? (
        <div class="tl-turn-abort-result tl-turn-abort-failure" role="alert">
          {failure}
        </div>
      ) : null}
    </>
  );
}
