// Comments on a session's Timeline (DR-0062), as schemas (DR-0038): the
// record of one comment, the state of a thread, the ops that add, change,
// send and resolve them, and the pushes to the tabs that look at the
// session. And the text a comment reaches the agent as: one JSON line per
// comment (`commentBlockText`), read back by `parseCommentBlocks`.
//
// Only the webui (user role) adds and sends comments, and the daemon serves
// the webui's bundle, so these move no protocol version (protocol-version.ts).
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";
import { isSessionIdShape } from "./ccmsg-address.ts";
import { CidSchema, NonEmptyText } from "./comment-reply.ts";
import { jsonText, parseWith, type Output } from "./parse.ts";
import { UserPromptReasonSchema } from "./response-sessions.ts";

// --- the anchor (DR-0062 §2) ---

/** The moment of the conversation: no message nor quote. Where it stands is
 * the record's time points (`sent`, else `written`). */
const TimingAnchorSchema = v.object({ kind: v.literal("timing") });

/** The start of the message a comment is on, as its block's
 * `on:"msg_start_with:…"` (DR-0062 §4): what the agent finds the message by. */
const MsgStartWithEntry = { msg_start_with: v.string() };

/** A Timeline item: the uuid of its row, and the start of its text. */
const MessageAnchorSchema = v.object({
  kind: v.literal("message"),
  uuid: v.pipe(v.string(), v.nonEmpty("Expected the row's uuid")),
  ...MsgStartWithEntry,
});

/** The text chosen and the few characters around it, to find it again in
 * what is drawn now (DR-0062 §2): the offsets where it was are a hint. */
const ChosenTextEntries = {
  text: NonEmptyText("the chosen text"),
  before: v.string(),
  after: v.string(),
};

/** A quote inside a Timeline item. */
const SelectionAnchorSchema = v.object({
  kind: v.literal("selection"),
  uuid: v.pipe(v.string(), v.nonEmpty("Expected the row's uuid")),
  ...MsgStartWithEntry,
  ...ChosenTextEntries,
  start: v.optional(v.number()),
  end: v.optional(v.number()),
});

/** A line of a file, counted from 1. */
const LineNumberSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

/** A quote in a file the Files tab shows, as source or as its markdown
 * preview (DR-0062 §7, P20): the path as the block's `file` names it
 * (relative to the session's cwd when inside it, else absolute), the line
 * and column where the choice started and the line it ended on when the
 * comment was made (the preview's are its block's first and last lines in
 * the source, and it has no column; no end line when it is the start's), and
 * the start's line as it read then. */
const FileAnchorSchema = v.object({
  kind: v.literal("file"),
  path: v.pipe(v.string(), v.nonEmpty("Expected the file's path")),
  view: v.picklist(["source", "preview"]),
  ...ChosenTextEntries,
  line: LineNumberSchema,
  end_line: v.optional(LineNumberSchema),
  col: v.optional(LineNumberSchema),
  line_text: v.string(),
});

/** Another comment or reply (cid), whole or a quote inside it: what makes a
 * reply (DR-0062 §2). */
const ReplyAnchorSchema = v.object({
  kind: v.literal("comment"),
  cid: CidSchema,
  text: v.optional(NonEmptyText("the chosen text")),
  before: v.optional(v.string()),
  after: v.optional(v.string()),
  start: v.optional(v.number()),
  end: v.optional(v.number()),
});

export const CommentAnchorKindSchema = v.picklist([
  "timing",
  "message",
  "selection",
  "file",
  "comment",
]);
export type CommentAnchorKind = Output<typeof CommentAnchorKindSchema>;

export const CommentAnchorSchema = v.variant("kind", [
  TimingAnchorSchema,
  MessageAnchorSchema,
  SelectionAnchorSchema,
  FileAnchorSchema,
  ReplyAnchorSchema,
]);
export type CommentAnchor = Output<typeof CommentAnchorSchema>;

// --- the record (DR-0062 §7) ---

/** A point of the conversation: when, and the uuid of the transcript's last
 * row then (not a sidechain's; absent when it held none), as a btw's anchor
 * is (DR-0060 §4). */
