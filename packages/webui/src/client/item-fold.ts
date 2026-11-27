// Which items of the Timeline fold to a bubble of one line, and what the line
// says (DR-0062 §12「解決済みのスレッドの吹き出しの畳み」, P36, P37; DR-0068 §5).
//
// The one place that decides it for every kind of item (DR-0068 §5): an item
// says what it is and the state that folds it (FoldSubject), and its wrapper
// reads only what this answers. Pure, per DR-0005 §1.
import type { TimelineFilter } from "./locator.ts";

/** An item that folds to one line, as far as folding goes: its kind, the
 * state that folds it, and the text whose start its line shows. */
export type FoldSubject =
  | {
      /** An item of a comment thread (DR-0062 §6): a person's comment, an
       * agent's reply, a btw's question and answer. Folds while its thread
       * is resolved. */
      kind: "comment-thread";
      /** The cid of its comment (a btw's: its question's). */
      cid: string;
      resolved: boolean;
      /** The text its line starts (a person's comment's and a btw question's
       * body, an agent's reply's body), as written. */
      text: string;
      /** The bubble it is: a person's comment (at the person's side) or an
       * agent's reply. */
      frame: "comment" | "reply";
    }
  | {
      /** An agent's response's bubble (DR-0068 §2): folds while the person
       * has marked it read. */
      kind: "response";
      /** The uuid of its message. */
      uuid: string;
      read: boolean;
      /** Its body's text. */
      text: string;
    }
  | {
      /** A say's bubble (DR-0068 §3): folds while it is not unread. */
      kind: "say";
      /** The id of its call's tool_use. */
      toolUseId: string;
      read: boolean;
      /** What it speaks. */
      text: string;
    }
  | {
      /** A request for permission's bubble (DR-0068 §3): folds while it is
       * not unread. */
      kind: "permit";
      /** The id of its call's tool_use. */
      toolUseId: string;
      read: boolean;
      /** The action it says was blocked. */
      text: string;
    };

/** The bubble an item's folded line is drawn in the frame of. */
export type FoldFrame = "comment" | "reply" | "response" | "say" | "permit";

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

/** The key a response's bubble is opened by: its message's uuid's. */
export function responseFoldKey(uuid: string): string {
  return `item-fold:u:${uuid}`;
}

/** The key a say's or a request's bubble is opened by: its call's tool_use
 * id's. */
export function toolFoldKey(toolUseId: string): string {
  return `item-fold:t:${toolUseId}`;
}

/** The start of `text` its folded line shows (DR-0062 §12): from its head,
 * each run of spaces and line breaks one space, markdown's marks kept. Where
 * the line ends is the bubble's width's (CSS cuts it). */
function foldStart(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

/** What folds `subject`, by its kind: its key, whether its state folds it,
 * the words its line starts with, and its frame. */
function foldingOf(subject: FoldSubject): {
  key: string;
  folds: boolean;
  label: string;
  frame: FoldFrame;
} {
  switch (subject.kind) {
    case "comment-thread":
      return {
        key: commentFoldKey(subject.cid),
        folds: subject.resolved,
        label: "✅ 解決済み:",
        frame: subject.frame,
      };
    case "response":
      return {
        key: responseFoldKey(subject.uuid),
        folds: subject.read,
        label: "✅ 既読:",
        frame: "response",
      };
    case "say":
    case "permit":
      return {
        key: toolFoldKey(subject.toolUseId),
        folds: subject.read,
        label: "✅ 既読:",
        frame: subject.kind,
      };
  }
}

export function itemFoldOf(subject: FoldSubject, filter: TimelineFilter | null): ItemFold {
  const { key, folds, label, frame } = foldingOf(subject);
  if (!folds) return { state: "none", key };
  if (filter !== null) return { state: "filtered", key };
  const start = foldStart(subject.text);
  return { state: "folded", key, line: start === "" ? label : `${label} ${start}`, frame };
}
