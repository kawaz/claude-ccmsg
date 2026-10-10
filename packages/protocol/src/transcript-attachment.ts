// What Claude Code attaches to a transcript (the `attachment` of an
// `attachment` row), and where a turn came from, as schemas (DR-0038 §3).
//
// An attachment is told apart by its own `type`. Claude Code adds kinds over
// time (19 were seen in two weeks), so the variant ends in an "other" option
// (`otherThan`) that reads a kind not known yet with its fields as JSON
// values, while an attachment of a known kind whose shape is wrong fails.
import * as v from "valibot";
import { JsonValueSchema } from "./json-value.ts";
import { otherThan, type Output } from "./parse.ts";
import { ContentBlockSchema } from "./transcript-content.ts";

/** Where a turn came from (`origin` of a user row or a queued command):
 * `kind` names the source (`human`, `peer`, `task-notification`, ...), and
 * the rest depends on it. */
export const OriginSchema = v.looseObject({
  kind: v.string(),
});
export type Origin = Output<typeof OriginSchema>;

/** A prompt queued while a turn was running, delivered with the next one.
 * `prompt` is text, or blocks when it carries an image. */
export const QueuedCommandAttachmentSchema = v.looseObject({
  type: v.literal("queued_command"),
  prompt: v.union([v.string(), v.array(ContentBlockSchema)]),
  origin: v.optional(OriginSchema),
  commandMode: v.optional(v.string()),
});
export type QueuedCommandAttachment = Output<typeof QueuedCommandAttachmentSchema>;

/** One item of the task list a task reminder carries. */
export const TaskReminderItemSchema = v.looseObject({
  id: v.string(),
  subject: v.string(),
  status: v.string(),
  owner: v.optional(v.string()),
  blocks: v.array(v.string()),
  blockedBy: v.array(v.string()),
});
export type TaskReminderItem = Output<typeof TaskReminderItemSchema>;

export const TaskReminderAttachmentSchema = v.looseObject({
  type: v.literal("task_reminder"),
  content: v.array(TaskReminderItemSchema),
});
export type TaskReminderAttachment = Output<typeof TaskReminderAttachmentSchema>;

/** A file the user or a tool changed outside the conversation, with the
 * changed part. */
export const EditedTextFileAttachmentSchema = v.looseObject({
  type: v.literal("edited_text_file"),
  filename: v.string(),
  snippet: v.string(),
});
export type EditedTextFileAttachment = Output<typeof EditedTextFileAttachmentSchema>;

/** A file mentioned in a prompt, read into the turn. `content.file` holds
 * text (`content`, `startLine`) or an image, by the file. Text with no
 * `startLine` starts at the file's first line. */
export const FileAttachmentSchema = v.looseObject({
  type: v.literal("file"),
  filename: v.string(),
  displayPath: v.string(),
  content: v.looseObject({
    type: v.string(),
    file: v.looseObject({
      content: v.optional(v.string()),
      startLine: v.optional(v.number(), 1),
    }),
  }),
});
export type FileAttachment = Output<typeof FileAttachmentSchema>;

/** A hook that ran and succeeded, with what it printed. */
export const HookSuccessAttachmentSchema = v.looseObject({
  type: v.literal("hook_success"),
  hookName: v.string(),
  hookEvent: v.string(),
  command: v.string(),
  exitCode: v.number(),
  durationMs: v.number(),
  stdout: v.string(),
  stderr: v.string(),
});
export type HookSuccessAttachment = Output<typeof HookSuccessAttachmentSchema>;

/** Context a hook added to the turn. */
export const HookAdditionalContextAttachmentSchema = v.looseObject({
  type: v.literal("hook_additional_context"),
  hookName: v.string(),
  hookEvent: v.string(),
  content: v.array(v.string()),
});
export type HookAdditionalContextAttachment = Output<typeof HookAdditionalContextAttachmentSchema>;

const KNOWN_ATTACHMENTS = [
  QueuedCommandAttachmentSchema,
  TaskReminderAttachmentSchema,
  EditedTextFileAttachmentSchema,
  FileAttachmentSchema,
  HookSuccessAttachmentSchema,
  HookAdditionalContextAttachmentSchema,
] as const;

/** The `type` of every attachment read here. */
export const KNOWN_ATTACHMENT_TYPES = KNOWN_ATTACHMENTS.map(
  (option) => option.entries.type.literal,
);

/** An attachment of a kind not known here, its fields as JSON. */
export const OtherAttachmentSchema = v.objectWithRest(
  { type: otherThan(KNOWN_ATTACHMENT_TYPES) },
  JsonValueSchema,
);
export type OtherAttachment = Output<typeof OtherAttachmentSchema>;

export const AttachmentSchema = v.variant("type", [...KNOWN_ATTACHMENTS, OtherAttachmentSchema]);
export type Attachment = Output<typeof AttachmentSchema>;
export type KnownAttachment = Output<(typeof KNOWN_ATTACHMENTS)[number]>;

const KNOWN_ATTACHMENT_TYPE_SET: ReadonlySet<string> = new Set<string>(KNOWN_ATTACHMENT_TYPES);

/** Whether an attachment is of a kind read here (and so narrows by its
 * `type`), rather than other. */
export function isKnownAttachment(attachment: Attachment): attachment is KnownAttachment {
  return KNOWN_ATTACHMENT_TYPE_SET.has(attachment.type);
}
