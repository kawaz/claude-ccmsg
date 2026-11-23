// The agent's reply to a comment (DR-0062 §5): the `comment_reply` tool, as
// schemas (DR-0038). What the model writes into the tool, what the hooks
// module asks the daemon with it (op `comment_reply` over `POST /op`,
// DR-0046), the daemon's reply, and the text the tool answers when the reply
// was recorded, which a reader of the transcript reads the reply's new cid
// from (commentReplyRecorded).
//
// The hooks module bundles this file, so it imports nothing but valibot and
// parse.ts.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

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

/** A text that holds something other than whitespace. */
export const NonEmptyText = (what: string) =>
  v.pipe(
    v.string(),
    v.check((text) => text.trim() !== "", `Expected ${what}, not an empty text`),
  );

// --- the tool ---

/** What the model writes into `comment_reply`: the cid of the comment it
 * answers, and its answer. */
export const CommentReplyToolInputSchema = v.object({
  cid: CidSchema,
  body: NonEmptyText("the reply"),
});
export type CommentReplyToolInput = Output<typeof CommentReplyToolInputSchema>;

// --- the op (session role only) ---

/** Record the calling session's reply to the comment `cid` (DR-0062 §9). The
 * session is the caller; `tool_use_id` is the call's, by which a call asked
 * twice is recorded once. */
export const CommentReplyRequestSchema = v.object({
  op: v.literal("comment_reply"),
  cid: CidSchema,
  body: NonEmptyText("the reply"),
  tool_use_id: v.pipe(v.string(), v.nonEmpty("Expected the call's tool_use id")),
});
export type CommentReplyRequest = Output<typeof CommentReplyRequestSchema>;

/** comment_reply's reply: the reply's own cid, and the quote of what it
 * answers. */
export const CommentReplyResponseSchema = v.object({
  ok: v.literal(true),
  cid: CidSchema,
  quote: v.string(),
});
export type CommentReplyResponse = Output<typeof CommentReplyResponseSchema>;
export const CommentReplyResponseTextSchema = jsonText(CommentReplyResponseSchema);

// --- the response after the replies ---

/** What the agent ends its response with when its replies said all there
 * was to say (DR-0062 §5): one word, as the ccmsg skill tells it. The
 * webui's Timeline draws a one-line response holding it as an item folded
 * among the other items, not as a bubble (§12). */
export const COMMENT_REPLY_DONE_TEXT = "comment_reply_done";

// --- the text the tool answers ---

/** What the tool answers when the reply to `replied` (whose start is
 * `quote`) was recorded as `cid` (DR-0062 §5): the reply has a cid of its
 * own, which a reply of the person's to it names. */
export function commentReplyRecordedText(replied: string, quote: string, cid: string): string {
  return `${replied} (「${quote}」) への返信を記録した。この返信の cid は ${cid} (人がこれに返信すると "on":"comment:${cid}" で届く)`;
}

const RECORDED_RE =
  /^c[a-z0-9]{4} \(「[\s\S]*」\) への返信を記録した。この返信の cid は (c[a-z0-9]{4}) \(人がこれに返信すると "on":"comment:\1" で届く\)$/;

/** The reply's cid a `comment_reply` call's result (its text, and whether it
 * is an error) says was recorded, or null when the result says otherwise (a
 * refusal, a subagent's call, no daemon). Only a call recorded is a reply in
 * a thread. */
export function commentReplyRecorded(text: string, isError: boolean): string | null {
  if (isError) return null;
  return RECORDED_RE.exec(text.trim())?.[1] ?? null;
}
