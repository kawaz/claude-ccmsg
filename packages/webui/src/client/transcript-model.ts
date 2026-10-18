import {
  type AssistantRow,
  type Attachment,
  ccmsgSendCall,
  classifyCcmsgSendResult,
  type ContentBlock,
  DIRECT_DELIVERY_USER_SENDER,
  type ImageBlock,
  isKnownAttachment,
  isKnownContentBlock,
  isKnownReadResult,
  isKnownToolResultContentBlock,
  isKnownToolUse,
  isKnownTranscriptRow,
  type JsonObject,
  JsonTextSchema,
  jsonText,
  type JsonValue,
  JsonValueSchema,
  type KnownTranscriptRow,
  mayContainDirectDelivery,
  parseCcmsgSendCommand,
  parseDirectDeliveries,
  type ParseFailure,
  parseWith,
  pushNotificationText,
  readSendResultText,
  queuedCommandPrompt,
  ReadToolResultSchema,
  type ToolResultBlock,
  type ToolResultContentBlock,
  type ToolUseBlock,
  ToolUseFilePathSchema,
  ToolUseSchema,
  TranscriptRowHeadSchema,
  TranscriptRowSchema,
  type UserRow,
} from "@ccmsg/protocol";
import * as v from "valibot";
// Pure jsonl-line -> renderable-event transform for the Timeline view
// (DR-0009). Kept out of the Timeline components (components/timeline/) so the fold logic is unit-testable
// without preact/DOM, mirroring store.ts's reducer/effect split (DR-0005 §1).
//
// Each line is read once, as protocol's transcript row (DR-0038 §3). Claude
// Code's transcript is not stable across versions (DR-0009 "jsonl フォーマット
// の安定性"), so a row of a kind not read here (`file-history-snapshot`,
// `mode`, a kind added later, ...) reads as protocol's "other" row and folds
// through the same one-line-summary path as the known non-turn rows
// (`system`, `queue-operation`, `custom-title`), with the raw JSON behind it:
// "safe fallback for unknown types" and "compact display for the other known
// types" are one code path. A line that does not read at all — not JSON, or a
// row of a known kind whose shape is wrong — is a BrokenLine that says so,
// never a guess at what it meant.

/**
 * What a file tool (Read/Write/Edit) actually got back, in the three shapes
 * Claude Code writes for it. Measured over the local session corpus
 * (2026-07-30, 254 Read results): 235 text, 15 image, 4 error — no fourth
 * shape, and every one of those 19 non-text results used to leave the Read
 * card claiming "読み取り結果は現在の読み込み範囲外です" (kawaz r76 m90).
 *
 * - `text`: `toolUseResult.file.content` — the file's decoded text.
 * - `image`: reading an image file. `toolUseResult` carries no `content`;
 *   the bytes arrive as `file.base64` (`file.type` = mime), sized to
 *   `file.dimensions.display{Width,Height}` — the harness downscales large
 *   images before handing them to the model, so these are the dimensions of
 *   the base64 payload itself, not of the file on disk.
 * - `error`: the tool failed (`is_error`, e.g. "File does not exist."), so
 *   there is no file payload at all.
 */
export type FileToolResult =
  | { kind: "text"; content: string }
  | {
      kind: "image";
      mediaType: string;
      base64: string;
      width: number | null;
      height: number | null;
    }
  | { kind: "error"; message: string };

/** One block inside a user/assistant turn's `message.content`, normalized
 * across the shapes Claude Code emits (string content, array of typed
 * blocks). `unknown-segment` is the forward-compat catch-all for a content
 * block of a kind this module has no rendering for, shown as its JSON. A tool
 * result carries the row's `toolUseResult` unread (`resolveToolResults` reads
 * it by the tool that was called). */
export type Segment =
  | { kind: "text"; role: "user" | "assistant"; text: string }
  | { kind: "thinking"; text: string }
  // 思考は起きたが本文が transcript に無い block。`omitted` は API の
  // `display:"omitted"` (thinking:"" + signature — signature は本文の
  // 暗号化コピーなので復号できず、表示にも使えない)、`redacted` は
  // `redacted_thinking` (本文が `data` に墨消し済みで入る)。本文が無い以上
  // 翻訳も検索もできないため、text を持つ `thinking` とは別 variant にして
  // 各 switch に扱いを明示させる。
  | { kind: "thinking-hidden"; reason: "omitted" | "redacted" }
  | {
      kind: "tool-use";
      toolUseId: string;
      name: string;
      input: JsonObject;
      /** The call's tool_result, once one is paired with it (withToolResults). */
      result: { text: string; isError: boolean } | null;
    }
  | {
      kind: "file-read";
      toolUseId: string;
      path: string;
      offset: number | null;
      limit: number | null;
      result: FileToolResult | null;
    }
  | { kind: "file-write"; path: string; content: string }
  | { kind: "file-edit"; path: string; oldString: string; newString: string }
  | {
      kind: "file-tool-result";
      toolUseId: string;
      result: FileToolResult;
      toolUseResult?: JsonValue;
    }
  | {
      kind: "bash-use";
      toolUseId: string;
      command: string;
      description: string;
      background: boolean;
      result: { text: string; isError: boolean } | null;
      hasResult: boolean;
    }
  | {
      kind: "bash-result";
      toolUseId: string;
      text: string;
      isError: boolean;
      background: boolean;
      hasCommand: boolean;
    }
  | {
      kind: "agent-send";
      to: string;
      summary: string | null;
      message: string;
      messageType: string;
    }
  | {
      kind: "agent-spawn";
      name: string;
      agentType: string;
      model: string;
      description: string;
      prompt: string;
      background: boolean;
    }
  | { kind: "slash-command-prefix"; command: string }
  | { kind: "bash-command"; command: string; output: BashCommandOutput | null }
  | ({ kind: "bash-command-output"; hasCommand: boolean } & BashCommandOutput)
  | {
      kind: "tool-result";
      toolUseId: string;
      isError: boolean;
      text: string;
      toolUseResult?: JsonValue;
    }
  | { kind: "unknown-segment"; type: string; raw: JsonValue };

/** Output of one TUI `! <cmd>` run. Claude Code caps what it writes into the
 * transcript: past roughly 50KB the `<bash-stdout>` body is replaced by a
 * `<persisted-output>` block holding a short note, the absolute path of a
 * sidecar file with the untruncated bytes, and a 2KB preview (measured
 * 2026-07-29 against Claude Code v2.1.220: 30KB inline verbatim, 60KB and
 * 4.8MB both persisted with a ~2.3KB stub). So `stdout` here is always small
 * enough to render directly, and `persisted` is what points at the rest. */
export interface BashCommandOutput {
  stdout: string | null;
  stderr: string | null;
  persisted: { note: string; path: string; preview: string } | null;
}

export interface TurnLine {
  kind: "turn";
  ts: string | null;
  /** Stable JSONL row identifier used by Timeline position URLs. */
  uuid?: string;
  /** The row this one was written as a continuation of. A transcript is a tree,
   * not a list: resuming a session without `--fork-session` appends a new
   * branch to the same file, leaving the rows after the resume point on an
   * abandoned branch that stays in the file and is still rendered. Only the
   * chain ending at the last row is the conversation `claude --resume`
   * reconstructs, which is what makes this field worth carrying — see
   * `liveChainUuids` in fork-point.ts. Absent on a session's first row
   * (`parentUuid: null` on the wire) and on rows that carry no link. */
  parentUuid?: string;
  role: "user" | "assistant";
  segments: Segment[];
  /** classifyUserMessage's verdict for a role:"user" line — which pattern of
   * "type:user に見えるシステム由来メッセージ" (or a real human utterance,
   * "user-prompt") this line matches. Absent for role:"assistant" (that side
   * has its own `assistantMessageKind`, since the user-role injection
   * patterns classifyUserMessage catalogs never appear there) and for
   * hand-built ParsedLine values elsewhere (e.g. test fixtures) that never
   * went through parseTranscriptLine. */
  userMessageKind?: UserMessageKind;
  /** classifyAssistantMessage's verdict for a role:"assistant" line — real
   * model output ("assistant-response") vs a harness-synthesized report of
   * the turn being cut short ("api-error"). The mirror of `userMessageKind`
   * on the assistant side; absent for role:"user" and for hand-built
   * ParsedLine values that never went through parseTranscriptLine. */
  assistantMessageKind?: AssistantMessageKind;
  /** For a turn synthesized from a `queue-operation` enqueue row: that row's
   * raw `content` string. Present only on that synthetic shape, and used by
   * `parseTranscriptLines` to pair the queued copy with the `type:"user"`
   * row that later delivered it (see `parseKnownRow`'s queue-operation
   * branch). */
  queuedContent?: string;
}

/** Any top-level `type` other than "user"/"assistant" — see module doc
 * comment for why known and unknown types share this one shape. */
export interface MetaLine {
  kind: "meta";
  ts: string | null;
  /** Stable JSONL row identifier used by Timeline position URLs. */
  uuid?: string;
  /** Same link as TurnLine.parentUuid. Carried on meta rows too because the
   * chain `liveChainUuids` walks runs through them — an attachment sitting
   * between two turns is part of the conversation's parent chain, and dropping
   * its link would cut the walk short at the first attachment. */
  parentUuid?: string;
  type: string;
  summary: string;
  raw: string;
  /** Present only on `type:"attachment"` rows — the shared chrome (type name)
   * plus whatever the per-type spec could pull out of this attachment. */
  attachment?: AttachmentDetail;
}

/** A line that does not read as a transcript row: not JSON, or a row of a
 * known kind whose shape is wrong. Shown as unreadable, with why and the line
 * as written — never thrown, never guessed at. */
export interface BrokenLine {
  kind: "broken";
  raw: string;
  /** Why the line does not read (the first thing wrong with it). */
  error: string;
}

export type ParsedLine = TurnLine | MetaLine | BrokenLine;

/** A tool result's content as text: the text blocks as they are, an image as
 * a short placeholder naming its media type, and a block of a kind not known
 * here as its JSON. */
function toolResultText(content: ToolResultBlock["content"]): string {
  if (typeof content === "string") return content;
  return content.map(toolResultContentText).join("\n");
}

function toolResultContentText(block: ToolResultContentBlock): string {
  if (!isKnownToolResultContentBlock(block)) return JSON.stringify(block);
  switch (block.type) {
    case "text":
      return block.text;
    case "image":
      return `[image ${block.source.media_type}]`;
  }
}

/** The segment of one tool call. A call whose input reads as its tool's gets
 * that tool's card; a call of a tool with no card, or whose input does not
 * read as its tool's (the model wrote it), shows its input as written. A Read
 * whose input is wrong apart from the path (an `offset` written as a list)
 * keeps its card, without the range. */
function toolUseSegment(block: ToolUseBlock): Segment {
  const read = parseWith(ToolUseSchema, block);
  if (!read.ok) {
    const file = parseWith(ToolUseFilePathSchema, block);
    return file.ok && file.value.name === "Read"
      ? fileReadSegment(block.id, file.value.input.file_path, null, null)
      : genericToolUseSegment(block);
  }
  const call = read.value;
  if (!isKnownToolUse(call)) return genericToolUseSegment(block);
  switch (call.name) {
    case "Bash":
      return {
        kind: "bash-use",
        toolUseId: call.id,
        command: call.input.command,
        description: call.input.description,
        background: call.input.run_in_background === true,
        result: null,
        hasResult: false,
      };
    case "Read":
      return fileReadSegment(
        call.id,
        call.input.file_path,
        call.input.offset ?? null,
        call.input.limit ?? null,
      );
    case "Write":
      return { kind: "file-write", path: call.input.file_path, content: call.input.content };
    case "Edit":
      return {
        kind: "file-edit",
        path: call.input.file_path,
        oldString: call.input.old_string,
        newString: call.input.new_string,
      };
    case "SendMessage": {
      const { message } = call.input;
      return {
        kind: "agent-send",
        to: call.input.to,
        summary: call.input.summary ?? null,
        message: typeof message === "string" ? message : JSON.stringify(message, null, 2),
        messageType: call.input.type ?? "message",
      };
    }
    case "Agent":
      // Agent tool の identity は explicit な `name` を最優先。
      // 無ければ `subagent_type` (worker preset 名) にフォールバックする。
      // `description` は「起動理由」であって identity ではないため、
      // 名前欄には流し込まない (kawaz r44 mid=5: 🤖→ の後ろには
      // spawn 先の名前を出すのが自然、description は従属表示)。
      return {
        kind: "agent-spawn",
        name: call.input.name ?? call.input.subagent_type ?? "agent",
        agentType: call.input.subagent_type ?? "",
        model: call.input.model ?? "",
        description: call.input.description,
        prompt: call.input.prompt,
        background: call.input.run_in_background === true,
      };
    default:
      return genericToolUseSegment(block);
  }
}

function fileReadSegment(
  toolUseId: string,
  path: string,
  offset: number | null,
  limit: number | null,
): Segment {
  return { kind: "file-read", toolUseId, path, offset, limit, result: null };
}

function genericToolUseSegment(block: ToolUseBlock): Segment {
  return {
    kind: "tool-use",
    toolUseId: block.id,
    name: block.name,
    input: block.input,
    result: null,
  };
}

/** The image a tool result's content carries, or `null` when it carries none:
 * the block's own `{type:"image", source}`, in the shape the Anthropic API
 * uses. It names no size (`toolUseResult` does, for a Read: see
 * `readToolResult`). */
function blockImage(
  content: ToolResultBlock["content"],
): Extract<FileToolResult, { kind: "image" }> | null {
  if (typeof content === "string") return null;
  for (const block of content) {
    if (!isKnownToolResultContentBlock(block) || block.type !== "image") continue;
    return {
      kind: "image",
      mediaType: block.source.media_type,
      base64: block.source.data,
      width: null,
      height: null,
    };
  }
  return null;
}

/** One tool result. Its `toolUseResult` is the called tool's, so it rides
 * along unread until `resolveToolResults` knows the tool. An image in the
 * block itself is read here: a transcript row that has only the block (no
 * `toolUseResult`, e.g. a row written by a different harness version) still
 * renders as an image. */
function toolResultSegment(block: ToolResultBlock, toolUseResult: JsonValue | undefined): Segment {
  const carried = toolUseResult !== undefined ? { toolUseResult } : {};
  const image = blockImage(block.content);
  if (image !== null) {
    return { kind: "file-tool-result", toolUseId: block.tool_use_id, result: image, ...carried };
  }
  return {
    kind: "tool-result",
    toolUseId: block.tool_use_id,
    isError: block.is_error === true,
    text: toolResultText(block.content),
    ...carried,
  };
}

/** An image block of a user's message, as the JSON it was written as: a
 * pasted image has no card yet and shows as its block. */
function imageBlockJson(block: ImageBlock): JsonValue {
  return {
    type: block.type,
    source: {
      type: block.source.type,
      media_type: block.source.media_type,
      data: block.source.data,
    },
  };
}

function blockSegment(
  block: ContentBlock,
  role: "user" | "assistant",
  toolUseResult: JsonValue | undefined,
): Segment {
  if (!isKnownContentBlock(block)) return { kind: "unknown-segment", type: block.type, raw: block };
  switch (block.type) {
    case "text":
      return { kind: "text", role, text: block.text };
    case "thinking":
      return block.thinking.trim()
        ? { kind: "thinking", text: block.thinking }
        : { kind: "thinking-hidden", reason: "omitted" };
    case "redacted_thinking":
      return { kind: "thinking-hidden", reason: "redacted" };
    case "image":
      return { kind: "unknown-segment", type: block.type, raw: imageBlockJson(block) };
    case "tool_use":
      return toolUseSegment(block);
    case "tool_result":
      return toolResultSegment(block, toolUseResult);
  }
}

function parseSegments(
  content: string | readonly ContentBlock[],
  role: "user" | "assistant",
  toolUseResult: JsonValue | undefined,
): Segment[] {
  if (typeof content === "string") {
    return content ? [{ kind: "text", role, text: content }] : [];
  }
  return content.map((block) => blockSegment(block, role, toolUseResult));
}

/**
 * What the Timeline shows for a `type:"attachment"` row: shared chrome (the
 * attachment's own `type`, always rendered the same way) plus the per-type
 * extras its kind carries. A kind with nothing extracted — including one
 * Claude Code adds after this was written — still gets `type` and the
 * raw-JSON expand, matching the module's forward-compat rule for unseen
 * shapes.
 */
