// Which items of the Timeline fold to their bubble cut to one line, and the
// label on the folded bubble's frame (DR-0062 §12「解決済みのスレッドの吹き出しの
// 畳み」, P36, P37; DR-0068 §5).
//
// The one place that decides it for every kind of item (DR-0068 §5): an item
// says what it is and the state that folds it (FoldSubject), and its wrapper
// reads only what this answers. Pure, per DR-0005 §1.
import type { TimelineFilter } from "./locator.ts";

/** An item that folds, as far as folding goes: its kind and the state that
 * folds it. */
export type FoldSubject =
  | {
      /** An item of a comment thread (DR-0062 §6): a person's comment, an
       * agent's reply, a btw's question and answer. Folds while its thread
       * is resolved. */
      kind: "comment-thread";
      /** The cid of its comment (a btw's: its question's). */
      cid: string;
      resolved: boolean;
    }
  | {
      /** An agent's response's bubble (DR-0068 §2): folds while the person
       * has marked it read. */
      kind: "response";
      /** The uuid of its message. */
      uuid: string;
      read: boolean;
    }
  | {
      /** A say's bubble (DR-0068 §3): folds while it is not unread. */
      kind: "say";
      /** The id of its call's tool_use. */
      toolUseId: string;
      read: boolean;
    }
  | {
      /** A request for permission's bubble (DR-0068 §3): folds while it is
       * not unread. */
      kind: "permit";
      /** The id of its call's tool_use. */
      toolUseId: string;
      read: boolean;
    };

/** What an item that can fold is on this view.
 * - `none`: it does not fold now; what opened it is forgotten (folded again
 *   from its line, DR-0062 §12)
 * - `filtered`: it folds, but not under this filter (P36); what opened it is
 *   kept
 * - `folded`: its bubble is cut to one line, with `label` on its frame, until
 *   opened (by the key) */
export type ItemFold =
  | { state: "none"; key: string }
  | { state: "filtered"; key: string }
  | { state: "folded"; key: string; label: string };

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

/** What folds `subject`, by its kind: its key, whether its state folds it and
 * the label on its frame. */
function foldingOf(subject: FoldSubject): { key: string; folds: boolean; label: string } {
  switch (subject.kind) {
    case "comment-thread":
      return { key: commentFoldKey(subject.cid), folds: subject.resolved, label: "✅解決済み" };
    case "response":
      return { key: responseFoldKey(subject.uuid), folds: subject.read, label: "✅既読" };
    case "say":
    case "permit":
      return { key: toolFoldKey(subject.toolUseId), folds: subject.read, label: "✅既読" };
  }
}

export function itemFoldOf(subject: FoldSubject, filter: TimelineFilter | null): ItemFold {
  const { key, folds, label } = foldingOf(subject);
  if (!folds) return { state: "none", key };
  if (filter !== null) return { state: "filtered", key };
  return { state: "folded", key, label };
}
