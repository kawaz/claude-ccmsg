// What the Timeline draws of a session's comments (DR-0062 §12, §13): which
// rows are prompts of comments sent, how many comments each item has, which
// thread a comment is in and whether it is resolved, where an unsent or
// not-yet-seen comment or a FAB's draft stands, what the 💬 filter's head
// shows, and what its 全部送信 sends.
//
// Pure, per DR-0005 §1, as btw-slots.ts beside it.
import * as v from "valibot";
import {
  commentOnlyBlocks,
  ErrorCode,
  msgStartWithOf,
  type BtwStartReason,
  type CommentBlock,
  type CommentRecord,
  type CommentSendError,
  type ErrorResponse,
  type PromptDraftRecord,
  type PromptDraftStatus,
  type QueueSendItem,
  type QueueSendRefusal,
  type QueueSendResult,
  type AgentReply,
  type ThreadState,
  type UserComment,
  type UserCommentStatus,
  type UserMessageKind,
} from "@ccmsg/protocol";
import { REASON_DETAIL } from "./components/session-input.ts";
import {
  isUserSpeechKind,
  parseSystemMessageFields,
  type CcmsgMessage,
  type ParsedLine,
  type TurnLine,
} from "./transcript-model.ts";

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

/** What a comment on a whole item of the Timeline is on, as the agent reads
 * it: the start of the text the Timeline heads it with (the block's
 * `msg_start_with`, DR-0062 §4). */
export interface ItemCommentOn {
  msg_start_with: string;
}

function itemOn(text: string): ItemCommentOn {
  return { msg_start_with: msgStartWithOf(text) };
}

/** What a comment on a ccmsg message's bubble is on. */
export function commentOnOfCcmsg(message: CcmsgMessage): ItemCommentOn {
  return itemOn(message.msg);
}

/** What a comment on the main conversation's response is on (DR-0062 §2):
 * the start of its text. */
export function commentOnOfResponse(line: TurnLine): ItemCommentOn {
  return itemOn(lineText(line));
}

/** What a comment on an item of a fold is on (DR-0062 §2): an instruction to
 * a subagent or teammate (SendMessage, Agent), and what one answers. Null for
 * any other row (a tool's call or result, thinking alone, a meta or
 * unreadable row, a ccmsg row, which is commented on per message): no comment
 * is made on it. */
export function commentOnOfFoldLine(line: ParsedLine): ItemCommentOn | null {
  if (line.kind !== "turn") return null;
  if (line.role === "user" && line.userMessageKind && !isUserSpeechKind(line.userMessageKind)) {
    return commentOnOfSystemMessage(line.userMessageKind, line);
  }
  for (const segment of line.segments) {
    switch (segment.kind) {
      case "thinking":
      case "thinking-hidden":
        continue;
      case "agent-send":
        return itemOn(segment.summary ?? segment.message);
      case "agent-spawn":
        return itemOn(segment.description || segment.prompt);
      default:
        return null;
    }
  }
  return null;
}

/** A subagent's or teammate's answer (a task-notification, a
 * teammate-message): the text its item heads with. Null for any other
 * system-origin row. */