export interface AttachmentDetail {
  /** `attachment.type` verbatim, `"?"` when it is empty. */
  type: string;
  /** Short label shown to the right of the closed fold's own label — the one
   * field that identifies *which* attachment of this type this row is (hook
   * name, edited file, …). `null` when the type has nothing to name. */
  trailing: string | null;
  /** Rows rendered above the raw JSON when the fold is open. Empty for types
   * whose payload the raw JSON already shows adequately. */
  fields: SystemMessageField[];
  /** File body carried by the attachment itself, for the types that embed one
   * (kawaz r99 m35: read these like a Read card rather than as raw JSON).
   * Absent when the payload has no text body — an image `file` attachment, or
   * any type this module has no file shape for. */
  file?: AttachmentFile;
}

/** One attachment's embedded file preview. `content` is the raw text as the
 * file has it (line numbers, where the payload carries them, are stripped into
 * `startLine`), so it renders through the same InlineFileViewer a Read card
 * uses. */
export interface AttachmentFile {
  /** Absolute path as the attachment spelled it — the spelling the daemon's
   * external_files allowlist also records, so the timeline can link it. */
  path: string;
  content: string;
  /** 1-based line number of `content`'s first line. An edited-file snippet
   * starts wherever the edit was, so numbering it from 1 would misname every
   * line. */
  startLine: number;
}

/** The path an attachment of a kind not known here names, by the field names
 * seen across attachment kinds, in priority order. */
const OtherAttachmentPathSchema = v.looseObject({
  filename: v.optional(v.string()),
  file_path: v.optional(v.string()),
  filePath: v.optional(v.string()),
  path: v.optional(v.string()),
  displayPath: v.optional(v.string()),
});

/** `path` shortened to a cwd-relative form when it sits under `cwd`. */
function displayPath(path: string, cwd: string): string {
  if (cwd === "") return path;
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

/** `path` as a trailing label, or `null` for an empty one. */
function pathTrailing(path: string | undefined, cwd: string): string | null {
  return path === undefined || path === "" ? null : displayPath(path, cwd);
}

function field(name: string, value: string | number): SystemMessageField | null {
  if (typeof value === "string") return value === "" ? null : { name, value };
  return { name, value: String(value) };
}

function presentFields(fields: (SystemMessageField | null)[]): SystemMessageField[] {
  return fields.filter((f): f is SystemMessageField => f !== null);
}

/**
 * Splits a `"12\tconst x = 1"`-numbered listing into its text and the line
 * number it starts at. Returns null unless *every* line carries the prefix and
 * the numbers run consecutively — a body whose own first characters happen to
 * look like a number then stays verbatim rather than losing a column of text,
 * and a partial match cannot silently shift the numbering.
 */
export function parseNumberedSnippet(
  snippet: string,
): { content: string; startLine: number } | null {
  if (snippet === "") return null;
  const lines = snippet.split("\n");
  const texts: string[] = [];
  let startLine = 0;
  for (const [index, line] of lines.entries()) {
    // A trailing newline leaves an empty final element; it is the text's own
    // trailing blank, not a missing line number.
    if (index === lines.length - 1 && line === "") {
      texts.push("");
      break;
    }
    const match = /^(\d+)\t([\s\S]*)$/.exec(line);
    if (!match) return null;
    const [, number = "", text = ""] = match;
    const n = Number(number);
    if (index === 0) startLine = n;
    else if (n !== startLine + index) return null;
    texts.push(text);
  }
  if (startLine < 1) return null;
  return { content: texts.join("\n"), startLine };
}

/**
 * Classifies one `type:"attachment"` row's payload into its `AttachmentDetail`.
 * Pure. A kind not known here still gets its name plus a path trailing when
 * the payload carries a recognizable path field, so new file-shaped attachment
 * kinds read sensibly without a case of their own.
 *
 * - hook_success / hook_additional_context: named by the hook that produced
 *   them, and worth unfolding into the command's own outcome
 * - edited_text_file: the user's editor saved a file and the harness showed
 *   the model a numbered snippet around the edit
 * - file: an @-mentioned file, carrying the same `file.content` shape a Read
 *   result does. An image payload has no text body and keeps the raw-JSON
 *   rendering
 */
export function attachmentDetail(attachment: Attachment, cwd: string): AttachmentDetail {
  const type = attachment.type === "" ? "?" : attachment.type;
  if (!isKnownAttachment(attachment)) {
    const paths = parseWith(OtherAttachmentPathSchema, attachment);
    const trailing = paths.ok
      ? [
          paths.value.filename,
          paths.value.file_path,
          paths.value.filePath,
          paths.value.path,
          paths.value.displayPath,
        ]
          .map((path) => pathTrailing(path, cwd))
          .find((label) => label !== null)
      : undefined;
    return { type, trailing: trailing ?? null, fields: [] };
  }
  switch (attachment.type) {
    case "hook_success":
      return {
        type,
        trailing: attachment.hookName,
        fields: presentFields([
          field("event", attachment.hookEvent),
          field("command", attachment.command),
          field("exitCode", attachment.exitCode),
          field("durationMs", attachment.durationMs),
          field("stdout", attachment.stdout),
          field("stderr", attachment.stderr),
        ]),
      };
    case "hook_additional_context":
      return {
        type,
        trailing: attachment.hookName,
        fields: presentFields([field("event", attachment.hookEvent)]),
      };
    case "edited_text_file": {
      const trailing = pathTrailing(attachment.filename, cwd);
      const path = attachment.filename;
      const snippet = attachment.snippet;
      if (path === "" || snippet === "") return { type, trailing, fields: [] };
      const parsed = parseNumberedSnippet(snippet);
      return {
        type,
        trailing,
        fields: [],
        file: parsed
          ? { path, content: parsed.content, startLine: parsed.startLine }
          : { path, content: snippet, startLine: 1 },
      };
    }
    case "file": {
      const trailing = pathTrailing(attachment.filename, cwd);
      const path = attachment.filename;
      const { content, startLine } = attachment.content.file;
      if (path === "" || content === undefined) return { type, trailing, fields: [] };
      return {
        type,
        trailing,
        fields: [],
        file: { path, content, startLine },
      };
    }
    case "queued_command":
    case "task_reminder":
      return { type, trailing: null, fields: [] };
  }
}

/** Joins tool_use segments with matching tool_result segments by id. Result
 * lines remain in the array so transcript byte offsets stay aligned; foreground
 * Read/Bash results are omitted by groupTimelineLines after their content has
 * been attached to the command card. Background Bash results stay visible and
 * link back to their command card.
 *
 * A result's `toolUseResult` is read here, where the call it answers is known,
 * by that tool's result schema: the result of a Read becomes the file it read
 * (text, or an image with its size). A result whose call is outside the loaded
 * window stays as it was parsed. */
export function resolveToolResults(lines: ParsedLine[]): ParsedLine[] {
  const fileReads = new Set<string>();
  for (const line of lines) {
    if (line.kind !== "turn") continue;
    for (const segment of line.segments) {
      if (segment.kind === "file-read") fileReads.add(segment.toolUseId);
    }
  }
  const read = fileReads.size === 0 ? lines : lines.map((line) => withReadResults(line, fileReads));
  const fileResults = new Map<string, FileToolResult>();
  const genericResults = new Map<string, { text: string; isError: boolean }>();
  const bashUses = new Map<string, { background: boolean }>();
  for (const line of read) {
    if (line.kind !== "turn") continue;
    for (const segment of line.segments) {
      if (segment.kind === "file-tool-result") {
        fileResults.set(segment.toolUseId, segment.result);
      } else if (segment.kind === "tool-result") {
        genericResults.set(segment.toolUseId, { text: segment.text, isError: segment.isError });
      } else if (segment.kind === "bash-use") {
        bashUses.set(segment.toolUseId, { background: segment.background });
      }
    }
  }
  const withToolResults = read.map((line): ParsedLine => {
    if (line.kind !== "turn") return line;
    let changed = false;
    const segments = line.segments.map((segment): Segment => {
      if (segment.kind === "file-read") {
        const generic = genericResults.get(segment.toolUseId);
        const result =
          fileResults.get(segment.toolUseId) ??
          (generic?.isError ? ({ kind: "error", message: generic.text } as const) : undefined);
        if (result === undefined) return segment;
        changed = true;
        return { ...segment, result };
      }
      if (segment.kind === "bash-use") {
        const result = genericResults.get(segment.toolUseId) ?? null;
        if (result !== null) changed = true;
        return { ...segment, result, hasResult: result !== null };
      }
      if (segment.kind === "tool-use") {
        const result = genericResults.get(segment.toolUseId) ?? null;
        if (result === null) return segment;
        changed = true;
        return { ...segment, result };
      }
      if (segment.kind === "tool-result") {
        // A failed Read ("File does not exist.") has no file payload, so it
        // arrives here rather than as a file-tool-result. Fold it into the
        // Read card the same way a successful one is folded — otherwise the
        // card claims its result is unavailable while the reason sits in a
        // separate tool_result item right below it. Only `is_error` results
        // are taken: a non-error result of an unrecognized shape keeps its
        // own fold rather than being silently relabeled as file content.
        if (segment.isError && fileReads.has(segment.toolUseId)) {
          changed = true;
          return {
            kind: "file-tool-result",
            toolUseId: segment.toolUseId,
            result: { kind: "error", message: segment.text },
          };
        }
        const use = bashUses.get(segment.toolUseId);
        if (!use) return segment;
        changed = true;
        return {
          kind: "bash-result",
          toolUseId: segment.toolUseId,
          text: segment.text,
          isError: segment.isError,
          background: use.background,
          hasCommand: true,
        };
      }
      return segment;
    });
    return changed ? { ...line, segments } : line;
  });
  return resolveBashCommands(withToolResults);
}

/** `line` with the results of the Read calls in `fileReads` read as the file
 * each read, where its `toolUseResult` says. */
function withReadResults(line: ParsedLine, fileReads: ReadonlySet<string>): ParsedLine {
  if (line.kind !== "turn") return line;
  let changed = false;
  const segments = line.segments.map((segment): Segment => {
    if (segment.kind !== "tool-result" && segment.kind !== "file-tool-result") return segment;
    if (segment.toolUseResult === undefined || !fileReads.has(segment.toolUseId)) return segment;
    const result = readToolResult(segment.toolUseResult);
    if (result === null) return segment;
    changed = true;
    return {
      kind: "file-tool-result",
      toolUseId: segment.toolUseId,
      result,
      toolUseResult: segment.toolUseResult,
    };
  });
  return changed ? { ...line, segments } : line;
}

/** The file a Read's `toolUseResult` says it read: its text, or an image
 * sized to what the model was shown. `null` for anything else (the error text
 * of a failed Read, an unchanged file, a PDF), which keeps the result's own
 * rendering. */
function readToolResult(toolUseResult: JsonValue): FileToolResult | null {
  const read = parseWith(ReadToolResultSchema, toolUseResult);
  if (!read.ok || typeof read.value === "string" || !isKnownReadResult(read.value)) return null;
  const result = read.value;
  switch (result.type) {
    case "text":
      return { kind: "text", content: result.file.content };
    case "image":
      return {
        kind: "image",
        mediaType: result.file.type,
        base64: result.file.base64,
        width: result.file.dimensions?.displayWidth ?? null,
        height: result.file.dimensions?.displayHeight ?? null,
      };
  }
}

/** Text of a line classified as one of the two `! <cmd>` shapes, or `null`
 * for any other line. The classification (`classifyUserMessage`) is what
 * identifies these, so a normal user message that merely starts with the
 * same characters is never picked up here. */
function bashLineText(line: ParsedLine | undefined, kind: UserMessageKind): string | null {
  if (line === undefined || line.kind !== "turn" || line.userMessageKind !== kind) return null;
  const text = line.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
  return text === "" ? null : text;
}

/**
 * Joins each `! <cmd>` invocation with the output row that follows it, the
 * same way `resolveToolResults` joins a tool_use with its tool_result: the
 * invocation line gets a `bash-command` segment carrying both halves, and the
 * output line gets a `bash-command-output` segment flagged `hasCommand` so
 * `isConsumedToolResult` drops it from the rendered groups. Both lines stay
 * in the array so transcript byte offsets remain aligned.
 *
 * Pairing is by adjacency rather than by id because the harness gives these
 * rows no correlation id — it writes the output as the immediately next
 * `type:"user"` row. Verified against every `! <cmd>` run in the local
 * session corpus (2026-07-29: 77/77 pairs adjacent, no orphans), and an
 * invocation whose next line is something else simply keeps `output: null`
 * and renders as a command with no result, rather than swallowing an
 * unrelated line.
 */
function resolveBashCommands(lines: ParsedLine[]): ParsedLine[] {
  const consumed = new Set<number>();
  const merged = lines.map((line, i): ParsedLine => {
    if (line.kind !== "turn") return line;
    const rawCommand = bashLineText(line, "bash-command-invocation");
    if (rawCommand === null) return line;
    const command = parseBashInputText(rawCommand);
    if (command === null) return line;
    const nextRaw = bashLineText(lines[i + 1], "bash-command-stdout");
    const output = nextRaw === null ? null : parseBashOutputText(nextRaw);
    if (output !== null) consumed.add(i + 1);
    return { ...line, segments: [{ kind: "bash-command", command, output }] };
  });
  return merged.map((line, i): ParsedLine => {
    if (line.kind !== "turn") return line;
    const raw = bashLineText(line, "bash-command-stdout");
    if (raw === null) return line;
    const output = parseBashOutputText(raw);
    if (output === null) return line;
    return {
      ...line,
      segments: [{ kind: "bash-command-output", hasCommand: consumed.has(i), ...output }],
    };
  });
}

export const resolveFileToolResults = resolveToolResults;

function isConsumedToolResult(line: ParsedLine): boolean {
  return (
    line.kind === "turn" &&
    line.segments.length > 0 &&
    line.segments.every(
      (segment) =>
        segment.kind === "file-tool-result" ||
        (segment.kind === "bash-result" && !segment.background && segment.hasCommand) ||
        (segment.kind === "bash-command-output" && segment.hasCommand),
    )
  );
}

/**
 * Absolute byte offset (in the transcript file) of each cached line's start,
 * given the cache's current `start` (TimelineState.start: byte offset of the
 * earliest loaded line, DR-0009). Each line consumed `byteLength(line) + 1`
 * bytes on disk (jsonl: the line's own content plus the `\n` transcript_read
 * strips before returning it).
 *
 * Used as Preact `key`s (components/timeline/) instead of the array index: an index
 * key would make a "load older" prepend renumber every already-rendered
 * line, so an open `<details>` fold would jump to a *different* line after
 * the prepend. A line's absolute byte offset never changes once loaded —
 * only `start` (and the offsets recomputed from it) shrinks when an older
 * page is spliced in front — so offsets computed this way stay stable across
 * prepends for every line that was already cached.
 */
export function lineByteOffsets(start: number, lines: readonly string[]): number[] {
  return byteOffsetsFromLengths(start, lines.map(utf8ByteLength));
}

const TEXT_ENCODER = new TextEncoder();

/** UTF-8 size of one transcript line, without its newline. Split out (with
 * `byteOffsetsFromLengths` below) so useTranscriptModel (components/timeline/) can measure each line once
 * and keep the measurement across renders — offsets shift wholesale when a
 * "load older" page moves `start`, but a line's own byte length never changes.
 */
export function utf8ByteLength(line: string): number {
  return TEXT_ENCODER.encode(line).length;
}

/** Absolute offsets from `start` given each line's UTF-8 byte length, adding
 * back the newline that separates them on disk. */
export function byteOffsetsFromLengths(start: number, byteLengths: readonly number[]): number[] {
  const offsets: number[] = [];
  let pos = start;
  for (const bytes of byteLengths) {
    offsets.push(pos);
    pos += bytes + 1;
  }
  return offsets;
}

/** One cached transcript line as the raw-JSONL view shows it: the original
 * text exactly as it sits on disk, plus the two coordinates that let a reader
 * line it up with the file. */
export interface RawTranscriptRow {
  /** Absolute byte offset of the line's first byte in the transcript file —
   * the same number the rich view uses as a Preact key, so a row here and a
   * bubble there can be matched up. Stable across a "load older" prepend. */
  offset: number;
  /** 1-based position among the *currently cached* lines. Not the file's line
   * number: paging starts at the tail, so line 1 of the cache is usually not
   * line 1 of the file (`atStart` tells whether they coincide). */
  index: number;
  /** The line's own content, without the trailing newline (transcript_read
   * already strips it). */
  text: string;
  /** UTF-8 byte length of `text` (the line occupies `bytes + 1` on disk). */
  bytes: number;
}

/**
 * Pairs each cached raw jsonl line with its absolute byte offset and its
 * 1-based position in the cache — the model behind Timeline's raw view
 * (kawaz r55 m68: 「生の JSONL も切り替えて見られるように」). Deliberately
 * does no parsing, folding or de-duplication: the rich view's grouping can
 * collapse several lines into one fold, split one line into several ccmsg
 * bubbles, or demote a row to meta, whereas here every cached line appears
 * exactly once, in file order, verbatim — that verbatim 1:1 mapping is the
 * whole point of the raw view.
 *
 * Offsets come from `lineByteOffsets`, so raw rows and rich entries key off
 * the identical numbers.
 */
export function rawTranscriptRows(start: number, lines: readonly string[]): RawTranscriptRow[] {
  const byteLengths = lines.map(utf8ByteLength);
  return rawTranscriptRowsFrom(lines, byteOffsetsFromLengths(start, byteLengths), byteLengths);
}

/** `rawTranscriptRows` for a caller that already holds the two per-line
 * measurements (useTranscriptModel keeps both across renders). All three arrays are
 * index-aligned. */
export function rawTranscriptRowsFrom(
  lines: readonly string[],
  offsets: readonly number[],
  byteLengths: readonly number[],
): RawTranscriptRow[] {
  return lines.flatMap((text, i) => {
    const offset = offsets[i];
    const bytes = byteLengths[i];
    return offset === undefined || bytes === undefined
      ? []
      : [{ offset, index: i + 1, text, bytes }];
  });
}

/**
 * For every line the timeline actually renders, the jsonl lines that item was
 * built from — the model behind the per-item raw toggle (kawaz r55 m89:
 * 「個別に raw モードトグルが欲しい。そのアイテムが raw jsonl 用ビュー
 * コンポーネントとトグルされるイメージ」). Keyed and valued by absolute byte
 * offset (`lineByteOffsets`), so a rendered item and its source lines line up
 * with the whole-transcript raw view's coordinates.
 *
 * Usually 1:1, with one exception: a line pair that `resolveToolResults`
 * merged into a single card renders as one item, so the owning line's entry
 * lists *both* offsets in file order (kawaz r55 m69: 「両方の行を見せる」).
 * `groupTimelineLines` drops those consumed lines (`isConsumedToolResult`)
 * from the rendered groups entirely, so without this pairing their raw text
 * would be unreachable from the timeline. Both merge shapes go through here:
 * a tool_use/tool_result pair, correlated by `toolUseId`, and a `! <cmd>`
 * invocation/output pair, correlated by adjacency (kawaz r76 m87: bash カードの
 * jsonl が入力行しか出せていなかった).
 *
 * The reverse — one line rendering as several items (a ccmsg line carrying
 * several messages) — needs nothing special here: every bubble shares the
 * line's offset and therefore the same single-element entry.
 *
 * A consumed result whose tool_use sits outside the loaded window has no
 * owner to attach to and is simply absent, matching the rich view, which
 * already drops it.
 */
export function itemRawSourceOffsets(
  lines: readonly ParsedLine[],
  offsets: readonly number[],
): Map<number, number[]> {
  const ownerOffsetByToolUseId = new Map<string, number>();
  lines.forEach((line, i) => {
    if (line.kind !== "turn") return;
    for (const segment of line.segments) {
      const offset = offsets[i];
      if (offset !== undefined && (segment.kind === "file-read" || segment.kind === "bash-use")) {
        ownerOffsetByToolUseId.set(segment.toolUseId, offset);
      }
    }
  });
  const sources = new Map<number, number[]>();
  lines.forEach((line, i) => {
    const offset = offsets[i];
    if (offset === undefined) return;
    if (line.kind !== "turn" || !isConsumedToolResult(line)) {
      // 自分の行を先頭に置く (file 順は下の push で保たれる — consumed な
      // tool_result は必ず対応する tool_use より後ろの行)。
      sources.set(offset, [...(sources.get(offset) ?? []), offset]);
      return;
    }
    const ownerOffset = line.segments
      .map((segment) => {
        if (segment.kind === "file-tool-result" || segment.kind === "bash-result") {
          return ownerOffsetByToolUseId.get(segment.toolUseId);
        }
        // `! <cmd>` の出力行は harness が相関 id を振らないので id 表を引けない
        // (`resolveBashCommands` が隣接でペアリングしている)。`hasCommand` が
        // 立つのは直前の行に畳まれた時だけなので、所有者は必ず 1 つ前の行。
        if (segment.kind === "bash-command-output" && segment.hasCommand) {
          return offsets[i - 1];
        }
        return undefined;
      })
      .find((o) => o !== undefined);
    if (ownerOffset === undefined) return;
    sources.set(ownerOffset, [...(sources.get(ownerOffset) ?? []), offset]);
  });
  for (const list of sources.values()) list.sort((a, b) => a - b);
  return sources;
}

/** Characters of a raw line rendered before it is cut off behind a per-row
 * "全体を表示". A pasted image or a large tool result is a single jsonl line
 * running to megabytes of base64; rendering every such line in full turns
 * switching to the raw view into a multi-second layout stall. */
export const RAW_LINE_PREVIEW_LIMIT = 2000;

/**
 * Cuts `text` down to `limit` characters for the raw view's collapsed state.
 * Splits on a code-unit boundary but never in the middle of a surrogate pair
 * (a lone half would render as U+FFFD), so the preview is always valid text.
 */
export function truncateRawLine(
  text: string,
  limit: number = RAW_LINE_PREVIEW_LIMIT,
): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  let end = limit;
  const code = text.charCodeAt(end - 1);
  // High surrogate at the cut point: its low half is on the other side.
  if (code >= 0xd800 && code <= 0xdbff) end -= 1;
  return { text: text.slice(0, end), truncated: true };
}

