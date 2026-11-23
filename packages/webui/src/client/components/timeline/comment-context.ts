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
  openForm: (target: CommentFormTarget, opener: HTMLElement | null) => void;
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
 * item's comments (comment-view.ts commentTargetKey), and the anchor: the
 * item, a quote in it, or (a comment's bubble) that comment. Provided by the
 * item that can be commented on. */
export interface CommentTarget {
  key: string;
  anchor: Exclude<CommentAddAnchor, { kind: "file" }>;
}

/** What the comment the form writes is on: a Timeline item's (CommentTarget),
 * or a quote in a file the Files tab shows. `key` tells one form from
 * another (a form on another key starts empty). */
export interface CommentFormTarget {
  key: string;
  anchor: CommentAddAnchor;
}
export const CommentTargetContext = createContext<CommentTarget | null>(null);

/** The comment form open: what the comment is on, and the button that opened
 * it (null when it is gone from the page). */
export interface OpenCommentForm {
  target: CommentFormTarget;
  opener: HTMLElement | null;
}

/** A press that asks for something once: what, and a count that tells a
 * second press of the same from the first. */
export interface Asked<T> {
  value: T;
  seq: number;
}

/** What a session's screen holds of its comments for its Timeline and its
 * Files alike (DR-0062 §3, §12, §13): the one comment form open (a comment
 * on a Timeline item or on a quote in a file), what the 💬 filter is to
 * select (a 💬 pressed in either), the quote Files is to bring into view
 * (「コメントした場所へ」 of a comment on a file), and the comments on a file
 * whose quote the file drawn now does not have (P20). */
export interface SessionComments {
  form: OpenCommentForm | null;
  openForm: (target: CommentFormTarget, opener: HTMLElement | null) => void;
  closeForm: () => void;
  /** The key of the 💬 filter's selection (comment-view.ts
   * commentTargetKey / commentSelectionKey), null when none. */
  selected: Asked<string> | null;
  select: (key: string | null) => void;
  /** The comment on a file whose place Files is to show (null: none, or
   * shown). */
  reveal: Asked<string> | null;
  revealFile: (cid: string | null) => void;
  /** The session's root (`repo_root ?? cwd`, the Files tab's paths are
   * relative to it) and cwd (a comment names a file relative to it): the
   * session's, undefined until known. */
  root: string | undefined;
  cwd: string | undefined;
  lostFiles: ReadonlySet<string>;
  /** The comments on a file a viewer of it does not find again (null: the
   * viewer is gone), by the viewer. */
  reportLostFile: (viewer: object, lost: readonly string[] | null) => void;
}
export const SessionCommentsContext = createContext<SessionComments | null>(null);
