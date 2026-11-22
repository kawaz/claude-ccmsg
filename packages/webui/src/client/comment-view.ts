// What the Timeline draws of a session's comments (DR-0062 §12, §13): which
// rows are prompts of comments sent, how many comments each item has, which
// thread a comment is in and whether it is resolved, where an unsent or
// not-yet-seen comment stands, and the prompt the comments would be sent as.
//
// Pure, per DR-0005 §1, as btw-slots.ts beside it.
import {
  commentBlockOf,
  commentOnlyBlocks,
  commentsPromptText,
  type CommentBlock,
  type CommentRecord,
  type ThreadState,
  type UserComment,
} from "@ccmsg/protocol";
import { readStorage, writeStorage } from "./storage.ts";
import type { TurnLine } from "./transcript-model.ts";

/** A person's prompt row's text, as its bubble draws it. */
export function lineText(line: TurnLine): string {
  return line.segments.flatMap((seg) => (seg.kind === "text" ? [seg.text] : [])).join("\n\n");
}

/** The comment blocks of a person's prompt row that is nothing but comments
 * sent (DR-0062 §12): the Timeline draws it as their comment bubbles. Null
 * for any other row. */
export function commentBlocksOfLine(line: TurnLine): CommentBlock[] | null {
  if (line.role !== "user") return null;
  return commentOnlyBlocks(lineText(line));
}

/** The kind of item a comment on a whole message is on, as the agent reads
 * it (DR-0062 §4). */
export function onOfBoundary(kind: "user-prompt" | "assistant-response"): string {
  return kind === "user-prompt" ? "ユーザの発言" : "応答";
}

/** Whether `record` is a person's comment that is not sent yet. */
export function isDraft(record: CommentRecord): record is UserComment {
  return record.author === "user" && record.status === "draft";
}

/** How many of a session's comments are not sent: the 💬 badge's number
 * (DR-0062 §13). */
export function unsentCount(records: Iterable<CommentRecord>): number {
  let count = 0;
  for (const record of records) if (isDraft(record)) count += 1;
  return count;
}

/** The first cid of the thread `cid` is in (DR-0062 §6): followed up
 * through the comments it replies to. */
export function threadRootOf(records: ReadonlyMap<string, CommentRecord>, cid: string): string {
  let at = cid;
  for (let depth = 0; depth < records.size; depth += 1) {
    const anchor = records.get(at)?.anchor;
    if (anchor?.kind !== "comment" || !records.has(anchor.cid)) return at;
    at = anchor.cid;
  }
  return at;
}

/** Whether the thread `cid` is in is resolved. */
export function threadResolved(
  records: ReadonlyMap<string, CommentRecord>,
  threads: ReadonlyMap<string, ThreadState> | undefined,
  cid: string,
): boolean {
  return threads?.get(threadRootOf(records, cid))?.resolved_at !== undefined;
}

/** The last record of the thread `cid` is in, in the order made: what the
 * person has seen when resolving it (`seen_cid`). */
export function threadLastCid(records: ReadonlyMap<string, CommentRecord>, cid: string): string {
  const root = threadRootOf(records, cid);
  let last = root;
  for (const record of records.values()) {
    if (threadRootOf(records, record.cid) === root) last = record.cid;
  }
  return last;
}

/** Whether the thread `cid` is in can be resolved now (DR-0062 §6): its
 * first comment is sent and none of it waits unsent. */
export function threadResolvable(
  records: ReadonlyMap<string, CommentRecord>,
  cid: string,
): boolean {
  const root = threadRootOf(records, cid);
  for (const record of records.values()) {
    if (threadRootOf(records, record.cid) === root && isDraft(record)) return false;
  }
  return true;
}

/** What an item's comments are counted by: its row's uuid (a comment on the
 * message or a quote in it), or a comment's cid (a reply to it). */
export function commentTargetKey(anchor: CommentRecord["anchor"]): string | null {
  switch (anchor.kind) {
    case "message":
    case "selection":
      return `u:${anchor.uuid}`;
    case "comment":
      return `c:${anchor.cid}`;
    case "timing":
    case "file":
      return null;
  }
}

/** How many of the person's comments each item has (DR-0062 P8), by
 * commentTargetKey. */
export function commentCounts(records: Iterable<CommentRecord>): Map<string, number> {
  const counts = new Map<string, number>();
  for (const record of records) {
    if (record.author !== "user") continue;
    const key = commentTargetKey(record.anchor);
    if (key !== null) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return counts;
}

/** A person's comment drawn from its record rather than the transcript:
 * sent and not seen in the transcript yet, or (under the 💬 filter) not
 * sent. */
export interface PlacedComment {
  comment: UserComment;
  /** The row it stands after. */
  after: string | undefined;
  ts: string;
}

/** The person's comments sent and not seen delivered yet (DR-0062 §11): they
 * are drawn from their records at the point they were sent until the
 * transcript has their row. */
export function pendingComments(records: Iterable<CommentRecord>): PlacedComment[] {
  const placed: PlacedComment[] = [];
  for (const record of records) {
    if (record.author !== "user" || record.sent === undefined) continue;
    if (
      record.status !== "sending" &&
      record.status !== "sent" &&
      record.status !== "unconfirmed"
    ) {
      continue;
    }
    placed.push({ comment: record, after: record.sent.after_uuid, ts: record.sent.at });
  }
  return placed;
}

/** The person's comments not sent (the 💬 filter's cards, DR-0062 P10): one
 * on an item stands after it, a reply after what it answers (the row its
 * comment was seen in, else where it was sent), and any other where the
 * conversation stood when it was written. */
export function unsentComments(records: ReadonlyMap<string, CommentRecord>): PlacedComment[] {
  const placed: PlacedComment[] = [];
  for (const record of records.values()) {
    if (!isDraft(record)) continue;
    const { anchor } = record;
    let after: string | undefined;
    if (anchor.kind === "message" || anchor.kind === "selection") after = anchor.uuid;
    else if (anchor.kind === "comment") {
      const replied = records.get(anchor.cid);
      after =
        replied?.author === "user"
          ? (replied.row_uuid ?? replied.sent?.after_uuid)
          : replied?.sent?.after_uuid;
    } else after = record.written.after_uuid;
    placed.push({ comment: record, after, ts: record.written.at });
  }
  return placed;
}

/** The unsent comments (btw ones apart), oldest first: what 「全部送る」
 * sends, in its order (DR-0062 §11). */
export function sendOrder(records: ReadonlyMap<string, CommentRecord>): UserComment[] {
  return [...records.values()]
    .filter((record): record is UserComment => isDraft(record) && !record.btw)
    .sort((a, b) => Date.parse(a.written.at) - Date.parse(b.written.at));
}

/** The prompt the unsent comments would reach the agent as (the preview area,
 * DR-0062 §13): the same text the daemon sends. */
export function previewPrompt(
  records: ReadonlyMap<string, CommentRecord>,
  comments: readonly UserComment[],
): string {
  return commentsPromptText(
    comments.map((comment) => commentBlockOf(comment, (cid) => records.get(cid))),
  );
}

/** Where the comment form's 「今すぐ送る」 is kept, per session (DR-0062 §3). */
function sendNowKey(sid: string): string {
  return `ccmsg.comments.sendNow.${sid}`;
}

/** Whether the comment form of session `sid` sends at once (off until set). */
export function readSendNow(sid: string): boolean {
  return readStorage(sendNowKey(sid)) === "1";
}

export function writeSendNow(sid: string, on: boolean): void {
  writeStorage(sendNowKey(sid), on ? "1" : "0");
}