/**
 * True for a real human utterance — a "user" turn classified (or, for
 * hand-built fixtures, assumed) as `userMessageKind === "user-prompt"` — as
 * opposed to a tool_result-only user turn (Anthropic API convention wraps
 * tool results in a user-typed line, see the parseTranscriptLine/user-turns
 * test above), a system-origin "type:user" line (teammate-message /
 * task-notification / slash-command plumbing / etc., see
 * `classifyUserMessage`), or any non-turn line. `userMessageKind` is only
 * `undefined` for hand-built `ParsedLine` values that never went through
 * `parseTranscriptLine` (test fixtures, see `TurnLine.userMessageKind`'s doc
 * comment) — those fall back to the text-segment check below rather than
 * being unconditionally excluded.
 *
 * A classified `"user-prompt"` counts even with zero *text* segments as long
 * as it has *some* segment: an image-only paste (no caption) is real human
 * input per `classifyUserMessage` (an array of only text/image blocks), but
 * `parseSegments` has no `image` case yet, so an image block yields an
 * `unknown-segment` rather than `{kind:"text"}` — requiring a text segment
 * specifically would wrongly fold it. The `segments.length > 0` guard still
 * excludes a `content: ""` turn (zero segments, `classifyUserMessage` even
 * classifies empty string as `"user-prompt"` since no exclusion pattern
 * matches) from counting as a real utterance.
 *
 * Shared by the chat-bubble styling (components/timeline/bubbles.tsx), the "👤 N/M" user-turn nav (useUserTurnNav)
 * counter, and `isBoundaryLine` below — so a turn can't count toward one and
 * not the others: kawaz's U2 spec ties all three to the same "本物のユーザ
 * 発話 (tool_result・システム由来メッセージは除く)" definition (U2:
 * previously this only excluded tool_result-only turns, letting
 * system-origin messages both stand outside tools-folding *and* pollute the
 * nav counter — kawaz: "システムメッセージも tool や thinking と同じで
 * folding しといて").
 */
/** 👤 nav (n/N ジャンプ) の対象: 人間のユーザプロンプトに加えて、ccmsg 経由の
 * kawaz 発メッセージ (from:"u1") も「ユーザメッセージ」として数える
 * (kawaz r38 mid=51 — 1on1 運用では指示が ccmsg で届くため、prompt だけの
 * カウントでは実質のユーザ発話を辿れない)。 */
export function isUserNavTurn(line: ParsedLine): boolean {
  if (isUserTextTurn(line)) return true;
  return extractCcmsgMessages(line).some((m) => m.from === "u1");
}

export function isUserTextTurn(line: ParsedLine): boolean {
  if (line.kind !== "turn" || line.role !== "user") return false;
  if (line.userMessageKind !== undefined && !isUserSpeechKind(line.userMessageKind)) return false;
  if (line.userMessageKind !== undefined) return line.segments.length > 0;
  return line.segments.some((s) => s.kind === "text");
}

/** ユーザ自身が書いた文章として扱う `UserMessageKind` — 素のプロンプトと、
 * 引数付き slash command (`/clear <本文>`)。この 2 つだけが吹き出し表示 /
 * fold 境界 / 👤 nav / 検索対象の「ユーザ発話」で、残りはシステム由来として
 * fold される (components/timeline/folds.tsx の LineView の `sysKind` もこの述語を使う)。 */
export function isUserSpeechKind(kind: UserMessageKind): boolean {
  return kind === "user-prompt" || kind === "slash-command-prompt";
}

/**
 * Plain-text projection of a Segment for in-view search (DR-0022 §3: "TL は
 * text/thinking/tool セグメント" — every Segment variant, not just text/
 * thinking). tool-use/unknown-segment have no natural "text" field, so this
 * mirrors what SegmentView actually renders for them (`JSON.stringify(...,
 * null, 2)`) so a search hit corresponds to something visibly on screen once
 * the fold is expanded, rather than searching raw unrendered JSON shape.
 */
/** Searchable projection of a file tool result: its text, or the error the
 * card shows. An image contributes nothing — its base64 is data the viewer
 * never displays as text, and matching it would produce hits with no visible
 * counterpart on screen. */
function fileToolResultText(result: FileToolResult | null): string {
  if (result === null) return "";
  switch (result.kind) {
    case "text":
      return result.content;
    case "error":
      return result.message;
    case "image":
      return "";
  }
}

export function segmentSearchText(segment: Segment): string {
  switch (segment.kind) {
    case "text":
    case "thinking":
    case "tool-result":
      return segment.text;
    case "thinking-hidden":
      return "";
    case "tool-use":
      return JSON.stringify(segment.input, null, 2);
    case "file-read":
      return [segment.path, fileToolResultText(segment.result)].filter(Boolean).join("\n");
    case "file-write":
      return `${segment.path}\n${segment.content}`;
    case "file-edit":
      return `${segment.path}\n${segment.oldString}\n${segment.newString}`;
    case "file-tool-result":
      return fileToolResultText(segment.result);
    case "bash-use":
      return [segment.description, segment.command, segment.result?.text]
        .filter(Boolean)
        .join("\n");
    case "bash-result":
      return segment.text;
    case "slash-command-prefix":
      return segment.command;
    case "bash-command":
      return [segment.command, segment.output?.stdout, segment.output?.stderr]
        .filter(Boolean)
        .join("\n");
    case "bash-command-output":
      return [segment.stdout, segment.stderr, segment.persisted?.preview]
        .filter(Boolean)
        .join("\n");
    case "agent-send":
      return [segment.to, segment.summary, segment.message].filter(Boolean).join("\n");
    case "agent-spawn":
      return [segment.name, segment.agentType, segment.description, segment.prompt]
        .filter(Boolean)
        .join("\n");
    case "unknown-segment":
      return JSON.stringify(segment.raw, null, 2);
  }
}

/** The three checkboxes SearchBar's TL-only target toggles expose (kawaz r26
 * mid=97 spec): whether a real human utterance, an assistant text/thinking
 * response, and a ccmsg room message respectively count as in-view search
 * units. */
export interface SearchTargets {
  user: boolean;
  ai: boolean;
  ccmsg: boolean;
}

/**
 * Whether a Segment belonging to a user-prompt or assistant `TurnLine` (never
 * a system-origin line — those are excluded by useInViewSearch's speech-kind check (components/timeline/useInViewSearch.ts)
 * before this is ever consulted, same guard `segmentSearchText`'s callers
 * apply) counts as an in-view search unit given TL's target toggles.
 *
 * `tool-use`/`tool-result`/`unknown-segment` are excluded unconditionally,
 * regardless of `targets` — kawaz r26 mid=97 bug report: TL search was
 * matching a `Bash` tool_use's raw command JSON, which the spec says must
 * never be a search target (only 👤 human text / 🤖 assistant text+thinking /
 * 💬 ccmsg messages are). `thinking` has no `role` field (it's always an
 * assistant artifact) so it follows `targets.ai` alone; `text` splits on its
 * own `role` since a user-prompt turn's text segment and an assistant turn's
 * text segment share the same Segment variant.
 */
export function isSearchableSegment(segment: Segment, targets: SearchTargets): boolean {
  switch (segment.kind) {
    case "text":
      return segment.role === "user" ? targets.user : targets.ai;
    case "thinking":
      return targets.ai;
    // 本文が無いので綴りが存在しない = どのクエリにも当たらない。数えると
    // highlight も scroll 先も無い ghost match になる。
    case "thinking-hidden":
      return false;
    case "tool-use":
    case "file-read":
    case "file-write":
    case "file-edit":
    case "file-tool-result":
    case "bash-use":
    case "bash-result":
    case "slash-command-prefix":
    case "bash-command":
    case "bash-command-output":
    case "agent-send":
    case "agent-spawn":
    case "tool-result":
    case "unknown-segment":
      return false;
  }
}

/** One cached line paired with its stable Preact key (see `lineByteOffsets`
 * doc comment) — the unit `groupTimelineLines` operates on and emits inside
 * a fold group. */
export interface TimelineEntry {
  offset: number;
  line: ParsedLine;
}

/** The entries of a fold group: one or more, so the first one is always there
 * to key the group by. */
export type FoldEntries = readonly [TimelineEntry, ...TimelineEntry[]];

/** The Timeline's render unit (components/timeline/) after tools-folding (kawaz spec): either a
 * boundary line rendered directly (a real user prompt, or the assistant's
 * next user-facing final response), or a run of everything in between
 * (thinking / tool_use / tool_result / meta lines / broken lines) collapsed
 * into one foldable group. */
export type TimelineGroup =
  | { kind: "entry"; offset: number; line: ParsedLine }
  | { kind: "fold"; entries: FoldEntries };

export type UserNavTarget =
  | { key: string; offset: number; kind: "user-prompt" }
  | { key: string; offset: number; kind: "ccmsg"; messageIndex: number };

/** One ccmsg bubble the Timeline mounts, identified by the line it came from
 * (`offset`) and its index within that line's `extractCcmsgMessages` output.
 * `placement` says which renderer draws it: `"boundary"` = a u1 発 line that
 * `classifyBoundaryLine` kept standalone (Timeline() 直下の CcmsgBubble),
 * `"fold"` = a peer 発 line inside a fold group (LineView →
 * PeerCcmsgLineView). */
export interface CcmsgRenderTarget {
  key: string;
  offset: number;
  messageIndex: number;
  message: CcmsgMessage;
  placement: "boundary" | "fold";
}

/** Per-bubble key shared by everything that has to agree on "which ccmsg
 * bubbles exist": the render-visibility set, the in-view search unit list, and
 * the `searchKey` each `CcmsgBubble` registers. */
export function ccmsgUnitKey(offset: number, messageIndex: number): string {
  return `${offset}-ccmsg-${messageIndex}`;
}

/**
 * Every ccmsg bubble the Timeline mounts, in document order, with duplicates
 * (`ccmsgDedupKey`) already dropped — the single source of truth for the
 * dedup decision (kawaz r15 mid=21 の 2 重表示回避).
 *
 * The decision has to live here, in a phase the caller can memoize on
 * `groups`, rather than in the renderer: the two render paths (boundary側と
 * fold group 側) are *different components*, so a `Set` threaded through
 * context and mutated while rendering only holds "first wins" as long as every
 * pass starts from an empty Set. `FoldGroup` の開閉 (子局所 `setOpen`) は
 * Timeline 本体を再実行しないので、その前提が破れて前 pass の残留 key で
 * バブルが消える (docs/issue/2026-07-29-fold-toggle-drops-peer-ccmsg-bubble)。
 *
 * Document order also settles which copy of a cross-path duplicate survives:
 * the first one in the transcript, regardless of the fact that Preact renders
 * every boundary bubble before it descends into any fold group.
 */