export const CommentTimePointSchema = v.object({
  at: v.string(),
  after_uuid: v.optional(v.string()),
});
export type CommentTimePoint = Output<typeof CommentTimePointSchema>;

/** Where a person's comment stands: not sent (`draft`), being put in
 * (`sending`), put in (`sent`: the composer took it), seen in the
 * transcript (`delivered`), not known (`unconfirmed`), or taken back
 * (`deleted`). */
export const UserCommentStatusSchema = v.picklist([
  "draft",
  "sending",
  "sent",
  "delivered",
  "unconfirmed",
  "deleted",
]);
export type UserCommentStatus = Output<typeof UserCommentStatusSchema>;

/** A comment the person wrote. */
export const UserCommentSchema = v.object({
  kind: v.literal("comment"),
  author: v.literal("user"),
  cid: CidSchema,
  session_id: v.string(),
  anchor: CommentAnchorSchema,
  body: v.string(),
  written: CommentTimePointSchema,
  sent: v.optional(CommentTimePointSchema),
  updated_at: v.string(),
  btw: v.boolean(),
  status: UserCommentStatusSchema,
  /** Why the last send did not put it in. */
  send_error: v.optional(UserPromptReasonSchema),
  /** The transcript row its block was seen in, once delivered. */
  row_uuid: v.optional(v.string()),
});
export type UserComment = Output<typeof UserCommentSchema>;

/** A reply the agent made with `comment_reply` (DR-0062 §5). Its body is the
 * transcript's (the tool call's row), not kept here. */
export const AgentReplySchema = v.object({
  kind: v.literal("comment"),
  author: v.literal("agent"),
  cid: CidSchema,
  session_id: v.string(),
  anchor: CommentAnchorSchema,
  /** The start of its body (msgStartWithOf), the body being the
   * transcript's: what a reply to it carries as `msg_start_with`, and what
   * stands for it where its row is not read. */
  body_start: v.optional(v.string()),
  written: CommentTimePointSchema,
  sent: v.optional(CommentTimePointSchema),
  updated_at: v.string(),
  tool_use_id: v.optional(v.string()),
});
export type AgentReply = Output<typeof AgentReplySchema>;

/** The answer of a btw comment's fork (DR-0062 §14). */
export const BtwAnswerSchema = v.object({
  kind: v.literal("comment"),
  author: v.literal("btw"),
  cid: CidSchema,
  session_id: v.string(),
  anchor: CommentAnchorSchema,
  body: v.string(),
  written: CommentTimePointSchema,
  sent: v.optional(CommentTimePointSchema),
  updated_at: v.string(),
  status: v.picklist(["running", "done", "failed", "canceled"]),
  model: v.optional(v.string()),
  effort: v.optional(v.string()),
  tool: v.optional(v.string()),
  ended_at: v.optional(v.string()),
  error: v.optional(v.string()),
  btw_id: v.optional(v.string()),
});
export type BtwAnswer = Output<typeof BtwAnswerSchema>;

export const CommentRecordSchema = v.variant("author", [
  UserCommentSchema,
  AgentReplySchema,
  BtwAnswerSchema,
]);
export type CommentRecord = Output<typeof CommentRecordSchema>;

/** A thread's state (DR-0062 §6, §7): whether its first comment's thread is
 * resolved, and the last cid the person saw when resolving it. */
export const ThreadStateSchema = v.object({
  kind: v.literal("thread"),
  session_id: v.string(),
  root: CidSchema,
  resolved_at: v.optional(v.string()),
  seen_cid: v.optional(CidSchema),
});
export type ThreadState = Output<typeof ThreadStateSchema>;

/** A line of `<stateDir>/sessions/<sid>.comments.jsonl`. */
export const CommentsFileLineSchema = jsonText(
  v.variant("kind", [
    v.variant("author", [UserCommentSchema, AgentReplySchema, BtwAnswerSchema]),
    ThreadStateSchema,
  ]),
);

// --- ops (DR-0062 §9; user role only) ---

/** The session the op is on. Its id names the session's comments file, so it
 * is a session id's shape and nothing that could name a file elsewhere. */
