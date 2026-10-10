// Claude Code's transcript rows as their schemas read them (DR-0038 §3): the
// rows Claude Code writes read, a row of a known kind in a wrong shape fails,
// a kind not known yet reads as other, a projection reads its fields
// whatever the rest of the row holds, and a Read's result reads by its kind.
import { describe, expect, test } from "bun:test";
import type { JsonObject, JsonValue } from "../src/json-value.ts";
import { type Parsed, parseWith } from "../src/parse.ts";
import { isKnownAttachment } from "../src/transcript-attachment.ts";
import {
  isKnownContentBlock,
  isKnownToolResultContentBlock,
  isKnownToolUse,
  type ToolUse,
  ToolUseSchema,
} from "../src/transcript-content.ts";
import {
  isKnownTranscriptRow,
  type TranscriptRow,
  TranscriptRowCwdLineSchema,
  TranscriptRowLineSchema,
  TranscriptRowTimestampLineSchema,
  TranscriptRowUuidLineSchema,
} from "../src/transcript-row.ts";
import { isKnownReadResult, ReadToolResultSchema } from "../src/transcript-tool-result.ts";
import {
  assistantContentRow,
  assistantMessage,
  assistantRow,
  attachmentRow,
  customTitleRow,
  imageBlock,
  line,
  metadataRow,
  queueOperationRow,
  systemRow,
  textBlock,
  thinkingBlock,
  toolResultBlock,
  toolUseBlock,
  userContentRow,
  userRow,
} from "./transcript-rows.ts";

function readRow(row: JsonObject): TranscriptRow {
  const read = parseWith(TranscriptRowLineSchema, line(row));
  if (!read.ok) throw new Error(read.failure.summary);
  return read.value;
}

/** What a reader takes from a row, by its kind: a known row narrows by its
 * `type`, and its blocks and attachment by theirs. */
function describeRow(row: TranscriptRow): string {
  if (!isKnownTranscriptRow(row)) return `other ${row.type}`;
  switch (row.type) {
    case "user": {
      const content = row.message.content;
      if (typeof content === "string") return `user text ${content}`;
      return `user ${content.map((block) => (isKnownContentBlock(block) ? block.type : `other ${block.type}`)).join(",")}`;
    }
    case "assistant":
      return `assistant ${row.message.content
        .map((block) => (isKnownContentBlock(block) ? block.type : `other ${block.type}`))
        .join(",")}`;
    case "attachment": {
      const attachment = row.attachment;
      if (!isKnownAttachment(attachment)) return `attachment other ${attachment.type}`;
      switch (attachment.type) {
        case "queued_command":
          return `queued ${typeof attachment.prompt === "string" ? attachment.prompt : "blocks"}`;
        case "task_reminder":
          return `tasks ${attachment.content.map((item) => item.subject).join(",")}`;
        case "edited_text_file":
        case "file":
          return `file ${attachment.filename}`;
        case "hook_success":
        case "hook_additional_context":
          return `hook ${attachment.hookName}`;
      }
      return "";
    }
    case "queue-operation":
      return `queue ${row.operation}`;
    case "system":
      return `system ${row.subtype}`;
    case "custom-title":
      return `title ${row.customTitle}`;
  }
}

