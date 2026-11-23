// Where each item of the 💬 filter stands (DR-0062 §13, P10): the filter
// lists its items by thread, not by where their rows are in the transcript.
// A thread's first item keeps its place among the others; what replies to it
// (an agent's comment_reply, a person's reply to that, one not sent yet)
// follows right after it, each reply after what it answers, the replies to
// one item in the order of their time. An item whose reply-to is not listed
// (not read, gone) stands at its own place, as do the ones of no thread (a
// FAB's draft, a btw). Between two threads shown, a line (the first item
// shown of a thread carries it, the first thread shown none).
//
// Pure, per DR-0005 §1, as comment-view.ts beside it.
import type { CommentRecord } from "@ccmsg/protocol";
import { commentItemShown, type CommentItemKind, type CommentShow } from "./comment-view.ts";

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
}

/** Where one item stands: its place in the filter's list (the CSS `order`,
 * from 1), and whether a line stands above it (the first item shown of a
 * thread that is not the first thread shown). */
export interface ThreadPlace {
  order: number;
  sep: boolean;
}

/** When a record was made, for the order of the replies to one item: a
 * person's comment when it was sent (or written, not sent), a reply when it
 * was kept. */
function recordTime(record: CommentRecord | undefined): number {
  if (record === undefined) return Number.POSITIVE_INFINITY;
  const at = record.author === "user" ? (record.sent ?? record.written).at : record.written.at;
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? Number.POSITIVE_INFINITY : ms;
}

export function threadPlaces(
  items: readonly ListedItem[],
  records: ReadonlyMap<string, CommentRecord>,
  show: CommentShow,
): Map<string, ThreadPlace> {
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
  for (const list of children.values()) {
    list.sort((a, b) => time(a) - time(b) || (indexOf.get(a.key) ?? 0) - (indexOf.get(b.key) ?? 0));
  }
  const places = new Map<string, ThreadPlace>();
  let order = 0;
  let threadShown = false;
  const placed = new Set<string>();
  for (const root of roots) {
    // The thread, the root first and each reply after what it answers.
    const thread: ListedItem[] = [];
    const walk = (item: ListedItem) => {
      if (placed.has(item.key)) return;
      placed.add(item.key);
      thread.push(item);
      for (const child of children.get(item.key) ?? []) walk(child);
    };
    walk(root);
    let lineDrawn = false;
    for (const item of thread) {
      order += 1;
      const shown = commentItemShown(show, item);
      const sep = shown && !lineDrawn && threadShown;
      if (shown) lineDrawn = true;
      places.set(item.key, { order, sep });
    }
    if (lineDrawn) threadShown = true;
  }
  // None is left out: one not reached (no such thread can be made, a reply
  // answering an older cid) would stand last, a thread of its own.
  for (const item of items) {
    if (places.has(item.key)) continue;
    order += 1;
    const shown = commentItemShown(show, item);
    places.set(item.key, { order, sep: shown && threadShown });
    if (shown) threadShown = true;
  }
  return places;
}