export function ccmsgRenderTargets(groups: readonly TimelineGroup[]): CcmsgRenderTarget[] {
  const targets: CcmsgRenderTarget[] = [];
  const seen = new Set<string>();
  const push = (
    offset: number,
    messages: CcmsgMessage[],
    placement: CcmsgRenderTarget["placement"],
  ) => {
    messages.forEach((message, messageIndex) => {
      const dedupKey = ccmsgDedupKey(message);
      if (seen.has(dedupKey)) return;
      seen.add(dedupKey);
      targets.push({
        key: ccmsgUnitKey(offset, messageIndex),
        offset,
        messageIndex,
        message,
        placement,
      });
    });
  };
  for (const group of groups) {
    if (group.kind === "fold") {
      for (const entry of group.entries) {
        if (entry.line.kind !== "turn") continue;
        push(entry.offset, extractCcmsgMessages(entry.line), "fold");
      }
      continue;
    }
    if (group.line.kind !== "turn") continue;
    const boundary = classifyBoundaryLine(group.line);
    if (boundary?.kind !== "ccmsg") continue;
    push(group.offset, boundary.messages, "boundary");
  }
  return targets;
}

/**
 * Returns the mounted green bubbles that the user-message navigation can jump
 * to. ccmsg messages reuse `ccmsgRenderTargets`' deduplication, so the counter
 * and the set of registered DOM targets stay equal.
 */
export function userNavTargets(groups: readonly TimelineGroup[]): UserNavTarget[] {
  const rendered = new Set(
    ccmsgRenderTargets(groups)
      .filter((target) => target.placement === "boundary" && target.message.from === "u1")
      .map((target) => target.key),
  );
  const targets: UserNavTarget[] = [];
  for (const group of groups) {
    if (group.kind !== "entry" || group.line.kind !== "turn") continue;
    const boundary = classifyBoundaryLine(group.line);
    if (boundary?.kind === "user-prompt") {
      targets.push({ key: `user:${group.offset}`, offset: group.offset, kind: "user-prompt" });
      continue;
    }
    if (boundary?.kind !== "ccmsg") continue;
    boundary.messages.forEach((_message, messageIndex) => {
      if (!rendered.has(ccmsgUnitKey(group.offset, messageIndex))) return;
      targets.push({
        key: `ccmsg:${group.offset}:${messageIndex}`,
        offset: group.offset,
        kind: "ccmsg",
        messageIndex,
      });
    });
  }
  return targets;
}

/** Which of the three chat-bubble kinds (webui Timeline display unification
 * task, kawaz spec) a boundary line renders as — `null` for every non-boundary
 * line (folds instead). The single source of truth both `isBoundaryLine`
 * (groupTimelineLines' fold/no-fold split) and components/timeline/Timeline.tsx (which bubble
 * component + alignment to render) key off of, so the two can never disagree
 * about which lines are boundaries. */
export type BoundaryKind =
  | { kind: "user-prompt" }
  | { kind: "assistant-response" }
  | { kind: "api-error" }
  | { kind: "bash-command"; segment: Extract<Segment, { kind: "bash-command" }> }
  | { kind: "bash-command-output"; segment: Extract<Segment, { kind: "bash-command-output" }> }
  | { kind: "ccmsg"; messages: CcmsgMessage[] }
  | { kind: "push-notification"; text: string };

/**
 * Classifies a boundary line (kawaz spec order, first match wins): a real
 * user utterance (`isUserTextTurn`, which — U2 — already excludes
 * system-origin "type:user" messages such as teammate-message/
 * task-notification/slash-command plumbing, so those fold like any other
 * intermediate entry instead of standing alone) is `"user-prompt"`; an
 * assistant-role line that is really Claude Code reporting the turn being cut
 * short (`isApiErrorLine`) is `"api-error"` — checked before the plain
 * assistant case since such a line does carry a `text` segment and would
 * otherwise render as the agent's own final response; an
 * assistant turn carrying at least one `text` segment — the "次のユーザ向け
 * アシスタント最終レスポンス" that ends a run of intermediate entries — is
 * `"assistant-response"`, unless it is only a cache-keepalive reply
 * (`isCacheKeepaliveReplyLine`), which folds like the keepalive notify it
 * answers; a system-origin "type:user" line that itself
 * carries at least one **u1 (ADMIN)-発** ccmsg room message (kawaz r55 m14
 * 裁定: u1 発 ccmsg は本物のユーザ発話と同格の主役表示なので boundary
 * 維持、peer 発 ccmsg は thinking/agent と同様に fold group 内へ) is
 * `"ccmsg"`. Anything else — including an assistant turn with only thinking/
 * tool_use segments (no text yet), and system-origin lines that carry only
 * peer-発 ccmsg (which fold into the surrounding fold group where CcmsgBubble
 * still renders each one as a direct entry with thinking-style summary) —
 * is `null` (not a boundary).
 */
export function classifyBoundaryLine(line: ParsedLine): BoundaryKind | null {
  if (isUserTextTurn(line)) return { kind: "user-prompt" };
  if (isApiErrorLine(line)) return { kind: "api-error" };
  // A TUI `! <cmd>` run (kawaz r76m20 裁定): unlike the other system-origin
  // "type:user" shapes this module catalogs, this one *is* something the user
  // demonstrably typed, so it belongs on the user side of the conversation
  // rather than folded away with harness plumbing — just drawn as a terminal
  // execution rather than as speech. An output row still paired with its
  // command never reaches here (`isConsumedToolResult` drops it); one that
  // arrives orphaned stands alone rather than sinking into a fold, so its
  // bytes are never silently hidden.
  const bashSegment = line.kind === "turn" ? line.segments[0] : undefined;
  if (bashSegment?.kind === "bash-command") return { kind: "bash-command", segment: bashSegment };
  if (bashSegment?.kind === "bash-command-output")
    return { kind: "bash-command-output", segment: bashSegment };
  if (
    line.kind === "turn" &&
    line.role === "assistant" &&
    line.segments.some((s) => s.kind === "text") &&
    !isCacheKeepaliveReplyLine(line)
  )
    return { kind: "assistant-response" };
  const pushText = pushNotificationOf(line);
  if (pushText !== null) return { kind: "push-notification", text: pushText };
  const ccmsgMessages = extractCcmsgMessages(line);
  if (ccmsgMessages.length === 0) return null;
  // r55 m14: peer 発 ccmsg のみの line は boundary にせず fold group へ流す。
  // u1 発を 1 件でも含む line は boundary として standalone。
  // "u1" は protocol の ADMIN_ID。この module は pure で外部 import なし
  // (unit-test 容易性のため) — 文字列リテラルで揃える。
  const hasU1 = ccmsgMessages.some((m) => m.from === "u1");
  return hasU1 ? { kind: "ccmsg", messages: ccmsgMessages } : null;
}

/** True for a line that should render on its own (never folded into a tools
 * group) — see `classifyBoundaryLine`'s doc comment for the three cases this
 * covers. Kept as its own boolean predicate (rather than making every caller
 * check `!== null`) since `groupTimelineLines` only needs the yes/no split,
 * not which kind. */
function isBoundaryLine(line: ParsedLine): boolean {
  return classifyBoundaryLine(line) !== null;
}

/**
 * Groups the run of entries strictly between one boundary line and the next
 * into `{kind:"fold"}` groups, leaving boundary lines (user prompts, and the
 * assistant's user-facing final responses) as standalone `{kind:"entry"}`
 * groups in their original order (kawaz spec: "tools folding"). A trailing
 * run with no closing boundary yet (an in-progress turn) still folds — there
 * is simply no following boundary entry after it.
 *
 * `offsets` must be the same length as `lines` (the offsets
 * components/timeline/useTranscriptModel.ts derives) so each entry keeps its stable Preact key.
 */
export function groupTimelineLines(
  lines: readonly ParsedLine[],
  offsets: readonly number[],
): TimelineGroup[] {
  const groups: TimelineGroup[] = [];
  let pending: TimelineEntry[] = [];
  const flushPending = () => {
    const [first, ...rest] = pending;
    if (first !== undefined) {
      groups.push({ kind: "fold", entries: [first, ...rest] });
      pending = [];
    }
  };
  lines.forEach((line, i) => {
    const offset = offsets[i];
    if (offset === undefined || isConsumedToolResult(line)) return;
    if (isBoundaryLine(line)) {
      flushPending();
      groups.push({ kind: "entry", offset, line });
    } else {
      pending.push({ offset, line });
    }
  });
  flushPending();
  return groups;
}

/** True when an entry contains a thinking segment. A mixed thinking+tool
 * turn is intentionally classified as thinking so the fold summary advertises
 * its narrative marker instead of burying it in the `N items` tally. */
export function isThinkingEntry(entry: TimelineEntry): boolean {
  const { line } = entry;
  return (
    line.kind === "turn" &&
    line.segments.some((s) => s.kind === "thinking" || s.kind === "thinking-hidden")
  );
}

/** Outgoing agent communication segments: SendMessage and Agent calls. */
export function isAgentCommunicationSegment(segment: Segment): boolean {
  return segment.kind === "agent-send" || segment.kind === "agent-spawn";
}

/** Incoming peer relays use a user-role transcript line rather than a Segment. */
export function isPeerMessageLine(line: ParsedLine): boolean {
  return line.kind === "turn" && line.userMessageKind === "peer-message";
}

/** True for an assistant-role line Claude Code synthesized to report that the
 * turn was cut short instead of answered (see `classifyAssistantMessage`).
 * The assistant-side counterpart of `isPeerMessageLine`: the one predicate
 * both `classifyBoundaryLine` (which bubble/notice to render) and Timeline's
 * in-view-search unit count key off, so the render side and the count side
 * can't disagree about what is agent speech. */
export function isApiErrorLine(line: ParsedLine): boolean {
  return line.kind === "turn" && line.assistantMessageKind === "api-error";
}

/** The one line a session says back to the LLM gateway's prompt-cache
 * keepalive marker. The marker asks for exactly this and nothing else, so a
 * conforming reply is entirely the gateway's bookkeeping — nothing the session
 * decided, and nothing a reader of the conversation is looking for.
 *
 * The reply is one opaque token, `LLMGW-KEEPALIVE-<nonce>` with a 32-byte
 * base64url nonce (always 43 characters), on a single line (backticks or
 * similar wrapping allowed): a turn that answers with a second line is real
 * speech and stays a bubble. */