const SessionIdEntry = {
  session_id: v.pipe(v.string(), v.check(isSessionIdShape, "Expected a session id")),
};

/** The anchors a comment is made on now (DR-0062's step 1): a Timeline item,
 * or another comment. The other kinds come with the steps that make them. */
export const CommentAddAnchorSchema = v.variant("kind", [MessageAnchorSchema, ReplyAnchorSchema]);
export type CommentAddAnchor = Output<typeof CommentAddAnchorSchema>;

/** Add a comment to session `session_id`, and with `send_now` send it right
 * after it is kept. */
export const CommentAddRequestSchema = v.object({
  op: v.literal("comment_add"),
  ...SessionIdEntry,
  anchor: CommentAddAnchorSchema,
  body: NonEmptyText("the comment"),
  send_now: v.boolean(),
});
export type CommentAddRequest = Output<typeof CommentAddRequestSchema>;

/** Change an unsent comment's body. `seen_updated_at` is the version the
 * person changed: another one is `conflict`. */
export const CommentUpdateRequestSchema = v.object({
  op: v.literal("comment_update"),
  ...SessionIdEntry,
  cid: CidSchema,
  seen_updated_at: v.string(),
  body: NonEmptyText("the comment"),
});
export type CommentUpdateRequest = Output<typeof CommentUpdateRequestSchema>;

/** Take an unsent comment back. */
export const CommentDeleteRequestSchema = v.object({
  op: v.literal("comment_delete"),
  ...SessionIdEntry,
  cid: CidSchema,
  seen_updated_at: v.string(),
});
export type CommentDeleteRequest = Output<typeof CommentDeleteRequestSchema>;

/** Resolve the thread `cid` is in, or take the mark off. `seen_cid` is the
 * last record of the thread the person saw. */
export const CommentResolveRequestSchema = v.object({
  op: v.literal("comment_resolve"),
  ...SessionIdEntry,
  cid: CidSchema,
  resolved: v.boolean(),
  seen_cid: CidSchema,
});
export type CommentResolveRequest = Output<typeof CommentResolveRequestSchema>;

/** One unsent item to send, with the version the person saw. */
export const QueueSendItemSchema = v.object({
  kind: v.literal("comment"),
  cid: CidSchema,
  seen_updated_at: v.string(),
});
export type QueueSendItem = Output<typeof QueueSendItemSchema>;

/** Send unsent items, in the order given (DR-0062 §11). */
export const QueueSendRequestSchema = v.object({
  op: v.literal("queue_send"),
  ...SessionIdEntry,
  items: v.pipe(v.array(QueueSendItemSchema), v.nonEmpty("Expected an item to send")),
});
export type QueueSendRequest = Output<typeof QueueSendRequestSchema>;

/** What a person does with an unconfirmed item (DR-0062 §11): make it a
 * draft again, or take it as sent. */
export const UnconfirmedSettleRequestSchema = v.object({
  op: v.literal("unconfirmed_settle"),
  ...SessionIdEntry,
  item: v.object({ kind: v.literal("comment"), cid: CidSchema }),
  action: v.picklist(["back_to_draft", "mark_sent"]),
  seen_updated_at: v.string(),
});
export type UnconfirmedSettleRequest = Output<typeof UnconfirmedSettleRequestSchema>;

/** Why an item was not tried (DR-0062 §9): it is not unsent (`not_sendable`,
 * with the status it has), it is not the version the person saw
 * (`conflict`), or it is not there, or what it replies to is not sent
 * (`not_found`). */
export const QueueSendRefusalSchema = v.picklist(["not_sendable", "conflict", "not_found"]);
export type QueueSendRefusal = Output<typeof QueueSendRefusalSchema>;

const QueueSendItemEntries = { kind: v.literal("comment"), id: CidSchema };

/** What became of one item sent: put in (`sent`), not known
 * (`unconfirmed`), not put in (`not_delivered`, the reason in DR-0035 §5's
 * words), or not tried (`refused`). */
