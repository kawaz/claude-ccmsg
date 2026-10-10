// The content of a message in a Claude Code transcript row, and the tool
// calls in it, as schemas (DR-0038 §3).
//
// A message's content is a list of blocks told apart by `type`; a tool call
// is a `tool_use` block told apart again by the tool's `name`. Claude Code and
// the API add kinds of block and tools over time, so each variant ends in an
// "other" option (`otherThan`) that reads a kind not known yet with its fields
// as JSON values, while a block of a known kind whose shape is wrong fails.
//
// A tool's input is written by the model and reaches the transcript whether
// or not the tool could read it (an input that was not JSON is kept under
// `__unparsedToolInput`, a number may arrive as text). So a `tool_use` block
// holds its input as a JSON object, and the input's shape for its tool is read
// apart, with ToolUseSchema, where a reader interprets that tool: a call whose
// input does not fit fails alone, never the row that carries it.
import * as v from "valibot";
import { JsonObjectSchema, JsonValueSchema } from "./json-value.ts";
import { otherThan, type Output } from "./parse.ts";

// --- blocks -------------------------------------------------------------------

export const TextBlockSchema = v.looseObject({
  type: v.literal("text"),
  text: v.string(),
});
export type TextBlock = Output<typeof TextBlockSchema>;

export const ThinkingBlockSchema = v.looseObject({
  type: v.literal("thinking"),
  thinking: v.string(),
});
export type ThinkingBlock = Output<typeof ThinkingBlockSchema>;

/** Thinking the API returns encrypted: nothing in it is readable. */
export const RedactedThinkingBlockSchema = v.looseObject({
  type: v.literal("redacted_thinking"),
});
export type RedactedThinkingBlock = Output<typeof RedactedThinkingBlockSchema>;

/** An image, as Claude Code writes one: base64 data and its media type. */
export const ImageSourceSchema = v.looseObject({
  type: v.string(),
  media_type: v.string(),
  data: v.string(),
});
export type ImageSource = Output<typeof ImageSourceSchema>;

export const ImageBlockSchema = v.looseObject({
  type: v.literal("image"),
  source: ImageSourceSchema,
});
export type ImageBlock = Output<typeof ImageBlockSchema>;

/** A tool call: which tool (`name`), the id its result answers to, and the
 * input as the model wrote it. ToolUseSchema reads the input by its tool. */
export const ToolUseBlockSchema = v.looseObject({
  type: v.literal("tool_use"),
  id: v.string(),
  name: v.string(),
  input: JsonObjectSchema,
});
export type ToolUseBlock = Output<typeof ToolUseBlockSchema>;

const KNOWN_TOOL_RESULT_CONTENT_BLOCKS = [TextBlockSchema, ImageBlockSchema] as const;

/** The `type` of every block a tool result's content is read as. */
export const KNOWN_TOOL_RESULT_CONTENT_BLOCK_TYPES = KNOWN_TOOL_RESULT_CONTENT_BLOCKS.map(
  (option) => option.entries.type.literal,
);

/** A block of a tool result's content of a kind not known here (a document, a
 * tool reference), its fields as JSON. */
export const OtherToolResultContentBlockSchema = v.objectWithRest(
  { type: otherThan(KNOWN_TOOL_RESULT_CONTENT_BLOCK_TYPES) },
  JsonValueSchema,
);
export type OtherToolResultContentBlock = Output<typeof OtherToolResultContentBlockSchema>;

/** One block of a tool result's content when it is a list. */
export const ToolResultContentBlockSchema = v.variant("type", [
  ...KNOWN_TOOL_RESULT_CONTENT_BLOCKS,
  OtherToolResultContentBlockSchema,
]);
export type ToolResultContentBlock = Output<typeof ToolResultContentBlockSchema>;
export type KnownToolResultContentBlock = Output<(typeof KNOWN_TOOL_RESULT_CONTENT_BLOCKS)[number]>;

const KNOWN_TOOL_RESULT_CONTENT_BLOCK_TYPE_SET: ReadonlySet<string> = new Set<string>(
  KNOWN_TOOL_RESULT_CONTENT_BLOCK_TYPES,
);

/** Whether a block of a tool result's content is of a kind read here (and so
 * narrows by its `type`), rather than other. */
export function isKnownToolResultContentBlock(
  block: ToolResultContentBlock,
): block is KnownToolResultContentBlock {
  return KNOWN_TOOL_RESULT_CONTENT_BLOCK_TYPE_SET.has(block.type);
}

/** A tool's result, answering the `tool_use` of the same id. `content` is
 * text, or a list of blocks (text and images). `is_error` is there only on
 * some results. */
export const ToolResultBlockSchema = v.looseObject({
  type: v.literal("tool_result"),
  tool_use_id: v.string(),
  content: v.union([v.string(), v.array(ToolResultContentBlockSchema)]),
  is_error: v.optional(v.boolean()),
});
export type ToolResultBlock = Output<typeof ToolResultBlockSchema>;

const KNOWN_CONTENT_BLOCKS = [
  TextBlockSchema,
  ThinkingBlockSchema,
  RedactedThinkingBlockSchema,
  ToolUseBlockSchema,
  ToolResultBlockSchema,
  ImageBlockSchema,
] as const;

/** The `type` of every content block read here. */
export const KNOWN_CONTENT_BLOCK_TYPES = KNOWN_CONTENT_BLOCKS.map(
  (option) => option.entries.type.literal,
);

/** A content block of a kind not known here, its fields as JSON. */
export const OtherContentBlockSchema = v.objectWithRest(
  { type: otherThan(KNOWN_CONTENT_BLOCK_TYPES) },
  JsonValueSchema,
);
export type OtherContentBlock = Output<typeof OtherContentBlockSchema>;