const CACHE_KEEPALIVE_REPLY =
  /(?<![A-Za-z0-9_-])LLMGW-KEEPALIVE-[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/;

/** True for an assistant turn that is nothing but a cache-keepalive reply —
 * one `text` segment, whose whole content matches, and no thinking or tool
 * call alongside it. The assistant-side mirror of the keepalive *notify*,
 * which folds because `classifyUserMessage` marks it system-origin: both
 * halves of the exchange become fold items rather than disappearing, so
 * opening the fold still shows what was said. A turn carrying thinking or a
 * tool call did more than the marker asked, and is left as a bubble. */
export function isCacheKeepaliveReplyLine(line: ParsedLine): boolean {
  if (line.kind !== "turn" || line.role !== "assistant") return false;
  const segment = line.segments.length === 1 ? line.segments[0] : undefined;
  if (segment?.kind !== "text") return false;
  // One line only: the model may wrap the token in backticks or similar, so
  // the token is matched by character-class boundaries rather than ^…$, but
  // any second line means it said something else too.
  const text = segment.text.trim();
  return !text.includes("\n") && CACHE_KEEPALIVE_REPLY.test(text);
}

/** Closed-summary label for a folded keepalive reply (kawaz r259 m60/m61)。
 * 他の fold item と同じ「▶ 時刻 ラベル」の 1 行に揃えるためのラベルで、
 * トークン本体は開いてから見る。
 *
 * 形は meta 行の summary の `<type>: <何の行か>` に倣う (`system: turn_duration`
 * / `queue-operation: enqueue` と同じ組み立て、`parseKnownRow`) — prefix は jsonl 行の
 * top-level `type`、つまりこの行では `assistant`。 */
export const CACHE_KEEPALIVE_FOLD_LABEL = "assistant: llm-gateway keep-alive";

/** Agent transcript 先頭の spawn prompt (親からの指示書) も agent 間
 * コミュニケーションの一種 (kawaz r55 m35: AUTO OPEN の A で開いておいて
 * ほしい対象)。 */
export function isSpawnPromptLine(line: ParsedLine): boolean {
  return line.kind === "turn" && line.userMessageKind === "spawn-prompt";
}

/** The relayed teammate turns one incoming peer line carries (empty for any
 * other line). Idle notifications are among them: they are operational noise
 * rather than conversation, so callers filter them out — but a line that also
 * carries a real relayed turn must not be demoted along with the idle
 * notifications it happened to be batched with. */
function peerRelaysOfEntry(entry: TimelineEntry): PeerRelay[] {
  const { line } = entry;
  if (!isPeerMessageLine(line) || line.kind !== "turn") return [];
  const rawText = line.segments
    .filter((segment): segment is Extract<Segment, { kind: "text" }> => segment.kind === "text")
    .map((segment) => segment.text)
    .join("\n");
  const rich = parseSystemMessageFields("peer-message", rawText);
  return rich.display === "peer" ? rich.relays : [];
}

/** Number of agent communication messages represented by one entry. Outgoing
 * calls are counted per segment; an incoming relay line counts its non-idle
 * relays (a single line can carry several relayed turns). */
export function agentCommunicationCount(entry: TimelineEntry): number {
  const { line } = entry;
  if (line.kind !== "turn") return 0;
  if (isPeerMessageLine(line)) {
    const relays = peerRelaysOfEntry(entry);
    if (relays.length === 0) return 1;
    return relays.filter((relay) => relay.category !== "idle").length;
  }
  if (isSpawnPromptLine(line)) return 1;
  return line.segments.filter(isAgentCommunicationSegment).length;
}

/** Number of ccmsg room messages carried by this entry (0 if none). ccmsg
 * boundary lines are normally emitted as their own top-level bubbles rather
 * than folded, but the count is exposed here so the fold-group summary and
 * `isDirectFoldEntry` can treat them symmetrically with thinking / agent
 * communication if a future grouping change places one inside a fold group
 * (kawaz r55 m11: 「Nthinking+Nccmsg+Nagentmessages+Nitems」)。 */
export function ccmsgMessageCount(entry: TimelineEntry): number {
  const { line } = entry;
  if (line.kind !== "turn") return 0;
  return extractCcmsgMessages(line).length;
}

/** Entries the fold summary names by their own category (thinking, ccmsg,
 * agent communication) rather than counting into the generic `N items`
 * tally. Every entry of a fold group is rendered on its own line either way;
 * this only decides how the closed summary describes it. */
export function isDirectFoldEntry(entry: TimelineEntry): boolean {
  const { line } = entry;
  if (line.kind !== "turn") return false;
  return (
    isThinkingEntry(entry) || ccmsgMessageCount(entry) > 0 || agentCommunicationCount(entry) > 0
  );
}

/** Folded-group summary label: each present category is listed in the fixed
 * order "N thinking + N ccmsg + N agent messages + N items". */
export function foldGroupLabel(entries: readonly TimelineEntry[]): string {
  const thinkingCount = entries.filter(isThinkingEntry).length;
  const ccmsgCount = entries.reduce((count, entry) => count + ccmsgMessageCount(entry), 0);
  const agentMessageCount = entries.reduce(
    (count, entry) => count + agentCommunicationCount(entry),
    0,
  );
  const itemCount = entries.filter((entry) => !isDirectFoldEntry(entry)).length;
  return [
    thinkingCount > 0 ? `${thinkingCount} thinking` : null,
    ccmsgCount > 0 ? `${ccmsgCount} ccmsg` : null,
    agentMessageCount > 0 ? `${agentMessageCount} agent messages` : null,
    itemCount > 0 ? `${itemCount} items` : null,
  ]
    .filter((part): part is string => part !== null)
    .join(" + ");
}

/** Whether a fold group renders its turn-level `<details>` at all. A group
 * that is a single plain item is hoisted to the timeline instead (kawaz r38
 * mid=44: 「1 items」を開く手間が無駄 — the entry carries its own tool card
 * fold already). Everything else folds, and its body lists every entry on its
 * own line. */
export function foldGroupNeedsOuterFold(entries: readonly TimelineEntry[]): boolean {
  return entries.length > 1 || entries.some(isDirectFoldEntry);
}

/**
 * Classification of a `type:"user"` jsonl entry's actual origin (webui
 * Timeline UI improvement, kawaz spec): Claude Code's harness injects
 * several kinds of system-generated content under the wire-protocol "user"
 * role (slash-command plumbing, Monitor/Task notifications, ccmsg
 * teammate-message relays, tool_result echoes, ...), which would otherwise
 * render identically to a real human utterance. See
 * `docs/findings/2026-07-1?-jsonl-user-message-patterns.md`-style research
 * (scratchpad `jsonl-user-message-patterns.md`, U2 delegation) for the full
 * sample-derived pattern catalog this mirrors — kept as one flat union
 * rather than a nested taxonomy so a genuinely new/unseen pattern degrades
 * to "unknown-meta"/"unknown-array" (both still rendered, not dropped)
 * instead of needing a new case to compile.
 */
export type UserMessageKind =
  | "user-prompt"
  | "tool-result"
  | "user-interrupt-marker"
  | "skill-invocation-preamble"
  | "system-caveat"
  | "slash-command-invocation"
  /** A slash command the user submitted with arguments — `/clear <次タスクの
   * 本文>` のような形 (kawaz r244m18)。コマンド行の体裁は harness の配管だが、
   * `<command-args>` の中身はユーザが書いた文章そのものなので、fold に沈める
   * 配管ではなく本物のユーザ発話として扱う (引数なしの裸コマンドは
   * `slash-command-invocation` のまま — セッションを動かすだけで何も喋って
   * いない)。daemon 側 prompt 判定 (packages/daemon/src/session-user-input.ts
   * の classifyUserInputRow) と同じ「非空 command-args」規則。 */
  | "slash-command-prompt"
  | "slash-command-stdout"
  | "bash-command-invocation"
  | "bash-command-stdout"
  | "tool-retry-hint"
  | "task-notification"
  | "workflow-resume"
  | "peer-message"
  | "cross-session-notice"
  | "spawn-prompt"
  | "unknown-meta"
  | "unknown-array";

/** True for a `{type:"tool_result"}` block — shared by classifyUserMessage's
 * array branch. */
function isToolResultBlock(block: ContentBlock): boolean {
  return isKnownContentBlock(block) && block.type === "tool_result";
}

/** True for a `{type:"text"}` or `{type:"image"}` content block — the two
 * block kinds Claude Code emits for a real human utterance (a plain typed
 * message, and an image paste, which arrives as one or more `image` blocks
 * alongside an optional `text` block). Shared by classifyUserMessage's array
 * branch to recognize a real-utterance array shape without hardcoding the
 * two-block-exactly case. */
function isTextOrImageBlock(block: ContentBlock): boolean {
  return isKnownContentBlock(block) && (block.type === "text" || block.type === "image");
}

/** `<command-name>` と、中身が空でない `<command-args>` を持つ user 行から、
 * コマンド名と引数本文を取り出す (どちらか欠けていれば null = 引数なしの裸
 * コマンド、または slash command ですらない行)。
 *
 * 引数本文に `<` が含まれていても拾えるよう非貪欲マッチで書いてある
 * (コード片や XML を /clear に渡す形が普通にあるため)。daemon 側の同じ規則は
 * packages/daemon/src/session-user-input.ts の hasNonEmptyCommandArgs — TL の
 * 表示と prompt 件数の判定がずれないよう、両者は同じ「非空 command-args」で
 * 揃える (パッケージ境界を跨ぐ共有ではなく、相互参照で同期を保つ)。 */
const COMMAND_NAME_TAG_RE = /<command-name>([\s\S]*?)<\/command-name>/;
const COMMAND_ARGS_TAG_RE = /<command-args>([\s\S]*?)<\/command-args>/;

export function parseSlashCommandPrompt(text: string): { command: string; args: string } | null {
  const name = text.match(COMMAND_NAME_TAG_RE)?.[1]?.trim();
  if (!name) return null;
  const args = text.match(COMMAND_ARGS_TAG_RE)?.[1]?.trim();
  if (!args) return null;
  return { command: name, args };
}

/** 引数付き slash command 行の表示形: コマンド名のチップ + ユーザが書いた
 * 本文。本文を通常の user text segment にすることで、検索 / 折返し / 吹き出し
 * 描画が普通のユーザ発話とまったく同じ経路に乗る。 */
function slashCommandPromptSegments(text: string): Segment[] | null {
  const parsed = parseSlashCommandPrompt(text);
  if (parsed === null) return null;
  return [
    { kind: "slash-command-prefix", command: parsed.command },
    { kind: "text", role: "user", text: parsed.args },
  ];
}

/**
 * Classifies one `type:"user"` row (the whole row, so both `isMeta` and
 * `message.content` are visible) into a `UserMessageKind`. Judged in this
 * order, matching the research's discriminating axes:
 *
 * 1. `promptSource === "system"` — authoritative system-origin metadata;
 *    known `origin.kind` values preserve task-notification/peer-message, and
 *    unknown kinds safely degrade to unknown-meta
 * 2. array `content` — tool_result echo, `[Request interrupted...]`
 *    marker, Skill-tool invocation preamble (isMeta + specific prefix), or a
 *    real human utterance with an image/file paste (array of only text/image
 *    blocks, no tool_result — Claude Code emits this shape for a pasted
 *    image, with or without a caption)
 * 3. string `content`: `classifyUserText`
 *
 * Known false-negative (documented in the research, not fixed here): a real
 * user who types text starting with one of the exact literal prefixes below
 * (`<task-notification>`, `Another Claude session sent a message:`) is
 * misclassified as the system kind — `isMeta` doesn't distinguish this case
 * from the wire. Accepted per the research's own limits section; not
 * observed in any sampled real transcript.
 */
export function classifyUserMessage(row: UserRow): UserMessageKind {
  const content = row.message.content;
  const isMeta = row.isMeta === true;

  // Agent (subagent) transcript の先頭 user 行 = Agent tool の spawn prompt
  // (親セッションから渡された指示書)。wire signal は `isSidechain: true` と
  // `parentUuid: null` の組。`isSidechain` は subagent 転写の全行で true、通常
  // セッションの全行で false (agentId を持つのも subagent 転写の行だけ)。
  // `parentUuid: null` だけでは足りない: 通常セッションの最初の user 行 (人の
  // prompt も sdk 経由の prompt も) も `parentUuid: null` で書かれることがある。
  // string 直接値 + プレフィックスマッチではなく wire フィールドで判定して、
  // 「plain text spawn」「<teammate-message> wrapper 付き spawn」の両ケースを
  // 同一 kind に落とす (peer-message 経路は「会話中に届いた relay」用として
  // 温存)。
  if (row.isSidechain && row.parentUuid === null) return "spawn-prompt";

  if (row.promptSource === "system") {
    if (row.origin?.kind === "task-notification") return "task-notification";
    if (row.origin?.kind === "peer") return "peer-message";
    // A cross-session notice is injected by this session's own harness (the
    // subscription is ours), so it carries no `origin` naming a peer — the
    // bracket label is the only wire signal it has.
    if (typeof content === "string" && CROSS_SESSION_NOTICE_RE.test(content)) {
      return "cross-session-notice";
    }
    return "unknown-meta";
  }

  if (typeof content !== "string") {
    if (content.some(isToolResultBlock)) return "tool-result";
    if (content.length === 1) {
      const [block] = content;
      if (block !== undefined && isKnownContentBlock(block) && block.type === "text") {
        const t = block.text;
        if (t.startsWith("[Request interrupted by user")) return "user-interrupt-marker";
        if (isMeta && t.startsWith("Base directory for this skill:"))
          return "skill-invocation-preamble";
        // A lone text block matching none of the above stays the
        // conservative unknown-array fallback below — real plain-text
        // prompts arrive as a bare string `content`, not a single-element
        // array (see the "single text block ... unknown-array" tests), so
        // this shape has no confirmed real-utterance reading to fall back to.
        return "unknown-array";
      }
    }
    // A real human utterance carrying an image/file paste (with or without a
    // caption): Claude Code emits these as an array made up entirely of
    // text/image blocks, no tool_result. Any block type this module hasn't
    // seen (alone or mixed in) keeps the safe unknown-array fallback instead
    // — this module's forward-compat design (see the module doc comment).
    if (content.length > 0 && content.every(isTextOrImageBlock)) return "user-prompt";
    return "unknown-array";
  }

  return classifyUserText(content, isMeta);
}

/**
 * Classifies the text of a user turn — a `type:"user"` row's string content,
 * or the prompt a `queue-operation` row queued — into a `UserMessageKind`:
 *
 * 1. a peer-relay prefix — peer-message, regardless of whether Claude Code
 *    also sets `isMeta:true`
 * 2. `isMeta` — remaining Claude Code CLI/harness UI injection (slash command
 *    caveat/invocation/stdout, malformed-tool-call retry hint)
 * 3. not `isMeta`, another literal system-injection prefix —
 *    task-notification (Monitor/Workflow/subagent), delivered as an ordinary
 *    prompt (`promptId`-bearing)
 * 4. anything else — a real human utterance
 */
function classifyUserText(text: string, isMeta: boolean): UserMessageKind {
  // A peer relay may carry isMeta:true while retaining the fixed peer banner.
  // The decisive peer wrapper must run before the generic isMeta catch.
  if (text.startsWith("Another Claude session sent a message:")) return "peer-message";
  if (PEER_MESSAGE_TAGS.some((tag) => text.startsWith(`<${tag}`))) return "peer-message";
  // Same decisive-prefix reasoning as the peer wrapper above: the queued copy
  // of a notice (a `queue-operation` row) has no `promptSource`/`origin` at
  // all, so it reaches here rather than the system branch.
  if (CROSS_SESSION_NOTICE_RE.test(text)) return "cross-session-notice";

  // TUI の `! <cmd>` (bash モード) 実行。ハーネスは入力を `<bash-input>`、
  // 直後の結果を `<bash-stdout>`+`<bash-stderr>` の別 `type:"user"` 行として
  // 書く (2026-07-25 実観測、`isMeta` は付かない)。slash command 系と同じく
  // タグ prefix は人間の発話が取り得ない形なので meta フラグに依らず判定し、
  // isMeta 分岐の前に置いて両形を 1 箇所で拾う。
  if (text.startsWith("<bash-input>")) return "bash-command-invocation";
  if (text.startsWith("<bash-stdout>") || text.startsWith("<bash-stderr>")) {
    return "bash-command-stdout";
  }

  // 引数付き slash command はユーザ発話 (classifyUserMessage の doc comment
  // 参照)。isMeta の有無に依らないので、slash-command-invocation を拾う 2 経路
  // (isMeta 分岐とその下の bare prefix 判定) の両方より前に置く。
  if (parseSlashCommandPrompt(text) !== null) return "slash-command-prompt";

  if (isMeta) {
    if (text.startsWith("<local-command-caveat>")) return "system-caveat";
    if (text.startsWith("<command-name>")) return "slash-command-invocation";
    if (text.startsWith("<local-command-stdout>")) return "slash-command-stdout";
    if (text === "Your tool call was malformed and could not be parsed. Please retry.")
      return "tool-retry-hint";
    return "unknown-meta";
  }

  // slash command の invocation/stdout は isMeta 付きが通常形だが、isMeta
  // なしで届く transcript もある (kawaz r20、2026-07-15 実観測 — /reload-plugins
  // 等が緑のユーザ発話バブルで表示された)。タグ prefix は人間の発話が取り得
  // ない形なので、meta フラグに依らず同じ分類に落とす。
  if (text.startsWith("<command-name>") || text.startsWith("<command-message>")) {
    return "slash-command-invocation";
  }
  if (text.startsWith("<local-command-stdout>")) return "slash-command-stdout";

  if (text.startsWith("<task-notification>")) return "task-notification";
  // The harness prefixes background-task notifications with a fixed banner
  // line ("[SYSTEM NOTIFICATION - NOT USER INPUT]\n...") before the
  // <task-notification> block — a decisive injected-content marker no human
  // prompt starts with. Without this branch such lines fall through to
  // "user-prompt" and render as a (huge, green) user bubble instead of
  // folding (observed on this very session's transcript, 2026-07-12).
  if (text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]")) {
    return text.includes("<task-notification>") ? "task-notification" : "unknown-meta";
  }
  // TUI で workflow を pause → resume した際にハーネスが注入する定型再開命令。
  // 実 transcript では `promptSource:"typed"` / `origin:{kind:"human"}` / `isMeta`
  // なし、で通常のタイプ入力と wire 上区別できず、文字列 prefix で判定するしかない
  // (kawaz r46 mid=14、本セッションの transcript で 2 件実観測)。
  // 誤爆リスク: 人間が手打ちで `Resume the paused workflow by calling: Workflow({`
  // で始まる文章を送ると誤分類されるが、`{`まで含んだこの厳密 prefix を能動的に
  // 打つケースは実用上ゼロ (=`<task-notification>` prefix 判定と同種の accepted
  // false-negative)。
  if (text.startsWith("Resume the paused workflow by calling: Workflow({")) {
    return "workflow-resume";
  }
  return "user-prompt";
}

/**
 * Classification of a `type:"assistant"` jsonl entry's actual origin — the
 * assistant-side mirror of `UserMessageKind`. Claude Code writes a
 * *synthesized* assistant line whenever a turn is cut short instead of
 * answered (main-context overflow, API/transport failure, usage limit
 * exhausted, not logged in, unparseable tool call, safeguard refusal): the
 * CLI's own report of the interruption, wearing the wire "assistant" role, so
 * it renders identically to something the agent said.
 *
 * Kept a union (rather than a boolean flag) for the same reason
 * `UserMessageKind` is one: the genuine case is a named member, so a future
 * synthetic-assistant shape is a new member here and at the render switch,
 * not a second parallel boolean.
 */
export type AssistantMessageKind = "assistant-response" | "api-error";

/**
 * Classifies one `type:"assistant"` row (the whole row, so the top-level
 * `isApiErrorMessage` flag is visible, not just `message`).
 *
 * The wire signal is top-level `isApiErrorMessage === true`, which Claude
 * Code sets on exactly these synthesized lines (they also carry
 * `message.model === "<synthetic>"`, an all-zero `usage`, and a top-level
 * `error` — all corroborating, none needed: `<synthetic>` alone is *not*
 * sufficient, since the harness also writes non-error synthetic lines such as
 * "No response requested." with `isApiErrorMessage:false`).
 *
 * The message *text* is deliberately not consulted: its wording is the
 * upstream CLI's ("Prompt is too long", "You're out of extra usage · resets
 * 7pm (Asia/Tokyo)", "API Error: 500 {...}", "Not logged in · Please run
 * /login", ...) and changes freely between versions, so any prefix catalog
 * here would rot silently. One flag, no text matching.
 */
export function classifyAssistantMessage(row: AssistantRow): AssistantMessageKind {
  return row.isApiErrorMessage === true ? "api-error" : "assistant-response";
}

/** One ccmsg room message recovered from inside a `teammate-message`/
 * `task-notification` system line (webui Timeline chat-bubble task, kawaz
 * spec) — a trimmed-down `MsgEvent` (`@ccmsg/protocol`): `room` is that
 * event's `r` field (room id), renamed here since this module has no
 * dependency on `@ccmsg/protocol`'s wire types and `extractCcmsgMessages`
 * only needs the fields the bubble UI renders. */
export interface CcmsgMessage {
  from: string;
  to?: string[];
  room: string;
  msg: string;
  ts: string;
  /** DR-0027 §2: canonical (room, mid) pair to look the daemon-stored full
   * message up with (webui's `ws.read(room, [mid])` — CcmsgBubble does this
   * lazily on mount). Present for every wire-format ccmsg extraction the
   * daemon actually emitted a mid for (subscribe teammate-message relay,
   * task-notification `<event>` body, tool_result `{ok:true,room,mid}` post/
   * reply response — even the truncated-fragment recovery when the fragment
   * still carries `"mid":N` before the truncation point). Absent only when
   * the fragment lost the mid to truncation before we could parse it — those
   * still render with the recovered body (救済 parse), just without the
   * canonical read-fallback path. */
  mid?: number;
  /** Present for a message the standalone ccmsg delivered or the session sent
   * with it (`@ccmsg/protocol`'s ccmsg-direct-transcript). Such a message has
   * no room: `room` is `""`, `mid` is absent, and `msg` is already the full
   * body, so nothing is looked up. */
  direct?: CcmsgDirect;
}

/** The standalone-ccmsg half of a `CcmsgMessage`.
 *
 * - `in`: an envelope delivered to this session; `id` is its mid
 *   (`<instance>/<n>`)
 * - `out`: this session's `ccmsg post|reply|notify` Bash call or `send` tool
 *   call; `id` is the tool_use id, `status` what its tool_result said
 *   (`pending` until one arrives), `command` the Bash command as written or
 *   the tool's input */
export type CcmsgDirect =
  | { direction: "in"; id: string; replyTo?: string }
  | {
      direction: "out";
      id: string;
      verb: "post" | "reply" | "notify" | "send";
      replyTo?: string;
      status: "sent" | "failed" | "unconfirmed" | "pending";
      /** The result text of a `failed` or `unconfirmed` send. */
      error?: string;
      command: string;
    };

