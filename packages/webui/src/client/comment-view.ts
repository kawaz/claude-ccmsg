// What the Timeline draws of a session's comments (DR-0062 §12, §13): which
// rows are prompts of comments sent, how many comments each item has, which
// thread a comment is in and whether it is resolved, where an unsent or
// not-yet-seen comment stands, and the prompt the comments would be sent as.
//
// Pure, per DR-0005 §1, as btw-slots.ts beside it.
import * as v from "valibot";
import {
  commentBlockOf,
  commentOnlyBlocks,
  commentsPromptText,
  ErrorCode,
  quoteOf,
  type CommentBlock,
  type CommentRecord,
  type ErrorResponse,
  type QueueSendRefusal,
  type QueueSendResult,
  type ThreadState,
  type UserComment,
  type UserCommentStatus,
  type UserMessageKind,
} from "@ccmsg/protocol";
import { userPromptReasonDetail } from "./components/session-input.ts";
import { readStorage, writeStorage } from "./storage.ts";
import {
  isUserSpeechKind,
  parseSystemMessageFields,
  type BoundaryKind,
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
 * it: the item's kind (`on`, DR-0062 §4's table and P2's names) and the start
 * of the text the Timeline heads it with (`quote`, quoteOf). */
export interface ItemCommentOn {
  on: string;
  quote: string;
}

function itemOn(on: string, text: string): ItemCommentOn {
  return { on, quote: quoteOf(text) };
}

/** What a comment on a ccmsg message's bubble is on (P2). */
export function commentOnOfCcmsg(message: CcmsgMessage): ItemCommentOn {
  const on =
    message.direct?.direction === "out"
      ? `${(message.to ?? []).join(", ")} への ccmsg`
      : `${message.from} からの ccmsg`;
  return itemOn(on, message.msg);
}

/** What a comment on a boundary item is on (the items Timeline draws apart,
 * classifyBoundaryLine). A ccmsg row is one item per message
 * (commentOnOfCcmsg). */
export function commentOnOfBoundary(
  boundary: Exclude<BoundaryKind, { kind: "ccmsg" }>,
  line: TurnLine,
): ItemCommentOn {
  switch (boundary.kind) {
    case "user-prompt":
      return itemOn("ユーザの発言", lineText(line));
    case "assistant-response":
      return itemOn("応答", lineText(line));
    case "api-error":
      return itemOn("turn interrupted", lineText(line));
    case "bash-command":
      return itemOn("! コマンドの実行", boundary.segment.command);
    case "bash-command-output":
      return itemOn("! コマンドの出力", boundary.segment.stdout || boundary.segment.stderr || "");
    case "push-notification":
      return itemOn("tool PushNotification の呼び出し", boundary.text);
    case "say":
      return itemOn("say", boundary.text);
    case "permit":
      return itemOn("許可依頼", boundary.permit.blocked);
  }
}

/** What a comment on an item of a fold is on: a tool's call, an instruction
 * to a subagent or teammate, and what comes back from one (DR-0062 §4, P2).
 * Null for what is not a message (thinking alone, a meta or unreadable row, a
 * ccmsg row, which is commented on per message). */
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
      case "tool-use":
        return itemOn(`tool ${segment.name} の呼び出し`, `tool_use: ${segment.name}`);
      case "file-read":
        return itemOn("tool Read の呼び出し", `Read ${segment.path}`);
      case "file-write":
        return itemOn("tool Write の呼び出し", `Write ${segment.path}`);
      case "file-edit":
        return itemOn("tool Edit の呼び出し", `Edit ${segment.path}`);
      case "bash-use":
        return itemOn("tool Bash の呼び出し", segment.command);
      case "agent-send":
        return itemOn(`${segment.to} への指示`, segment.summary ?? segment.message);
      case "agent-spawn":
        return itemOn(`${segment.name} への指示`, segment.description || segment.prompt);
      case "tool-result":
      case "bash-result":
        return itemOn("tool の結果", segment.text);
      case "file-tool-result":
        return itemOn("tool の結果", segment.result.kind === "text" ? segment.result.content : "");
      case "text":
      case "slash-command-prefix":
      case "bash-command":
      case "bash-command-output":
      case "unknown-segment":
        return null;
    }
  }
  return null;
}

/** A system-origin row (DR-0062 §4: a subagent's or teammate's answer is a
 * task-notification or a teammate-message): who it comes from, or its kind. */
function commentOnOfSystemMessage(kind: UserMessageKind, line: TurnLine): ItemCommentOn {
  const raw = line.segments.flatMap((seg) => (seg.kind === "text" ? [seg.text] : [])).join("\n");
  const rich = parseSystemMessageFields(kind, raw);
  if (rich.display === "peer") {
    const peer = rich.relays.find((relay) => relay.category !== "idle") ?? rich.relays[0];
    if (peer !== undefined) return itemOn(`${peer.from} からの応答`, peer.summary ?? peer.body);
  }
  if (kind === "task-notification" && rich.display === "fields") {
    const task = rich.fields.find((field) => field.name === "task-id")?.value;
    return itemOn(`${task ?? "task"} からの応答`, rich.heading ?? raw);
  }
  return itemOn(kind, raw);
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

/** The person's comments sending, sent and not seen delivered yet, or not
 * known (DR-0062 §11): they are drawn from their records until the transcript
 * has their row, so none is out of both the unsent list and the Timeline. One
 * stands at the point it was sent, or, while it has none (waiting its turn in
 * the session's line, or left unknown when the daemon stopped), where it was
 * written (§2). */
export function pendingComments(records: Iterable<CommentRecord>): PlacedComment[] {
  const placed: PlacedComment[] = [];
  for (const record of records) {
    if (record.author !== "user") continue;
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

/** What became of one comment sent, in words (DR-0062 §9, §11): null when
 * the session took it in. */
export function sendResultText(result: QueueSendResult): string | null {
  switch (result.outcome) {
    case "sent":
      return null;
    case "unconfirmed":
      return "セッションが入れたかの返事が来なかった。届いていれば TL に出る。出なければ「下書きに戻す」か「送った扱いにする」で片付ける";
    case "not_delivered":
      return `届けられなかった (未送信に戻した): ${userPromptReasonDetail(result.reason)}`;
    case "refused":
      return refusalText(result.reason, result.status);
  }
}

function refusalText(reason: QueueSendRefusal, status: UserCommentStatus | undefined): string {
  switch (reason) {
    case "not_sendable":
      return `未送信でないため送らなかった${status !== undefined ? ` (今は「${commentStatusWord(status)}」)` : ""}`;
    case "conflict":
      return "別の画面で先に直された・送られたため送らなかった。今の内容を見てから送り直す";
    case "not_found":
      return "コメントが無いか、返信先がまだ送られていない (下書きに戻された等) ため送らなかった";
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