export const QueueSendResultSchema = v.variant("outcome", [
  v.object({ ...QueueSendItemEntries, outcome: v.literal("sent") }),
  v.object({ ...QueueSendItemEntries, outcome: v.literal("unconfirmed") }),
  v.object({
    ...QueueSendItemEntries,
    outcome: v.literal("not_delivered"),
    reason: UserPromptReasonSchema,
  }),
  v.object({
    ...QueueSendItemEntries,
    outcome: v.literal("refused"),
    reason: QueueSendRefusalSchema,
    status: v.optional(UserCommentStatusSchema),
  }),
]);
export type QueueSendResult = Output<typeof QueueSendResultSchema>;

export const CommentAddResponseSchema = v.object({
  ok: v.literal(true),
  comment: UserCommentSchema,
  outcome: v.optional(QueueSendResultSchema),
});
export type CommentAddResponse = Output<typeof CommentAddResponseSchema>;

export const CommentUpdateResponseSchema = v.object({
  ok: v.literal(true),
  comment: UserCommentSchema,
});
export type CommentUpdateResponse = Output<typeof CommentUpdateResponseSchema>;

export const CommentDeleteResponseSchema = v.object({ ok: v.literal(true) });
export type CommentDeleteResponse = Output<typeof CommentDeleteResponseSchema>;

export const CommentResolveResponseSchema = v.object({
  ok: v.literal(true),
  thread: ThreadStateSchema,
});
export type CommentResolveResponse = Output<typeof CommentResolveResponseSchema>;

export const QueueSendResponseSchema = v.object({
  ok: v.literal(true),
  results: v.array(QueueSendResultSchema),
});
export type QueueSendResponse = Output<typeof QueueSendResponseSchema>;

export const UnconfirmedSettleResponseSchema = v.object({ ok: v.literal(true) });
export type UnconfirmedSettleResponse = Output<typeof UnconfirmedSettleResponseSchema>;

// --- pushes (DR-0062 §10) ---

/** Every comment and thread state of session `session_id` the daemon holds
 * (deleted ones left out), to a tab as it begins to look at the session
 * (session_status_subscribe), even when there are none. */
export const CommentsStreamEventSchema = v.object({
  ev: v.literal("comments"),
  session_id: v.string(),
  comments: v.array(CommentRecordSchema),
  threads: v.array(ThreadStateSchema),
});
export type CommentsStreamEvent = Output<typeof CommentsStreamEventSchema>;

/** One comment as it is now, whenever it changes: a tab replaces what it
 * held of that cid (and drops a deleted one). */
export const CommentStreamEventSchema = v.object({
  ev: v.literal("comment"),
  comment: CommentRecordSchema,
});
export type CommentStreamEvent = Output<typeof CommentStreamEventSchema>;

/** One thread's state as it is now, whenever it changes. */
export const CommentThreadStreamEventSchema = v.object({
  ev: v.literal("comment_thread"),
  thread: ThreadStateSchema,
});
export type CommentThreadStreamEvent = Output<typeof CommentThreadStreamEventSchema>;

// --- the text the agent reads (DR-0062 §4) ---

/** `on`'s text split at its first `:`: the word naming the kind, and the
 * rest as it is (a file's path and lines hold `:` too). No `:` is no kind. */
const OnTextSchema = v.pipe(
  v.string(),
  v.transform((text) => {
    const at = text.indexOf(":");
    return at < 0
      ? { kind: "", value: text }
      : { kind: text.slice(0, at), value: text.slice(at + 1) };
  }),
);

/** What a comment is on, but a btw's answer: a message without a cid (the
 * start of it), a comment or reply with one, or a file and its lines. */
const OnSchema = v.pipe(
  OnTextSchema,
  v.variant("kind", [
    v.object({ kind: v.literal("msg_start_with"), value: v.string() }),
    v.object({ kind: v.literal("comment"), value: CidSchema }),
    v.object({ kind: v.literal("file"), value: v.pipe(v.string(), v.nonEmpty("Expected a file")) }),
  ]),
);

/** A btw's answer (its cid): what a first reply to it is on. */
const BtwOnSchema = v.pipe(OnTextSchema, v.object({ kind: v.literal("btw"), value: CidSchema }));