/** Dedup key for a `CcmsgMessage` (kawaz r15 mid=21: the same room event can
 * be extracted twice from one transcript — a `queue-operation` enqueue line
 * and its `task-notification` Monitor tool_result echo both carry it,
 * DR-0027 §2.2 extends this to also cover the sender-side echo: an AI post/
 * reply's tool_result `{ok:true,room,mid}` response, and the same message
 * arriving back through the subscribe teammate-message relay, are the same
 * canonical `(room, mid)`). Shared by the bubble-list render (components/timeline/Timeline.tsx) and
 * the in-view search unit list (useInViewSearch.ts) so the two dedup identically — a message the
 * render side drops as a duplicate must never still count toward the search
 * "[N/M]" total (a ghost match with no bubble to highlight/scroll to).
 *
 * When `mid` is present the key is `${room}|m${mid}` — canonical per daemon
 * (rooms/*.jsonl mid is unique per room), so two extractions of the same
 * message from different transcript wrappers collapse regardless of whether
 * their transcript body copies still match verbatim (truncation, XML entity
 * escaping differences, DR-0027 §2 lazy-read replacement). Falls back to the
 * old `${room}|${ts}|${from}|${msg}` form for pre-DR-0027 extractions and
 * for fragments that lost their mid to truncation. */
export function ccmsgDedupKey(m: CcmsgMessage): string {
  if (m.direct) return `direct-${m.direct.direction}|${m.direct.id}`;
  if (m.mid !== undefined) return `${m.room}|m${m.mid}`;
  return `${m.room}|${m.ts}|${m.from}|${m.msg}`;
}

/** Matches Claude Code's Task-tool teammate relay wrapper (see
 * `classifyUserMessage`'s "Another Claude session sent a message:" prefix,
 * `peer-message` kind) — one tag per relayed teammate turn, body is normally
 * one JSON object. Global so a single line carrying several relays (observed
 * in practice: a session going idle twice in a row) yields one match per tag. */
const TEAMMATE_MESSAGE_RE = /<teammate-message[^>]*>([\s\S]*?)<\/teammate-message>/g;

/** Matches the `<event>...</event>` body Claude Code's Monitor-tool
 * `task-notification` wrapper carries (see `classifyUserMessage`'s
 * `task-notification` kind) — a ccmsg `subscribe` Monitor prints one JSON
 * event per stdout line, so this tag's body can itself be multi-line jsonl,
 * not a single JSON value like `teammate-message`'s. */
const EVENT_TAG_RE = /<event>([\s\S]*?)<\/event>/g;

/** A ccmsg `MsgEvent` delivered over `subscribe` (wire shape: `{type:"msg",
 * mid, from, to?, ts, msg|msg_via, r}` — `r` is the room id DeliveredEvent
 * flattening adds. `msg_via` is accepted only with a mid, producing a
 * placeholder that the existing daemon read path hydrates). Any other event
 * shape this line might carry (`idle_notification`, `ev:"notify"`,
 * member/leave/title/... — anything whose `type` isn't exactly `"msg"`) does
 * not read, which is the whole point: only a real room message becomes a chat
 * bubble, everything else stays inside the fold. */
const CcmsgMsgEventSchema = v.pipe(
  v.looseObject({
    type: v.literal("msg"),
    // `mid` is surfaced (DR-0027 §2 lazy-read key), still not required for
    // shape validity — pre-DR-0027 fixtures without mid must keep flowing
    // through (they degrade to no read-fallback, see CcmsgMessage.mid doc).
    mid: v.optional(v.number()),
    from: v.string(),
    to: v.optional(v.array(v.string())),
    r: v.string(),
    msg: v.optional(v.string()),
    msg_via: v.optional(v.string()),
    ts: v.string(),
  }),
  v.check(
    (event) => event.msg !== undefined || (event.msg_via !== undefined && event.mid !== undefined),
    "a msg event carries its body, or msg_via with a mid",
  ),
);

/** Reverses the entity escaping Claude Code's harness applies to text it
 * embeds in a tag body — a `<task-notification><event>` block (kawaz r26
 * mid=30: a literal ">" in a room message showed as "&gt;" in Timeline) and a
 * `<bash-stdout>`/`<bash-stderr>` body (kawaz r76 m84: `! <cmd>` output showed
 * "&lt;"). The daemon's stored jsonl carries the raw text — the escaping exists
 * only inside the transcript copy — so unescaping here restores the original.
 *
 * The escape set is `&`, `<`, `>` — the XML *text-content* minimum, not the
 * five predefined entities. Measured on CC 2.1.220 by feeding a known payload
 * through `! head payload.txt`: `<`/`>`/`&` came back as `&lt;`/`&gt;`/`&amp;`
 * while `"` and `'` came back verbatim, and 4472 real `<event>` bodies contain
 * zero `&quot;`/`&apos;`/numeric references. Decoding quotes would therefore
 * only ever corrupt output that genuinely printed "&quot;".
 *
 * Because `&` is escaped too, this is an exact inverse rather than a guess:
 * a literal "&lt;" in the source is stored as "&amp;lt;", and decoding &amp;
 * last restores it without the &lt; rule stealing it first. */
function unescapeHarnessEntities(text: string): string {
  if (!text.includes("&")) return text;
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** Parses one candidate fragment (a `teammate-message` tag body, or one line
 * of a `task-notification`'s `<event>` jsonl body) into a `CcmsgMessage`.
 * Returns null — never throws — for invalid JSON or a validly-parsed value
 * that isn't a ccmsg `type:"msg"` event (kawaz spec: "壊れた JSON は空で
 * fallback", and non-msg events like `idle_notification` must NOT become a
 * bubble). */
function tryParseCcmsgMessage(fragment: string, fallbackRoom?: string): CcmsgMessage | null {
  const json = parseWith(JsonTextSchema, fragment.trim());
  if (!json.ok) return tryParseTruncatedCcmsgMessage(fragment.trim(), fallbackRoom);
  const read = parseWith(CcmsgMsgEventSchema, json.value);
  if (!read.ok) return null;
  const event = read.value;
  return {
    from: event.from,
    ...(event.to !== undefined ? { to: [...event.to] } : {}),
    room: event.r,
    msg: event.msg !== undefined ? unescapeHarnessEntities(event.msg) : "",
    ts: event.ts,
    ...(event.mid !== undefined ? { mid: event.mid } : {}),
  };
}

/** Monitor 通知の <event> は長い msg を「...(truncated)」で切り詰めることが
 * あり (harness 側の通知サイズ上限)、その行は JSON として壊れて上の parse が
 * 落ちる — 従来はそのまま null → CcmsgBubble にならず生 JSON の fold 表示に
 * なっていた (kawaz r17 mid=43 の実観測)。切れていても field 順は固定
 * (daemon の subscribe wire order:
 * `type,mid,from,ts,to?,r,seq,reply_via?,msg` — msg が必ず最後、
 * docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md) なので、msg の
 * 途中までを regex で抜けば「途中まで + 切り詰め注記」の bubble にできる。
 * 読める形が生 JSON より常に良い、が判断 (全文は webui の room 表示か read
 * で見られる)。
 *
 * room (`r`) は msg より前の field なので、truncation が msg 本文側で起きる
 * 限り通常は失われない — ただし単独 msg 通知で `r` 自体が何らかの理由で
 * 欠けた場合の保険として、呼び出し側 (extractCcmsgMessages) が同じ <event>
 * ブロック内の parse できた行から補完した `fallbackRoom` を渡す (subscribe
 * の 1 通知は room event のバッチで、実観測の形は kind/title/member 行が
 * 同居する)。それも無い単独 msg 通知では `?` を room 表示に使い、復元できた
 * 本文を bubble として保持する。 */
/** A JSON string literal, as the text it says. */
const JsonStringTextSchema = jsonText(v.string());

function tryParseTruncatedCcmsgMessage(
  fragment: string,
  fallbackRoom?: string,
): CcmsgMessage | null {
  if (!fragment.endsWith("(truncated)")) return null;
  if (!fragment.startsWith('{"type":"msg"')) return null;
  const from = fragment.match(/"from":"((?:[^"\\]|\\.)*)"/)?.[1];
  const ts = fragment.match(/"ts":"((?:[^"\\]|\\.)*)"/)?.[1];
  const knownRoom = fragment.match(/"r":"((?:[^"\\]|\\.)*)"/)?.[1] ?? fallbackRoom;
  const room = knownRoom ?? "?";
  // mid は subscribe wire order (docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md
  // 済) では msg より前 (`type,mid,from,ts,to?,r,seq,reply_via?,msg`) なので
  // truncation 前に必ず来る — 拾えれば DR-0027 §2 の read-fallback パスに乗る。
  // ただし canonical lookup key は (r, mid) の**組**: room が復元できなかった
  // fragment (`room === "?"`) に mid だけ付けると、`ws.read("?", [mid])` の
  // 無意味な発火と、別 room の同 mid truncated fragment との dedup 偽衝突
  // (`?|m99` が room を跨いで同キー化) を起こす。room 不明時は mid を捨てて
  // 救済 parse 本文だけの最終フォールバックに落とす (DR-0027 §2.1)。
  const midMatch = knownRoom !== undefined ? fragment.match(/"mid":(\d+)/)?.[1] : undefined;
  const mid = midMatch !== undefined ? Number(midMatch) : undefined;
  const msgMatch = fragment.match(/"msg":"((?:[^"\\]|\\.)*)/)?.[1];
  if (!from || !ts || msgMatch === undefined) return null;
  // 抜き出した半端な JSON string 断片を JSON の文字列としてデコード (escape
  // 解決)。断片が escape の途中で切れていたら最後の \ を落としてから読む。
  const decoded = parseWith(JsonStringTextSchema, `"${msgMatch.replace(/\\$/, "")}"`);
  if (!decoded.ok) return null;
  const msg = decoded.value;
  return {
    from,
    room,
    msg: `${unescapeHarnessEntities(msg)}…(切り詰め — 全文は room で)`,
    ts,
    ...(mid !== undefined ? { mid } : {}),
  };
}

/** One event of a `<event>` block, read for its room alone. */
const CcmsgEventRoomLineSchema = jsonText(v.looseObject({ r: v.string() }));

/**
 * Recovers every ccmsg room message (`type:"msg"` events) embedded in a
 * `role:"user"` line's text, regardless of which system-injection wrapper
 * carries it — a `teammate-message` relay (Task-tool teammate turn) or a
 * `task-notification`'s `<event>` body (a ccmsg `subscribe` Monitor's stdout,
 * which is itself jsonl and can hold several events per notification). Both
 * patterns are scanned unconditionally rather than gating on
 * `classifyUserMessage`'s verdict first: a tag that doesn't match either
 * regex contributes nothing, so the result is the same either way, and this
 * keeps the function self-contained (works on a hand-built `ParsedLine` too,
 * not only ones that went through `parseTranscriptLine`/`classifyUserMessage`).
 *
 * Non-turn lines, assistant turns, and any fragment that isn't a `type:"msg"`
 * event (an `idle_notification` teammate-message body, a `task-notification`
 * `<event>` with no ccmsg activity at all, ...) all yield `[]` — the caller
 * (the chat-bubble rendering in components/timeline/, and `isBoundaryLine` above) treats
 * an empty result as "render this line the ordinary way", not as an error.
 *
 * Known false-negative (accepted, not fixed here — same category as
 * `classifyUserMessage`'s documented false-negative above): `TEAMMATE_MESSAGE_RE`/
 * `EVENT_TAG_RE` are non-greedy, so if a `msg` field's *value* itself contains
 * the literal closing-tag text (e.g. someone pastes `</event>` into a ccmsg
 * message), the regex closes early at that literal occurrence instead of the
 * wrapper's real closing tag. The truncated fragment fails `JSON.parse`
 * (`tryParseCcmsgMessage` returns `null`, never throws), so that one message
 * silently falls back to the ordinary fold-line rendering instead of becoming
 * a chat bubble — degrades safely, doesn't crash or corrupt other messages in
 * the same line. No JSON-escaping trick can hide the literal (the value is
 * substring-matched against the raw wrapper text, not the JSON-decoded
 * string), so fixing this for real would need tag-aware scanning (e.g.
 * last-closing-tag-wins) rather than a regex tweak.
 */
export function extractCcmsgMessages(line: ParsedLine): CcmsgMessage[] {
  if (line.kind !== "turn") return [];
  if (line.role === "assistant") return extractDirectSends(line);
  const text = line.segments
    .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
    .map((s) => s.text)
    .join("\n");
  if (!text) return [];
  // 早期 return: どちらのタグも含まない (大半の user 行、システム注入行は
  // 本文が巨大になりがち) なら matchAll を 2 本走らせるまでもない — join
  // コスト自体は避けられないが、この関数は classifyBoundaryLine 経由で
  // groups が変わるたび (load older / tail 追記 / refresh, components/timeline/useTranscriptModel.ts)
  // に呼ばれるので、軽いほど再分類コストが下がる。
  const direct = mayContainDirectDelivery(text);
  if (!direct && !text.includes("<teammate-message") && !text.includes("<event>")) return [];
  const results: CcmsgMessage[] = [];
  // The queued copy of an envelope is the same message as the delivered row
  // that follows it; only the delivered one counts.
  if (direct && line.queuedContent === undefined) {
    for (const envelope of parseDirectDeliveries(text)) {
      results.push({
        from: envelope.from === DIRECT_DELIVERY_USER_SENDER ? "u1" : envelope.from,
        room: "",
        msg: envelope.text,
        ts: line.ts ?? "",
        direct: {
          direction: "in",
          id: envelope.mid,
          ...(envelope.replyTo !== undefined ? { replyTo: envelope.replyTo } : {}),
        },
      });
    }
  }
  for (const [, body] of text.matchAll(TEAMMATE_MESSAGE_RE)) {
    const parsed = body === undefined ? null : tryParseCcmsgMessage(body);
    if (parsed) results.push(parsed);
  }
  for (const [, block] of text.matchAll(EVENT_TAG_RE)) {
    if (block === undefined) continue;
    // truncated 行の room 補完用: 同じ <event> ブロック内で parse できた
    // event の r (subscribe の 1 通知は同一 room のバッチが普通)。
    let blockRoom: string | undefined;
    for (const eventLine of block.split("\n")) {
      const trimmed = eventLine.trim();
      if (!trimmed) continue;
      // truncated 等の壊れ行・room の無い行では blockRoom はそのまま。
      const event = parseWith(CcmsgEventRoomLineSchema, trimmed);
      if (event.ok) blockRoom = event.value.r;
      const parsed = tryParseCcmsgMessage(trimmed, blockRoom);
      if (parsed) results.push(parsed);
    }
  }
  return results;
}

/** This session's own `send` tool call as an outgoing bubble (DR-0039 §3):
 * to the sessions its result says it reached (or may have), or the session
 * it named by id until a result says. */
function toolSend(
  line: TurnLine,
  segment: Extract<Segment, { kind: "tool-use" }>,
): CcmsgMessage | null {
  const send = ccmsgSendCall(segment.name, segment.input);
  if (send === null) return null;
  const reading = segment.result === null ? null : readSendResultText(segment.result.text);
  const reached = reading === null || reading.status === "failed" ? [] : reading.to;
  const to = reached.length > 0 ? reached : send.sessionId !== undefined ? [send.sessionId] : [];
  return {
    from: "",
    ...(to.length > 0 ? { to } : {}),
    room: "",
    msg: send.text,
    ts: line.ts ?? "",
    direct: {
      direction: "out",
      id: segment.toolUseId,
      verb: "send",
      status: reading === null ? "pending" : reading.status,
      ...(reading?.detail !== undefined ? { error: reading.detail } : {}),
      command: JSON.stringify(segment.input, null, 2),
    },
  };
}

/** This session's own sends on an assistant line, as outgoing bubbles: its
 * `ccmsg post|reply|notify` Bash calls and its `send` tool calls. A Bash call
 * answered by the room CLI's `{ok:…}` is left alone: that message reaches the
 * timeline through the room path. */
