// Where each item of the 💬 filter stands (DR-0062 §13, P10): the filter
// lists its items by thread, not by where their rows are in the transcript.
// A thread's first item keeps its place among the others; what replies to it
// (an agent's comment_reply, a person's reply to that) follows right after
// it, each reply after what it answers, the replies to one item in the order
// of their time. An item whose reply-to is not listed (not read, gone) stands
// at its own place, as do the ones of no thread (a FAB's draft, a btw). What
// is not sent (kawaz 2026-11-24) stands apart from all that, at the bottom,
// whatever its time or thread: the unsent ones in the order written. Between
// two threads shown, and above the unsent ones, a line (the first item shown
// of a thread or of the unsent ones carries it, the first shown none).
//
// On the Timeline without a filter (DR-0062 §12): the agent's replies whose
// thread goes on further down, apart from them (「↓続きへ↓」).
//
// Pure, per DR-0005 §1, as comment-view.ts beside it.
import type { CommentRecord } from "@ccmsg/protocol";
import {
  commentItemShown,
  threadRootOf,
  type CommentItemKind,
  type CommentShow,
} from "./comment-view.ts";

/** An item of the 💬 filter, in the order the Timeline draws it (its rows
 * and its merged bubbles, by the transcript and by time). */
export interface ListedItem extends CommentItemKind {
  /** Its key among the filter's items. */
  key: string;
  /** The comment or reply it draws; absent for a FAB's draft and a btw. */
  cid?: string | undefined;
  /** The other records it draws (a btw's answers, with its question): a
   * reply to one of them follows this item. */
  also?: readonly string[] | undefined;
  /** It is of the agent's side (a `comment_reply`): shown only in a thread
   * the selection opens, when the person's comment it answers is listed. */
  agent?: boolean | undefined;
  /** When a FAB's draft was written, for the order of the unsent ones (a
   * comment's is its record's). */
  written?: string | undefined;
}

/** Where one item stands: its place in the filter's list (the CSS `order`,
 * from 1), whether it is shown (the same rule as the filter's CSS: its
 * boxes, and the agent's side only in an open thread), whether a line stands
 * above it (the first item shown of a thread that is not the first thread
 * shown), whether it is of the agent's side hidden until its thread opens
 * (`agent`: one answering a person's comment listed; one whose person's
 * comment is not listed has no other way to be seen, and stands shown at its
 * place) and whether its thread is open (the agent's side and a btw's answer
 * are shown only then), and the person's comment a press of it selects (none
 * for the agent's side and a FAB's draft). */
export interface ThreadPlace {
  order: number;
  shown: boolean;
  sep: boolean;
  agent: boolean;
  open: boolean;
  selects?: string | undefined;
}

/** When a record was made, for the order of the replies to one item: a
 * person's comment when it was sent (or written, not sent), a reply when it
 * was kept. */
function recordTime(record: CommentRecord | undefined): number {
  if (record === undefined) return Number.POSITIVE_INFINITY;
  return timeOf(record.author === "user" ? (record.sent ?? record.written).at : record.written.at);
}

