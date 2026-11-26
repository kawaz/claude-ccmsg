// Which items of the Timeline fold to a bubble of one line, and what the line
// says (DR-0062 §12「解決済みのスレッドの吹き出しの畳み」, P36, P37).
//
// The one place that decides it for every kind of item (DR-0068 §5): an item
// says what it is (FoldSubject) and its wrapper reads only what this answers.
// Pure, per DR-0005 §1.
import type { TimelineFilter } from "./locator.ts";

/** An item that folds to one line, as far as folding goes: what decides it
 * folds, the text whose start its line shows, and the bubble whose frame the
 * line is drawn in. */
export type FoldSubject = {
  /** An item of a comment thread (DR-0062 §6): a person's comment, an
   * agent's reply, a btw's question and answer. */
  kind: "comment-thread";
  /** The cid of its comment (a btw's: its question's). */
  cid: string;
  /** Whether its thread is resolved. */
  resolved: boolean;
  /** The text its line starts (a person's comment's and a btw question's
   * body, an agent's reply's body), as written. */
  text: string;
  /** The bubble it is: a person's comment (at the person's side) or an
   * agent's reply. */
  frame: FoldFrame;
};

export type FoldFrame = "comment" | "reply";

/** What an item that can fold is on this view.
 * - `none`: it does not fold now; what opened it is forgotten (folded again
 *   from its line, DR-0062 §12)
 * - `filtered`: it folds, but not under this filter (P36); what opened it is
 *   kept
 * - `folded`: it is its one-line bubble until opened (by the key) */
export type ItemFold =
  | { state: "none"; key: string }
  | { state: "filtered"; key: string }
  | { state: "folded"; key: string; line: string; frame: FoldFrame };

/** The key a comment thread's item is opened by: its cid's (DR-0068 §5). */
export function commentFoldKey(cid: string): string {
  return `item-fold:c:${cid}`;
}

/** The start of `text` its folded line shows (DR-0062 §12): from its head,
 * each run of spaces and line breaks one space, markdown's marks kept. Where
 * the line ends is the bubble's width's (CSS cuts it). */
function foldStart(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

export function itemFoldOf(subject: FoldSubject, filter: TimelineFilter | null): ItemFold {
  const key = commentFoldKey(subject.cid);
  if (!subject.resolved) return { state: "none", key };
  if (filter !== null) return { state: "filtered", key };
  const start = foldStart(subject.text);
  return {
    state: "folded",
    key,
    line: start === "" ? "✅ 解決済み:" : `✅ 解決済み: ${start}`,
    frame: subject.frame,
  };
}