function extractDirectSends(line: TurnLine): CcmsgMessage[] {
  const out: CcmsgMessage[] = [];
  for (const segment of line.segments) {
    if (segment.kind === "tool-use") {
      const sent = toolSend(line, segment);
      if (sent !== null) out.push(sent);
      continue;
    }
    if (segment.kind !== "bash-use") continue;
    const send = parseCcmsgSendCommand(segment.command);
    if (!send) continue;
    const outcome = segment.result
      ? classifyCcmsgSendResult(segment.result.text, segment.result.isError)
      : null;
    if (outcome?.status === "other-ccmsg") continue;
    const to =
      send.verb === "post" ? send.to : send.verb === "reply" ? (send.to ?? "u1") : undefined;
    out.push({
      from: "",
      ...(to !== undefined ? { to: [to] } : {}),
      room: "",
      msg: send.text,
      ts: line.ts ?? "",
      direct: {
        direction: "out",
        id: segment.toolUseId,
        verb: send.verb,
        ...(send.replyTo !== undefined ? { replyTo: send.replyTo } : {}),
        status: outcome === null ? "pending" : outcome.status,
        ...(outcome?.status === "failed" || outcome?.status === "unconfirmed"
          ? { error: outcome.detail }
          : {}),
        command: segment.command,
      },
    });
  }
  return out;
}

/** The text of a PushNotification call on an assistant line, or null. */
export function pushNotificationOf(line: ParsedLine): string | null {
  if (line.kind !== "turn" || line.role !== "assistant") return null;
  for (const segment of line.segments) {
    if (segment.kind !== "tool-use") continue;
    const text = pushNotificationText(segment.name, segment.input);
    if (text !== null) return text;
  }
  return null;
}

// --- rich|raw タブの rich 側パース (U2 kawaz spec: 「分類済みシステム
// メッセージの details 展開時の本文に rich | raw のタブ切替を追加、ccmsg
// 吹き出しの msg/raw タブと同じ UI 流儀」) ---
//
// 対象は components/timeline/folds.tsx の LineView が `sysKind` (= role:"user" かつ
// userMessageKind !== "user-prompt") と判定した全 fold — task-notification /
// peer-message / slash-command-invocation / slash-command-stdout / それ以外
// すべて。「壊れた入力は raw fallback」(throw しない) という要件を満たすため、
// 認識できないタグ形状は常に `{display:"text", text: rawText}` に degrade する
// — raw タブ (LineView が今までどおり描画する segments) と同じ生テキストを
// 保持するので、rich タブが空振りしても情報は失われない。

/** One name/value pair recovered from an XML-ish `<tag>...</tag>` child (or
 * an opening tag's attribute) inside a system-origin line's raw text. `value`
 * is trimmed but otherwise untouched — JSON pretty-printing (peer-message's
 * body) happens at the call site, not here, since only some fields are JSON. */
export interface SystemMessageField {
  name: string;
  value: string;
}

/** Rich-display shape `parseSystemMessageFields` returns — `SystemMessageBody`
 * (components/timeline/system-messages.tsx) renders one of these three layouts. `"text"` is also the
 * universal fallback for a kind with no dedicated layout (system-caveat,
 * tool-retry-hint, user-interrupt-marker, unknown-meta, unknown-array,
 * skill-invocation-preamble, tool-result, and any unmatched/malformed input)
 * — kawaz spec bullet 5: 「定型文はそのまま <pre> (rich と raw が同じでも
 * タブは出して構造統一)」. */
export type PeerMessageCategory = "message" | "idle" | "task-assignment" | "lifecycle" | "unknown";

/** Which transport carried a relay. `"teammate"` is the in-process Task-tool
 * relay (`<teammate-message>`/`<agent-message>`); `"cross-session"` is Claude
 * Code's session-to-session delivery (`<cross-session-message>`, the
 * SendMessage/ListAgents pair) plus the `[Cross-session ...]` harness notices
 * that ride the same channel. The two look alike once parsed, so the channel
 * is kept on the relay itself and surfaced as a discreet label rather than
 * being flattened away. */
export type PeerChannel = "teammate" | "cross-session";

export type SystemMessageRich =
  | { display: "fields"; heading: string | null; fields: SystemMessageField[] }
  | { display: "chip"; label: string; detail: string | null }
  | { display: "bash"; command: string | null; output: BashCommandOutput | null }
  | { display: "peer"; relays: PeerRelay[] }
  | { display: "text"; text: string };

/** One relayed teammate turn — the body of a single `<teammate-message>` tag.
 * A relay line often carries several (11% of 2597 sampled relay lines; the
 * shapes range from `idle+idle` to `msg+idle+msg+msg+idle+idle`), because the
 * harness batches everything that arrived while the session was busy into one
 * injected user turn. Each is displayed on its own, so a report sharing a line
 * with an idle notification is not swallowed by it. */
export interface PeerRelay {
  from: string;
  summary: string | null;
  category: PeerMessageCategory;
  body: string;
  channel: PeerChannel;
}

/** Matches a top-level (non-nested) `<tag>...</tag>` pair — the backreference
 * `\1` ties the close tag to the same name as the open tag it matched, so
 * this only needs one pass regardless of which tag names actually appear
 * (task-id/summary/event/output-file/... for task-notification,
 * command-name/command-message/command-args/... for
 * slash-command-invocation — no whitelist, matching this module's existing
 * "no hardcoded whitelist of known fields" design, see the module doc
 * comment). Doesn't handle same-name tags nested inside each other (not
 * observed in any sampled pattern), and a tag's own content containing the
 * literal closing-tag text truncates the match early — same accepted
 * false-negative shape as `TEAMMATE_MESSAGE_RE`/`EVENT_TAG_RE` above,
 * degrading to a missing field rather than a throw. */
const XML_CHILD_TAG_RE = /<([a-zA-Z][\w-]*)>([\s\S]*?)<\/\1>/g;

function extractXmlFields(text: string): SystemMessageField[] {
  const fields: SystemMessageField[] = [];
  for (const [, name, value] of text.matchAll(XML_CHILD_TAG_RE)) {
    if (name !== undefined && value !== undefined) fields.push({ name, value: value.trim() });
  }
  return fields;
}

/** Strips one specific outer `<tagName>...</tagName>` wrapper (e.g.
 * `<task-notification>`, whose banner-prefixed variant per
 * `classifyUserMessage`'s doc comment still contains this tag somewhere, not
 * necessarily at index 0 — hence a search, not an anchored match) and returns
 * only its inner content, so a follow-up `extractXmlFields` call sees the
 * *children* (task-id/summary/event/...) as top-level matches instead of the
 * whole wrapper consuming itself as one match. Returns null (not `text`
 * itself) when the wrapper isn't found, so callers can tell "unwrapped" from
 * "wrapper missing" apart rather than silently scanning the un-unwrapped text
 * for children that were never there. */
function unwrapOuterTag(text: string, tagName: string): string | null {
  const re = new RegExp(`<${tagName}>([\\s\\S]*?)<\\/${tagName}>`);
  return text.match(re)?.[1] ?? null;
}

/** Matches one `<teammate-message>`, `<agent-message>` or
 * `<cross-session-message>` relay and captures its tag name, opening-tag
 * attributes, and body. A line can carry several relays; every one of them is
 * parsed, and the tag name decides the relay's `channel`. */
const PEER_MESSAGE_ATTRS_RE =
  /<(teammate-message|agent-message|cross-session-message)([^>]*)>([\s\S]*?)<\/\1>/g;

/** Every peer relay tag in `text`: its name, its attribute string and its
 * body, in order. */
function peerRelayTags(text: string): { tag: string; attrs: string; body: string }[] {
  return [...text.matchAll(PEER_MESSAGE_ATTRS_RE)].flatMap(([, tag, attrs, body]) =>
    tag === undefined || attrs === undefined || body === undefined ? [] : [{ tag, attrs, body }],
  );
}

/** Relay tag names, in the shape `classifyUserMessage`'s bare-prefix check and
 * `queuePairingKey`'s tail search need them. */
const PEER_MESSAGE_TAGS = ["teammate-message", "agent-message", "cross-session-message"] as const;

function peerChannelOfTag(tagName: string): PeerChannel {
  return tagName === "cross-session-message" ? "cross-session" : "teammate";
}

/** Harness notices about a cross-session subscription, delivered as their own
 * injected user turn rather than inside a relay tag. The observed wording is
 * `[Cross-session idle notice] "<name>", which you asked to be notified
 * about, is idle now — ...`; the bracket label is matched by its
 * `[Cross-session …]` shape instead of the one exact phrase so a sibling
 * notice of the same family (a subscription that expired before the peer went
 * idle) lands in the same compact row instead of falling back to a raw
 * unknown-meta fold. */
const CROSS_SESSION_NOTICE_RE = /^\[Cross-session [^\]]*\]/;

/** The session the notice is about — the first double-quoted name in it. The
 * notice is prose, so this is a best-effort read: an unnamed variant keeps the
 * generic fallback rather than dropping the row. */
const CROSS_SESSION_NOTICE_NAME_RE = /"([^"]+)"/;

/** Shown as the sender of a cross-session notice whose text names no session.
 * Japanese to match the surrounding UI vocabulary, and a role rather than a
 * guessed name. */
const CROSS_SESSION_NOTICE_FROM = "相手セッション";

const XML_ATTR_RE = /([\w-]+)="([^"]*)"/g;

function parseXmlAttrs(attrString: string): SystemMessageField[] {
  const fields: SystemMessageField[] = [];
  for (const [, name, value] of attrString.matchAll(XML_ATTR_RE)) {
    if (name !== undefined && value !== undefined) fields.push({ name, value });
  }
  return fields;
}

// ANSI CSI escape sequences (color codes, cursor movement, DEC private modes
// like cursor hide/show, ...) — a `<local-command-stdout>` body can carry these
// verbatim when the local command's own stdout was terminal-color-coded (kawaz
// spec: 「ANSI エスケープ除去」). Matches the full ECMA-48 CSI shape: `ESC [`,
// then parameter bytes 0x30-0x3F (digits/`;`/`?`/`<`/`=`/`>` — `?` covers the
// DEC private mode prefix spinner-style CLIs use for `\x1b[?25l`/`\x1b[?25h`
// cursor hide/show), then intermediate bytes 0x20-0x2F, then a final byte
// 0x40-0x7E. Doesn't attempt to handle every ECMA-48 escape family (OSC/DCS),
// which this harness's local commands haven't been observed to emit.
// oxlint-disable-next-line no-control-regex -- ESC は ANSI CSI の定義そのもので意図的
const ANSI_CSI_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;

/** Strips ANSI CSI escape sequences from `text` — exported since it's a
 * generically useful primitive, not only used by `parseSystemMessageFields`. */
export function stripAnsiEscapes(text: string): string {
  return text.replace(ANSI_CSI_RE, "");
}

/** Matches the `<persisted-output>` block Claude Code substitutes for an
 * oversized `! <cmd>` result. Capture 1 is the note line naming the original
 * size and the sidecar path; capture 2 is the preview body that follows the
 * `Preview (first NKB):` marker. The path is pulled separately by
 * `PERSISTED_PATH_RE` rather than woven into this pattern so a wording change
 * upstream degrades to "no link, full text still shown" instead of dropping
 * the whole block back to raw. */
const PERSISTED_OUTPUT_RE =
  /^\s*<persisted-output>\s*([\s\S]*?)\n\s*Preview \(first [^)]*\):\n([\s\S]*?)\s*<\/persisted-output>\s*$/;
const PERSISTED_PATH_RE = /saved to:\s*(\S+)/;

/** Splits a `<bash-stdout>` body into either plain text or the
 * `<persisted-output>` shape. Returns `null` for a body that is not
 * persisted, letting the caller keep it verbatim. */
function parsePersistedOutput(stdout: string): BashCommandOutput["persisted"] | null {
  const [, notice, preview] = stdout.match(PERSISTED_OUTPUT_RE) ?? [];
  if (notice === undefined || preview === undefined) return null;
  const note = notice.trim();
  const path = note.match(PERSISTED_PATH_RE)?.[1] ?? "";
  if (path === "") return null;
  return { note, path, preview };
}

/** Restores a `<bash-stdout>`/`<bash-stderr>` body to the bytes the command
 * actually printed. Runs before `stripAnsiEscapes` because a CSI parameter
 * byte may itself be `<`, `=` or `>` (SGR mouse reports are `ESC [ <…M`) —
 * those arrive escaped, so stripping first would leave the sequence unmatched
 * and its bytes on screen.
 *
 * A `<persisted-output>` block is handed back untouched: the harness
 * substitutes it for an oversized result *instead of* escaping, so its note
 * and preview hold raw bytes (measured on CC 2.1.220 with a 78KB payload —
 * the preview came back as `line 0 <tag> & amp "q"`, unescaped). Decoding it
 * would corrupt any preview that genuinely printed "&lt;". */
function decodeBashBody(body: string): string {
  if (body.trimStart().startsWith("<persisted-output>")) return body;
  return stripAnsiEscapes(unescapeHarnessEntities(body));
}

/** Parses one `<bash-stdout>…</bash-stdout><bash-stderr>…</bash-stderr>` line
 * (the observed single-line shape) into the display model. Returns `null`
 * only when neither tag is present — a malformed body the caller renders raw.
 * Empty sides become `null` so the renderer can omit them (kawaz spec:
 * 「stderr は空なら出さない」). Shared by `resolveToolResults`' pairing pass
 * and `parseSystemMessageFields` so the two can't drift. */
export function parseBashOutputText(rawText: string): BashCommandOutput | null {
  const stdout = unwrapOuterTag(rawText, "bash-stdout");
  const stderr = unwrapOuterTag(rawText, "bash-stderr");
  if (stdout === null && stderr === null) return null;
  const persisted = stdout === null ? null : parsePersistedOutput(stdout);
  const plainStdout = persisted !== null ? null : stdout;
  return {
    stdout: plainStdout ? decodeBashBody(plainStdout) : null,
    stderr: stderr ? decodeBashBody(stderr) : null,
    persisted,
  };
}

/** Parses one `<bash-input>` line into the command text, or `null` when the
 * tag is absent. No entity decoding here: unlike the output tags, the harness
 * stores the typed command verbatim (measured on CC 2.1.220 — `! head f #
 * <tag> & "q"` round-trips with `<`, `>` and `&` intact). */
export function parseBashInputText(rawText: string): string | null {
  return unwrapOuterTag(rawText, "bash-input")?.trim() ?? null;
}

/** Sender shown for a spawn prompt that carries no `<teammate-message>`
 * wrapper (a bare `Agent` tool call). The wire gives no name in that shape,
 * but an agent transcript's first line is by definition the instruction its
 * parent handed it, so "親" is a statement of that structure rather than a
 * guess. Japanese to match the surrounding UI vocabulary (「タスク指示」
 * 「受信」…) and to read as a role rather than a session name. */
const SPAWN_PROMPT_FROM = "親";

function parsePeerMessage(rawText: string): Extract<SystemMessageRich, { display: "peer" }> | null {
  const relays = peerRelayTags(rawText).map(({ tag, attrs, body }) =>
    parsePeerRelay(tag, attrs, body),
  );
  if (relays.length === 0) return null;
  return { display: "peer", relays };
}

/** A relay's body when it is JSON. */
const RelayBodyTextSchema = jsonText(JsonValueSchema);

/** The notices a relay's JSON body can be, by `type`. */
const RelayNoticeSchema = v.variant("type", [
  v.looseObject({
    type: v.literal("idle_notification"),
    idleReason: v.optional(v.string(), "idle"),
    // `failureReason` (the API error that ended the peer's turn) only rides
    // along on a failed idle notification, and it is the one part of an
    // idle body worth reading — keep it in the text the compact idle row
    // reveals when opened.
    failureReason: v.optional(v.string()),
  }),
  v.looseObject({
    type: v.literal("task_assignment"),
    subject: v.optional(v.string(), "タスク割り当て"),
    description: v.optional(v.string()),
  }),
  v.looseObject({
    type: v.picklist(["shutdown_request", "shutdown_approved", "teammate_terminated"]),
    reason: v.optional(v.string()),
    message: v.optional(v.string()),
  }),
]);