/** A time of a record as a number to order by; one that does not read last. */
function timeOf(at: string | undefined): number {
  const ms = at === undefined ? Number.NaN : Date.parse(at);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

export function threadPlaces(
  items: readonly ListedItem[],
  records: ReadonlyMap<string, CommentRecord>,
  show: CommentShow,
  open: ReadonlySet<string> = new Set(),
): Map<string, ThreadPlace> {
  const openOf = (item: ListedItem): boolean =>
    item.cid !== undefined && open.has(threadRootOf(records, item.cid));
  /** Of the agent's side, under a person's comment listed: hidden until its
   * thread opens. */
  const closableOf = (item: ListedItem): boolean =>
    item.agent === true && parentOf(item) !== undefined;
  /** Shown: its boxes are on, and an agent's side only in an open thread. */
  const shownOf = (item: ListedItem): boolean =>
    commentItemShown(show, item) && (!closableOf(item) || openOf(item));
  const placeOf = (item: ListedItem, order: number, sep: boolean): ThreadPlace => ({
    order,
    shown: shownOf(item),
    sep,
    agent: closableOf(item),
    open: openOf(item),
    ...(item.agent === true || item.cid === undefined ? {} : { selects: item.cid }),
  });
  const indexOf = new Map(items.map((item, index) => [item.key, index] as const));
  const byCid = new Map<string, ListedItem>();
  for (const item of items) {
    for (const cid of [...(item.cid !== undefined ? [item.cid] : []), ...(item.also ?? [])]) {
      if (!byCid.has(cid)) byCid.set(cid, item);
    }
  }
  const parentOf = (item: ListedItem): ListedItem | undefined => {
    if (item.cid === undefined) return undefined;
    const anchor = records.get(item.cid)?.anchor;
    if (anchor?.kind !== "comment") return undefined;
    const parent = byCid.get(anchor.cid);
    return parent === undefined || parent.key === item.key ? undefined : parent;
  };
  const children = new Map<string, ListedItem[]>();
  const roots: ListedItem[] = [];
  for (const item of items) {
    const parent = parentOf(item);
    if (parent === undefined) roots.push(item);
    else children.set(parent.key, [...(children.get(parent.key) ?? []), item]);
  }
  const time = (item: ListedItem) =>
    item.cid === undefined ? Number.POSITIVE_INFINITY : recordTime(records.get(item.cid));
  const byIndex = (a: ListedItem, b: ListedItem) =>
    (indexOf.get(a.key) ?? 0) - (indexOf.get(b.key) ?? 0);
  for (const list of children.values()) list.sort((a, b) => time(a) - time(b) || byIndex(a, b));
  const places = new Map<string, ThreadPlace>();
  let order = 0;
  let threadShown = false;
  /** Places one thread's items in turn: a line above its first shown, unless
   * it is the first thread shown. */
  const placeThread = (thread: readonly ListedItem[]) => {
    let lineDrawn = false;
    for (const item of thread) {
      order += 1;
      const shown = shownOf(item);
      const sep = shown && !lineDrawn && threadShown;
      if (shown) lineDrawn = true;
      places.set(item.key, placeOf(item, order, sep));
    }
    if (lineDrawn) threadShown = true;
  };
  const placed = new Set<string>();
  // The unsent ones, taken out of their threads (a reply after them still
  // stands in its thread).
  const unsent: ListedItem[] = [];
  for (const root of roots) {
    // The thread, the root first and each reply after what it answers.
    const thread: ListedItem[] = [];
    const walk = (item: ListedItem) => {
      if (placed.has(item.key)) return;
      placed.add(item.key);
      (item.unsent ? unsent : thread).push(item);
      for (const child of children.get(item.key) ?? []) walk(child);
    };
    walk(root);
    placeThread(thread);
  }
  // None is left out: one not reached (no such thread can be made, a reply
  // answering an older cid) would stand after the threads, a thread of its
  // own.
  for (const item of items) {
    if (placed.has(item.key)) continue;
    placed.add(item.key);
    if (item.unsent) unsent.push(item);
    else placeThread([item]);
  }
  // At the bottom, the unsent ones in the order written, one line above them:
  // the order a send takes them in (stockedItems: written at the same moment,
  // a comment before a FAB's draft).
  const writtenOf = (item: ListedItem): number => {
    const record = item.cid === undefined ? undefined : records.get(item.cid);
    return timeOf(record !== undefined ? record.written.at : item.written);
  };
  const draftLast = (item: ListedItem): number => (item.kind === "draft" ? 1 : 0);
  placeThread(
    unsent.sort(
      (a, b) => writtenOf(a) - writtenOf(b) || draftLast(a) - draftLast(b) || byIndex(a, b),
    ),
  );
  return places;
}

/** The person's comment that continues the thread after the agent's reply
 * or btw answer `cid` (DR-0062 §12「↓続きへ↓」): of the comments sent that
 * reply to it (a btw's question too), the oldest. None while none is sent (a
 * comment not sent, or deleted, is not drawn on the Timeline). */
export function nextComment(
  records: ReadonlyMap<string, CommentRecord>,
  cid: string,
): string | undefined {
  let next: CommentRecord | undefined;
  for (const record of records.values()) {
    if (record.author !== "user" || record.status === "draft" || record.status === "deleted") {
      continue;
    }
    if (record.anchor.kind !== "comment" || record.anchor.cid !== cid) continue;
    if (next === undefined || recordTime(record) < recordTime(next)) next = record;
  }
  return next?.cid;
}

/** One of what the Timeline draws without a filter, in its order, as far as
 * a thread's continuation goes: a fold (「N items」, the agent's own work on
 * one line), or another item, with the comments, replies and btw answers it
 * draws. */
export type DrawnUnit = { fold: true } | { fold: false; cids: readonly string[] };

/** The agent's replies and btw answers drawn in `units` whose continuation
 * (nextComment) does not stand right below them, each with the row to move to
 * (`placeRow`, commentPlaceRow): the ones another item stands between, past
 * folds (DR-0062 §12「↓続きへ↓」). One whose continuation has no row to move
 * to is left out. */
export function continuationsApart(
  units: readonly DrawnUnit[],
  records: ReadonlyMap<string, CommentRecord>,
  placeRow: (cid: string) => string | undefined,
): Map<string, string> {
  const unitOf = new Map<string, number>();
  units.forEach((unit, index) => {
    if (unit.fold) return;
    for (const cid of unit.cids) if (!unitOf.has(cid)) unitOf.set(cid, index);
  });
  const apart = new Map<string, string>();
  units.forEach((unit, index) => {
    if (unit.fold) return;
    for (const cid of unit.cids) {
      const author = records.get(cid)?.author;
      if (author !== "agent" && author !== "btw") continue;
      const next = nextComment(records, cid);
      if (next === undefined) continue;
      const at = unitOf.get(next);
      if (at !== undefined && at > index && units.slice(index + 1, at).every((u) => u.fold)) {
        continue;
      }
      const row = placeRow(next);
      if (row !== undefined) apart.set(cid, row);
    }
  });
  return apart;
}

/** A person's comment's place among the person's comments of its thread
 * (DR-0062 §12, §13): the `at`-th of `of`. */
export interface ThreadNumber {
  at: number;
  of: number;
}

/** The numbers of the person's comments in the threads with two or more of
 * them (「1 / 3」, kawaz 2026-11-24): the comments not deleted (unsent ones
 * too), in the thread's order (each reply after what it answers, the replies
 * to one record by their time; an unsent one where it stands in its thread,
 * not at the bottom the 💬 filter puts it). An agent's reply or a btw answer
 * carries the number of the comment it answers. */
export function threadNumbers(
  records: ReadonlyMap<string, CommentRecord>,
): Map<string, ThreadNumber> {
  const indexOf = new Map([...records.keys()].map((cid, index) => [cid, index] as const));
  const children = new Map<string, CommentRecord[]>();
  const roots: CommentRecord[] = [];
  for (const record of records.values()) {
    const { anchor } = record;
    if (anchor.kind === "comment" && records.has(anchor.cid) && anchor.cid !== record.cid) {
      children.set(anchor.cid, [...(children.get(anchor.cid) ?? []), record]);
    } else {
      roots.push(record);
    }
  }
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        recordTime(a) - recordTime(b) || (indexOf.get(a.cid) ?? 0) - (indexOf.get(b.cid) ?? 0),
    );
  }
  const numbers = new Map<string, ThreadNumber>();
  const seen = new Set<string>();
  for (const root of roots) {
    const people: string[] = [];
    const walk = (record: CommentRecord) => {
      if (seen.has(record.cid)) return;
      seen.add(record.cid);
      if (record.author === "user" && record.status !== "deleted") people.push(record.cid);
      for (const child of children.get(record.cid) ?? []) walk(child);
    };
    walk(root);
    if (people.length < 2) continue;
    people.forEach((cid, index) => numbers.set(cid, { at: index + 1, of: people.length }));
  }
  return numbers;
}