/** What a block is on, but a btw's answer, or on nothing (a moment of the
 * conversation): no btw question nor answer with it. */
const NotBtwEntries = {
  on: v.optional(OnSchema),
  btw_req: v.optional(v.never()),
  btw_res: v.optional(v.never()),
};
/** A first reply to a btw's answer: the btw's question and its whole answer
 * with it, as the conversation it goes to has not seen them. */
const BtwEntries = {
  on: BtwOnSchema,
  btw_req: v.string(),
  btw_res: v.string(),
};

/** The text chosen and the characters around it, as a block carries them:
 * all three, or (no choice made) none. */
const ChoiceEntries = {
  before: v.string(),
  select: NonEmptyText("the chosen text"),
  after: v.string(),
};
const NoChoiceEntries = {
  before: v.optional(v.never()),
  select: v.optional(v.never()),
  after: v.optional(v.never()),
};

const BlockEntries = { comment: CidSchema, body: v.string() };

/** One comment as the agent reads it (DR-0062 §4): one JSON line. Strict: a
 * line with a key of no block's is not a comment, so a person's own JSON is
 * not read as one. */
export const CommentBlockSchema = v.union([
  v.strictObject({ ...BlockEntries, ...NotBtwEntries, ...NoChoiceEntries }),
  v.strictObject({ ...BlockEntries, ...NotBtwEntries, ...ChoiceEntries }),
  v.strictObject({ ...BlockEntries, ...BtwEntries, ...NoChoiceEntries }),
  v.strictObject({ ...BlockEntries, ...BtwEntries, ...ChoiceEntries }),
]);
export type CommentBlock = Output<typeof CommentBlockSchema>;
/** What a block is on, as read. */
export type CommentBlockOn = NonNullable<CommentBlock["on"]>;

const CommentBlockLineSchema = jsonText(CommentBlockSchema);

/** One comment's block, as one line (DR-0062 §4): its keys in the order of
 * the DR's table, those it has not left out, and `on` as the word of its
 * kind, `:` and its value. JSON writes a line break inside a text as `\n`,
 * so the block holds none.
 *
 *     {"comment":"c7k2p","on":"msg_start_with:…","body":"…"}
 */
export function commentBlockText(block: CommentBlock): string {
  return JSON.stringify({
    comment: block.comment,
    on: block.on === undefined ? undefined : `${block.on.kind}:${block.on.value}`,
    btw_req: block.btw_req,
    btw_res: block.btw_res,
    before: block.before,
    select: block.select,
    after: block.after,
    body: block.body,
  });
}

/** Comments sent together: their blocks, one per line (JSONL), as one prompt
 * (DR-0062 §11). */
export function commentsPromptText(blocks: readonly CommentBlock[]): string {
  return blocks.map(commentBlockText).join("\n");
}

/** The block `line` is, or null for any other line. Only a line that opens
 * as a JSON object is read as JSON. */
function blockOfLine(line: string): CommentBlock | null {
  if (!line.trimStart().startsWith("{")) return null;
  const read = parseWith(CommentBlockLineSchema, line);
  return read.ok ? read.value : null;
}

function linesOf(text: string): string[] {
  return text.split(/\r?\n/);
}

/** The comment blocks in `text`, in order: its lines that are blocks
 * (`commentBlockText`'s read back, the inverse of it). */
export function parseCommentBlocks(text: string): CommentBlock[] {
  return linesOf(text).flatMap((line) => {
    const block = blockOfLine(line);
    return block === null ? [] : [block];
  });
}

/** The blocks of `text` when it is nothing but comment blocks (every line
 * that is not blank is one): a prompt of comments sent, which the Timeline
 * draws as comment bubbles. Null for any other text. */
export function commentOnlyBlocks(text: string): CommentBlock[] | null {
  const blocks: CommentBlock[] = [];
  for (const line of linesOf(text)) {
    if (line.trim() === "") continue;
    const block = blockOfLine(line);
    if (block === null) return null;
    blocks.push(block);
  }
  return blocks.length === 0 ? null : blocks;
}