/** One block of a message's content. */
export const ContentBlockSchema = v.variant("type", [
  ...KNOWN_CONTENT_BLOCKS,
  OtherContentBlockSchema,
]);
export type ContentBlock = Output<typeof ContentBlockSchema>;
export type KnownContentBlock = Output<(typeof KNOWN_CONTENT_BLOCKS)[number]>;

const KNOWN_CONTENT_BLOCK_TYPE_SET: ReadonlySet<string> = new Set<string>(
  KNOWN_CONTENT_BLOCK_TYPES,
);

/** Whether a content block is of a kind read here (and so narrows by its
 * `type`), rather than other. An other block's `type` is a string, which
 * TypeScript cannot tell apart from the known names; this tells them apart by
 * the names the other option excludes. */
export function isKnownContentBlock(block: ContentBlock): block is KnownContentBlock {
  return KNOWN_CONTENT_BLOCK_TYPE_SET.has(block.type);
}

// --- tool calls, by tool --------------------------------------------------------

/** A `tool_use` block of the tool `name` whose input has `input`'s fields. */
function toolUse<const TName extends string, const TInput extends v.ObjectEntries>(
  name: TName,
  input: TInput,
) {
  return v.looseObject({
    type: v.literal("tool_use"),
    id: v.string(),
    name: v.literal(name),
    input: v.looseObject(input),
  });
}

export const ReadToolUseSchema = toolUse("Read", {
  file_path: v.string(),
  offset: v.optional(v.number()),
  limit: v.optional(v.number()),
});
export const WriteToolUseSchema = toolUse("Write", {
  file_path: v.string(),
  content: v.string(),
});
export const EditToolUseSchema = toolUse("Edit", {
  file_path: v.string(),
  old_string: v.string(),
  new_string: v.string(),
});
export const MultiEditToolUseSchema = toolUse("MultiEdit", {
  file_path: v.string(),
});
export const NotebookEditToolUseSchema = toolUse("NotebookEdit", {
  notebook_path: v.string(),
});
export const BashToolUseSchema = toolUse("Bash", {
  command: v.string(),
  description: v.optional(v.string()),
  run_in_background: v.optional(v.boolean()),
});
export const AgentToolUseSchema = toolUse("Agent", {
  description: v.string(),
  prompt: v.string(),
  subagent_type: v.optional(v.string()),
  name: v.optional(v.string()),
  model: v.optional(v.string()),
  run_in_background: v.optional(v.boolean()),
});
/** `message` is text, or a structured message (an object) such as a request
 * to shut down. */
export const SendMessageToolUseSchema = toolUse("SendMessage", {
  to: v.string(),
  message: v.union([v.string(), JsonObjectSchema]),
  summary: v.optional(v.string()),
});
export const TaskCreateToolUseSchema = toolUse("TaskCreate", {
  subject: v.string(),
  description: v.optional(v.string()),
});
export const TaskUpdateToolUseSchema = toolUse("TaskUpdate", {
  taskId: v.string(),
  status: v.optional(v.string()),
  owner: v.optional(v.string()),
  subject: v.optional(v.string()),
  addBlockedBy: v.optional(v.array(v.string())),
  addBlocks: v.optional(v.array(v.string())),
});
export const TaskStopToolUseSchema = toolUse("TaskStop", {
  task_id: v.string(),
});
export const MonitorToolUseSchema = toolUse("Monitor", {
  command: v.string(),
  description: v.string(),
});
export const CronCreateToolUseSchema = toolUse("CronCreate", {
  cron: v.string(),
  prompt: v.string(),
  recurring: v.optional(v.boolean()),
});
export const CronDeleteToolUseSchema = toolUse("CronDelete", {
  id: v.string(),
});

const KNOWN_TOOL_USES = [
  ReadToolUseSchema,
  WriteToolUseSchema,
  EditToolUseSchema,
  MultiEditToolUseSchema,
  NotebookEditToolUseSchema,
  BashToolUseSchema,
  AgentToolUseSchema,
  SendMessageToolUseSchema,
  TaskCreateToolUseSchema,
  TaskUpdateToolUseSchema,
  TaskStopToolUseSchema,
  MonitorToolUseSchema,
  CronCreateToolUseSchema,
  CronDeleteToolUseSchema,
] as const;

/** The name of every tool whose input is read here. */
export const KNOWN_TOOL_NAMES = KNOWN_TOOL_USES.map((option) => option.entries.name.literal);

/** A call of a tool whose input is not read here: the input as JSON. */
export const OtherToolUseSchema = v.looseObject({
  type: v.literal("tool_use"),
  id: v.string(),
  name: otherThan(KNOWN_TOOL_NAMES),
  input: JsonObjectSchema,
});
export type OtherToolUse = Output<typeof OtherToolUseSchema>;

/** A tool call with its input read by its tool. Read from a ToolUseBlock
 * where a reader interprets the call; a call whose input does not fit its
 * tool is a failure of that call alone. */
export const ToolUseSchema = v.variant("name", [...KNOWN_TOOL_USES, OtherToolUseSchema]);
export type ToolUse = Output<typeof ToolUseSchema>;
export type KnownToolUse = Output<(typeof KNOWN_TOOL_USES)[number]>;

const KNOWN_TOOL_NAME_SET: ReadonlySet<string> = new Set<string>(KNOWN_TOOL_NAMES);

/** Whether a tool call is of a tool whose input is read here (and so narrows
 * by its `name`), rather than other. */
export function isKnownToolUse(call: ToolUse): call is KnownToolUse {
  return KNOWN_TOOL_NAME_SET.has(call.name);
}
