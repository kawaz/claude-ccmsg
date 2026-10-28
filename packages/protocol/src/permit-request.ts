// A request for the person's permission (DR-0040): an agent whose action the
// auto mode classifier stopped asks, through the `permit` tool, for the words
// that let it run the action again. As schemas (DR-0038): what the model
// writes into the tool, what the hooks module hands `ccmsg sidecar permit` on
// standard input, the daemon's record of it, its reply, and an attachment as
// the daemon reads it when the person opens it.
//
// The hooks module bundles this file, so it imports nothing but valibot and
// parse.ts.
import * as v from "valibot";
import { jsonText, type Output } from "./parse.ts";

/** How much of an attachment the daemon reads when the person opens it: the
 * first this many bytes. A longer file is shown as its start and a note
 * that the rest is left out. */
export const PERMIT_ATTACHMENT_MAX_BYTES = 64 * 1024;

/** How many attachments one request may name: each is a line of the bubble
 * the person reads, and of the permission they copy. */
export const PERMIT_ATTACHMENTS_MAX = 16;

/** A text an agent wrote, not only whitespace. */
const PermitTextSchema = v.pipe(
  v.string(),
  v.check((text) => text.trim() !== "", "the text holds something other than whitespace"),
);

/** How long a request's `voice` may be: a call to the person, said in one
 * breath. */
export const PERMIT_VOICE_MAX_LENGTH = 80;

/** A file the person is to read before permitting: an absolute path. */
const AttachmentPathSchema = v.pipe(
  v.string(),
  v.check((path) => path.startsWith("/"), "an attachment is an absolute path"),
);

/** One command to permit: exactly as it goes to Bash, and what it does in a
 * few words. */
const PermitCommandEntries = {
  command: PermitTextSchema,
  description: v.optional(PermitTextSchema),
};

const PermitEntries = {
  /** The action the classifier stopped, in markdown. */
  blocked: PermitTextSchema,
  /** Files the commands read (a script, a policy, a patch …), which the
   * person opens to read what is permitted. */
  attachments: v.optional(
    v.pipe(
      v.array(AttachmentPathSchema),
      v.maxLength(PERMIT_ATTACHMENTS_MAX, `at most ${PERMIT_ATTACHMENTS_MAX} attachments`),
      v.check((paths) => new Set(paths).size === paths.length, "each attachment is named once"),
    ),
  ),
  /** What to permit that is not a command (an edit, a write …), in markdown,
   * one sentence each. */
  intents: v.optional(v.array(PermitTextSchema)),
  /** The commands to permit. */
  commands: v.optional(v.array(v.object(PermitCommandEntries))),
  /** What the speakers say in place of the fixed sentence (DR-0040 §6): a
   * short call to the person. Not shown in the webui. */
  voice: v.optional(
    v.pipe(
      PermitTextSchema,
      v.maxLength(
        PERMIT_VOICE_MAX_LENGTH,
        `voice is a short call of at most ${PERMIT_VOICE_MAX_LENGTH} characters`,
      ),
    ),
  ),
};

/** Whether a request asks for anything: an intent or a command, by how many
 * of each it has. */
function asksForSomething(intents: number | undefined, commands: number | undefined): boolean {
  return (intents ?? 0) + (commands ?? 0) > 0;
}
const ASKS_FOR_SOMETHING = "ask for at least one of intents and commands";

/** The `permit` tool's input, picked out of the call (the engine puts its
 * own fields beside it, which `v.object` leaves out). */
export const PermitToolInputSchema = v.pipe(
  v.object(PermitEntries),
  v.check(
    (input) => asksForSomething(input.intents?.length, input.commands?.length),
    ASKS_FOR_SOMETHING,
  ),
);
export type PermitToolInput = Output<typeof PermitToolInputSchema>;

/** What `ccmsg sidecar permit` takes on standard input, and the `permit`
 * field of the `permit_request` op. Strict: the module writes exactly these
 * fields, so another is a mistake of the writer. */
