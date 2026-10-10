// Builders of Claude Code transcript rows for tests, in the shape Claude Code
// writes them (docs/findings/2026-10-09-transcript-line-readers.md §4): every
// field a row of its kind always carries, a few of the fields ccmsg does not
// read, and nothing a test did not ask for. Each takes the fields to set over
// the defaults, of any kind, so a test of a broken row builds it the same way.
import type { JsonObject, JsonValue } from "../src/json-value.ts";

export const ROW_SESSION_ID = "11111111-2222-4333-8444-555555555555";
export const ROW_CWD = "/work/repo";
export const ROW_TIMESTAMP = "2026-10-09T01:02:03.456Z";

/** A row as one transcript line. */
export function line(row: JsonValue): string {
  return JSON.stringify(row);
}

/** What every row of a turn (user, assistant, attachment, system) carries
 * besides its own fields. */
function turnHead(uuid: string): JsonObject {
  return {
    uuid,
    parentUuid: "00000000-0000-4000-8000-000000000000",
    timestamp: ROW_TIMESTAMP,
    cwd: ROW_CWD,
    isSidechain: false,
    sessionId: ROW_SESSION_ID,
    version: "2.1.295",
    userType: "external",
    gitBranch: "main",
  };
}

export function userRow(fields: JsonObject = {}): JsonObject {
  return {
    type: "user",
    ...turnHead("00000000-0000-4000-8000-000000000001"),
    promptId: "00000000-0000-4000-8000-0000000000aa",
    message: { role: "user", content: "hello" },
    ...fields,
  };
}

/** A user row whose message is `content` (text, or blocks). */
export function userContentRow(content: JsonValue, fields: JsonObject = {}): JsonObject {
  return userRow({ message: { role: "user", content }, ...fields });
}

/** An assistant's message: one text block by default, with the usage of one
 * request. */
export function assistantMessage(fields: JsonObject = {}): JsonObject {
  return {
    id: "msg_0001",
    type: "message",
    role: "assistant",
    model: "claude-opus-5-5",
    content: [textBlock("hi")],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 10,
      cache_creation_input_tokens: 20,
      cache_read_input_tokens: 30,
      output_tokens: 40,
      cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 20 },
      service_tier: "standard",
    },
    ...fields,
  };
}

export function assistantRow(fields: JsonObject = {}): JsonObject {
  return {
    type: "assistant",
    ...turnHead("00000000-0000-4000-8000-000000000002"),
    requestId: "req_0001",
    effort: "high",
    message: assistantMessage(),
    ...fields,
  };
}

/** An assistant row whose message holds `content`. */
export function assistantContentRow(content: JsonValue, fields: JsonObject = {}): JsonObject {
  return assistantRow({ message: assistantMessage({ content }), ...fields });
}

export function attachmentRow(attachment: JsonObject, fields: JsonObject = {}): JsonObject {
  return {
    type: "attachment",
    ...turnHead("00000000-0000-4000-8000-000000000003"),
    attachment,
    ...fields,
  };
}

export function queueOperationRow(fields: JsonObject = {}): JsonObject {
  return {
    type: "queue-operation",
    operation: "enqueue",
    timestamp: ROW_TIMESTAMP,
    sessionId: ROW_SESSION_ID,
    content: "queued prompt",
    ...fields,
  };
}

export function systemRow(fields: JsonObject = {}): JsonObject {
  return {
    type: "system",
    ...turnHead("00000000-0000-4000-8000-000000000004"),
    subtype: "turn_duration",
    durationMs: 1234,
    isMeta: false,
    ...fields,
  };
}

export function customTitleRow(fields: JsonObject = {}): JsonObject {
  return { type: "custom-title", customTitle: "a title", sessionId: ROW_SESSION_ID, ...fields };
}

/** A metadata row of a kind ccmsg does not read (`ai-title`, `last-prompt`,
 * `mode`, ...): its type, the session, and its own fields. */
export function metadataRow(type: string, fields: JsonObject = {}): JsonObject {
  return { type, sessionId: ROW_SESSION_ID, ...fields };
}

export function textBlock(text: string): JsonObject {
  return { type: "text", text };
}

export function thinkingBlock(thinking: string): JsonObject {
  return { type: "thinking", thinking, signature: "sig" };
}

export function imageBlock(): JsonObject {
  return { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } };
}

export function toolUseBlock(name: string, input: JsonObject, id = "toolu_0001"): JsonObject {
  return { type: "tool_use", id, name, input, caller: { type: "direct" } };
}

export function toolResultBlock(content: JsonValue, fields: JsonObject = {}): JsonObject {
  return { type: "tool_result", tool_use_id: "toolu_0001", content, ...fields };
}