describe("the rows Claude Code writes read", () => {
  test("a user's prompt, as text", () => {
    expect(describeRow(readRow(userRow()))).toBe("user text hello");
  });

  test("the first row of a session, with no parent", () => {
    expect(readRow(userRow({ parentUuid: null }))).toMatchObject({ parentUuid: null });
  });

  test("a tool's result, with the result as JSON whatever its shape", () => {
    for (const toolUseResult of [
      { stdout: "ok", stderr: "", interrupted: false },
      "Error: the tool failed",
      [{ type: "text", text: "x" }],
    ]) {
      const row = readRow(
        userContentRow([toolResultBlock("ok", { is_error: false })], { toolUseResult }),
      );
      expect(describeRow(row)).toBe("user tool_result");
      expect(row).toMatchObject({ toolUseResult });
    }
  });

  test("a tool's result as blocks, an image among them", () => {
    const row = readRow(
      userContentRow([
        toolResultBlock([
          textBlock("see"),
          imageBlock(),
          { type: "tool_reference", tool_name: "Read" },
        ]),
      ]),
    );
    if (!isKnownTranscriptRow(row) || row.type !== "user") throw new Error("not a user row");
    const content = row.message.content;
    if (typeof content === "string") throw new Error("not blocks");
    const [block] = content;
    if (block === undefined || !isKnownContentBlock(block) || block.type !== "tool_result") {
      throw new Error("not a tool result");
    }
    if (typeof block.content === "string") throw new Error("not blocks");
    expect(
      block.content.map((part) =>
        isKnownToolResultContentBlock(part) ? part.type : `other ${part.type}`,
      ),
    ).toEqual(["text", "image", "other tool_reference"]);
  });

  test("a turn delivered from elsewhere, with its origin", () => {
    expect(
      readRow(
        userRow({ isMeta: true, promptSource: "system", origin: { kind: "peer", from: "x" } }),
      ),
    ).toMatchObject({ origin: { kind: "peer", from: "x" }, promptSource: "system" });
  });

  test("an assistant's turn: thinking, text and a tool call", () => {
    expect(
      describeRow(
        readRow(
          assistantContentRow([
            thinkingBlock("hm"),
            textBlock("hi"),
            toolUseBlock("Bash", { command: "ls" }),
          ]),
        ),
      ),
    ).toBe("assistant thinking,text,tool_use");
  });

  test("an API error Claude Code wrote itself", () => {
    const row = assistantRow({
      isApiErrorMessage: true,
      error: "rate_limit",
      message: assistantMessage({ model: "<synthetic>" }),
    });
    expect(readRow(row)).toMatchObject({
      isApiErrorMessage: true,
      message: { model: "<synthetic>" },
    });
  });

  test("the attachments ccmsg reads", () => {
    const cases: [JsonObject, string][] = [
      [
        {
          type: "queued_command",
          prompt: "later",
          commandMode: "prompt",
          origin: { kind: "human" },
        },
        "queued later",
      ],
      [{ type: "queued_command", prompt: [textBlock("look"), imageBlock()] }, "queued blocks"],
      [
        {
          type: "task_reminder",
          itemCount: 1,
          content: [
            {
              id: "1",
              subject: "do it",
              description: "",
              status: "pending",
              blocks: [],
              blockedBy: [],
            },
          ],
        },
        "tasks do it",
      ],
      [
        { type: "edited_text_file", filename: "/work/repo/a.ts", snippet: "1\tx" },
        "file /work/repo/a.ts",
      ],
      [
        {
          type: "file",
          filename: "/work/repo/b.md",
          displayPath: "b.md",
          content: {
            type: "text",
            file: {
              filePath: "/work/repo/b.md",
              content: "x",
              numLines: 1,
              startLine: 1,
              totalLines: 1,
            },
          },
        },
        "file /work/repo/b.md",
      ],
      [
        {
          type: "hook_success",
          hookName: "SessionStart:startup",
          hookEvent: "SessionStart",
          toolUseID: "t",
          content: "",
          command: "hook.sh",
          exitCode: 0,
          durationMs: 5,
          stdout: "",
          stderr: "",
        },
        "hook SessionStart:startup",
      ],
      [
        {
          type: "hook_additional_context",
          hookName: "PostToolUse:Bash",
          hookEvent: "PostToolUse",
          toolUseID: "t",
          content: ["note"],
        },
        "hook PostToolUse:Bash",
      ],
    ];
    for (const [attachment, said] of cases) {
      expect(describeRow(readRow(attachmentRow(attachment)))).toBe(said);
    }
  });

  test("a queue operation: no uuid, parent, cwd or sidechain flag, content only when queued", () => {
    expect(describeRow(readRow(queueOperationRow()))).toBe("queue enqueue");
    expect(
      describeRow(readRow({ type: "queue-operation", operation: "dequeue", timestamp: "t" })),
    ).toBe("queue dequeue");
  });

  test("a system row", () => {
    expect(describeRow(readRow(systemRow()))).toBe("system turn_duration");
  });

  test("a custom title: no timestamp, no uuid", () => {
    expect(describeRow(readRow(customTitleRow()))).toBe("title a title");
  });

  test("a field ccmsg does not read is kept", () => {
    expect(readRow(userRow({ entrypoint: "cli" }))).toMatchObject({ entrypoint: "cli" });
  });
});

