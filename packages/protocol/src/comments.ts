// Comments on a session's Timeline (DR-0062), as schemas (DR-0038): the
// record of one comment, the state of a thread, the ops that add, change,
// send and resolve them, and the pushes to the tabs that look at the
// session. And the text a comment reaches the agent as: one block per
// comment (`commentBlockText`), read back by `parseCommentBlocks`.
//
// Only the webui (user role) adds and sends comments, and the daemon serves
// the webui's bundle, so these move no protocol version (protocol-version.ts).
// Unknown fields are left out rather than refused (`v.object`): see
// request.ts for why.
import * as v from "valibot";
import { isSessionIdShape } from "./ccmsg-address.ts";
import { jsonText, type Output } from "./parse.ts";
import { UserPromptReasonSchema } from "./response-sessions.ts";

// --- the comment id ---

/** A comment's id as the agent sees it: `c` and four lowercase letters or
 * digits (DR-0062 §7). Random rather than counted: a session's file that
 * was swept and started again would count from the start, and a new id
 * would name an old comment the conversation still holds. */
export const CID_PATTERN = /^c[a-z0-9]{4}$/;

export const CidSchema = v.pipe(
  v.string(),
  v.regex(CID_PATTERN, "Expected a comment id (c and four letters or digits)"),
);

const NonEmptyText = (what: string) =>
  v.pipe(
    v.string(),
    v.check((text) => text.trim() !== "", `Expected ${what}, not an empty text`),
  );

// --- the anchor (DR-0062 §2) ---

/** The moment of the conversation: no message nor quote. Where it stands is
 * the record's time points (`sent`, else `written`). */
const TimingAnchorSchema = v.object({ kind: v.literal("timing") });

/** A Timeline item: the uuid of its row, and the kind of item as the agent
 * reads it (`on`, DR-0062 §4). */
const MessageAnchorSchema = v.object({
  kind: v.literal("message"),
  uuid: v.pipe(v.string(), v.nonEmpty("Expected the row's uuid")),
  on: NonEmptyText("the kind of item"),
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
  on: NonEmptyText("the kind of item"),
  ...ChosenTextEntries,
  start: v.optional(v.number()),
  end: v.optional(v.number()),
});

/** A quote in a file the Files tab shows, as source or as its markdown
 * preview (DR-0062 §7, P20): the line and column where the choice started
 * when the comment was made (the preview's line is its block's first line in
 * the source, and it has no column), and that line as it read then. */
