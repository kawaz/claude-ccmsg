// One row of a Claude Code transcript (a line of `<sid>.jsonl`), as schemas
// (DR-0038 §3).
//
// The transcript is Claude Code's, and its shape moves with Claude Code. Each
// schema lists the fields ccmsg reads and lets the rest through; a field is
// required only where every row of its kind observed carries it. A row that
// does not read fails alone: a reader drops it or shows it as broken, and goes
// on with the next.
//
// A row is told apart by `type`. The kinds read here end in an "other" option
// (`otherThan`): Claude Code writes more kinds than ccmsg reads (titles, modes,
// the last prompt, ...) and adds new ones, and those read as other with their
// fields as JSON values, while a row of a known kind whose shape is wrong
// fails.
//
// A scan that wants one or two fields of every row (its uuid, its cwd, its
// time) reads a projection instead of the whole row: the head fields it needs,
// from the same field schemas as the rows. A projection reads only what it
// names, so a row whose other fields are wrong, or that is huge, costs it
// nothing more than the JSON.
import * as v from "valibot";
import { JsonValueSchema } from "./json-value.ts";
import { jsonText, otherThan, type Output } from "./parse.ts";
import { AttachmentSchema, OriginSchema } from "./transcript-attachment.ts";
import { ContentBlockSchema } from "./transcript-content.ts";

/** The fields of a row's head, each its own schema, for the rows and the
 * projections to build from. Which rows carry which differs: a
 * `queue-operation` has no `uuid`, `parentUuid`, `cwd` or `isSidechain`, and
 * the metadata rows (titles, modes, ...) not even a `timestamp`. */
export const RowHeadEntries = {
  type: v.string(),
  uuid: v.pipe(v.string(), v.nonEmpty()),
  /** null on the first row of a session, and of a subagent's. */
  parentUuid: v.nullable(v.string()),
  timestamp: v.string(),
  cwd: v.string(),
  /** true on every row of a subagent's transcript. */
  isSidechain: v.boolean(),
};

/** The head of the rows of a turn (user, assistant, attachment, system). */
const TurnRowHeadEntries = {
  uuid: RowHeadEntries.uuid,
  parentUuid: RowHeadEntries.parentUuid,
  timestamp: RowHeadEntries.timestamp,
  cwd: RowHeadEntries.cwd,
  isSidechain: RowHeadEntries.isSidechain,
};

// --- projections ----------------------------------------------------------------

/** Any row, read for its head alone: every head field it carries. */
export const TranscriptRowHeadSchema = v.looseObject({
  type: RowHeadEntries.type,
  uuid: v.optional(RowHeadEntries.uuid),
  parentUuid: v.optional(RowHeadEntries.parentUuid),
  timestamp: v.optional(RowHeadEntries.timestamp),
  cwd: v.optional(RowHeadEntries.cwd),
  isSidechain: v.optional(RowHeadEntries.isSidechain),
});
export type TranscriptRowHead = Output<typeof TranscriptRowHeadSchema>;

/** Any row, read for its uuid alone. */
export const TranscriptRowUuidSchema = v.looseObject({
  uuid: v.optional(RowHeadEntries.uuid),
});
export const TranscriptRowUuidLineSchema = jsonText(TranscriptRowUuidSchema);

/** Any row, read for its cwd alone. */
export const TranscriptRowCwdSchema = v.looseObject({
  cwd: v.optional(RowHeadEntries.cwd),
});
export const TranscriptRowCwdLineSchema = jsonText(TranscriptRowCwdSchema);

/** Any row, read for its timestamp alone. */
export const TranscriptRowTimestampSchema = v.looseObject({
  timestamp: v.optional(RowHeadEntries.timestamp),
});
export const TranscriptRowTimestampLineSchema = jsonText(TranscriptRowTimestampSchema);

// --- messages ---------------------------------------------------------------------

/** What a user row says: text, or blocks (tool results, text, images). */
export const UserMessageSchema = v.looseObject({
  content: v.union([v.string(), v.array(ContentBlockSchema)]),
});
export type UserMessage = Output<typeof UserMessageSchema>;

/** The tokens one API request used. A request that neither read nor wrote
 * the prompt cache may leave those counts out: none were used. */
export const UsageSchema = v.looseObject({
  input_tokens: v.number(),
  cache_read_input_tokens: v.optional(v.number(), 0),
  cache_creation_input_tokens: v.optional(v.number(), 0),
});
export type Usage = Output<typeof UsageSchema>;

/** What an assistant row says, and which model said it (`<synthetic>` for a
 * message Claude Code wrote itself, such as an API error). */
export const AssistantMessageSchema = v.looseObject({
  model: v.string(),
  content: v.array(ContentBlockSchema),
  usage: UsageSchema,
});
export type AssistantMessage = Output<typeof AssistantMessageSchema>;