describe("a kind not known yet reads as other, its fields as they are", () => {
  test("a metadata row", () => {
    for (const [type, fields] of [
      ["ai-title", { aiTitle: "t" }],
      ["last-prompt", { lastPrompt: "p", leafUuid: "u" }],
      ["a-kind-from-a-later-version", { nested: { a: [1, null] } }],
    ] as const) {
      const row = metadataRow(type, fields);
      const read = readRow(row);
      expect(describeRow(read)).toBe(`other ${type}`);
      expect(JSON.stringify(read)).toBe(line(row));
    }
  });

  test("a content block", () => {
    const row = assistantContentRow([
      { type: "server_tool_use", id: "s", name: "web_search", input: {} },
    ]);
    expect(describeRow(readRow(row))).toBe("assistant other server_tool_use");
  });

  test("an attachment", () => {
    expect(
      describeRow(readRow(attachmentRow({ type: "deferred_tools_record", entries: [] }))),
    ).toBe("attachment other deferred_tools_record");
  });
});

describe("a row of a known kind in a wrong shape fails, rather than reading as other", () => {
  const without = (row: JsonObject, field: string): JsonObject =>
    Object.fromEntries(Object.entries(row).filter(([name]) => name !== field));
  for (const [name, row] of [
    ["a user row with no message", without(userRow(), "message")],
    ["a user row with no timestamp", without(userRow(), "timestamp")],
    ["a user row with no sidechain flag", without(userRow(), "isSidechain")],
    ["a user row with an empty uuid", userRow({ uuid: "" })],
    ["a user row whose content is a number", userContentRow(1)],
    ["a user row whose parent is a number", userRow({ parentUuid: 1 })],
    ["an assistant row whose content is text", assistantContentRow("hi")],
    [
      "an assistant row with no usage",
      assistantRow({ message: without(assistantMessage(), "usage") }),
    ],
    [
      "a tool call with no id",
      assistantContentRow([{ type: "tool_use", name: "Bash", input: {} }]),
    ],
    [
      "a tool call whose input is not an object",
      assistantContentRow([
        toolUseBlock("Bash", {}),
        { type: "tool_use", id: "t", name: "Bash", input: "ls" },
      ]),
    ],
    ["a tool result whose content is a number", userContentRow([toolResultBlock(1)])],
    [
      "a queued command whose prompt is a number",
      attachmentRow({ type: "queued_command", prompt: 1 }),
    ],
    [
      "a task reminder item with no subject",
      attachmentRow({
        type: "task_reminder",
        content: [{ id: "1", status: "pending", blocks: [], blockedBy: [] }],
      }),
    ],
    ["a queue operation with no timestamp", without(queueOperationRow(), "timestamp")],
    ["a custom title that is not text", customTitleRow({ customTitle: 1 })],
    ["a system row with no subtype", without(systemRow(), "subtype")],
    ["a row with no type", without(userRow(), "type")],
  ] as const) {
    test(name, () => {
      expect(parseWith(TranscriptRowLineSchema, line(row)).ok).toBe(false);
    });
  }

  test("a row that is not an object, and text that is not JSON", () => {
    expect(parseWith(TranscriptRowLineSchema, line([userRow()])).ok).toBe(false);
    expect(parseWith(TranscriptRowLineSchema, '{"type":"user",').ok).toBe(false);
  });
});

describe("a projection reads its fields whatever the rest of the row holds", () => {
  const broken = userRow({ message: 1, isSidechain: "no" });

  test("the uuid", () => {
    expect(parseWith(TranscriptRowUuidLineSchema, line(broken))).toMatchObject({
      ok: true,
      value: { uuid: "00000000-0000-4000-8000-000000000001" },
    });
    const queued = parseWith(TranscriptRowUuidLineSchema, line(queueOperationRow()));
    expect(queued.ok ? queued.value.uuid : "failed").toBeUndefined();
    expect(parseWith(TranscriptRowUuidLineSchema, line(userRow({ uuid: "" }))).ok).toBe(false);
  });

  test("the cwd", () => {
    expect(parseWith(TranscriptRowCwdLineSchema, line({ ...broken, timestamp: 1 }))).toMatchObject({
      ok: true,
      value: { cwd: "/work/repo" },
    });
    expect(parseWith(TranscriptRowCwdLineSchema, line({ ...broken, cwd: 1 })).ok).toBe(false);
  });

  test("the timestamp", () => {
    expect(parseWith(TranscriptRowTimestampLineSchema, line({ ...broken, cwd: 1 }))).toMatchObject({
      ok: true,
      value: { timestamp: "2026-10-09T01:02:03.456Z" },
    });
    const title = parseWith(TranscriptRowTimestampLineSchema, line(customTitleRow()));
    expect(title.ok ? title.value.timestamp : "failed").toBeUndefined();
  });
});