export const PermitInputSchema = v.pipe(
  v.strictObject({
    ...PermitEntries,
    commands: v.optional(v.array(v.strictObject(PermitCommandEntries))),
  }),
  v.check(
    (input) => asksForSomething(input.intents?.length, input.commands?.length),
    ASKS_FOR_SOMETHING,
  ),
);
export type PermitInput = Output<typeof PermitInputSchema>;
export const PermitInputTextSchema = jsonText(PermitInputSchema);

/** One command of a request as the daemon holds it. */
export const PermitCommandSchema = v.object({
  command: v.string(),
  description: v.optional(v.string()),
});
export type PermitCommand = Output<typeof PermitCommandSchema>;

/** One request for permission as the daemon holds it. Held in memory only,
 * like a say (DR-0040 §4). The attachments are their paths: the daemon reads
 * one when the person opens it (permit_attachment_read). The one thing that
 * changes is `read`, which the person's 許可する sets; whether the person
 * permitted is not tracked. */
export const PermitRequestRecordSchema = v.object({
  /** `<instance id>/<n>` (mid-issuer.ts). */
  id: v.string(),
  /** sid of the session that asked. */
  sid: v.string(),
  ts: v.string(),
  blocked: v.string(),
  attachments: v.array(v.string()),
  intents: v.array(v.string()),
  commands: v.array(PermitCommandSchema),
  /** What the speakers say for the request in place of the fixed sentence;
   * not shown in the webui. */
  voice: v.optional(v.string()),
  /** Set when the person pressed 許可する on it (permit_request_read); never
   * cleared. What the Sessions list's 🔐 counts is the unread ones. */
  read: v.boolean(),
});
export type PermitRequestRecord = Output<typeof PermitRequestRecordSchema>;

/** permit_request's reply, and what `ccmsg sidecar permit` prints: the id
 * of the record the daemon now holds. */
export const PermitRequestResponseSchema = v.object({
  ok: v.literal(true),
  id: v.string(),
});
export type PermitRequestResponse = Output<typeof PermitRequestResponseSchema>;
export const PermitRequestResponseTextSchema = jsonText(PermitRequestResponseSchema);

/** permit_request_read's reply: the ids it marked, echoed. */
export const PermitRequestReadResponseSchema = v.object({
  ok: v.literal(true),
  ids: v.array(v.string()),
});
export type PermitRequestReadResponse = Output<typeof PermitRequestReadResponseSchema>;

/** Why the daemon could not show an attachment's content:
 *
 * - `missing`: nothing is at the path
 * - `not_a_file`: something is, and it is not a regular file (a directory …)
 * - `denied`: the daemon may not read it
 * - `not_text`: it is not UTF-8 text (it holds a NUL byte or a byte sequence
 *   UTF-8 does not have)
 * - `failed`: reading it failed otherwise */
export const PermitAttachmentUnreadableSchema = v.picklist([
  "missing",
  "not_a_file",
  "denied",
  "not_text",
  "failed",
]);
export type PermitAttachmentUnreadable = Output<typeof PermitAttachmentUnreadableSchema>;

/** Each reason in the words the person reads it in. */
export const PERMIT_ATTACHMENT_UNREADABLE_TEXT: Readonly<
  Record<PermitAttachmentUnreadable, string>
> = {
  missing: "ファイルが無い",
  not_a_file: "通常のファイルでない",
  denied: "読む権限が無い",
  not_text: "テキストでない",
  failed: "読めなかった",
};

/** One attachment as the daemon read it when the person opened it: its
 * content (the first PERMIT_ATTACHMENT_MAX_BYTES, `truncated` when the file
 * is longer, `bytes` its whole size), or why it could not. */
export const PermitAttachmentSchema = v.variant("read", [
  v.object({
    path: v.string(),
    read: v.literal(true),
    content: v.string(),
    bytes: v.number(),
    truncated: v.boolean(),
  }),
  v.object({
    path: v.string(),
    read: v.literal(false),
    reason: PermitAttachmentUnreadableSchema,
  }),
]);
export type PermitAttachment = Output<typeof PermitAttachmentSchema>;

/** permit_attachment_read's reply: the attachment as read now. */
export const PermitAttachmentReadResponseSchema = v.object({
  ok: v.literal(true),
  attachment: PermitAttachmentSchema,
});
export type PermitAttachmentReadResponse = Output<typeof PermitAttachmentReadResponseSchema>;