const FileAnchorSchema = v.object({
  kind: v.literal("file"),
  path: v.pipe(v.string(), v.nonEmpty("Expected the file's path")),
  view: v.picklist(["source", "preview"]),
  ...ChosenTextEntries,
  line: v.pipe(v.number(), v.integer(), v.minValue(1)),
  col: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
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
  /** The block's `quote` (DR-0062 §4), as the webui made it. */
  quote: v.optional(v.string()),
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
  quote: v.optional(v.string()),
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
  quote: v.optional(v.string()),
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
  quote: v.optional(v.string()),
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

/** What one comment's block says. */
export interface CommentBlock {
  cid: string;
  /** The cid it replies to. */
  reply_to?: string;
  /** The kind of what it is on. */
  on?: string;
  quote?: string;
  /** The text chosen in what it is on. */
  selection?: string;
  body: string;
}

/** `text` as a value of a block's attribute: every character that would end
 * the value or the tag, or break the line, as an entity. Reversible
 * (unescapeText). */
function escapeAttribute(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\n", "&#10;")
    .replaceAll("\r", "&#13;")
    .replaceAll("\t", "&#9;");
}

/** `text` inside a block (the chosen text, the body): `&`, `<` and `>` as
 * entities, so nothing in it reads as the block's tags. Line breaks stay. */
function escapeText(text: string): string {
  return text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

const ENTITIES: Readonly<Record<string, string>> = {
  "&amp;": "&",
  "&quot;": '"',
  "&lt;": "<",
  "&gt;": ">",
  "&#10;": "\n",
  "&#13;": "\r",
  "&#9;": "\t",
};

function unescapeText(text: string): string {
  return text.replace(/&(?:amp|quot|lt|gt|#10|#13|#9);/g, (entity) => ENTITIES[entity] ?? entity);
}

/** The order the attributes are written in. */
const ATTRIBUTES = ["cid", "reply_to", "on", "quote"] as const;

/** One comment as the agent reads it (DR-0062 §4):
 *
 *     <comment cid="c7k2p" on="応答" quote="…">
 *     <selection>…</selection>
 *     the person's text
 *     </comment>
 */
export function commentBlockText(block: CommentBlock): string {
  const attributes = ATTRIBUTES.flatMap((name) => {
    const value = block[name];
    return value === undefined ? [] : [`${name}="${escapeAttribute(value)}"`];
  }).join(" ");
  return [
    `<comment ${attributes}>`,
    ...(block.selection !== undefined
      ? [`<selection>${escapeText(block.selection)}</selection>`]
      : []),
    escapeText(block.body),
    "</comment>",
  ].join("\n");
}

/** Comments sent together: their blocks, a blank line between them, as one
 * prompt (DR-0062 §11). */
export function commentsPromptText(blocks: readonly CommentBlock[]): string {
  return blocks.map(commentBlockText).join("\n\n");
}

const BLOCK_RE =
  /<comment((?: [a-z_]+="[^"]*")*)>\n(?:<selection>([^<]*)<\/selection>\n)?([^<]*)\n<\/comment>/g;
const ATTRIBUTE_RE = / ([a-z_]+)="([^"]*)"/g;

function blockOf(match: RegExpExecArray): CommentBlock | null {
  const attributes = new Map<string, string>();
  for (const [, name, value] of (match[1] ?? "").matchAll(ATTRIBUTE_RE)) {
    if (name !== undefined && value !== undefined) attributes.set(name, unescapeText(value));
  }
  const cid = attributes.get("cid");
  if (cid === undefined || !CID_PATTERN.test(cid)) return null;
  const replyTo = attributes.get("reply_to");
  const on = attributes.get("on");
  const quote = attributes.get("quote");
  const selection = match[2];
  return {
    cid,
    ...(replyTo !== undefined ? { reply_to: replyTo } : {}),
    ...(on !== undefined ? { on } : {}),
    ...(quote !== undefined ? { quote } : {}),
    ...(selection !== undefined ? { selection: unescapeText(selection) } : {}),
    body: unescapeText(match[3] ?? ""),
  };
}

/** The comment blocks in `text`, in order: `commentBlockText`'s blocks read
 * back (the inverse of it). */
export function parseCommentBlocks(text: string): CommentBlock[] {
  const blocks: CommentBlock[] = [];
  for (const match of text.matchAll(BLOCK_RE)) {
    const block = blockOf(match);
    if (block !== null) blocks.push(block);
  }
  return blocks;
}

/** The blocks of `text` when it is nothing but comment blocks (with
 * whitespace between and around them): a prompt of comments sent, which the
 * Timeline draws as comment bubbles. Null for any other text. */
export function commentOnlyBlocks(text: string): CommentBlock[] | null {
  const blocks: CommentBlock[] = [];
  let at = 0;
  for (const match of text.matchAll(BLOCK_RE)) {
    if (text.slice(at, match.index).trim() !== "") return null;
    const block = blockOf(match);
    if (block === null) return null;
    blocks.push(block);
    at = match.index + match[0].length;
  }
  if (blocks.length === 0 || text.slice(at).trim() !== "") return null;
  return blocks;
}

/** The kind of a comment record as the `on` of a reply to it (DR-0062 §4). */
function onOfReplied(record: CommentRecord): string {
  switch (record.author) {
    case "user":
      return "コメント";
    case "agent":
      return "エージェントの返信";
    case "btw":
      return "btw の答え";
  }
}

/** Where a file's quote is, as the agent reads it (DR-0062 §4). */
function onOfFile(anchor: Extract<CommentAnchor, { kind: "file" }>): string {
  return anchor.view === "preview"
    ? `ファイル ${anchor.path}:${String(anchor.line)} (プレビュー)`
    : `ファイル ${anchor.path}:${String(anchor.line)}${anchor.col !== undefined ? `:${String(anchor.col)}` : ""}`;
}

/** The block a person's comment is sent as. `recordOf` finds the record a
 * reply answers. */
export function commentBlockOf(
  comment: UserComment,
  recordOf: (cid: string) => CommentRecord | undefined,
): CommentBlock {
  const { anchor } = comment;
  const quote = comment.quote !== undefined ? { quote: comment.quote } : {};
  const base = { cid: comment.cid, body: comment.body };
  switch (anchor.kind) {
    case "timing":
      return base;
    case "message":
      return { ...base, on: anchor.on, ...quote };
    case "selection":
      return { ...base, on: anchor.on, ...quote, selection: anchor.text };
    case "file":
      return { ...base, on: onOfFile(anchor), ...quote, selection: anchor.text };
    case "comment": {
      const replied = recordOf(anchor.cid);
      return {
        ...base,
        reply_to: anchor.cid,
        ...(replied !== undefined ? { on: onOfReplied(replied) } : {}),
        ...quote,
        ...(anchor.text !== undefined ? { selection: anchor.text } : {}),
      };
    }
  }
}

/** The first characters of `text` as a block's `quote`: spaces folded, at
 * most `QUOTE_LENGTH` characters, `…` when cut (DR-0062 §4). */
export const QUOTE_LENGTH = 40;

export function quoteOf(text: string): string {
  const folded = text.replace(/\s+/g, " ").trim();
  const chars = Array.from(new Intl.Segmenter().segment(folded), (part) => part.segment);
  return chars.length <= QUOTE_LENGTH ? folded : `${chars.slice(0, QUOTE_LENGTH).join("")}…`;
}