describe("a tool call is read by its tool, apart from its row", () => {
  const readCall = (name: string, input: JsonObject): Parsed<ToolUse> =>
    parseWith(ToolUseSchema, toolUseBlock(name, input));

  const describeCall = (call: ToolUse): string => {
    if (!isKnownToolUse(call)) return `other ${call.name}`;
    switch (call.name) {
      case "Bash":
        return `bash ${call.input.command}`;
      case "SendMessage":
        return `send ${call.input.to} ${typeof call.input.message === "string" ? call.input.message : "structured"}`;
      default:
        return call.name;
    }
  };

  test("a known tool's input", () => {
    const call = readCall("Bash", { command: "ls", description: "list", run_in_background: false });
    expect(call.ok && describeCall(call.value)).toBe("bash ls");
    const send = readCall("SendMessage", { to: "main", message: { type: "shutdown_request" } });
    expect(send.ok && describeCall(send.value)).toBe("send main structured");
  });

  test("a tool not known here, its input as JSON", () => {
    const call = readCall("Grep", { pattern: "x", path: "/work" });
    expect(call.ok && describeCall(call.value)).toBe("other Grep");
    expect(call).toMatchObject({ value: { input: { pattern: "x", path: "/work" } } });
  });

  test("an input that does not fit its tool fails that call, not its row", () => {
    // Claude Code keeps an input the model wrote as broken JSON under
    // `__unparsedToolInput`, and a number the model wrote as text as text.
    for (const [name, input] of [
      ["Edit", { __unparsedToolInput: { raw: '{"file_path": "/a' } }],
      ["Read", { file_path: "/a", offset: "1, 200" }],
      ["TaskUpdate", { task_id: "1", status: "completed" }],
    ] as const) {
      expect(readCall(name, input).ok).toBe(false);
      expect(
        describeRow(readRow(assistantContentRow([textBlock("x"), toolUseBlock(name, input)]))),
      ).toBe("assistant text,tool_use");
    }
  });
});

describe("a Read's result is read by its kind", () => {
  const readResult = (value: JsonValue): string => {
    const read = parseWith(ReadToolResultSchema, value);
    if (!read.ok) return "fails";
    const result = read.value;
    if (typeof result === "string") return `error ${result}`;
    if (!isKnownReadResult(result)) return `other ${result.type}`;
    switch (result.type) {
      case "text":
        return `text ${result.file.content}`;
      case "image":
        return `image ${result.file.type} ${result.file.dimensions?.displayWidth ?? "unsized"}`;
    }
  };

  test("text, an image with or without its size, a kind not known here, and a failed call", () => {
    expect(
      readResult({ type: "text", file: { filePath: "/a", content: "x\n", startLine: 1 } }),
    ).toBe("text x\n");
    const dimensions = {
      originalWidth: 1776,
      originalHeight: 287,
      displayWidth: 888,
      displayHeight: 143,
    };
    expect(
      readResult({ type: "image", file: { base64: "iVBOR", type: "image/png", dimensions } }),
    ).toBe("image image/png 888");
    expect(readResult({ type: "image", file: { base64: "iVBOR", type: "image/png" } })).toBe(
      "image image/png unsized",
    );
    expect(readResult({ type: "file_unchanged", file: { filePath: "/a" } })).toBe(
      "other file_unchanged",
    );
    expect(readResult("File does not exist.")).toBe("error File does not exist.");
  });

  test("a result of a known kind in a wrong shape fails", () => {
    expect(readResult({ type: "text", file: { filePath: "/a" } })).toBe("fails");
    expect(readResult({ type: "image", file: { type: "image/png" } })).toBe("fails");
  });
});