function commentOnOfSystemMessage(kind: UserMessageKind, line: TurnLine): ItemCommentOn | null {
  const raw = line.segments.flatMap((seg) => (seg.kind === "text" ? [seg.text] : [])).join("\n");
  const rich = parseSystemMessageFields(kind, raw);
  if (rich.display === "peer") {
    const peer = rich.relays.find((relay) => relay.category !== "idle") ?? rich.relays[0];
    return peer === undefined ? null : itemOn(peer.summary ?? peer.body);
  }
  if (kind === "task-notification" && rich.display === "fields") {
    return itemOn(rich.heading ?? raw);
  }
  return null;
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

/** What the key of the 💬 filter's selection is when one comment is
 * selected (its quote's 💬 pressed, DR-0062 §12), beside an item's
 * (commentTargetKey, all the comments on it). */
export function commentSelectionKey(cid: string): string {
  return `one:${cid}`;
}

/** Whether the comment `cid` on `anchor` is selected by `selected` (the
 * 💬 filter's selection): it is the one selected, or it is on the item
 * selected. */
export function commentSelected(
  selected: string | null,
  anchor: CommentRecord["anchor"],
  cid: string | undefined,
): boolean {
  if (selected === null) return false;
  return (
    selected === commentTargetKey(anchor) ||
    (cid !== undefined && selected === commentSelectionKey(cid))
  );
}

/** A bubble whose quotes are found again (DR-0062 §12): a message (its row
 * and the start of it, as more than one message can be drawn of one row),
 * or a comment (its cid). */
export type QuoteTarget =
  | { kind: "message"; uuid: string; msg_start_with: string }
  | { kind: "comment"; cid: string };

/** The quote target of a bubble on the comment `cid`, else the message of
 * row `uuid` that starts with `msgStartWith`. */
export function quoteTargetOf(
  cid: string | undefined,
  uuid: string | undefined,
  msgStartWith: string | undefined,
): QuoteTarget {
  return cid !== undefined
    ? { kind: "comment", cid }
    : { kind: "message", uuid: uuid ?? "", msg_start_with: msgStartWith ?? "" };
}

/** A quote of a person's comment on a bubble: its cid, and what it is found
 * again by (comment-quote.ts findQuote). */
export interface CommentQuote {
  cid: string;
  quote: { text: string; before: string; after: string; start?: number | undefined };
}

/** The quotes the person's comments on `target` are on (DR-0062 §2, §12):
 * a choice in the message (a `selection` anchor of its row and start), or in
 * the comment (a `comment` anchor of its cid with a text chosen). Not sent
 * ones too, as the item's 💬 counts them (P8); not deleted ones. */
export function quotesOn(
  records: ReadonlyMap<string, CommentRecord>,
  target: QuoteTarget,
): CommentQuote[] {
  const quotes: CommentQuote[] = [];
  for (const record of records.values()) {
    if (record.author !== "user" || record.status === "deleted") continue;
    const { anchor } = record;
    if (
      target.kind === "message" &&
      anchor.kind === "selection" &&
      anchor.uuid === target.uuid &&
      anchor.msg_start_with === target.msg_start_with
    ) {
      quotes.push({
        cid: record.cid,
        quote: {
          text: anchor.text,
          before: anchor.before,
          after: anchor.after,
          start: anchor.start,
        },
      });
    } else if (
      target.kind === "comment" &&
      anchor.kind === "comment" &&
      anchor.cid === target.cid &&
      anchor.text !== undefined
    ) {
      quotes.push({
        cid: record.cid,
        quote: {
          text: anchor.text,
          before: anchor.before ?? "",
          after: anchor.after ?? "",
          start: anchor.start,
        },
      });
    }
  }
  return quotes;
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

/** The person's comments sending, sent and not seen delivered yet, or not
 * known (DR-0062 §11): they are drawn from their records until the transcript
 * has their row, so none is out of both the unsent list and the Timeline. One
 * stands at the point it was sent, or, while it has none (waiting its turn in
 * the session's line, or left unknown when the daemon stopped), where it was
 * written (§2). */
export function pendingComments(records: Iterable<CommentRecord>): PlacedComment[] {
  const placed: PlacedComment[] = [];
  for (const record of records) {
    // A btw is drawn with its answer (btw-slots.ts placedBtws).
    if (record.author !== "user" || record.btw) continue;
    if (
      record.status !== "sending" &&
      record.status !== "sent" &&
      record.status !== "unconfirmed"
    ) {
      continue;
    }
    const point = record.sent ?? record.written;
    placed.push({ comment: record, after: point.after_uuid, ts: point.at });
  }
  return placed;
}

/** The person's comments delivered whose row the window does not hold
 * (`inWindow`, the cids of the comment rows read): the 💬 filter draws them
 * from their records at their time (DR-0062 §13 「届いたコメントバブルもここに
 * 出る」, P10), as it does the other filters' items outside the window. */
export function deliveredOutside(
  records: Iterable<CommentRecord>,
  inWindow: ReadonlySet<string>,
): PlacedComment[] {
  const placed: PlacedComment[] = [];
  for (const record of records) {
    if (record.author !== "user" || record.status !== "delivered") continue;
    if (inWindow.has(record.cid)) continue;
    const point = record.sent ?? record.written;
    placed.push({ comment: record, after: record.row_uuid, ts: point.at });
  }
  return placed;
}

/** The start of what the record `cid` says (DR-0062 §4): a person's
 * comment's or a btw's answer's text, or the start an agent's reply was kept
 * with (its text is the transcript's). Undefined for a cid the session has
 * no record of. */
export function recordQuoteOf(
  records: ReadonlyMap<string, CommentRecord>,
  cid: string,
): string | undefined {
  const record = records.get(cid);
  if (record === undefined) return undefined;
  return record.author === "agent" ? record.body_start : msgStartWithOf(record.body);
}

/** An agent's reply drawn from its record rather than the transcript (the
 * 💬 filter's, outside the window). */
export interface PlacedReply {
  reply: AgentReply;
  ts: string;
}

/** The agent's replies whose `comment_reply` row the window does not hold
 * (`inWindow`, the cids of the replies read): the 💬 filter draws them from
 * their records at the time they were kept, with the start of their body for
 * text (DR-0062 §13 「窓の外のエージェントの返信は記録の body_start で出す」,
 * P10). */
export function repliesOutside(
  records: Iterable<CommentRecord>,
  inWindow: ReadonlySet<string>,
): PlacedReply[] {
  const placed: PlacedReply[] = [];
  for (const record of records) {
    if (record.author !== "agent" || inWindow.has(record.cid)) continue;
    placed.push({ reply: record, ts: record.written.at });
  }
  return placed;
}

/** The person's comments not sent (the 💬 filter's, DR-0062 P10): one
 * on an item stands after it, a reply after what it answers (the row its
 * comment was seen in, else where it was sent; an agent's reply's row), and
 * any other where the conversation stood when it was written. */
export function unsentComments(
  records: ReadonlyMap<string, CommentRecord>,
  /** The row an agent's reply's `comment_reply` call is in, when the window
   * holds it. */
  replyRow: (cid: string) => string | undefined = () => undefined,
): PlacedComment[] {
  const placed: PlacedComment[] = [];
  for (const record of records.values()) {
    // An unsent btw is drawn as a btw (btw-slots.ts placedBtws).
    if (!isDraft(record) || record.btw) continue;
    const { anchor } = record;
    let after: string | undefined;
    if (anchor.kind === "message" || anchor.kind === "selection") after = anchor.uuid;
    else if (anchor.kind === "comment") {
      const replied = records.get(anchor.cid);
      // An agent's reply stands at its call's row, else where the
      // conversation stood when it was kept (it has no send of its own).
      after =
        replied?.author === "user"
          ? (replied.row_uuid ?? replied.sent?.after_uuid)
          : replied?.author === "agent"
            ? (replyRow(replied.cid) ?? replied.written.after_uuid)
            : replied?.sent?.after_uuid;
    } else after = record.written.after_uuid;
    placed.push({ comment: record, after, ts: record.written.at });
  }
  return placed;
}

/** The check boxes of the 💬 filter's head, in their order (DR-0062 §13):
 * what is sent, the comments and their replies, the btws, the resolved
 * threads. */
export const COMMENT_SHOW_KEYS = ["sent", "comment", "btw", "resolved"] as const;
export type CommentShowKey = (typeof COMMENT_SHOW_KEYS)[number];
export type CommentShow = Readonly<Record<CommentShowKey, boolean>>;

/** What the 💬 filter shows each time it is entered (not kept). */
export const COMMENT_SHOW_DEFAULT: CommentShow = {
  sent: true,
  comment: true,
  btw: true,
  resolved: false,
};

/** The `data-comment-show` of the Timeline's list: the keys checked, as the
 * words its CSS looks for (`~=`). */
export function commentShowTokens(show: CommentShow): string {
  return COMMENT_SHOW_KEYS.filter((key) => show[key]).join(" ");
}

/** What an item of the 💬 filter is, as its head's boxes see it: a comment
 * (or a reply), a btw, or a FAB's draft; not sent; of a resolved thread. */
export interface CommentItemKind {
  kind: "comment" | "btw" | "draft";
  unsent: boolean;
  resolved: boolean;
}

/** Whether the 💬 filter shows an item under `show` (the rule its CSS draws
 * by, `data-comment-show`): what is sent only with `sent`, a comment only
 * with `comment` and a btw only with `btw` (a FAB's draft whatever those
 * two are), a resolved thread only with `resolved`. */
export function commentItemShown(show: CommentShow, item: CommentItemKind): boolean {
  return (
    (item.unsent || show.sent) &&
    (item.kind === "draft" || show[item.kind]) &&
    (!item.resolved || show.resolved)
  );
}

/** The unsent items 全部送信 sends (DR-0062 §11, §13): the ones shown under
 * `show`. The comments come first, in the order written (a btw one apart: it
 * goes to a fork, not in this prompt), then the FAB's queued drafts, which no
 * box hides, in the order put. */
export function sendAllItems(
  records: ReadonlyMap<string, CommentRecord>,
  threads: ReadonlyMap<string, ThreadState> | undefined,
  drafts: readonly PromptDraftRecord[],
  show: CommentShow,
): QueueSendItem[] {
  const comments = [...records.values()]
    .filter(
      (record): record is UserComment =>
        isDraft(record) &&
        !record.btw &&
        commentItemShown(show, {
          kind: "comment",
          unsent: true,
          resolved: threadResolved(records, threads, record.cid),
        }),
    )
    .sort((a, b) => Date.parse(a.written.at) - Date.parse(b.written.at));
  return [
    ...comments.map(
      (comment): QueueSendItem => ({
        kind: "comment",
        cid: comment.cid,
        seen_updated_at: comment.updated_at,
      }),
    ),
    ...drafts
      .filter((draft) => draft.status === "queued")
      .map(
        (draft): QueueSendItem => ({
          kind: "draft",
          id: draft.id,
          seen_updated_at: draft.updated_at,
        }),
      ),
  ];
}

/** A FAB's draft listed in the 💬 filter (DR-0062 P10): it has no place of
 * its own, so it stands where the conversation stood when it was sent, or,
 * not sent, when it was written (as a comment drawn from its record does). */
export interface PlacedDraft {
  draft: PromptDraftRecord;
  after: string | undefined;
  ts: string;
}

export function placedDrafts(drafts: readonly PromptDraftRecord[]): PlacedDraft[] {
  return drafts.map((draft) => {
    const point = draft.sent ?? draft.written;
    return { draft, after: point.after_uuid, ts: point.at };
  });
}

/** What a FAB's draft op that was refused means to the person (DR-0062
 * §15): the words of one code differ by what was asked. */
export function promptQueueErrorText(
  op: "add" | "update" | "delete" | "settle",
  error: ErrorResponse["error"],
): string {
  switch (error.code) {
    case "request_timeout":
    case "connection_closed":
      return "daemon から返事が来なかった。どうなったかは 💬 のフィルタで確かめる";
    case ErrorCode.conflict:
      return "別の画面で先に直された・送られたため変えなかった。今の内容を見てからやり直す";
    case ErrorCode.not_found:
      return op === "add" || op === "update"
        ? "添付のファイルが見つからない (アップロードし直す) か、下書きが無くなった"
        : "その下書きが見つからない (送られたか、消された)";
    case ErrorCode.invalid_args:
      return op === "settle"
        ? "届いたか分からない下書きではなくなったため変えなかった"
        : op === "add"
          ? `キューに置けなかった: ${error.msg}`
          : `直せなかった (送信中・送った下書きは直さない): ${error.msg}`;
    case ErrorCode.session_not_found:
      return "このセッションが daemon に見つからない";
    case ErrorCode.state_not_writable:
      return "下書きを保存できなかった (daemon が state dir に書けない)。何も変えていない";
    default:
      return `daemon が受け付けなかった (${error.code})`;
  }
}

/** The FAB's drafts of a session as the 💬 filter lists them (DR-0062
 * §13, §15): the ones not sent yet or not known to be, in the order put. */
export function listedDrafts(
  drafts: ReadonlyMap<string, PromptDraftRecord> | undefined,
): PromptDraftRecord[] {
  return drafts === undefined ? [] : [...drafts.values()].filter((d) => d.status !== "sent");
}

/** The FAB's drafts a plain send of the FAB takes along before its own text
 * (DR-0062 §15): the ones that may be sent (`queued`), oldest first. */
export function queuedDraftsOldestFirst(
  drafts: ReadonlyMap<string, PromptDraftRecord> | undefined,
): PromptDraftRecord[] {
  return drafts === undefined
    ? []
    : [...drafts.values()]
        .filter((d) => d.status === "queued")
        .sort((a, b) => a.written.at.localeCompare(b.written.at));
}

/** A comment's status as the person reads it. */
export function commentStatusWord(status: UserCommentStatus): string {
  switch (status) {
    case "draft":
      return "未送信";
    case "sending":
      return "送信中";
    case "sent":
      return "送った";
    case "delivered":
      return "届いた";
    case "unconfirmed":
      return "届いたか分からない";
    case "deleted":
      return "消した";
  }
}

/** Why a btw comment's fork was not started, with what to do (DR-0062 §14). */
const BTW_START_DETAIL: Record<BtwStartReason, string> = {
  session_not_found:
    "daemon がこのセッションの場所 (cwd) を知らないので btw の fork を起こせなかった",
  project_auto_mode_unreadable:
    "プロジェクトの autoMode の設定 (project-auto-mode.json) が読めないので btw の fork を起こせなかった。設定を直してから送り直す",
  btw_launch_unavailable: "起動コマンドを起こせなかったので btw の fork を起こせなかった",
};

const SEND_ERROR_DETAIL: Record<CommentSendError, string> = {
  ...REASON_DETAIL,
  ...BTW_START_DETAIL,
};

/** Why a comment was not put in (into the session, or a btw's into its
 * fork), in words. */
export function commentSendErrorDetail(reason: CommentSendError): string {
  return SEND_ERROR_DETAIL[reason];
}

/** What became of one item sent (a comment or a FAB's draft), in words
 * (DR-0062 §9, §11, §15): null when the session took it in. */
export function sendResultText(result: QueueSendResult): string | null {
  switch (result.outcome) {
    case "sent":
    case "btw_started":
    case "btw_waiting":
      return null;
    case "unconfirmed":
      return "セッションが入れたかの返事が来なかった。届いていれば TL に出る。出なければ「下書きに戻す」か「送った扱いにする」で片付ける";
    case "not_delivered":
      return `届けられなかった (${result.kind === "comment" ? "未送信" : "FAB の下書き"}に戻した): ${commentSendErrorDetail(result.reason)}`;
    case "refused":
      return refusalText(
        result.reason,
        result.kind === "comment"
          ? result.status !== undefined
            ? commentStatusWord(result.status)
            : undefined
          : result.status !== undefined
            ? draftStatusWord(result.status)
            : undefined,
        result.kind,
      );
  }
}

/** A FAB's draft's status in words (DR-0062 §15). */
export function draftStatusWord(status: PromptDraftStatus): string {
  switch (status) {
    case "queued":
      return "未送信";
    case "sending":
      return "送信中";
    case "sent":
      return "入れた";
    case "unconfirmed":
      return "届いたか分からない";
  }
}

function refusalText(
  reason: QueueSendRefusal,
  status: string | undefined,
  kind: "comment" | "draft",
): string {
  switch (reason) {
    case "not_sendable":
      return `未送信でないため送らなかった${status !== undefined ? ` (今は「${status}」)` : ""}`;
    case "conflict":
      return "別の画面で先に直された・送られたため送らなかった。今の内容を見てから送り直す";
    case "attachment_missing":
      return "添付のファイルが無くなったため送らなかった (未送信のまま残した)。添付を付け直してから送る";
    case "not_found":
      return kind === "comment"
        ? "コメントが無いか、返信先がまだ送られていない (下書きに戻された等) ため送らなかった"
        : "FAB の下書きが無い (別の画面で送られた・消された) ため送らなかった";
  }
}

/** The comment operation a refusal answers: the words of one code differ by
 * what was asked. */
export type CommentOp = "add" | "update" | "delete" | "resolve" | "send" | "settle";

/** The codes of a refusal the comment operations know (DR-0062 §9), and the
 * two ws.ts gives when the request was written and no answer came (the daemon
 * may have acted on it). */
const CommentErrorCodeSchema = v.picklist([
  ErrorCode.conflict,
  ErrorCode.not_found,
  ErrorCode.invalid_args,
  ErrorCode.session_not_found,
  ErrorCode.bad_request,
  ErrorCode.state_not_writable,
  "request_timeout",
  "connection_closed",
]);

/** Whether no answer came to a request written: it may have been acted on,
 * so the same comment is not asked for again (DR-0062 §9). */
export function replyLost(error: ErrorResponse["error"]): boolean {
  const code = v.safeParse(CommentErrorCodeSchema, error.code);
  return code.success && (code.output === "request_timeout" || code.output === "connection_closed");
}

/** Why a comment operation `op` was not done, in words, from the refusal's
 * code (the daemon's own line is English and for the log). */
export function commentErrorText(op: CommentOp, error: ErrorResponse["error"]): string {
  const code = v.safeParse(CommentErrorCodeSchema, error.code);
  if (!code.success) return `daemon が受け付けなかった (${error.code})`;
  switch (code.output) {
    case "request_timeout":
    case "connection_closed":
      return op === "add"
        ? "daemon から返事が来なかった。保存されたかは 💬 の一覧で確かめる"
        : op === "send"
          ? "daemon から返事が来なかった。送れたかは TL と 💬 の一覧で確かめる"
          : "daemon から返事が来なかった。どうなったかは 💬 の一覧で確かめる";
    case ErrorCode.conflict:
      return op === "resolve"
        ? "見ていた後にこのスレッドに記録が足されたため変えなかった。読んでからもう一度押す"
        : "別の画面で先に直された・送られたため変えなかった。今の内容を見てからやり直す";
    case ErrorCode.not_found:
      return op === "add"
        ? "返信先のコメントが無いか、まだ送られていない (下書きに戻された等)"
        : "そのコメントが見つからない (消えたか、掃除で無くなった)";
    case ErrorCode.invalid_args:
      return invalidArgsText(op);
    case ErrorCode.session_not_found:
      return "このセッションが daemon に見つからない";
    case ErrorCode.state_not_writable:
      return "コメントを保存できなかった (daemon が state dir に書けない)。何も変えていない";
    case ErrorCode.bad_request:
      return "依頼の形が daemon に合わない。画面を読み直してからやり直す";
  }
}

function invalidArgsText(op: CommentOp): string {
  switch (op) {
    case "add":
    case "send":
      return "本文が空か、コメントの形が合わない";
    case "update":
    case "delete":
      return "未送信でないコメントは直せない・消せない";
    case "resolve":
      return "未送信のコメントを含むスレッド、始まりが送られていないスレッドは解決済みにできない";
    case "settle":
      return "届いたか分からないコメントでなくなっているため変えなかった";
  }
}

/** Why a comment operation could not even be asked: the request was not
 * written (ws.ts rejects only before writing it). */
export const NOT_CONNECTED_TEXT = "daemon に繋がっていないため何もしていない";
