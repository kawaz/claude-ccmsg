// What a session's Timeline holds of its comments, and what an item that can
// be commented on is (DR-0062 §2, §3, §12): the contexts comments.tsx and
// comment-quotes.tsx read.
import { createContext } from "preact";
import type { CommentAddAnchor, CommentRecord, ThreadState } from "@ccmsg/protocol";

/** What the Timeline holds of its session's comments, and the comment form
 * open in it. Null outside a session's own Timeline (an agent's Timeline has
 * no comments, DR-0062 §2). */
export interface TimelineComments {
  sid: string;
  records: ReadonlyMap<string, CommentRecord>;
  threads: ReadonlyMap<string, ThreadState> | undefined;
  /** How many of the person's comments each item has (commentCounts). */
  counts: ReadonlyMap<string, number>;
  /** The comment form open (DR-0062 §3), floating over the Timeline. */
  form: OpenCommentForm | null;
  /** Opens the form of a comment on `target`; `opener` (the button pressed)
   * takes the focus back when it closes. */
  openForm: (target: CommentTarget, opener: HTMLElement | null) => void;
  closeForm: () => void;
  /** Move to the row `uuid` in the Timeline (DR-0058 §6). */
  jumpToRow: (uuid: string) => void;
  /** The transcript row the comment or reply `cid` is drawn at: a person's
   * comment's once seen delivered, an agent's reply's `comment_reply` call
   * when the window holds it. */
  rowOf: (cid: string) => string | undefined;
  /** The item (its target key) whose 💬 was pressed: its comments are the
   * selected ones in the 💬 filter (DR-0062 §12). */
  selected: string | null;
  select: (key: string) => void;
  /** The bubbles that can be commented on, drawn now: each one's region
   * (the element its 返信 row is in) and what a comment on it is on. A choice
   * in a region makes a comment on a quote in it (comment-quotes.tsx). */
  regions: WeakMap<Element, CommentTarget>;
  /** The comments whose quote is not found again in a bubble drawn now
   * (DR-0062 §2): the 💬 filter says so. */
  lost: ReadonlySet<string>;
  /** A region's quotes not found (null: the region is gone). */
  reportLost: (region: Element, lost: readonly string[] | null) => void;
}
export const TimelineCommentsContext = createContext<TimelineComments | null>(null);

/** What a comment made on this item is on (DR-0062 §2): its key among the
 * item's comments (comment-view.ts commentTargetKey), and the anchor.
 * Provided by the item that can be commented on. */
export interface CommentTarget {
  key: string;
  anchor: CommentAddAnchor;
}
export const CommentTargetContext = createContext<CommentTarget | null>(null);

/** The comment form open: what the comment is on, and the button that opened
 * it (null when it is gone from the page). */
export interface OpenCommentForm {
  target: CommentTarget;
  opener: HTMLElement | null;
}