/** How many characters of a message's start a block carries
 * (`on:"msg_start_with:…"`), and of the text before and after a choice
 * (`before` / `after`), DR-0062 §4. */
export const MSG_START_LENGTH = 30;
const AROUND_CHOICE_LENGTH = 30;

/** `text`'s characters as one sees them (a letter with its marks, an emoji
 * of several code points, is one). */
function charactersOf(text: string): string[] {
  return Array.from(new Intl.Segmenter().segment(text), (part) => part.segment);
}

/** Each run of whitespace (line breaks too) as one space. */
function foldSpaces(text: string): string {
  return text.replace(/\s+/g, " ");
}

/** The start of `text` as a block's `msg_start_with`: spaces folded and the
 * ends trimmed, at most `MSG_START_LENGTH` characters, `…` when cut. */
export function msgStartWithOf(text: string): string {
  const folded = foldSpaces(text).trim();
  const chars = charactersOf(folded);
  return chars.length <= MSG_START_LENGTH
    ? folded
    : `${chars.slice(0, MSG_START_LENGTH).join("")}…`;
}

/** The choice of an anchor as a block carries it: the chosen text as it is,
 * the last characters before it and the first after it, spaces folded. */
function blockChoiceOf(choice: { text: string; before: string; after: string }): {
  before: string;
  select: string;
  after: string;
} {
  return {
    before: charactersOf(foldSpaces(choice.before)).slice(-AROUND_CHOICE_LENGTH).join(""),
    select: choice.text,
    after: charactersOf(foldSpaces(choice.after)).slice(0, AROUND_CHOICE_LENGTH).join(""),
  };
}

/** Where a file's quote is, as a block's `file:` value: `<path>:<line>`, or
 * `<path>:<line>-<end>` over several lines. */
function fileOf(anchor: Extract<CommentAnchor, { kind: "file" }>): string {
  const end =
    anchor.end_line !== undefined && anchor.end_line !== anchor.line
      ? `-${String(anchor.end_line)}`
      : "";
  return `${anchor.path}:${String(anchor.line)}${end}`;
}

/** What a reply to the record `cid` is on (DR-0062 §4, §14): a btw's answer
 * as `btw:` with the btw's question and whole answer (the conversation it
 * goes to has not seen them), anything else with a cid as `comment:`. */
function replyOn(
  cid: string,
  recordOf: (cid: string) => CommentRecord | undefined,
):
  | { on: { kind: "comment"; value: string } }
  | { on: { kind: "btw"; value: string }; btw_req: string; btw_res: string } {
  const replied = recordOf(cid);
  if (replied?.author !== "btw") return { on: { kind: "comment", value: cid } };
  const question = replied.anchor.kind === "comment" ? recordOf(replied.anchor.cid) : undefined;
  return {
    on: { kind: "btw", value: cid },
    btw_req: question?.author === "user" ? question.body : "",
    btw_res: replied.body,
  };
}

/** The block a person's comment is sent as (DR-0062 §4). `recordOf` finds
 * the record a reply answers. */
export function commentBlockOf(
  comment: UserComment,
  recordOf: (cid: string) => CommentRecord | undefined,
): CommentBlock {
  const { anchor } = comment;
  const base = { comment: comment.cid, body: comment.body };
  switch (anchor.kind) {
    case "timing":
      return base;
    case "message":
      return { ...base, on: { kind: "msg_start_with", value: anchor.msg_start_with } };
    case "selection":
      return {
        ...base,
        on: { kind: "msg_start_with", value: anchor.msg_start_with },
        ...blockChoiceOf(anchor),
      };
    case "file":
      return { ...base, on: { kind: "file", value: fileOf(anchor) }, ...blockChoiceOf(anchor) };
    case "comment": {
      const reply = { ...base, ...replyOn(anchor.cid, recordOf) };
      return anchor.text === undefined
        ? reply
        : {
            ...reply,
            ...blockChoiceOf({
              text: anchor.text,
              before: anchor.before ?? "",
              after: anchor.after ?? "",
            }),
          };
    }
  }
}