// --- rows ---------------------------------------------------------------------------

/** A user's turn, a tool's result, or text Claude Code delivers as the
 * user's. `toolUseResult` is the result of the tool the row answers, whose
 * shape is the tool's: it is read by the tool where the result is matched to
 * its `tool_use` (text, when the tool failed). */
export const UserRowSchema = v.looseObject({
  type: v.literal("user"),
  ...TurnRowHeadEntries,
  message: UserMessageSchema,
  isMeta: v.optional(v.boolean()),
  origin: v.optional(OriginSchema),
  promptSource: v.optional(v.string()),
  toolUseResult: v.optional(JsonValueSchema),
});
export type UserRow = Output<typeof UserRowSchema>;

export const AssistantRowSchema = v.looseObject({
  type: v.literal("assistant"),
  ...TurnRowHeadEntries,
  message: AssistantMessageSchema,
  isApiErrorMessage: v.optional(v.boolean()),
  /** How Claude Code classified the API error an `isApiErrorMessage` row
   * reports (`server_error`, `rate_limit`, `invalid_request`, `unknown`, ...,
   * the words of its StopFailure). An open set: Claude Code names the kinds,
   * and some error rows carry none. */
  error: v.optional(v.string()),
  effort: v.optional(v.string()),
});
export type AssistantRow = Output<typeof AssistantRowSchema>;

export const AttachmentRowSchema = v.looseObject({
  type: v.literal("attachment"),
  ...TurnRowHeadEntries,
  attachment: AttachmentSchema,
});
export type AttachmentRow = Output<typeof AttachmentRowSchema>;

/** A change to the queue of prompts waiting for the turn to end
 * (`operation`: enqueue, dequeue, remove, popAll, ...). It is no part of the
 * conversation's tree: no uuid, parent, cwd or sidechain flag. */
export const QueueOperationRowSchema = v.looseObject({
  type: v.literal("queue-operation"),
  timestamp: RowHeadEntries.timestamp,
  operation: v.string(),
  content: v.optional(v.string()),
});
export type QueueOperationRow = Output<typeof QueueOperationRowSchema>;

/** Something Claude Code records about the turn (`subtype`: a hook summary,
 * the turn's duration, a local command, ...). */
export const SystemRowSchema = v.looseObject({
  type: v.literal("system"),
  ...TurnRowHeadEntries,
  subtype: v.string(),
  content: v.optional(v.string()),
  level: v.optional(v.string()),
  isMeta: v.optional(v.boolean()),
});
export type SystemRow = Output<typeof SystemRowSchema>;

/** The title `/rename` gave the session. A metadata row: no timestamp. */
export const CustomTitleRowSchema = v.looseObject({
  type: v.literal("custom-title"),
  customTitle: v.string(),
});
export type CustomTitleRow = Output<typeof CustomTitleRowSchema>;

const KNOWN_ROWS = [
  UserRowSchema,
  AssistantRowSchema,
  AttachmentRowSchema,
  QueueOperationRowSchema,
  SystemRowSchema,
  CustomTitleRowSchema,
] as const;

/** The `type` of every row read here. */
export const KNOWN_TRANSCRIPT_ROW_TYPES = KNOWN_ROWS.map((option) => option.entries.type.literal);

/** A row of a kind not read here, its fields as JSON. */
export const OtherTranscriptRowSchema = v.objectWithRest(
  { type: otherThan(KNOWN_TRANSCRIPT_ROW_TYPES) },
  JsonValueSchema,
);
export type OtherTranscriptRow = Output<typeof OtherTranscriptRowSchema>;

/** One row of a transcript. */
export const TranscriptRowSchema = v.variant("type", [...KNOWN_ROWS, OtherTranscriptRowSchema]);
export type TranscriptRow = Output<typeof TranscriptRowSchema>;
export type KnownTranscriptRow = Output<(typeof KNOWN_ROWS)[number]>;

/** One line of a transcript, read as its row. */
export const TranscriptRowLineSchema = jsonText(TranscriptRowSchema);

const KNOWN_TRANSCRIPT_ROW_TYPE_SET: ReadonlySet<string> = new Set<string>(
  KNOWN_TRANSCRIPT_ROW_TYPES,
);

/** Whether a row is of a kind read here (and so narrows by its `type`),
 * rather than other. An other row's `type` is a string, which TypeScript
 * cannot tell apart from the known names; this tells them apart by the names
 * the other option excludes. */
export function isKnownTranscriptRow(row: TranscriptRow): row is KnownTranscriptRow {
  return KNOWN_TRANSCRIPT_ROW_TYPE_SET.has(row.type);
}
