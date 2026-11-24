// What a session's Timeline holds of its comments, and what an item that can
// be commented on is (DR-0062 §2, §3, §12): the contexts comments.tsx and
// comment-quotes.tsx read.
import { createContext } from "preact";
import type { CommentAddAnchor, CommentRecord, ThreadState } from "@ccmsg/protocol";
import type { ThreadNumber } from "../../comment-threads.ts";

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
  /** Opens the form of a comment on `target` near `near` (FormNear);
   * `opener` (the button pressed) takes the focus back when it closes. */
  openForm: (target: CommentFormTarget, opener: HTMLElement | null, near: FormNear) => void;
  closeForm: () => void;
  /** Move to the row `uuid` in the Timeline (DR-0058 §6). */
  jumpToRow: (uuid: string) => void;
  /** The transcript row the comment, reply or btw answer `cid` is drawn at
   * or right after (comment-view.ts commentPlaceRow): where 「コメントした
   * 場所へ」 goes. */
  rowOf: (cid: string) => string | undefined;
  /** The row of the person's comment that continues the thread after the
   * agent's reply or btw answer `cid`, when another item stands between them
   * on the Timeline (comment-threads.ts continuationsApart): where
   * 「↓続きへ↓」 goes. */
  continuationOf: (cid: string) => string | undefined;
  /** The person's comments' numbers in their threads (comment-threads.ts
   * threadNumbers): 「1 / 3」 at their heads and their replies' heads. */
  numbers: ReadonlyMap<string, ThreadNumber>;
  /** The item (its target key) whose 💬 was pressed: its comments are the
   * selected ones in the 💬 filter (DR-0062 §12). */
  selected: string | null;
  /** Select `key`, or none (null: no thread open in the 💬 filter, §13). The
   * 💬 filter brings what is selected into view. */
  select: (key: string | null) => void;
  /** Select `key`, or none, by a press of a person's comment in the 💬
   * filter (§13, threadPressKey): the item `pressed` (the element pressed) is
   * in keeps its place on the screen as the thread opens or closes around
   * it. */
  press: (key: string | null, pressed: HTMLElement) => void;
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
  anchor: Exclude<CommentAddAnchor, { kind: "file" | "timing" }>;
}

/** What the comment the form writes is on: a Timeline item's (CommentTarget),
 * or a quote in a file the Files tab shows. `key` tells one form from
 * another (a form on another key starts empty). */
export interface CommentFormTarget {
  key: string;
  anchor: FormAnchor;
  /** Opened as a btw (the selection toolbar's btw, DR-0062 §3). */
  btw?: boolean;
}

/** What a comment the form writes is on: anything but the moment of the
 * conversation, which only the FAB's btw makes. */
export type FormAnchor = Exclude<CommentAddAnchor, { kind: "timing" }>;
export const CommentTargetContext = createContext<CommentTarget | null>(null);

/** What the comment form was opened from, where it is on the page (its
 * client rect when pressed), and which it is: the 返信 pressed (`reply`) or
 * the text chosen (`chosen`). The form comes out by it as DR-0062 §3 says for
 * each. */
export interface FormNear {
  top: number;
  bottom: number;
  left: number;
  right: number;
  from: "reply" | "chosen";
}

/** What the form opened from the box `rect`, `from` the 返信 or the text
 * chosen, comes out by (a DOMRect's fields are its prototype's, so they are
 * copied one by one). */
export function formNearOf(rect: DOMRect, from: FormNear["from"]): FormNear {
  return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, from };
}

/** The comment form open: what the comment is on, the button that opened it
 * (null when it is gone from the page), and what it was opened from. */
export interface OpenCommentForm {
  target: CommentFormTarget;
  opener: HTMLElement | null;
  near: FormNear;
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
  openForm: (target: CommentFormTarget, opener: HTMLElement | null, near: FormNear) => void;
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