function parsePeerRelay(tagName: string, attrString: string, rawTagBody: string): PeerRelay {
  const channel = peerChannelOfTag(tagName);
  const attrs = new Map(parseXmlAttrs(attrString).map((f) => [f.name, f.value]));
  // `<cross-session-message>` names the sender twice: `from` is the peer's
  // unix socket path (`uds:/tmp/cc-socks/<pid>.sock`, a pid that dies with the
  // session) and `from-name` is the session name every other part of the UI
  // addresses it by. Prefer the name so bubbles group and read by identity
  // rather than by a number that is meaningless a minute later; the socket
  // path stays as the last-resort fallback when a relay arrives unnamed.
  const from = attrs.get("from-name") || attrs.get("from") || attrs.get("teammate_id") || "agent";
  const summary = attrs.get("summary") || null;
  const rawBody = rawTagBody.trim();
  const json = parseWith(RelayBodyTextSchema, rawBody);
  // Plain relayed reports and instructions are already readable as-is.
  if (!json.ok) return { from, summary, category: "message", body: rawBody, channel };
  const notice = parseWith(RelayNoticeSchema, json.value);
  if (!notice.ok) {
    return {
      from,
      summary,
      category: "unknown",
      body: JSON.stringify(json.value, null, 2),
      channel,
    };
  }
  const value = notice.value;
  switch (value.type) {
    case "idle_notification": {
      const { idleReason, failureReason } = value;
      return {
        from,
        summary,
        category: "idle",
        body: failureReason
          ? `待機通知 · ${idleReason} · ${failureReason}`
          : `待機通知 · ${idleReason}`,
        channel,
      };
    }
    case "task_assignment":
      return {
        from,
        summary,
        category: "task-assignment",
        body: value.description ? `${value.subject}\n${value.description}` : value.subject,
        channel,
      };
    default:
      return {
        from,
        summary,
        category: "lifecycle",
        body: [value.type, value.reason, value.message]
          .filter((part): part is string => part !== undefined && part !== "")
          .join(" · "),
        channel,
      };
  }
}

/**
 * Rich-display parsing for a `sysKind` fold's "rich" tab (U2 kawaz spec:
 * task-notification / teammate-message / system-caveat / slash-command-
 * invocation / slash-command-stdout / skill-invocation-preamble 等の details
 * 展開時の本文に rich | raw のタブ切替、デフォルト rich). Given the line's
 * `userMessageKind` (LineView's `sysKind` in components/timeline/folds.tsx — any classified kind other
 * than `"user-prompt"`) and the line's raw text (joined text segments, same
 * input `extractCcmsgMessages` reads), returns one of the three
 * `SystemMessageRich` shapes. Never throws — any tag this doesn't recognize,
 * or a kind with no dedicated layout, degrades to `{display:"text", text:
 * rawText}` (see the module-level comment above this section).
 *
 * Delegation-note mismatch (reported per policy, not silently resolved): the
 * U2 spec names one target kind "teammate-message", but this module's
 * `UserMessageKind` union (`classifyUserMessage`) has no such value — the
 * kind that actually carries a `<teammate-message>`-wrapped body is
 * `"peer-message"` (Claude Code's Task-tool relay, "Another Claude session
 * sent a message:" prefix, see `classifyUserMessage`'s doc comment). This
 * function's `"peer-message"` case is what the spec's "teammate-message"
 * bullet describes; `type:"msg"` ccmsg events inside it never reach here at
 * all — `classifyBoundaryLine` promotes those lines to a standalone `"ccmsg"`
 * boundary (`CcmsgBubble`) before the fold path (components/timeline/folds.tsx) ever runs, so the
 * peer-message case here only ever sees the non-ccmsg bodies (idle
 * notifications, plain relayed text, ...).
 */
export function parseSystemMessageFields(
  kind: UserMessageKind | undefined,
  rawText: string,
): SystemMessageRich {
  switch (kind) {
    case "task-notification": {
      const inner = unwrapOuterTag(rawText, "task-notification") ?? rawText;
      const fields = extractXmlFields(inner);
      const summary = fields.find((f) => f.name === "summary")?.value ?? null;
      return {
        display: "fields",
        heading: summary,
        fields: fields.filter((f) => f.name !== "summary"),
      };
    }
    case "peer-message":
      return parsePeerMessage(rawText) ?? { display: "text", text: rawText };
    case "cross-session-notice":
      // Same shape an idle relay takes, so the notice reuses the compact row
      // idle notifications already get (operational noise, kawaz r46m6
      // 「でしゃばらせるな」) instead of growing a second one-line layout.
      return {
        display: "peer",
        relays: [
          {
            from: rawText.match(CROSS_SESSION_NOTICE_NAME_RE)?.[1] ?? CROSS_SESSION_NOTICE_FROM,
            summary: null,
            category: "idle",
            body: rawText,
            channel: "cross-session",
          },
        ],
      };
    case "spawn-prompt":
      // spawn prompt は「親から渡された指示書」= 実質 agent message なので、
      // agent message の見た目 (AgentCard) を当てる (kawaz r55m155/156:
      // 「ただの json 展開しかできない item 扱いなのでエージェントメッセージの
      // 見た目を当ててやりましょう」)。カテゴリ分け自体は維持する (同 m156)。
      //
      // team-lead 経由の spawn は本文が <teammate-message ...>...</...> で来る
      // ので parsePeerMessage が from/summary を拾えるが、通常の Agent tool
      // 呼び出しは plain text で wrapper が無い。後者も peer 形へ落として
      // 同じカードに載せる — 送り主は wire 上に無いが、agent 転写の先頭行は
      // 定義上「親セッションからの指示書」なので SPAWN_PROMPT_FROM が唯一の
      // 正しい送り主であり、推測ではない (classifyUserMessage の
      // isSidechain === true && parentUuid === null 判定がこの前提を保証している)。
      return (
        parsePeerMessage(rawText) ?? {
          display: "peer",
          relays: [
            {
              from: SPAWN_PROMPT_FROM,
              summary: null,
              category: "message",
              body: rawText,
              channel: "teammate",
            },
          ],
        }
      );
    case "slash-command-invocation": {
      const fields = extractXmlFields(rawText);
      const command = fields.find((f) => f.name === "command-name")?.value ?? null;
      if (command === null) return { display: "text", text: rawText };
      const detail =
        fields.find((f) => f.name === "command-args")?.value ??
        fields.find((f) => f.name === "command-message")?.value ??
        null;
      return { display: "chip", label: command, detail };
    }
    case "bash-command-invocation": {
      const command = parseBashInputText(rawText);
      if (command === null) return { display: "text", text: rawText };
      return { display: "bash", command, output: null };
    }
    case "bash-command-stdout": {
      const output = parseBashOutputText(rawText);
      if (output === null) return { display: "text", text: rawText };
      return { display: "bash", command: null, output };
    }
    case "slash-command-stdout": {
      const inner = unwrapOuterTag(rawText, "local-command-stdout") ?? rawText;
      return { display: "text", text: stripAnsiEscapes(inner) };
    }
    default:
      return { display: "text", text: rawText };
  }
}

/** Parse one raw jsonl line (as returned by `transcript_read`, DR-0009) into
 * a renderable event. Never throws — a line that does not read as a row
 * becomes `BrokenLine`, a row of a kind not read here becomes `MetaLine`, a
 * block of a kind not read here an `unknown-segment`. */
export function parseTranscriptLine(raw: string): ParsedLine {
  const json = parseWith(JsonTextSchema, raw);
  if (!json.ok) return brokenLine(raw, json.failure);
  const read = parseWith(TranscriptRowSchema, json.value, { firstIssue: true });
  if (!read.ok) return brokenLine(raw, read.failure);
  const row = read.value;
  if (isKnownTranscriptRow(row)) return parseKnownRow(row, raw);
  // A row of a kind not read here keeps its head, read from the same value:
  // the rows that carry a timestamp (`pr-link`, `file-history-delta`, ...)
  // still sit at their time.
  const head = parseWith(TranscriptRowHeadSchema, json.value, { firstIssue: true });
  if (!head.ok) return brokenLine(raw, head.failure);
  return {
    kind: "meta",
    ts: head.value.timestamp ?? null,
    ...linkOf(head.value.uuid, head.value.parentUuid ?? null),
    type: row.type,
    summary: row.type,
    raw,
  };
}

function brokenLine(raw: string, failure: ParseFailure): BrokenLine {
  return { kind: "broken", raw, error: failure.summary };
}

/** The `uuid` / `parentUuid` fields of a line, for a row that carries them. */
function linkOf(
  uuid: string | undefined,
  parentUuid: string | null,
): Pick<TurnLine, "uuid" | "parentUuid"> {
  return {
    ...(uuid !== undefined ? { uuid } : {}),
    ...(parentUuid !== null ? { parentUuid } : {}),
  };
}

function parseKnownRow(row: KnownTranscriptRow, raw: string): ParsedLine {
  switch (row.type) {
    case "user": {
      const userMessageKind = classifyUserMessage(row);
      const content = row.message.content;
      const parsedSegments = parseSegments(content, "user", row.toolUseResult);
      const segments =
        userMessageKind === "slash-command-prompt" && typeof content === "string"
          ? (slashCommandPromptSegments(content) ?? parsedSegments)
          : parsedSegments;
      return {
        kind: "turn",
        ts: row.timestamp,
        ...linkOf(row.uuid, row.parentUuid),
        role: "user",
        segments,
        userMessageKind,
      };
    }
    case "assistant":
      return {
        kind: "turn",
        ts: row.timestamp,
        ...linkOf(row.uuid, row.parentUuid),
        role: "assistant",
        segments: parseSegments(row.message.content, "assistant", undefined),
        assistantMessageKind: classifyAssistantMessage(row),
      };
    case "attachment": {
      // A standalone-ccmsg message that arrived mid-turn is delivered by this
      // attachment row rather than a `type:"user"` one, so it becomes the
      // delivered user turn itself — which also lets `pairQueuedTurns` drop
      // the queue-operation copy against it. `queuedCommandPrompt` takes only
      // a peer's queued command, and a peer's delivery is what a `type:"user"`
      // row says with `promptSource:"system"` + `origin.kind:"peer"`: a
      // peer-message. `rendered` repeats the envelope inside a
      // system-reminder and is not read.
      const queuedPrompt = queuedCommandPrompt(row);
      if (queuedPrompt !== null && mayContainDirectDelivery(queuedPrompt)) {
        return {
          kind: "turn",
          ts: row.timestamp,
          ...linkOf(row.uuid, row.parentUuid),
          role: "user",
          segments: [{ kind: "text", role: "user", text: queuedPrompt }],
          userMessageKind: "peer-message",
        };
      }
      return {
        kind: "meta",
        ts: row.timestamp,
        ...linkOf(row.uuid, row.parentUuid),
        type: row.type,
        summary: row.type,
        raw,
        attachment: attachmentDetail(row.attachment, row.cwd),
      };
    }
    case "queue-operation": {
      // queue-operation enqueue は「作業中に届いたメッセージが queue に積まれた
      // 記録」で、`content` field が queue に積まれた prompt 文字列。この行は
      // promptSource / origin / isMeta といった meta field を一切持たないため、
      // 単独では「人間が queue に積んだ本物の発話」と「ハーネスがシステム由来で
      // 積んだ通知」を wire 上で区別できない。区別できるのは queue から取り出され
      // て実際に配送された `type:"user"` 行の方 (そちらは promptSource:"system" +
      // origin.kind を持つ) なので、両者が揃っている transcript では配送側を正と
      // して queue 側を落とす — `parseTranscriptLines` の cross-line パスが行う。
      // ここでは単独行としての最善 (= 本文 prefix カタログの再利用) を返しつつ、
      // その判断材料を `queuedContent` に残す。
      const content = row.content;
      if (row.operation !== "enqueue" || content === undefined) {
        return {
          kind: "meta",
          ts: row.timestamp,
          type: row.type,
          summary: `${row.type}: ${row.operation}`,
          raw,
        };
      }
      return {
        kind: "turn",
        ts: row.timestamp,
        role: "user",
        segments: slashCommandPromptSegments(content) ?? [
          { kind: "text", role: "user", text: content },
        ],
        userMessageKind: classifyUserText(content, false),
        queuedContent: content,
      };
    }
    case "system":
      return {
        kind: "meta",
        ts: row.timestamp,
        ...linkOf(row.uuid, row.parentUuid),
        type: row.type,
        summary: `${row.type}: ${row.subtype}`,
        raw,
      };
    case "custom-title":
      return { kind: "meta", ts: null, type: row.type, summary: row.type, raw };
  }
}

/** The shape a queued copy and its delivered row are compared as. Identity for
 * every text except a peer relay, which the two copies do not spell the same
 * way: the delivered row adds the banner above and a trailing instruction
 * paragraph below, and the two opening tags carry different attribute sets
 * (a `<cross-session-message>` is queued with a `hop-chain` that the delivered
 * copy drops — measured on CC 2.1.241, bodies byte-identical). Comparing the
 * raw block therefore pairs the in-process relays and misses every
 * cross-session one, showing that message twice.
 *
 * So both sides are keyed on what identifies a relay instead of how it was
 * spelled: sender, summary, and body, per relay, in order. Every relay on the
 * line contributes, so two batches that happen to share a first relay stay
 * distinct.
 *
 * Applied to *both* sides of the comparison (`pairQueuedTurns`) — normalizing
 * only the delivered side would leave the queued raw text unable to match it. */
function queuePairingKey(text: string): string {
  const relays = peerRelayTags(text);
  if (relays.length === 0) return text;
  return relays
    .map(({ tag, attrs, body }) => {
      const relay = parsePeerRelay(tag, attrs, body);
      return [tag, relay.from, relay.summary ?? "", relay.body].join("\u0000");
    })
    .join("\u0000\u0000");
}

/**
 * Parses a whole transcript window, then drops each `queue-operation` enqueue
 * turn whose content is also delivered by a later `type:"user"` row.
 *
 * A queue-operation row records only `{operation, content, timestamp}` — no
 * `promptSource`, `origin`, or `isMeta` — so `classifyUserMessage` sees a
 * bare string and can only fall back to body-prefix matching. That is exactly
 * how a harness notice with no wrapper ("N background agents were stopped by
 * the user: ...") reached the green human bubble: the queued copy had nothing
 * to classify on, while the delivered row right after it carried the decisive
 * `promptSource:"system"` + `origin:{kind:"task-notification"}` and was
 * already folded correctly. Rather than grow the prefix catalog (which
 * guesses at content and mislabels a human who writes the same sentence),
 * this pass keeps the copy that has the metadata and drops the one that
 * doesn't — the same "one event, one rendering" rule `ccmsgDedupKey` applies
 * to doubly-extracted room messages.
 *
 * Only the queued copy is dropped, and only when a matching delivered row
 * actually follows it: a message the user queued and then cancelled (no
 * delivered row — 3649 of 12425 sampled enqueues, e.g. an interrupt that
 * popped the queue) is the sole record of that text and stays rendered.
 */
export function parseTranscriptLines(raws: string[]): ParsedLine[] {
  return pairQueuedTurns(raws.map(parseTranscriptLine), raws);
}

/**
 * The cross-line half of `parseTranscriptLines` (see its doc comment for what
 * the pairing does and why), split out so a caller that parses lines one at a
 * time — useTranscriptModel (components/timeline/) reuses the parse of every line a live-tail append left
 * untouched — can still apply it over the whole window. Pure: `lines` and
 * `raws` are index-aligned inputs, neither is mutated.
 */
export function pairQueuedTurns(
  lines: readonly ParsedLine[],
  raws: readonly string[],
): ParsedLine[] {
  // Delivered bodies -> their line indices, so a queued copy only cancels
  // against a delivery that comes *after* it (the queue row is written when
  // the message arrives, the user row when it is dequeued), and N queued
  // copies of one text can only cancel N deliveries (a prompt genuinely sent
  // twice keeps both copies).
  const delivered = new Map<string, number[]>();
  lines.forEach((line, index) => {
    if (line.kind !== "turn" || line.role !== "user" || line.queuedContent !== undefined) return;
    const text = line.segments
      .filter((s): s is Extract<Segment, { kind: "text" }> => s.kind === "text")
      .map((s) => s.text)
      .join("\n");
    if (text === "") return;
    const key = queuePairingKey(text);
    const indices = delivered.get(key);
    if (indices) indices.push(index);
    else delivered.set(key, [index]);
  });
  if (delivered.size === 0) return lines.slice();
  const consumed = new Set<number>();
  return lines.map((line, index) => {
    if (line.kind !== "turn" || line.queuedContent === undefined) return line;
    const indices = delivered.get(queuePairingKey(line.queuedContent));
    const match = indices?.find((at) => at > index && !consumed.has(at));
    const raw = raws[index];
    if (match === undefined || raw === undefined) return line;
    consumed.add(match);
    // Demoted rather than removed: the array stays index-aligned with the
    // caller's `lineByteOffsets` output (the Timeline components key every entry by its
    // absolute byte offset), and the row lands on the same compact one-line
    // meta rendering every other queue-operation (`dequeue`, `remove`, ...)
    // already gets, instead of a second copy of the delivered turn.
    return {
      kind: "meta",
      ts: line.ts,
      ...(line.uuid ? { uuid: line.uuid } : {}),
      ...(line.parentUuid ? { parentUuid: line.parentUuid } : {}),
      type: "queue-operation",
      summary: "queue-operation: enqueue",
      raw,
    };
  });
}
