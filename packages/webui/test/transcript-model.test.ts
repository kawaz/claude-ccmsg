// transcript-model unit tests (DR-0009): guards the pure jsonl-line -> render
// event fold that Timeline.tsx's effect calls into. Line shapes below mirror
// what a real Claude Code transcript jsonl contains (checked against a live
// personal-project transcript during implementation), not a guess — but per
// DR-0009's "jsonl フォーマットの安定性" note, the module must never assume
// only these shapes exist, hence the explicit unknown-type/unknown-segment
// coverage.
import { describe, expect, test } from "bun:test";
import {
  ccmsgDedupKey,
  classifyBoundaryLine,
  classifyUserMessage,
  extractCcmsgMessages,
  extractCcmsgToolResultRefs,
  foldGroupLabel,
  foldGroupNeedsOuterFold,
  splitFoldSubgroups,
  groupTimelineLines,
  isAgentCommunicationSegment,
  isPeerMessageLine,
  isSearchableSegment,
  isUserTextTurn,
  lineByteOffsets,
  parseSystemMessageFields,
  parseTranscriptLine,
  resolveFileToolResults,
  scrollPositionToUserTurnIndex,
  segmentSearchText,
  userNavTargets,
  stripAnsiEscapes,
  type CcmsgMessage,
  type ParsedLine,
  type Segment,
  type TimelineEntry,
} from "../src/client/transcript-model.ts";

// Terse ParsedLine builders for groupTimelineLines/foldGroupLabel tests below
// — these tests care about kind/role/segment shape, not the full jsonl
// round trip already covered by the parseTranscriptLine describe blocks
// above, so hand-constructing ParsedLine values keeps each case to one line.
function userText(text: string): ParsedLine {
  return { kind: "turn", ts: null, role: "user", segments: [{ kind: "text", role: "user", text }] };
}
function userToolResult(toolUseId: string): ParsedLine {
  return {
    kind: "turn",
    ts: null,
    role: "user",
    segments: [{ kind: "tool-result", toolUseId, isError: false, text: "ok" }],
  };
}
function assistantThinking(text: string): ParsedLine {
  return { kind: "turn", ts: null, role: "assistant", segments: [{ kind: "thinking", text }] };
}
function assistantToolUse(name: string): ParsedLine {
  return {
    kind: "turn",
    ts: null,
    role: "assistant",
    segments: [{ kind: "tool-use", name, input: {} }],
  };
}
function assistantText(text: string): ParsedLine {
  return {
    kind: "turn",
    ts: null,
    role: "assistant",
    segments: [{ kind: "text", role: "assistant", text }],
  };
}
function metaLine(type: string): ParsedLine {
  return { kind: "meta", ts: null, type, summary: type, raw: "{}" };
}

// lineByteOffsets (DR-0009 addendum): Timeline.tsx's Preact `key`s. The whole
// point is stability across a "load older" prepend — see the two-part test
// below.
describe("lineByteOffsets", () => {
  // Each line consumes byteLength(line) + 1 (its own stripped \n) bytes.
  test("累積で各行の絶対バイトオフセットを返す (ASCII)", () => {
    expect(lineByteOffsets(100, ["ab", "cde"])).toEqual([100, 103]); // 100, 100+(2+1)
  });

  test("空配列は空配列", () => {
    expect(lineByteOffsets(42, [])).toEqual([]);
  });

  // UTF-8 マルチバイト文字はバイト長 (文字数ではなく) で加算される: "あ" は
  // 3 バイト。charCount ベースで計算すると壊れる境界。
  test("マルチバイト文字はバイト長で加算される (文字数ではない)", () => {
    expect(lineByteOffsets(0, ["あ", "b"])).toEqual([0, 4]); // 0, 0+(3+1)
  });

  // 核心の不変条件: "older を読み込む" (prepend) で新しい行が前に足され、
  // `start` がその分小さくなっても、*既に表示済みだった行*の絶対オフセットは
  // 変わらない — これが Preact key として安定する理由そのもの。変わって
  // しまうと、開いていた <details> fold が別の行に飛ぶ (レビュー指摘の再現)。
  test("prepend 後も既存行のオフセットは不変 (安定 key の根拠)", () => {
    const before = lineByteOffsets(10, ["x", "yz"]);
    expect(before).toEqual([10, 12]); // 10, 10+(1+1)

    // "older" page prepends one line ("prefixLine", 10 bytes + \n = 11) and
    // start moves back by exactly that many bytes (no gap, no overlap —
    // mirrors transcript_read's adjacent-page invariant, DR-0009 §3).
    const prefixLine = "prefixLine";
    const newStart = 10 - (prefixLine.length + 1);
    const after = lineByteOffsets(newStart, [prefixLine, "x", "yz"]);

    // The prepended line gets a new offset, but "x" and "yz" keep the exact
    // offsets they had before the prepend.
    expect(after[1]).toBe(before[0]);
    expect(after[2]).toBe(before[1]);
  });
});

describe("parseTranscriptLine / user turns", () => {
  // Plain human input: message.content is a bare string (the common case).
  test("string content -> a single user text segment", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        timestamp: "2026-07-10T12:34:56.000Z",
        message: { role: "user", content: "hello" },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.role).toBe("user");
    expect(line.ts).toBe("2026-07-10T12:34:56.000Z");
    expect(line.segments).toEqual([{ kind: "text", role: "user", text: "hello" }]);
  });

  // Automatic tool-result turn: Claude Code wraps tool_result blocks in a
  // "user"-typed line (Anthropic API convention), so a tool_result segment
  // must be recognized here, not only under "assistant".
  test("content array with a tool_result block -> a tool-result segment (not rendered as user prose)", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        timestamp: "t",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42 files" }],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.segments).toEqual([
      { kind: "tool-result", toolUseId: "tu_1", isError: false, text: "42 files" },
    ]);
  });

  // is_error flag must survive into the segment so the UI can flag it.
  test("tool_result with is_error:true -> isError true", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_2", is_error: true, content: "boom" }],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    const seg = line.segments[0] as Extract<Segment, { kind: "tool-result" }>;
    expect(seg.isError).toBe(true);
  });

  // tool_result.content can itself be an array of blocks (observed in a real
  // transcript) rather than a plain string — contentToText must fold it to
  // text instead of leaving it unrendered or throwing.
  test("tool_result.content as an array of {type:'text'} blocks folds to joined text", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_3",
              content: [{ type: "text", text: "line one" }],
            },
          ],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    const seg = line.segments[0] as Extract<Segment, { kind: "tool-result" }>;
    expect(seg.text).toBe("line one");
  });

  // Empty string content (e.g. a degenerate/blank human turn) folds to zero
  // segments rather than a segment with empty text — nothing to render.
  test("empty string content -> no segments", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "" } }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.segments).toEqual([]);
  });
});

describe("parseTranscriptLine / assistant turns", () => {
  // The three content-block kinds Claude Code emits in an assistant turn
  // (text/thinking/tool_use), together, in the order the API returns them.
  test("SendMessage tool_use normalizes current and legacy field names", () => {
    const current = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "SendMessage",
              input: { to: "reviewer", summary: "確認依頼", message: "見てください" },
            },
          ],
        },
      }),
    );
    expect(current.kind === "turn" ? current.segments[0] : null).toEqual({
      kind: "agent-send",
      to: "reviewer",
      summary: "確認依頼",
      message: "見てください",
      messageType: "message",
    });

    const legacy = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "SendMessage",
              input: { recipient: "worker", content: "進めて", type: "message" },
            },
          ],
        },
      }),
    );
    expect(legacy.kind === "turn" ? legacy.segments[0] : null).toEqual({
      kind: "agent-send",
      to: "worker",
      summary: null,
      message: "進めて",
      messageType: "message",
    });
  });

  test("Read/Write/Edit tool_use blocks normalize to dedicated file segments", () => {
    const parse = (name: string, input: Record<string, unknown>, id = "tu_file") =>
      parseTranscriptLine(
        JSON.stringify({
          type: "assistant",
          message: { content: [{ type: "tool_use", id, name, input }] },
        }),
      );
    const read = parse("Read", { file_path: "/x/a.ts", offset: 9, limit: 3 });
    expect(read.kind === "turn" ? read.segments[0] : null).toEqual({
      kind: "file-read",
      toolUseId: "tu_file",
      path: "/x/a.ts",
      offset: 9,
      limit: 3,
      content: null,
    });
    const write = parse("Write", { file_path: "/x/a.ts", content: "new\n" });
    expect(write.kind === "turn" ? write.segments[0] : null).toEqual({
      kind: "file-write",
      path: "/x/a.ts",
      content: "new\n",
    });
    const edit = parse("Edit", {
      file_path: "/x/a.ts",
      old_string: "old",
      new_string: "new",
    });
    expect(edit.kind === "turn" ? edit.segments[0] : null).toEqual({
      kind: "file-edit",
      path: "/x/a.ts",
      oldString: "old",
      newString: "new",
    });
  });

  test("Read tool_result snapshot joins its tool_use and is omitted from groups", () => {
    const use = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_read", name: "Read", input: { file_path: "a.ts" } },
          ],
        },
      }),
    );
    const result = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_read", content: "1\\talpha" }],
        },
        toolUseResult: { type: "text", file: { filePath: "a.ts", content: "alpha\n" } },
      }),
    );
    const resolved = resolveFileToolResults([use, result]);
    expect(resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null).toEqual({
      kind: "file-read",
      toolUseId: "tu_read",
      path: "a.ts",
      offset: null,
      limit: null,
      content: "alpha\n",
    });
    expect(groupTimelineLines(resolved, [10, 20])).toEqual([
      { kind: "fold", entries: [{ offset: 10, line: resolved[0] }] },
    ]);
  });

  test("foreground Bash joins command and result into one rendered entry", () => {
    const use = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_bash",
              name: "Bash",
              input: { command: "printf ok", description: "Print result" },
            },
          ],
        },
      }),
    );
    const result = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [{ type: "tool_result", tool_use_id: "tu_bash", content: "ok" }],
        },
      }),
    );
    const resolved = resolveFileToolResults([use, result]);
    expect(resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null).toEqual({
      kind: "bash-use",
      toolUseId: "tu_bash",
      command: "printf ok",
      description: "Print result",
      background: false,
      result: { text: "ok", isError: false },
      hasResult: true,
    });
    expect(resolved[1]?.kind === "turn" ? resolved[1].segments[0] : null).toEqual({
      kind: "bash-result",
      toolUseId: "tu_bash",
      text: "ok",
      isError: false,
      background: false,
      hasCommand: true,
    });
    expect(groupTimelineLines(resolved, [10, 20])).toEqual([
      { kind: "fold", entries: [{ offset: 10, line: resolved[0] }] },
    ]);
  });

  test("background Bash keeps result visible and links both sides by tool id", () => {
    const use = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_bg",
              name: "Bash",
              input: { command: "long-job", run_in_background: true },
            },
          ],
        },
      }),
    );
    const result = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            { type: "tool_result", tool_use_id: "tu_bg", is_error: true, content: "failed" },
          ],
        },
      }),
    );
    const resolved = resolveFileToolResults([use, result]);
    expect(resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null).toMatchObject({
      kind: "bash-use",
      background: true,
      hasResult: true,
    });
    expect(resolved[1]?.kind === "turn" ? resolved[1].segments[0] : null).toEqual({
      kind: "bash-result",
      toolUseId: "tu_bg",
      text: "failed",
      isError: true,
      background: true,
      hasCommand: true,
    });
    expect(groupTimelineLines(resolved, [10, 20])).toEqual([
      {
        kind: "fold",
        entries: [
          { offset: 10, line: resolved[0] },
          { offset: 20, line: resolved[1] },
        ],
      },
    ]);
  });

  test("Bash without a loaded result remains a command card with no result", () => {
    const use = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tu_pending", name: "Bash", input: { command: "job" } },
          ],
        },
      }),
    );
    const resolved = resolveFileToolResults([use]);
    expect(resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null).toMatchObject({
      kind: "bash-use",
      result: null,
      hasResult: false,
    });
  });

  test("Agent tool_use extracts identity, type, prompt, and background state", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Agent",
              input: {
                name: "audit",
                subagent_type: "Explore",
                description: "構造調査",
                prompt: "対象を読んで報告",
                run_in_background: true,
              },
            },
          ],
        },
      }),
    );
    expect(line.kind === "turn" ? line.segments[0] : null).toEqual({
      kind: "agent-spawn",
      name: "audit",
      agentType: "Explore",
      model: "",
      description: "構造調査",
      prompt: "対象を読んで報告",
      background: true,
    });
  });

  test("text + thinking + tool_use blocks fold to matching segments in order", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "let me check", signature: "sig" },
            { type: "tool_use", id: "tu_1", name: "Bash", input: { command: "ls" } },
            { type: "text", text: "done" },
          ],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.role).toBe("assistant");
    expect(line.segments).toEqual([
      { kind: "thinking", text: "let me check" },
      {
        kind: "bash-use",
        toolUseId: "tu_1",
        command: "ls",
        description: "",
        background: false,
        result: null,
        hasResult: false,
      },
      { kind: "text", role: "assistant", text: "done" },
    ]);
  });
});

describe("parseTranscriptLine / meta lines (non-turn types)", () => {
  // A type with an `operation` field (queue-operation, observed in a real
  // transcript): summary should surface it without a per-type whitelist.
  test("queue-operation folds to a one-line summary including the operation", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "queue-operation", operation: "dequeue", timestamp: "t" }),
    );
    expect(line.kind).toBe("meta");
    if (line.kind !== "meta") return;
    expect(line.type).toBe("queue-operation");
    expect(line.summary).toBe("queue-operation: dequeue");
    expect(line.ts).toBe("t");
  });

  // Regression fixture reduced from the reported transcript line 1065. While
  // the main session was busy, the direct <agent-message> relay first appeared
  // as queue-operation enqueue; it must reuse normal user-message classification
  // instead of becoming a human user-prompt boundary and green bubble.
  test("queue-operation enqueue with a bare agent relay -> peer-message and folded", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "2026-07-16T18:28:50.000Z",
        content:
          '<agent-message from="general-purpose">\nRead-only audit found 2 Major candidates: (1) ...\n</agent-message>',
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("peer-message");
    expect(isUserTextTurn(line)).toBe(false);
    expect(classifyBoundaryLine(line)).toBeNull();
    expect(groupTimelineLines([line], [1065])).toEqual([
      { kind: "fold", entries: [{ offset: 1065, line }] },
    ]);
  });

  // A type with a `subtype` field but no `timestamp` (file-history-snapshot,
  // observed in a real transcript): ts must gracefully fall back to null
  // rather than throwing on the missing field.
  test("a type with no timestamp field -> ts null, no throw", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "file-history-snapshot", isSnapshotUpdate: true, snapshot: {} }),
    );
    expect(line.kind).toBe("meta");
    if (line.kind !== "meta") return;
    expect(line.ts).toBeNull();
    expect(line.summary).toBe("file-history-snapshot");
  });

  // Design rationale under test: a top-level `type` this module has never
  // been told about (no whitelist entry) must still degrade to the exact
  // same MetaLine shape — proving "known other type" and "unknown type" are
  // one code path, not two, per the module's doc comment.
  test("a completely unseen/future type still folds to a MetaLine with a safe summary, no throw", () => {
    const raw = JSON.stringify({
      type: "some-future-type-nobody-has-seen-yet",
      subtype: "novel",
      timestamp: "t",
    });
    expect(() => parseTranscriptLine(raw)).not.toThrow();
    const line = parseTranscriptLine(raw);
    expect(line.kind).toBe("meta");
    if (line.kind !== "meta") return;
    expect(line.type).toBe("some-future-type-nobody-has-seen-yet");
    expect(line.summary).toBe("some-future-type-nobody-has-seen-yet: novel");
    expect(line.raw).toBe(raw); // raw JSON preserved verbatim for the UI's expand-to-raw fallback
  });

  // A future content-block `type` inside a turn (not a top-level type) must
  // fall back the same way, one level down — proves the "unknown-segment"
  // path independent of the top-level MetaLine path.
  test("an unrecognized content-block type inside a turn folds to unknown-segment, not dropped", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "brand_new_block_kind", foo: "bar" }] },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.segments).toEqual([
      {
        kind: "unknown-segment",
        type: "brand_new_block_kind",
        raw: { type: "brand_new_block_kind", foo: "bar" },
      },
    ]);
  });
});

describe("parseTranscriptLine / broken lines", () => {
  test("invalid JSON -> broken, raw text preserved, no throw", () => {
    const raw = "{not json";
    expect(() => parseTranscriptLine(raw)).not.toThrow();
    const line = parseTranscriptLine(raw);
    expect(line.kind).toBe("broken");
    if (line.kind !== "broken") return;
    expect(line.raw).toBe(raw);
    expect(line.error.length).toBeGreaterThan(0);
  });

  // Empty line: JSON.parse("") throws, same as any other malformed input —
  // this is the "空" (empty) case Timeline must render without crashing.
  test("empty string line -> broken, not a crash", () => {
    expect(() => parseTranscriptLine("")).not.toThrow();
    expect(parseTranscriptLine("").kind).toBe("broken");
  });

  // Valid JSON that isn't an object (a bare number/array/string/null) is not
  // a transcript line shape this module understands — broken, not a throw.
  test("valid JSON that is not an object -> broken", () => {
    expect(parseTranscriptLine("42").kind).toBe("broken");
    expect(parseTranscriptLine("null").kind).toBe("broken");
    expect(parseTranscriptLine("[1,2,3]").kind).toBe("broken");
  });
});

describe("parseTranscriptLine / turn with empty content array", () => {
  // A turn whose message.content is present but an empty array — distinct
  // from the "no message at all" case, both must yield zero segments, not throw.
  test("empty content array -> zero segments", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.segments).toEqual([]);
  });

  // A "user"/"assistant"-typed line with no `message` field at all (should
  // not happen per the real schema, but the parser must not crash on it).
  test("turn type with no message field -> zero segments, no throw", () => {
    expect(() => parseTranscriptLine(JSON.stringify({ type: "user" }))).not.toThrow();
    const line = parseTranscriptLine(JSON.stringify({ type: "user" }));
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.segments).toEqual([]);
  });
});

// isUserTextTurn (webui Timeline UI improvement, kawaz spec): shared
// definition of "ユーザ発言" for the chat-bubble styling, the "👤 N/M" nav
// counter, and (U2) groupTimelineLines' boundary test — a tool_result-only
// "user" line, or (U2) any other classifyUserMessage verdict besides
// "user-prompt", must count as none of the three. See the dedicated
// "system-origin user messages fold (U2)" describe block below for the
// classification-driven cases (teammate-message etc.); this block covers the
// pre-existing segment-shape cases.
// segmentSearchText (DR-0022 §3): the plain-text projection Timeline's search
// matches/highlights against — must line up with what SegmentView actually
// renders (JSON.stringify(..., null, 2) for the two JSON-shaped variants) so
// a search hit corresponds to visible text once its fold is expanded.
describe("segmentSearchText", () => {
  test("text/thinking/tool-result segments return their text verbatim", () => {
    expect(segmentSearchText({ kind: "text", role: "user", text: "hello" })).toBe("hello");
    expect(segmentSearchText({ kind: "thinking", text: "pondering" })).toBe("pondering");
    expect(
      segmentSearchText({
        kind: "tool-result",
        toolUseId: "tu_1",
        isError: false,
        text: "42 files",
      }),
    ).toBe("42 files");
  });

  test("tool-use/unknown-segment stringify their JSON payload (matches SegmentView's pretty-print)", () => {
    expect(segmentSearchText({ kind: "tool-use", name: "Read", input: { path: "a.ts" } })).toBe(
      JSON.stringify({ path: "a.ts" }, null, 2),
    );
    expect(segmentSearchText({ kind: "unknown-segment", type: "number", raw: 42 })).toBe(
      JSON.stringify(42, null, 2),
    );
  });
});

// isSearchableSegment (kawaz r26 mid=97 spec): the TL search-target
// checkboxes (👤/🤖/💬) must never let a tool_use/tool_result/unknown-segment
// through regardless of toggle state — the bug report was TL search matching
// a Bash tool_use's raw command JSON.
describe("isSearchableSegment", () => {
  const ALL_ON = { user: true, ai: true, ccmsg: true };
  const ALL_OFF = { user: false, ai: false, ccmsg: false };

  test("tool-use/tool-result/unknown-segment are excluded even with every toggle on", () => {
    expect(
      isSearchableSegment({ kind: "tool-use", name: "Bash", input: { command: "ls" } }, ALL_ON),
    ).toBe(false);
    expect(
      isSearchableSegment(
        { kind: "tool-result", toolUseId: "tu_1", isError: false, text: "ok" },
        ALL_ON,
      ),
    ).toBe(false);
    expect(isSearchableSegment({ kind: "unknown-segment", type: "number", raw: 1 }, ALL_ON)).toBe(
      false,
    );
  });

  test("a user text segment follows the user toggle only", () => {
    const seg: Segment = { kind: "text", role: "user", text: "hi" };
    expect(isSearchableSegment(seg, { ...ALL_OFF, user: true })).toBe(true);
    expect(isSearchableSegment(seg, { ...ALL_ON, user: false })).toBe(false);
  });

  test("an assistant text segment follows the ai toggle only", () => {
    const seg: Segment = { kind: "text", role: "assistant", text: "hi" };
    expect(isSearchableSegment(seg, { ...ALL_OFF, ai: true })).toBe(true);
    expect(isSearchableSegment(seg, { ...ALL_ON, ai: false })).toBe(false);
  });

  test("a thinking segment follows the ai toggle only (no role field, always assistant)", () => {
    const seg: Segment = { kind: "thinking", text: "pondering" };
    expect(isSearchableSegment(seg, { ...ALL_OFF, ai: true })).toBe(true);
    expect(isSearchableSegment(seg, { ...ALL_ON, ai: false })).toBe(false);
  });
});

// ccmsgDedupKey (kawaz r15 mid=21 dedup, extended by r26 mid=97 search unit
// list): must be shared verbatim between render-side dedup and search-side
// dedup so the two never disagree about which ccmsg messages exist.
describe("ccmsgDedupKey", () => {
  test("built from room|ts|from|msg", () => {
    const m: CcmsgMessage = {
      from: "u1",
      room: "general",
      msg: "hello",
      ts: "2026-07-17T00:00:00Z",
    };
    expect(ccmsgDedupKey(m)).toBe("general|2026-07-17T00:00:00Z|u1|hello");
  });

  test("two messages differing only in msg get distinct keys", () => {
    const base = { from: "u1", room: "general", ts: "2026-07-17T00:00:00Z" };
    expect(ccmsgDedupKey({ ...base, msg: "a" })).not.toBe(ccmsgDedupKey({ ...base, msg: "b" }));
  });
});

describe("isUserTextTurn", () => {
  test("user turn with a text segment -> true", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    );
    expect(isUserTextTurn(line)).toBe(true);
  });

  // The Anthropic-API tool_result-wrapping convention (see the
  // parseTranscriptLine/user-turns describe block above): mechanical, must
  // not count.
  test("user turn with only a tool_result segment -> false", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42 files" }],
        },
      }),
    );
    expect(isUserTextTurn(line)).toBe(false);
  });

  // Mixed content (text alongside a tool_result block, seen in practice for
  // API-shaped turns): U2 revised this from the pre-classification behavior
  // (segment-shape only, ignoring userMessageKind) to defer to
  // classifyUserMessage's verdict whenever the line went through
  // parseTranscriptLine — and classifyUserMessage's array branch gives
  // tool_result priority over any accompanying text block
  // (`hasToolResultBlock` check runs first, see its doc comment), so this
  // line's userMessageKind is "tool-result", not "user-prompt". A mechanical
  // tool_result echo isn't a real utterance just because Claude Code happened
  // to attach a text block to it, so it now folds like any other
  // tool_result-bearing line instead of standing alone as a boundary/nav
  // stop.
  test("user turn with text + tool_result -> false (classifyUserMessage gives tool_result priority)", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
            { type: "text", text: "thanks" },
          ],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("tool-result");
    expect(isUserTextTurn(line)).toBe(false);
  });

  test("user turn with zero segments -> false", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "" } }),
    );
    expect(isUserTextTurn(line)).toBe(false);
  });

  test("assistant turn with a text segment -> false (not a user turn)", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    );
    expect(isUserTextTurn(line)).toBe(false);
  });

  test("meta line -> false", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "queue-operation", operation: "dequeue" }),
    );
    expect(isUserTextTurn(line)).toBe(false);
  });

  test("broken line -> false", () => {
    const line: ParsedLine = parseTranscriptLine("{not json");
    expect(isUserTextTurn(line)).toBe(false);
  });
});

// scrollPositionToUserTurnIndex (webui Timeline UI improvement, kawaz spec):
// the pure "topOffsets + scrollTop -> index" half of the "👤 N/M" nav
// indicator; DOM measurement (Timeline.tsx) supplies topOffsets.
describe("scrollPositionToUserTurnIndex", () => {
  test("no loaded user turns -> 0 regardless of scrollTop", () => {
    expect(scrollPositionToUserTurnIndex([], 0)).toBe(0);
    expect(scrollPositionToUserTurnIndex([], 9999)).toBe(0);
  });

  test("scrolled above the first turn -> 0", () => {
    expect(scrollPositionToUserTurnIndex([100, 300, 500], 50)).toBe(0);
  });

  // "at or above" is inclusive of an exact match — scrolled exactly to a
  // turn's top counts that turn as reached.
  test("scrollTop exactly at a turn's offset counts that turn", () => {
    expect(scrollPositionToUserTurnIndex([100, 300, 500], 100)).toBe(1);
    expect(scrollPositionToUserTurnIndex([100, 300, 500], 300)).toBe(2);
  });

  test("scrollTop strictly between two offsets counts only the earlier one", () => {
    expect(scrollPositionToUserTurnIndex([100, 300, 500], 299)).toBe(1);
    expect(scrollPositionToUserTurnIndex([100, 300, 500], 301)).toBe(2);
  });

  test("scrolled past the last turn -> full count", () => {
    expect(scrollPositionToUserTurnIndex([100, 300, 500], 9999)).toBe(3);
  });

  test("single loaded turn, scrolled to it -> 1", () => {
    expect(scrollPositionToUserTurnIndex([200], 200)).toBe(1);
  });
});

// groupTimelineLines (webui Timeline "tools folding" UI improvement, kawaz
// spec): boundary lines (user prompts / assistant user-facing final
// responses) stay standalone "entry" groups, everything strictly between two
// boundaries collapses into one "fold" group.
describe("groupTimelineLines", () => {
  test("no intermediate lines: two boundaries in a row stay two standalone entries, no fold group", () => {
    const lines = [userText("hi"), assistantText("hello")];
    const offsets = [0, 10];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      { kind: "entry", offset: 10, line: lines[1] },
    ]);
  });

  // The core case: a user prompt, a run of thinking/tool_use/tool_result,
  // then the assistant's final user-facing text — the middle run becomes one
  // fold group, both boundaries stay standalone.
  test("thinking + tool_use + tool_result between two boundaries fold into one group", () => {
    const lines = [
      userText("do the thing"),
      assistantThinking("let me check"),
      assistantToolUse("Bash"),
      userToolResult("tu_1"),
      assistantText("done"),
    ];
    const offsets = [0, 1, 2, 3, 4];
    const groups = groupTimelineLines(lines, offsets);
    expect(groups).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      {
        kind: "fold",
        entries: [
          { offset: 1, line: lines[1] },
          { offset: 2, line: lines[2] },
          { offset: 3, line: lines[3] },
        ],
      },
      { kind: "entry", offset: 4, line: lines[4] },
    ]);
  });

  // Meta lines (mode変更/permission系/その他, transcript-model.ts's MetaLine)
  // fold the same as thinking/tool_use/tool_result — no special-casing by
  // top-level `type`, matching this module's "one generic fold path" design
  // rationale (see the module doc comment at the top of this file).
  test("meta lines fold alongside tool entries in the same group", () => {
    const lines = [
      userText("go"),
      metaLine("mode-change"),
      assistantToolUse("Read"),
      metaLine("permission-request"),
      assistantText("ok done"),
    ];
    const offsets = [0, 1, 2, 3, 4];
    const groups = groupTimelineLines(lines, offsets);
    expect(groups).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      {
        kind: "fold",
        entries: [
          { offset: 1, line: lines[1] },
          { offset: 2, line: lines[2] },
          { offset: 3, line: lines[3] },
        ],
      },
      { kind: "entry", offset: 4, line: lines[4] },
    ]);
  });

  // A trailing run with no closing boundary yet (turn still in progress,
  // e.g. the session hasn't produced its final text response) still folds —
  // there's simply no following "entry" group after it.
  test("trailing intermediate run with no closing boundary still folds", () => {
    const lines = [userText("go"), assistantThinking("thinking...")];
    const offsets = [0, 1];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      { kind: "fold", entries: [{ offset: 1, line: lines[1] }] },
    ]);
  });

  // A leading run before the first boundary (e.g. transcript starts with
  // meta lines before any user prompt) also folds.
  test("leading intermediate run before the first boundary folds", () => {
    const lines = [metaLine("file-history-snapshot"), userText("hi")];
    const offsets = [0, 1];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "fold", entries: [{ offset: 0, line: lines[0] }] },
      { kind: "entry", offset: 1, line: lines[1] },
    ]);
  });

  // An assistant turn mixing text with thinking/tool_use in the *same* line
  // (parseTranscriptLine's "text + thinking + tool_use blocks" case) is a
  // boundary as a whole line — grouping operates at line granularity, not
  // segment granularity, so this single line never gets folded, its
  // thinking/tool_use segments render inline via SegmentView instead.
  test("an assistant line mixing text with thinking/tool_use segments is a boundary, not folded", () => {
    const mixed: ParsedLine = {
      kind: "turn",
      ts: null,
      role: "assistant",
      segments: [
        { kind: "thinking", text: "let me check" },
        { kind: "tool-use", name: "Bash", input: {} },
        { kind: "text", role: "assistant", text: "done" },
      ],
    };
    const lines = [userText("go"), mixed];
    const offsets = [0, 1];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      { kind: "entry", offset: 1, line: mixed },
    ]);
  });

  // A tool_result-only "user"-typed line (Anthropic API convention, see
  // isUserTextTurn's doc comment) is not a real user prompt — it must fold
  // like any other intermediate entry, not stand alone as a boundary.
  test("a tool_result-only user-typed line folds (not a real user prompt)", () => {
    const lines = [userText("go"), userToolResult("tu_1"), assistantText("done")];
    const offsets = [0, 1, 2];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      { kind: "fold", entries: [{ offset: 1, line: lines[1] }] },
      { kind: "entry", offset: 2, line: lines[2] },
    ]);
  });

  test("empty input -> empty output", () => {
    expect(groupTimelineLines([], [])).toEqual([]);
  });
});

// foldGroupLabel: each present category is listed in fixed order as
// "N thinking + N agent messages + N items". Agent communication is counted
// separately from generic items because it remains directly visible beside
// thinking when the outer fold is opened.
describe("foldGroupLabel", () => {
  function entry(offset: number, line: ParsedLine): TimelineEntry {
    return { offset, line };
  }

  // No thinking entries at all -> "M items" regardless of what the
  // non-thinking entries actually are (tool_use/tool_result here).
  test("no thinking entries -> 'N items'", () => {
    const entries = [
      entry(0, assistantToolUse("Bash")),
      entry(1, userToolResult("tu_1")),
      entry(2, assistantToolUse("Read")),
    ];
    expect(foldGroupLabel(entries)).toBe("3 items");
  });

  // Every entry is thinking-only -> "N thinking", no "+ 0 items" suffix.
  test("every entry is thinking-only -> 'N thinking' (no '+ 0 items')", () => {
    const entries = [entry(0, assistantThinking("a")), entry(1, assistantThinking("b"))];
    expect(foldGroupLabel(entries)).toBe("2 thinking");
  });

  // Mixed: one thinking + one non-thinking -> "1 thinking + 1 items".
  test("thinking mixed with a non-thinking entry -> 'N thinking + M items'", () => {
    const entries = [entry(0, assistantThinking("hmm")), entry(1, assistantToolUse("Bash"))];
    expect(foldGroupLabel(entries)).toBe("1 thinking + 1 items");
  });

  // A meta line mixed in (no thinking present) -> plain "items" count.
  test("a meta line mixed in, no thinking -> 'N items'", () => {
    const entries = [entry(0, assistantToolUse("Bash")), entry(1, metaLine("mode-change"))];
    expect(foldGroupLabel(entries)).toBe("2 items");
  });

  // Single non-thinking entry -> '1 items' (count reflects entry count, not
  // pluralization — matches the module's existing convention elsewhere).
  test("single non-thinking entry -> '1 items'", () => {
    expect(foldGroupLabel([entry(0, assistantToolUse("Bash"))])).toBe("1 items");
  });

  // Multiple thinking + multiple items together -> both counts shown.
  test("multiple thinking + multiple items -> both counts", () => {
    const entries = [
      entry(0, assistantThinking("a")),
      entry(1, assistantThinking("b")),
      entry(2, assistantToolUse("Bash")),
      entry(3, metaLine("mode-change")),
    ];
    expect(foldGroupLabel(entries)).toBe("2 thinking + 2 items");
  });

  test("thinking, agent messages, and items are listed in the fixed three-part order", () => {
    const send = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", name: "SendMessage", input: { to: "worker", message: "go" } },
          ],
        },
      }),
    );
    const peer = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: { content: '<agent-message from="worker">done</agent-message>' },
      }),
    );
    const entries = [
      entry(0, assistantThinking("inspect")),
      entry(1, send),
      entry(2, peer),
      entry(3, assistantToolUse("Bash")),
    ];
    expect(foldGroupLabel(entries)).toBe("1 thinking + 2 agent messages + 1 items");
  });
});

// classifyUserMessage (U2 kawaz spec, transcript-model.ts's doc comment):
// distinguishes real human utterances from the several patterns of
// system-generated content Claude Code's harness injects under the wire
// "user" role. Cases below mirror the sample-derived pattern catalog in
// scratchpad `jsonl-user-message-patterns.md` (U2 delegation's research
// input) — each `describe` block corresponds to one of that report's
// lettered categories.
describe("classifyUserMessage", () => {
  // 分類 A: isMeta:true — CLI/harness の UI インジェクション。isMeta が最強
  // のマーカーなので、これらは content の先頭文字列だけで機械判別できる。
  describe("isMeta:true patterns (report category A)", () => {
    test("<local-command-caveat> -> system-caveat", () => {
      const entry = {
        isMeta: true,
        message: {
          role: "user",
          content:
            "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.",
        },
      };
      expect(classifyUserMessage(entry)).toBe("system-caveat");
    });

    test("<command-name> -> slash-command-invocation", () => {
      const entry = {
        isMeta: true,
        message: {
          role: "user",
          content: "<command-name>/model</command-name>\n<command-message>model</command-message>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("slash-command-invocation");
    });

    test("<local-command-stdout> -> slash-command-stdout", () => {
      const entry = {
        isMeta: true,
        message: {
          role: "user",
          content: "<local-command-stdout>Set model to Fable 5</local-command-stdout>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("slash-command-stdout");
    });

    test("exact malformed-tool-call retry text -> tool-retry-hint", () => {
      const entry = {
        isMeta: true,
        message: {
          role: "user",
          content: "Your tool call was malformed and could not be parsed. Please retry.",
        },
      };
      expect(classifyUserMessage(entry)).toBe("tool-retry-hint");
    });

    // Skill 起動結果 (A-5): isMeta:true かつ content が array 形態で、単独
    // text ブロックが "Base directory for this skill:" で始まる — array 分岐
    // (report category C/D と同じ形) の中で isMeta を見る必要がある唯一の
    // ケースなので、array 判定より先に string content として扱わないことを
    // 確認する。
    test("array content, isMeta:true, single text block starting with 'Base directory for this skill:' -> skill-invocation-preamble", () => {
      const entry = {
        isMeta: true,
        message: {
          role: "user",
          content: [
            { type: "text", text: "Base directory for this skill: /path/to/skill\n\n# タスク..." },
          ],
        },
      };
      expect(classifyUserMessage(entry)).toBe("skill-invocation-preamble");
    });

    // A の中で上記どのプレフィックスにも一致しない文字列 (将来の未知
    // インジェクション種別) — 安全な fallback として unknown-meta に degrade
    // する (未知 type が MetaLine に degrade する transcript-model.ts の設計
    // と同じ思想)。
    test("isMeta:true with an unrecognized string content -> unknown-meta", () => {
      const entry = { isMeta: true, message: { role: "user", content: "some future injection" } };
      expect(classifyUserMessage(entry)).toBe("unknown-meta");
    });
  });

  // 分類 B: isMeta:null だが system 由来 — promptId 付きで「ユーザ発話に
  // 化けた」インジェクション。content の先頭リテラルでしか区別できない、
  // というレポートの核心的な発見に対応する。
  describe("isMeta not true, prompt-shaped system injections (report category B)", () => {
    // Claude Code can emit a task lifecycle notice as plain text with no wrapper.
    // `promptSource:"system"` is the decisive origin marker, and the known
    // `origin.kind` preserves the specific task-notification rendering kind.
    test("system promptSource + task-notification origin classifies plain text as task-notification", () => {
      const entry = {
        type: "user",
        message: {
          role: "user",
          content: '6 background agents were stopped by the user: "worker-a", "worker-b".',
        },
        origin: { kind: "task-notification" },
        promptSource: "system",
        queuePriority: "later",
      };
      expect(classifyUserMessage(entry)).toBe("task-notification");
    });

    // A future system-origin shape must stay out of the human-prompt path even
    // when its origin kind is not yet part of UserMessageKind.
    test("system promptSource + unknown origin classifies plain text as unknown-meta", () => {
      const entry = {
        type: "user",
        message: { role: "user", content: "some future system injection" },
        origin: { kind: "future-system-origin" },
        promptSource: "system",
      };
      expect(classifyUserMessage(entry)).toBe("unknown-meta");
    });

    test("<task-notification> prefix (isMeta absent) -> task-notification", () => {
      const entry = {
        message: {
          role: "user",
          content:
            "<task-notification>\n<task-id>b0f9a5r1q</task-id>\n<summary>Monitor event</summary>\n</task-notification>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("task-notification");
    });

    test("<task-notification> prefix with isMeta explicitly false -> task-notification", () => {
      const entry = {
        isMeta: false,
        message: { role: "user", content: "<task-notification>\n<task-id>x</task-id>" },
      };
      expect(classifyUserMessage(entry)).toBe("task-notification");
    });

    // ハーネスは background-task 通知の前に "[SYSTEM NOTIFICATION - NOT USER
    // INPUT]" の定型バナーを付けることがあり、その場合 content は
    // <task-notification> で「始まらない」。バナー自体が決定的な注入マーカー
    // (人間のプロンプトがこの文字列で始まることはない) なので、これを
    // user-prompt に落とすと巨大な緑吹き出しとして誤表示される (2026-07-12 に
    // 実セッションの transcript で観測、修正)。
    test("'[SYSTEM NOTIFICATION - NOT USER INPUT]' banner + <task-notification> body -> task-notification", () => {
      const entry = {
        message: {
          role: "user",
          content:
            "[SYSTEM NOTIFICATION - NOT USER INPUT]\nThis is an automated background-task event, NOT a message from the user.\n\n<task-notification>\n<task-id>bx1</task-id>\n<summary>Monitor event</summary>\n</task-notification>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("task-notification");
    });

    // 同バナーだが task-notification ブロックを持たない変種 (将来の別種通知)
    // も、バナーがある時点でユーザ発話ではない — 汎用の unknown-meta へ。
    test("'[SYSTEM NOTIFICATION - NOT USER INPUT]' banner without task-notification -> unknown-meta", () => {
      const entry = {
        message: {
          role: "user",
          content: "[SYSTEM NOTIFICATION - NOT USER INPUT]\nSome future notification shape.",
        },
      };
      expect(classifyUserMessage(entry)).toBe("unknown-meta");
    });

    // SendMessage relay は banner なしの <agent-message ...> 直開始形もある
    // (kawaz r17 mid=38 の実観測 — user-prompt に落ちて緑のユーザ発話として
    // 表示されていた)。teammate-message も同系 wrapper として防御的に拾う。
    // slash command は isMeta なしで届く transcript もある (kawaz r20 の
    // 実観測 — /reload-plugins が緑のユーザ発話で表示)。タグ prefix は人間の
    // 発話が取り得ない形なので meta フラグに依らず同じ分類に落ちる。
    test("bare <command-name>/<command-message> without isMeta -> slash-command-invocation", () => {
      const entry = {
        type: "user",
        message: {
          role: "user",
          content:
            "<command-name>/reload-plugins</command-name>\n<command-message>reload-plugins</command-message>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("slash-command-invocation");
      const msgFirst = {
        type: "user",
        message: {
          role: "user",
          content:
            "<command-message>ccmsg:ccmsg</command-message>\n<command-name>/ccmsg:ccmsg</command-name>",
        },
      };
      expect(classifyUserMessage(msgFirst)).toBe("slash-command-invocation");
    });

    test("bare <agent-message>/<teammate-message> prefix -> peer-message", () => {
      const agentEntry = {
        type: "user",
        message: { role: "user", content: '<agent-message from="a1">report</agent-message>' },
      };
      expect(classifyUserMessage(agentEntry)).toBe("peer-message");
      const teammateEntry = {
        type: "user",
        message: {
          role: "user",
          content: '<teammate-message teammate_id="x">hello</teammate-message>',
        },
      };
      expect(classifyUserMessage(teammateEntry)).toBe("peer-message");
    });

    // TUI で workflow を pause → resume した時にハーネスが注入する定型メッセージ
    // (kawaz r46 mid=14、本セッションの transcript ff82a8e6-... で 2 件実観測)。
    // 実データでは promptSource:"typed" / origin.kind:"human" / isMeta なしで
    // 通常のタイプ入力と wire レベルで区別できないため、文字列 prefix 判定に頼る。
    test("'Resume the paused workflow by calling: Workflow({' prefix -> workflow-resume", () => {
      const entry = {
        type: "user",
        promptSource: "typed",
        origin: { kind: "human" },
        message: {
          role: "user",
          content:
            "Resume the paused workflow by calling: Workflow({scriptPath: '/Users/kawaz/.claude-personal/projects/-Users-kawaz--local-share-repos-github-com-kawaz-claude-ccmsg-main/ff82a8e6-6598-49c2-ae8c-3a1fd55cc887/workflows/scripts/screenshot-longrun-fixture2-wf_666fea3f-0be.js', resumeFromRunId: 'wf_666fea3f-0be'}) — completed agents return cached results.",
        },
      };
      expect(classifyUserMessage(entry)).toBe("workflow-resume");
    });

    // 誤爆判定: prefix と少しでも違えば user-prompt に落ちる (人間の発話が
    // "Resume the paused workflow by calling: Workflow" で始まる可能性は残す)。
    test("'Resume the paused workflow' but missing '({' suffix -> user-prompt", () => {
      const entry = {
        message: {
          role: "user",
          content: "Resume the paused workflow when you have time.",
        },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    test("'Another Claude session sent a message:' prefix -> peer-message", () => {
      const entry = {
        message: {
          role: "user",
          content:
            'Another Claude session sent a message:\n<teammate-message teammate_id="poc5" color="blue">\n本文\n</teammate-message>\n\nThis came from another Claude session — not typed by your user...',
        },
      };
      expect(classifyUserMessage(entry)).toBe("peer-message");
    });
  });

  // 分類 C: content が array — tool_result 応答、interrupt マーカー。
  describe("array content (report category C/D)", () => {
    test("content array containing a tool_result block -> tool-result", () => {
      const entry = {
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "42 files" }],
        },
      };
      expect(classifyUserMessage(entry)).toBe("tool-result");
    });

    // tool_result と text が混在する配列 (Anthropic API 形状) でも
    // tool_result 優先で判定 — このメッセージ自体は "type:user に見える
    // システムメッセージ" というより通常の API 往復の一部なので、text
    // segment の有無に関わらず tool-result 扱いでよい。
    test("content array with tool_result + text blocks -> tool-result (tool_result takes priority)", () => {
      const entry = {
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
            { type: "text", text: "thanks" },
          ],
        },
      };
      expect(classifyUserMessage(entry)).toBe("tool-result");
    });

    test("[Request interrupted by user] single text block -> user-interrupt-marker", () => {
      const entry = {
        message: {
          role: "user",
          content: [{ type: "text", text: "[Request interrupted by user for tool use]" }],
        },
      };
      expect(classifyUserMessage(entry)).toBe("user-interrupt-marker");
    });

    // isMeta が立っていない array content で "Base directory for this
    // skill:" プレフィックスは無視される (A-5 は isMeta:true が必須条件) —
    // 未知の array 形状として unknown-array に degrade する。
    test("single text block starting with skill preamble text but isMeta not true -> unknown-array (not skill-invocation-preamble)", () => {
      const entry = {
        message: {
          role: "user",
          content: [{ type: "text", text: "Base directory for this skill: /path" }],
        },
      };
      expect(classifyUserMessage(entry)).toBe("unknown-array");
    });

    test("an unrecognized array content shape -> unknown-array", () => {
      const entry = {
        message: { role: "user", content: [{ type: "some_future_block", foo: "bar" }] },
      };
      expect(classifyUserMessage(entry)).toBe("unknown-array");
    });

    // Regression (adversarial review, transcript-model.ts major finding):
    // Claude Code emits an image-paste prompt as an array of `image` blocks
    // plus a `text` block (in wire order: images first, then the caption
    // text) — the array branch used to fall through every named pattern to
    // "unknown-array" for anything but a single tool_result/text block,
    // which misclassified a real human utterance as system-origin (Timeline
    // then strips the user-bubble styling and tags it with a syskind chip).
    test("image + text blocks (real image-paste prompt) -> user-prompt, not unknown-array", () => {
      const entry = {
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "..." } },
            { type: "text", text: "この画面のエラーは何？" },
          ],
        },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // Multiple images (no caption) is also a real utterance shape — every
    // block is `image`, none is `text`, still must not degrade to
    // unknown-array just because there's no caption to anchor on.
    test("two image blocks, no caption -> user-prompt", () => {
      const entry = {
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "a" } },
            { type: "image", source: { type: "base64", media_type: "image/png", data: "b" } },
          ],
        },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // A single image block (no caption, no text block at all) is the
    // smallest real-utterance array shape — must not be swallowed by the
    // length===1 branch's text-block-only special-casing (interrupt marker /
    // skill preamble), which only inspects `content[0]` when it's `type:"text"`.
    test("single image block, no caption -> user-prompt", () => {
      const entry = {
        message: {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "a" } },
          ],
        },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // A future/unseen block type MIXED IN with a text block must still keep
    // the safe unknown-array fallback — the "every block is text/image"
    // check must not accidentally treat a partially-recognized array as a
    // real prompt.
    test("a text block mixed with an unrecognized block type -> unknown-array", () => {
      const entry = {
        message: {
          role: "user",
          content: [
            { type: "text", text: "caption" },
            { type: "some_future_block", foo: "bar" },
          ],
        },
      };
      expect(classifyUserMessage(entry)).toBe("unknown-array");
    });
  });

  // 分類 E: 真のユーザ発話。誤爆防止ケース含む — レポートの「本物ユーザが
  // <foo> で始まる発話を書く」限界を明示的にテストし、isMeta が立っていない
  // 通常の文章はどんな内容でも user-prompt 判定になることを保証する
  // (task-notification/peer-message の 2 つの正確なプレフィックスに完全
  //一致しない限り)。
  describe("real human utterances (report category E) + false-positive guard", () => {
    test("plain string content -> user-prompt", () => {
      const entry = { message: { role: "user", content: "続けて" } };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // Observed human-input metadata must remain a human prompt; origin.kind is
    // not independently a system marker because human/channel are valid kinds.
    test("typed promptSource + human origin -> user-prompt", () => {
      const entry = {
        message: { role: "user", content: "続けて" },
        origin: { kind: "human" },
        promptSource: "typed",
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // isMeta が立っていなければ、文中に <foo> のようなタグ風の文字列を含んで
    // いても user-prompt のまま — <task-notification>/'Another Claude
    // session sent a message:' の完全一致プレフィックスでない限り誤爆しない
    // (レポートの判別ロジックそのもの)。
    test("user text containing an unrelated <tag>-looking string -> user-prompt (not misclassified)", () => {
      const entry = {
        message: { role: "user", content: "<foo>これはただのユーザ入力です</foo>" },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // isMeta:true が明示的に false でも同じ扱い (isMeta === true のみが
    // "isMeta 立っている" とみなされる、report のロジック通り)。
    test("isMeta:false with plain text -> user-prompt", () => {
      const entry = { isMeta: false, message: { role: "user", content: "hello" } };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    test("empty string content -> user-prompt (no content to classify as anything else)", () => {
      const entry = { message: { role: "user", content: "" } };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });
  });

  // Agent (subagent) 転写の先頭 user 行 — Agent tool の spawn prompt (親からの
  // 指示書)。wire signal は `parentUuid` field が明示的に `null` で、通常
  // セッションの `type:"user"` 行 (常に parent-linked) と区別できる。plain text
  // spawn / <teammate-message> wrapper 付き spawn の両方を同じ kind に落として
  // 「親からの指示」と分かる fold 表示に載せる (kawaz r46m28 2026-07-21)。
  describe("agent spawn prompt (parentUuid === null) — report category F", () => {
    test("parentUuid:null with plain text -> spawn-prompt", () => {
      const entry = {
        type: "user",
        parentUuid: null,
        message: {
          role: "user",
          content: "~/.claude/skills/thorough-review/reviewers/api-design.md を読み...",
        },
      };
      expect(classifyUserMessage(entry)).toBe("spawn-prompt");
    });

    test("parentUuid:null with <teammate-message> wrapper (team-lead spawn) -> spawn-prompt", () => {
      const entry = {
        type: "user",
        parentUuid: null,
        message: {
          role: "user",
          content:
            '<teammate-message teammate_id="team-lead" summary="タスク">本文</teammate-message>',
        },
      };
      expect(classifyUserMessage(entry)).toBe("spawn-prompt");
    });

    // parentUuid が string (通常の user 行) の時は spawn 判定に落ちてはならず、
    // 既存分類が引き続き適用される。
    test("parentUuid:string with plain text -> user-prompt", () => {
      const entry = {
        type: "user",
        parentUuid: "a3eb3a8a-9c46-4d5a-93e9-5ceb24fe6957",
        message: { role: "user", content: "hello" },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // parentUuid property そのものが欠落しているケース (手組みフィクスチャ /
    // 旧形式) は既存分類にフォールバックする — 既存 classifier テスト群を
    // 破らないための境界。
    test("parentUuid property missing entirely -> falls through to existing classification", () => {
      const entry = { message: { role: "user", content: "hello" } };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // parentUuid:null が最優先で走ることの確認: たとえ content が
    // <teammate-message>/isMeta:true など既存分類のトリガを持っていても、
    // spawn 判定が勝つ (agent 転写の先頭は文脈的に spawn 指示書として扱う)。
    test("parentUuid:null overrides isMeta:true classification -> spawn-prompt", () => {
      const entry = {
        parentUuid: null,
        isMeta: true,
        message: { role: "user", content: "<command-name>/foo</command-name>" },
      };
      expect(classifyUserMessage(entry)).toBe("spawn-prompt");
    });
  });
});

// parseTranscriptLine's userMessageKind wiring (U2): only role:"user" turns
// get a classification; role:"assistant" turns never call classifyUserMessage
// at all (see the module doc comment on TurnLine.userMessageKind).
describe("parseTranscriptLine / userMessageKind wiring (U2)", () => {
  test("a user turn's userMessageKind reflects classifyUserMessage's verdict", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        isMeta: true,
        type: "user",
        message: { role: "user", content: "<command-name>/model</command-name>" },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("slash-command-invocation");
  });

  // Regression fixture reduced from the reported transcript line 1100, keeping
  // its observed `isMeta:true`, peer banner, and origin metadata.
  // The fixed peer banner must win over the generic isMeta fallback so
  // the audit report is labeled peer-message and remains an intermediate fold,
  // never a human user-prompt boundary.
  test("isMeta:true peer-origin agent relay -> peer-message and folded", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        isMeta: true,
        message: {
          role: "user",
          content:
            'Another Claude session sent a message:\n<agent-message from="general-purpose">\nRead-only audit found 2 Major candidates: (1) ...\n</agent-message>',
        },
        origin: {
          kind: "peer",
          from: "general-purpose",
          name: "general-purpose",
        },
        promptSource: "system",
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("peer-message");
    expect(isUserTextTurn(line)).toBe(false);
    expect(groupTimelineLines([line], [1100])).toEqual([
      { kind: "fold", entries: [{ offset: 1100, line }] },
    ]);
  });

  // Regression fixture reduced from the reported plain-text task lifecycle
  // notice: metadata, not a body prefix, must keep it out of the green human
  // bubble and fold it with other system-origin entries.
  test("plain-text task notification metadata -> task-notification and folded", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: '6 background agents were stopped by the user: "worker-a", "worker-b".',
        },
        origin: { kind: "task-notification" },
        promptSource: "system",
        queuePriority: "later",
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("task-notification");
    expect(isUserTextTurn(line)).toBe(false);
    expect(groupTimelineLines([line], [571])).toEqual([
      { kind: "fold", entries: [{ offset: 571, line }] },
    ]);
  });

  test("a real user turn's userMessageKind is user-prompt", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("user-prompt");
  });

  test("an assistant turn's userMessageKind is undefined (classification never runs for assistant)", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBeUndefined();
  });
});

// isUserTextTurn / groupTimelineLines, system-origin "type:user" messages
// (U2 folding-scope fix): kawaz — "システムメッセージも tool や thinking と
// 同じで folding しといて". Before this fix, isUserTextTurn only excluded
// tool_result-only user turns, so a teammate-message/task-notification/
// slash-command-invocation line (any classifyUserMessage kind other than
// "user-prompt") both stood alone as a groupTimelineLines boundary *and*
// inflated the "👤 N/M" nav counter. Both bugs share one root cause (both
// read isUserTextTurn), so one fixed definition closes both.
describe("isUserTextTurn / groupTimelineLines — system-origin user messages fold (U2)", () => {
  // A real, parsed system-origin line (not a hand-built fixture) so
  // userMessageKind is actually populated by classifyUserMessage, exercising
  // the same code path Timeline.tsx sees for a live transcript.
  function parsedTeammateMessage(): ParsedLine {
    return parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: "Another Claude session sent a message: hi from room",
        },
      }),
    );
  }

  test("a system-origin user message (peer-message) -> isUserTextTurn false despite having a text segment", () => {
    const line = parsedTeammateMessage();
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("peer-message");
    expect(line.segments.some((s) => s.kind === "text")).toBe(true);
    expect(isUserTextTurn(line)).toBe(false);
  });

  // Agent spawn prompt (parentUuid:null) も system-origin と同じく boundary
  // 化させず fold に落とす — SystemMessageFold 経由で「spawn prompt (親からの
  // 指示)」として表示される (green user bubble にはしない、kawaz r46m28)。
  test("agent spawn prompt (parentUuid:null) -> isUserTextTurn false, folds into surrounding group", () => {
    const spawnLine = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        parentUuid: null,
        message: { role: "user", content: "spawned task: investigate X" },
      }),
    );
    expect(spawnLine.kind).toBe("turn");
    if (spawnLine.kind !== "turn") return;
    expect(spawnLine.userMessageKind).toBe("spawn-prompt");
    expect(spawnLine.segments.some((s) => s.kind === "text")).toBe(true);
    expect(isUserTextTurn(spawnLine)).toBe(false);
  });

  // Explicit userMessageKind:"user-prompt" (as parseTranscriptLine actually
  // produces for a real utterance, not the compat-fixture undefined case
  // covered by the "isUserTextTurn" describe block above) must still count.
  test("userMessageKind explicitly 'user-prompt' -> isUserTextTurn true", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "real question" } }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.userMessageKind).toBe("user-prompt");
    expect(isUserTextTurn(line)).toBe(true);
  });

  test("a system-origin user message folds into the surrounding group instead of standing as a boundary", () => {
    const sysLine = parsedTeammateMessage();
    const lines = [userText("go"), sysLine, assistantText("done")];
    const offsets = [0, 1, 2];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      { kind: "fold", entries: [{ offset: 1, line: sysLine }] },
      { kind: "entry", offset: 2, line: lines[2] },
    ]);
  });

  // A real user-prompt turn between two other boundaries still stays
  // standalone — the fold-scope change only pulls in system-origin messages,
  // not genuine human utterances.
  test("a real user-prompt turn between boundaries stays a standalone entry, not folded", () => {
    const realPrompt = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "follow-up question" } }),
    );
    const lines = [assistantText("first answer"), realPrompt, assistantText("second answer")];
    const offsets = [0, 1, 2];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      { kind: "entry", offset: 1, line: realPrompt },
      { kind: "entry", offset: 2, line: lines[2] },
    ]);
  });
});

// splitFoldSubgroups (kawaz r17 mid=45): fold group 展開時の中身を thinking
// 区切りでサブグループ化する分割の輪郭。
describe("splitFoldSubgroups", () => {
  const thinkingEntry = (offset: number) => ({
    offset,
    line: {
      kind: "turn" as const,
      ts: null,
      role: "assistant" as const,
      segments: [{ kind: "thinking" as const, text: "t" }],
    },
  });
  const toolEntry = (offset: number) => ({
    offset,
    line: {
      kind: "turn" as const,
      ts: null,
      role: "assistant" as const,
      segments: [{ kind: "tool-use" as const, name: "Bash", input: {} }],
    },
  });

  // 何を保証するか: tool 群 → thinking → tool 群 → thinking の列が
  // items/thinking の交互列に分割され、表示順が保たれる。thinking は
  // 単独 entry、tool run はまとめて 1 つの items グループ。
  test("splits runs of tools at each thinking boundary, preserving order", () => {
    const entries = [toolEntry(1), toolEntry(2), thinkingEntry(3), toolEntry(4), thinkingEntry(5)];
    const got = splitFoldSubgroups(entries);
    expect(got.map((g) => g.kind)).toEqual(["items", "direct", "items", "direct"]);
    expect(got[0]!.kind === "items" && got[0]!.entries.length).toBe(2);
    expect(got[2]!.kind === "items" && got[2]!.entries.length).toBe(1);
  });

  // 何を保証するか (kawaz r17 mid=49 の実観測): thinking と tool_use が
  // 同一 turn 行に混在するケースは thinking 側 — items サブ fold に沈むと
  // fold group 直下に出るべき thinking が 1 段深く表示される。
  test("a mixed thinking+tool turn splits as thinking, not items", () => {
    const mixed = {
      offset: 10,
      line: {
        kind: "turn" as const,
        ts: null,
        role: "assistant" as const,
        segments: [
          { kind: "thinking" as const, text: "t" },
          { kind: "tool-use" as const, name: "Bash", input: {} },
        ],
      },
    };
    const got = splitFoldSubgroups([toolEntry(1), mixed, toolEntry(3)]);
    expect(got.map((g) => g.kind)).toEqual(["items", "direct", "items"]);
  });

  // 何を保証するか (境界): thinking が無ければ全体が 1 つの items、
  // thinking だけなら items グループは生まれない (空 run を flush しない)。
  test("all-tools yields one items group; all-thinking yields no items group", () => {
    const tools = splitFoldSubgroups([toolEntry(1), toolEntry(2)]);
    expect(tools.map((g) => g.kind)).toEqual(["items"]);
    const thinking = splitFoldSubgroups([thinkingEntry(1), thinkingEntry(2)]);
    expect(thinking.map((g) => g.kind)).toEqual(["direct", "direct"]);
  });

  test("agent send, spawn, and peer messages split items runs and stay out of item counts", () => {
    const parsedEntry = (offset: number, raw: Record<string, unknown>): TimelineEntry => ({
      offset,
      line: parseTranscriptLine(JSON.stringify(raw)),
    });
    const send = parsedEntry(2, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "SendMessage", input: { to: "worker", message: "go" } },
        ],
      },
    });
    const spawn = parsedEntry(4, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", name: "Agent", input: { name: "reviewer", prompt: "review" } },
        ],
      },
    });
    const peer = parsedEntry(6, {
      type: "user",
      message: {
        role: "user",
        content: '<agent-message agent_id="worker">done</agent-message>',
      },
    });
    const entries = [toolEntry(1), send, toolEntry(3), spawn, toolEntry(5), peer, toolEntry(7)];

    // Agent 通信は items run を分割する direct subgroup だが、外側 fold と
    // 各通信 details は既定閉。通常 tool segment と他の system message は対象外。
    expect(send.line.kind === "turn" && isAgentCommunicationSegment(send.line.segments[0]!)).toBe(
      true,
    );
    expect(spawn.line.kind === "turn" && isAgentCommunicationSegment(spawn.line.segments[0]!)).toBe(
      true,
    );
    expect(isPeerMessageLine(peer.line)).toBe(true);
    const bashLine = assistantToolUse("Bash");
    expect(bashLine.kind === "turn" && isAgentCommunicationSegment(bashLine.segments[0]!)).toBe(
      false,
    );
    expect(isPeerMessageLine(userToolResult("tu_1"))).toBe(false);

    expect(splitFoldSubgroups(entries).map((group) => group.kind)).toEqual([
      "items",
      "direct",
      "items",
      "direct",
      "items",
      "direct",
      "items",
    ]);
    expect(foldGroupLabel(entries)).toBe("3 agent messages + 4 items");
    expect(foldGroupNeedsOuterFold(entries)).toBe(true);
  });

  test("idle_notification peer messages stay in the items run", () => {
    const idle: TimelineEntry = {
      offset: 2,
      line: parseTranscriptLine(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content:
              '<teammate-message teammate_id="worker">{"type":"idle_notification","from":"worker","idleReason":"available"}</teammate-message>',
          },
        }),
      ),
    };
    const entries = [toolEntry(1), idle, toolEntry(3)];

    expect(isPeerMessageLine(idle.line)).toBe(true);
    expect(splitFoldSubgroups(entries)).toEqual([{ kind: "items", entries }]);
    expect(foldGroupLabel(entries)).toBe("3 items");
    expect(foldGroupNeedsOuterFold(entries)).toBe(false);
  });
});

describe("foldGroupNeedsOuterFold", () => {
  function parsedEntry(offset: number, raw: Record<string, unknown>): TimelineEntry {
    return { offset, line: parseTranscriptLine(JSON.stringify(raw)) };
  }

  // 実 transcript と同じ assistant tool_use / user tool_result の交互列には
  // thinking の節目がない。外側も内側も同じ 2 items を表すため、外側 fold は
  // 表示せず items fold 1 段だけにする。
  test("tool-only transcript run is rendered as one flat items fold", () => {
    const entries = [
      parsedEntry(10, {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "tu_1", name: "Bash", input: { command: "pwd" } }],
        },
      }),
      parsedEntry(20, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
        },
      }),
    ];

    expect(foldGroupLabel(entries)).toBe("2 items");
    expect(splitFoldSubgroups(entries)).toEqual([{ kind: "items", entries }]);
    expect(foldGroupNeedsOuterFold(entries)).toBe(false);
  });

  // thinking が混在する run では外側 fold が作業全体、items sub-fold が
  // thinking 間の tool 群を表すため階層に意味がある。この場合は二段を保つ。
  test("thinking-separated tool runs keep the meaningful outer fold", () => {
    const entries = [
      parsedEntry(1, {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "tool_use", name: "Bash", input: {} }] },
      }),
      parsedEntry(2, {
        type: "assistant",
        message: { role: "assistant", content: [{ type: "thinking", thinking: "inspect" }] },
      }),
      parsedEntry(3, {
        type: "user",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
        },
      }),
    ];
    expect(splitFoldSubgroups(entries).map((group) => group.kind)).toEqual([
      "items",
      "direct",
      "items",
    ]);
    expect(foldGroupNeedsOuterFold(entries)).toBe(true);
  });
});

// extractCcmsgMessages (webui Timeline chat-bubble task, kawaz spec):
// recovers ccmsg room messages (`type:"msg"` events) embedded inside a
// system-injected "type:user" line, regardless of which wrapper carries them
// — a Task-tool `teammate-message` relay, or a Monitor-tool
// `task-notification`'s `<event>` jsonl body. Fixtures below use
// parseTranscriptLine (not hand-built ParsedLine) so the text actually goes
// through parseSegments/classifyUserMessage the same way a live transcript
// line would.
describe("extractCcmsgMessages", () => {
  // 何を保証するか (実データ回帰): Claude Code が mid=99 の Monitor event を
  // `"seq":102...(truncated)` で切り、その後に返信指示行を続けた実 transcript
  // でも、復元可能な u1 本文を room 不明の ccmsg bubble として残す。fixture の
  // message.content は報告対象 jsonl 行からそのまま採取した。
  test("the actual mid=99 truncated task-notification yields a u1 ccmsg bubble", () => {
    const actualMid99TranscriptLine = JSON.stringify({
      type: "user",
      message: {
        role: "user",
        content:
          '<task-notification>\n<task-id>baxep3rq2</task-id>\n<summary>Monitor event: "ccmsg 新着メッセージ監視"</summary>\n<event>{"type":"msg","mid":99,"from":"u1","ts":"2026-07-17T04:33:44.888Z","msg":"あるセッションが、Read/Write/Editしたcwd外のファイルを見たい。\\n自由にプロジェクト外のパスをブラウズしたいわけではない。\\nRead/Write/Editツールで触ったファイルリストからcwd内のものを除外したフルパスリストを表示するセクションがFileツリーに欲しいということです。\\n\\n現在、おきにいり、プロジェクトという2つのセクションがあるが、ここにプロジェクト外というセクションを設けて、セッションが触ったプロジェクト外ファイルのフルパスリストを表示して選択できるようにしたい。\\n当然横幅が足りなくなると思うが、横スクロールバーを付けてくれたら良い。そもそも現在も深いディレクトリや長いファイル名の際に右側が隠れる問題は存在する。スプリッタを右にずらせば広くはできるが限界はあるのでシンプルにセクション内のリストごとに横スクロールができればよいと思う。\\nお気に入り追加も可能となるようにしたい。","seq":102...(truncated)</event>\nIf this event is something the user would act on now, send a PushNotification. Routine or benign output doesn\'t need one.\n</task-notification>',
      },
      timestamp: "2026-07-17T04:33:45.105Z",
      origin: { kind: "task-notification" },
    });

    const msgs = extractCcmsgMessages(parseTranscriptLine(actualMid99TranscriptLine));
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("u1");
    expect(msgs[0]!.room).toBe("?");
    expect(msgs[0]!.msg).toContain(
      "あるセッションが、Read/Write/Editしたcwd外のファイルを見たい。",
    );
    expect(msgs[0]!.msg).toContain("切り詰め");
  });

  // Monitor 通知の <event> は長い msg を「...(truncated)」で切ることがあり、
  // その行は JSON として壊れる (kawaz r17 mid=43 の実観測 — bubble にならず
  // 生 JSON の fold 表示になっていた)。field 順は daemon の stringify 順で
  // 固定なので、切れていても from/ts/r/msg 冒頭を復元して「途中まで +
  // 切り詰め注記」の bubble にする。
  test("a truncated <event> msg line still yields a bubble with the partial text", () => {
    const truncated =
      '{"type":"msg","mid":43,"from":"u1","ts":"2026-07-15T04:02:43.478Z","msg":"[FILE1:スクショ.png](/tmp/x.png)\\nさっき間違えてemeradacoのセッションで1on1送信して...(truncated)';
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `[SYSTEM NOTIFICATION - NOT USER INPUT]\n<task-notification>\n<event>${"{"}"type":"kind","kind":"1on1","ts":"t","seq":1,"r":"r20"}\n${truncated}</event>\n</task-notification>`,
        },
        timestamp: "2026-07-15T04:02:44.000Z",
      }),
    );
    const msgs = extractCcmsgMessages(line);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("u1");
    expect(msgs[0]!.room).toBe("r20");
    expect(msgs[0]!.msg).toContain("さっき間違えて");
    expect(msgs[0]!.msg).toContain("切り詰め");
  });

  // docs/issue/2026-07-17-subscribe-jsonl-msg-last-column.md: daemon の
  // subscribe wire order を `type,mid,from,ts,to?,r,seq,reply_via?,msg`
  // (msg が必ず最後) に変更したことで、`r` が msg より前に来るようになった。
  // 同居 event の無い単独 msg 通知が切れても、fallbackRoom に頼らず断片自身の
  // `r` から room を復元できることを固定する (旧順では `r` が msg の後ろに
  // あり truncation でほぼ確実に失われていた — 上のテストの fallbackRoom
  // 依存はその名残)。
  test("new wire order: a truncated standalone msg notification recovers room from its own `r` (no fallback needed)", () => {
    const truncated =
      '{"type":"msg","mid":110,"from":"a1","ts":"2026-07-17T04:33:44.888Z","r":"r30","seq":42,"reply_via":"Use `ccmsg reply r30m109 <msg>`","msg":"a very long message body that keeps going and going...(truncated)';
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `<task-notification>\n<event>${truncated}</event>\n</task-notification>`,
        },
        timestamp: "2026-07-17T04:33:45.000Z",
      }),
    );
    const msgs = extractCcmsgMessages(line);
    expect(msgs.length).toBe(1);
    expect(msgs[0]!.from).toBe("a1");
    expect(msgs[0]!.room).toBe("r30");
    expect(msgs[0]!.msg).toContain("a very long message body");
    expect(msgs[0]!.msg).toContain("切り詰め");
  });

  // 対極 (誤爆防止): truncated marker があっても msg event でない行や、
  // from/ts/msg のいずれかを復元できない断片は bubble にしない。
  test("a truncated non-msg or msg missing identity fields stays out of bubbles", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            '<task-notification>\n<event>{"type":"member","id":"a1","sid":"x...(truncated)\n{"type":"msg","from":"u1","msg":"no timestamp...(truncated)</event>\n</task-notification>',
        },
        timestamp: "2026-07-15T04:02:44.000Z",
      }),
    );
    expect(extractCcmsgMessages(line)).toEqual([]);
  });

  function userLine(content: string): ParsedLine {
    return parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content } }),
    );
  }

  test("msg_via frame becomes a lazy-read placeholder keyed by room and mid", () => {
    const msgEvent = {
      type: "msg",
      mid: 38,
      from: "a3",
      r: "r35",
      ts: "2026-07-19T01:00:00.000Z",
      reply_via: "Use `ccmsg reply r35m38 <msg>`",
      msg_via: "Use `ccmsg read r35m38`",
    };
    const line = userLine(
      `<task-notification>\n<event>${JSON.stringify(msgEvent)}</event>\n</task-notification>`,
    );
    expect(extractCcmsgMessages(line)).toEqual([
      {
        from: "a3",
        to: undefined,
        room: "r35",
        msg: "",
        ts: "2026-07-19T01:00:00.000Z",
        mid: 38,
      },
    ]);
  });

  test("teammate-message body is a ccmsg type:msg event -> one CcmsgMessage", () => {
    const msgEvent = {
      type: "msg",
      mid: 12,
      from: "a3",
      r: "r7",
      ts: "2026-07-12T01:00:00.000Z",
      msg: "レビュー終わりました",
    };
    const line = userLine(
      `Another Claude session sent a message:\n<teammate-message teammate_id="reviewer" color="blue">\n${JSON.stringify(msgEvent)}\n</teammate-message>\n\nThis came from another Claude session...`,
    );
    expect(extractCcmsgMessages(line)).toEqual([
      {
        from: "a3",
        to: undefined,
        room: "r7",
        msg: "レビュー終わりました",
        ts: "2026-07-12T01:00:00.000Z",
        mid: 12,
      },
    ]);
  });

  // idle_notification (実観測パターン) は type:"msg" ではないので除外 — 従来
  // 通り fold されるべき (吹き出し化しない)。
  test("teammate-message body is an idle_notification -> excluded (not a msg event)", () => {
    const idleEvent = {
      type: "idle_notification",
      from: "a3",
      timestamp: "2026-07-12T01:00:00.000Z",
      idleReason: "available",
    };
    const line = userLine(
      `Another Claude session sent a message:\n<teammate-message teammate_id="a3" color="blue">\n${JSON.stringify(idleEvent)}\n</teammate-message>\n\nThis came from another Claude session...`,
    );
    expect(extractCcmsgMessages(line)).toEqual([]);
  });

  test("task-notification <event> jsonl body with a single type:msg line -> one CcmsgMessage", () => {
    const msgEvent = {
      type: "msg",
      mid: 3,
      from: "u1",
      to: ["a1"],
      r: "r2",
      ts: "2026-07-12T02:00:00.000Z",
      msg: "確認して",
    };
    const line = userLine(
      `<task-notification>\n<task-id>x</task-id>\n<summary>Monitor event</summary>\n<event>${JSON.stringify(msgEvent)}</event>\nIf this event is something the user would act on now...\n</task-notification>`,
    );
    expect(extractCcmsgMessages(line)).toEqual([
      {
        from: "u1",
        to: ["a1"],
        room: "r2",
        msg: "確認して",
        ts: "2026-07-12T02:00:00.000Z",
        mid: 3,
      },
    ]);
  });

  // ccmsg subscribe の Monitor は stdout 1 行 = 1 event の jsonl を出す —
  // 複数行 (複数 msg) が同じ <event> ブロックにまとまって来ることがある。
  test("task-notification <event> body with multiple type:msg jsonl lines -> multiple CcmsgMessages", () => {
    const e1 = { type: "msg", mid: 1, from: "a1", r: "r1", ts: "t1", msg: "one" };
    const e2 = { type: "msg", mid: 2, from: "a2", r: "r1", ts: "t2", msg: "two" };
    const line = userLine(
      `<task-notification>\n<event>${JSON.stringify(e1)}\n${JSON.stringify(e2)}</event>\n</task-notification>`,
    );
    expect(extractCcmsgMessages(line)).toEqual([
      { from: "a1", to: undefined, room: "r1", msg: "one", ts: "t1", mid: 1 },
      { from: "a2", to: undefined, room: "r1", msg: "two", ts: "t2", mid: 2 },
    ]);
  });

  // ccmsg と無関係な task-notification (通常の Monitor イベント文言、JSON
  // ですらない) は空 — 従来通り fold される。
  test("a task-notification unrelated to ccmsg (plain event text) -> empty", () => {
    const line = userLine(
      "<task-notification>\n<task-id>x</task-id>\n<event>[run:change] workflow:CI status:success</event>\nIf this event is something the user would act on now...\n</task-notification>",
    );
    expect(extractCcmsgMessages(line)).toEqual([]);
  });

  // <event> の中身が JSON として壊れている場合は例外を投げず空 fallback。
  test("malformed JSON inside <event> -> empty, no throw", () => {
    const line = userLine("<task-notification>\n<event>{not json\n</event>\n</task-notification>");
    expect(() => extractCcmsgMessages(line)).not.toThrow();
    expect(extractCcmsgMessages(line)).toEqual([]);
  });

  // タグそのものが無い通常のユーザ発話は当然空。
  test("a real user prompt with no teammate-message/task-notification tag -> empty", () => {
    expect(extractCcmsgMessages(userLine("hello"))).toEqual([]);
  });

  // 既知の false-negative (extractCcmsgMessages doc comment 参照): msg 値
  // 自体が閉じタグと同じ literal 文字列を含むと、非貪欲 regex がそこで
  // マッチを終えてしまい、切り詰められた fragment の JSON.parse が失敗
  // する。仕様限界として固定 — throw せず空 fallback (行ごと従来 fold) に
  // なることだけを保証する。
  test("msg value containing the literal closing tag text truncates the match -> falls back to empty, no throw", () => {
    const msgEvent = {
      type: "msg",
      from: "u1",
      r: "r1",
      ts: "t1",
      msg: "見て </event> ここ",
    };
    const line = userLine(
      `<task-notification>\n<event>${JSON.stringify(msgEvent)}</event>\n</task-notification>`,
    );
    expect(() => extractCcmsgMessages(line)).not.toThrow();
    expect(extractCcmsgMessages(line)).toEqual([]);
  });

  // assistant turn / meta / broken line は role:"user" ではない (or turn です
  // らない) ので常に空。
  test("assistant turn -> empty (not role:user)", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    );
    expect(extractCcmsgMessages(line)).toEqual([]);
  });

  test("meta line -> empty", () => {
    expect(
      extractCcmsgMessages(parseTranscriptLine(JSON.stringify({ type: "queue-operation" }))),
    ).toEqual([]);
  });

  test("broken line -> empty", () => {
    expect(extractCcmsgMessages(parseTranscriptLine("{not json"))).toEqual([]);
  });

  // DR-0027 §2: 抽出は (r, mid, from, ts) の同定に軽量化されたので、subscribe/
  // teammate-message wrappers 由来の CcmsgMessage は mid を含む (isCcmsgMsgEventLike
  // で拾えている限り)。Timeline.tsx が (room, mid) で ws.read → 完全版を lazy
  // 取得する経路のキーになる — 抽出段で mid を落とすと read-fallback が動かない。
  test("DR-0027: wrapper-parsed CcmsgMessage carries `mid` from the source event", () => {
    const msgEvent = {
      type: "msg",
      mid: 77,
      from: "a1",
      r: "r10",
      ts: "2026-07-18T00:00:00Z",
      msg: "carry mid",
    };
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `<task-notification>\n<event>${JSON.stringify(msgEvent)}</event>\n</task-notification>`,
        },
      }),
    );
    const msgs = extractCcmsgMessages(line);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.mid).toBe(77);
  });

  // DR-0027 §2 (truncated fragment 経路): 現行の wire order (msg が最後) では
  // mid は truncation の手前に必ずあるので、切れた fragment からでも拾えて
  // 完全版 read の canonical key を確保できる — 切り詰め本文の bubble も後で
  // daemon 一次情報で置き換わる。
  test("DR-0027: truncated fragment recovers `mid` before the truncation point", () => {
    const truncated =
      '{"type":"msg","mid":110,"from":"a1","ts":"2026-07-17T04:33:44.888Z","r":"r30","seq":42,"reply_via":"Use `ccmsg reply r30m109 <msg>`","msg":"a long body...(truncated)';
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `<task-notification>\n<event>${truncated}</event>\n</task-notification>`,
        },
      }),
    );
    const msgs = extractCcmsgMessages(line);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.mid).toBe(110);
  });

  // 対極 (DR-0027 §2.1): canonical lookup key は (r, mid) の組。旧 wire order
  // (`type,mid,from,ts,msg,...` — msg が中程で r が末尾側) の truncated
  // fragment では r が truncation で失われ room="?" になる。この場合 mid を
  // 付けると (a) ws.read("?", [mid]) の無意味な発火 (実 daemon 実測で確認)、
  // (b) dedup key "?|mN" が room を跨いで同 mid の別メッセージと偽衝突する。
  // room 不明の fragment は mid なし = 救済 parse 本文だけの最終フォールバック。
  test("DR-0027: room-less truncated fragment (old wire order) drops `mid` — no canonical key without a room", () => {
    const truncated =
      '{"type":"msg","mid":99,"from":"u1","ts":"2026-07-17T04:33:44.888Z","msg":"a long body cut before the r field...(truncated)';
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `<task-notification>\n<event>${truncated}</event>\n</task-notification>`,
        },
      }),
    );
    const msgs = extractCcmsgMessages(line);
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.room).toBe("?");
    expect(msgs[0]!.mid).toBeUndefined();
    // 本文の救済 parse は従来通り生きている (最終フォールバック)。
    expect(msgs[0]!.msg).toContain("a long body cut before the r field");
  });
});

// DR-0027 §2.2 (送信側 tool_result 検出): AI が Bash 経由で叩いた `ccmsg
// post`/`ccmsg reply` の response (`{"ok":true,"room":"rN","mid":M}`) を
// tool_result content から拾って placeholder CcmsgMessage にする — from/msg
// は空、実本文は CcmsgBubble が (room, mid) で lazy read する。実 tool_result
// 形状は 2026-07-16 の bbc718cd セッション transcript で観測 (line 184、
// {"ok":true,"room":"r25","mid":2})。
describe("extractCcmsgToolResultRefs", () => {
  function userToolResultLine(text: string, isError = false, ts: string | null = null): ParsedLine {
    return {
      kind: "turn",
      ts,
      role: "user",
      segments: [{ kind: "tool-result", toolUseId: "toolu_x", isError, text }],
    };
  }

  test("plain ccmsg post response -> one ref with (room, mid), from/msg empty, ts from line", () => {
    const line = userToolResultLine(
      '{"ok":true,"room":"r25","mid":2}',
      false,
      "2026-07-18T01:00:00Z",
    );
    expect(extractCcmsgToolResultRefs(line)).toEqual([
      { from: "", room: "r25", msg: "", ts: "2026-07-18T01:00:00Z", mid: 2 },
    ]);
  });

  // 実 transcript では stdout 末尾に \n が乗る (toolUseResult.stdout に改行が
  // 保持される)。regex は `\s*$` で許容してあるべき。
  test("response with a trailing newline still matches", () => {
    const line = userToolResultLine('{"ok":true,"room":"r17","mid":68}\n');
    expect(extractCcmsgToolResultRefs(line)).toHaveLength(1);
    expect(extractCcmsgToolResultRefs(line)[0]!.mid).toBe(68);
  });

  // `ccmsg reply` の応答は post と違い daemon が配信先を `to` に付けて返す
  // ({"ok":true,"room":rN,"mid":M,"to":["a1","u1"]} — server.ts の reply
  // handler)。DR-0027 §2.2 は post/reply 両方を TL バブル化の対象とするので
  // この形も (room, mid) ref として拾う。to の中身自体は使わない (lazy read
  // が daemon canonical の to を取ってくる)。
  test("reply response with `to` array also matches (DR-0027 §2.2 covers post AND reply)", () => {
    const line = userToolResultLine(
      '{"ok":true,"room":"r26","mid":84,"to":["a1","u1"]}\n',
      false,
      "2026-07-18T02:00:00Z",
    );
    expect(extractCcmsgToolResultRefs(line)).toEqual([
      { from: "", room: "r26", msg: "", ts: "2026-07-18T02:00:00Z", mid: 84 },
    ]);
  });

  // 単一要素の to (1on1 の reply 等) も同様。
  test("reply response with a single-element `to` matches", () => {
    const line = userToolResultLine('{"ok":true,"room":"r5","mid":3,"to":["u1"]}');
    expect(extractCcmsgToolResultRefs(line)).toHaveLength(1);
  });

  // 対極: to 以外の追加キーを持つ {ok,room,mid,...} 形 (無関係な daemon op の
  // 応答等) は reject — 未知キーを許すと誤爆面が広がる。
  test("response with an unknown extra key -> empty (strict shape)", () => {
    const line = userToolResultLine('{"ok":true,"room":"r5","mid":3,"seq":9}');
    expect(extractCcmsgToolResultRefs(line)).toEqual([]);
  });

  // 対極 (誤爆防止): エラー response `{"ok":false,...}` は拾わない。
  test("failure response {ok:false,error:...} -> empty (not matched)", () => {
    const line = userToolResultLine(
      '{"ok":false,"error":{"code":"not_a_member","msg":"not a member of r17"}}',
    );
    expect(extractCcmsgToolResultRefs(line)).toEqual([]);
  });

  // 対極: is_error:true な tool_result は content が response 形でも拾わない
  // (Bash が exit non-zero を返した状況、副作用としての post 成功でも扱わない)。
  test("is_error=true tool_result -> empty even if content matches the shape", () => {
    const line = userToolResultLine('{"ok":true,"room":"r25","mid":2}', true);
    expect(extractCcmsgToolResultRefs(line)).toEqual([]);
  });

  // 対極: `2>&1` などで前後にノイズが混ざったら strict 検出は空 (誤爆回避)。
  test("noisy content (mixed with other output) -> empty", () => {
    const line = userToolResultLine(
      'Exit code 1\n{"ok":true,"room":"r25","mid":2}\nsome trailing help',
    );
    expect(extractCcmsgToolResultRefs(line)).toEqual([]);
  });

  // 対極: text segment のみの user turn (通常のプロンプト等) は空。
  test("user turn with only text segments -> empty", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    );
    expect(extractCcmsgToolResultRefs(line)).toEqual([]);
  });

  test("assistant turn -> empty", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    );
    expect(extractCcmsgToolResultRefs(line)).toEqual([]);
  });

  // 複数 tool_result が同じ turn にバッチされている場合 (Anthropic API 慣習)、
  // ccmsg post response と非関連 tool_result が並ぶ — ccmsg のものだけ拾う。
  test("mixed batch: only ccmsg-shaped tool_results become refs", () => {
    const line: ParsedLine = {
      kind: "turn",
      ts: "2026-07-18T00:00:00Z",
      role: "user",
      segments: [
        { kind: "tool-result", toolUseId: "t1", isError: false, text: "unrelated ls output" },
        {
          kind: "tool-result",
          toolUseId: "t2",
          isError: false,
          text: '{"ok":true,"room":"r5","mid":9}',
        },
        {
          kind: "tool-result",
          toolUseId: "t3",
          isError: false,
          text: '{"ok":true,"room":"r6","mid":10}',
        },
      ],
    };
    const refs = extractCcmsgToolResultRefs(line);
    expect(refs).toHaveLength(2);
    expect(refs.map((r) => [r.room, r.mid])).toEqual([
      ["r5", 9],
      ["r6", 10],
    ]);
  });
});

// DR-0027 §2.2 統合: extractCcmsgMessages は tool_result 検出結果と wrapper
// 抽出結果の両方を返し、Timeline.tsx が同一 boundary の bubble 列として描画
// できる。ccmsgDedupKey が (room, mid) canonical キーを返すので、tool_result
// 由来の placeholder と subscribe teammate-message 由来の完全 event が同じ
// (room, mid) を持つ場合は 1 件に collapse される (kawaz r15 mid=21 dedup の
// 拡張、DR-0027 §2.2)。
describe("DR-0027 dedup: (room, mid) canonical key collapses send-side + receive-side echoes", () => {
  test("ccmsgDedupKey uses `${room}|m${mid}` when mid is present", () => {
    const m: CcmsgMessage = { from: "a1", room: "r5", msg: "", ts: "", mid: 42 };
    expect(ccmsgDedupKey(m)).toBe("r5|m42");
  });

  test("ccmsgDedupKey falls back to the ts|from|msg form when mid is absent (pre-DR-0027 shape)", () => {
    const m: CcmsgMessage = { from: "u1", room: "r5", msg: "hi", ts: "t" };
    expect(ccmsgDedupKey(m)).toBe("r5|t|u1|hi");
  });

  test("tool_result placeholder and wrapper-parsed message with same (room, mid) collapse", () => {
    const placeholder: CcmsgMessage = { from: "", room: "r5", msg: "", ts: "ts1", mid: 42 };
    const wrapperParsed: CcmsgMessage = {
      from: "a1",
      room: "r5",
      msg: "hello",
      ts: "ts2",
      mid: 42,
    };
    expect(ccmsgDedupKey(placeholder)).toBe(ccmsgDedupKey(wrapperParsed));
  });
});

// classifyBoundaryLine (webui Timeline chat-bubble task, kawaz spec): the
// single source of truth both `isBoundaryLine` (fold/no-fold split) and
// Timeline.tsx (which bubble to render) key off of. Only the "ccmsg" branch
// is new here — "user-prompt"/"assistant-response" are already covered by
// the isUserTextTurn/groupTimelineLines describe blocks above via
// isBoundaryLine's behavior.
describe("userNavTargets", () => {
  function ccmsgLine(message: CcmsgMessage): ParsedLine {
    const event = {
      type: "msg",
      mid: 1,
      from: message.from,
      r: message.room,
      ts: message.ts,
      msg: message.msg,
    };
    return parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Another Claude session sent a message:\n<teammate-message teammate_id="${message.from}">\n${JSON.stringify(event)}\n</teammate-message>`,
        },
      }),
    );
  }

  test("returns one target for every rendered green bubble in document order", () => {
    const userCcmsg = { from: "u1", room: "r1", ts: "t1", msg: "via ccmsg" };
    const lines = [userText("prompt"), ccmsgLine(userCcmsg), assistantText("done")];
    const groups = groupTimelineLines(lines, [10, 20, 30]);

    expect(userNavTargets(groups)).toEqual([
      { key: "user:10", offset: 10, kind: "user-prompt" },
      { key: "ccmsg:20:0", offset: 20, kind: "ccmsg", messageIndex: 0 },
    ]);
  });

  test("excludes duplicate and non-user ccmsg bubbles exactly as rendering does", () => {
    const userCcmsg = { from: "u1", room: "r1", ts: "t1", msg: "same message" };
    const agentCcmsg = { from: "a1", room: "r1", ts: "t2", msg: "agent message" };
    const lines = [
      ccmsgLine(userCcmsg),
      ccmsgLine(agentCcmsg),
      ccmsgLine(userCcmsg),
      userText("prompt"),
    ];
    const groups = groupTimelineLines(lines, [10, 20, 30, 40]);

    expect(userNavTargets(groups)).toEqual([
      { key: "ccmsg:10:0", offset: 10, kind: "ccmsg", messageIndex: 0 },
      { key: "user:40", offset: 40, kind: "user-prompt" },
    ]);
  });
});

describe("classifyBoundaryLine", () => {
  test("a system-origin line carrying a ccmsg type:msg event -> {kind:'ccmsg', messages:[...]}", () => {
    const msgEvent = { type: "msg", mid: 1, from: "a1", r: "r1", ts: "t1", msg: "hi" };
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Another Claude session sent a message:\n<teammate-message teammate_id="a1">\n${JSON.stringify(msgEvent)}\n</teammate-message>`,
        },
      }),
    );
    expect(classifyBoundaryLine(line)).toEqual({
      kind: "ccmsg",
      messages: [{ from: "a1", to: undefined, room: "r1", msg: "hi", ts: "t1", mid: 1 }],
    });
  });

  // ccmsg メッセージを含む行は groupTimelineLines でも境界 (standalone
  // entry) として扱われる — fold group の中に埋もれない。
  test("a ccmsg-carrying line stands alone as a boundary in groupTimelineLines, not folded", () => {
    const msgEvent = { type: "msg", mid: 1, from: "a1", r: "r1", ts: "t1", msg: "hi" };
    const ccmsgLine = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Another Claude session sent a message:\n<teammate-message teammate_id="a1">\n${JSON.stringify(msgEvent)}\n</teammate-message>`,
        },
      }),
    );
    const lines = [userText("go"), ccmsgLine, assistantText("done")];
    const offsets = [0, 1, 2];
    expect(groupTimelineLines(lines, offsets)).toEqual([
      { kind: "entry", offset: 0, line: lines[0] },
      { kind: "entry", offset: 1, line: ccmsgLine },
      { kind: "entry", offset: 2, line: lines[2] },
    ]);
  });

  test("a real user prompt -> {kind:'user-prompt'}", () => {
    const line = parseTranscriptLine(
      JSON.stringify({ type: "user", message: { role: "user", content: "hello" } }),
    );
    expect(classifyBoundaryLine(line)).toEqual({ kind: "user-prompt" });
  });

  test("an assistant text turn -> {kind:'assistant-response'}", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [{ type: "text", text: "done" }] },
      }),
    );
    expect(classifyBoundaryLine(line)).toEqual({ kind: "assistant-response" });
  });

  test("a non-boundary line (thinking-only assistant turn) -> null", () => {
    expect(classifyBoundaryLine(assistantThinking("hmm"))).toBeNull();
  });
});

// stripAnsiEscapes (U2 rich display task): strips ANSI CSI escape sequences
// (color codes etc.) from a `<local-command-stdout>` body before it renders
// as plain <pre> text (kawaz spec: 「ANSI エスケープ除去」).
describe("stripAnsiEscapes", () => {
  test("SGR color codes are removed, plain text kept", () => {
    // \x1b[32m = green, \x1b[0m = reset — a typical colored-stdout snippet.
    expect(stripAnsiEscapes("\x1b[32mOK\x1b[0m done")).toBe("OK done");
  });

  test("text with no escape sequences is returned unchanged", () => {
    expect(stripAnsiEscapes("plain text, no color")).toBe("plain text, no color");
  });

  test("multiple sequences in one string are all removed", () => {
    expect(stripAnsiEscapes("\x1b[1m\x1b[31mBOLD RED\x1b[0m\x1b[39m")).toBe("BOLD RED");
  });

  // DEC private mode CSI (adversarial review finding, 2026-07-12): the `?` prefix
  // byte (0x3F) is a CSI parameter byte per ECMA-48, same class as digits/`;` —
  // spinner-style CLIs commonly emit `\x1b[?25l` / `\x1b[?25h` to hide/show the
  // cursor around a progress animation. A regex whose parameter-byte class was
  // narrowed to `[0-9;]` (missing `?`) would leave these in the rendered <pre>.
  test("DEC private mode CSI (cursor hide/show) is removed", () => {
    expect(stripAnsiEscapes("\x1b[?25lLoading...\x1b[?25hdone")).toBe("Loading...done");
  });
});

// parseSystemMessageFields (U2 kawaz spec: システムメッセージ details 展開の
// rich タブ). Covers each kind's representative shape, a missing-field
// variant, and malformed input — the three axes the delegation asked for
// ("各タイプの代表 + 壊れた入力 + フィールド欠落"). Never throws for any
// input (module doc comment) — every test below also asserts that directly.
//
// Naming mismatch note (see transcript-model.ts's parseSystemMessageFields
// doc comment): the delegation spec calls this kind "teammate-message", but
// classifyUserMessage's actual UserMessageKind for a `<teammate-message>`-
// wrapped body is "peer-message" — tests below use the real kind name.
describe("parseSystemMessageFields", () => {
  describe("task-notification", () => {
    // Representative case: task-id/summary/event/output-file all present
    // (output-file per the delegation spec's field list, not observed in any
    // sampled real transcript but the generic XML-child-tag scan picks it up
    // the same way as task-id/summary/event with no dedicated code path).
    test("full fixture -> summary promoted to heading, remaining fields listed (excluding summary)", () => {
      const raw =
        "<task-notification>\n<task-id>b0f9a5r1q</task-id>\n<summary>Monitor event</summary>\n<event>[run:change] status:success</event>\n<output-file>/tmp/out.jsonl</output-file>\n</task-notification>";
      expect(() => parseSystemMessageFields("task-notification", raw)).not.toThrow();
      expect(parseSystemMessageFields("task-notification", raw)).toEqual({
        display: "fields",
        heading: "Monitor event",
        fields: [
          { name: "task-id", value: "b0f9a5r1q" },
          { name: "event", value: "[run:change] status:success" },
          { name: "output-file", value: "/tmp/out.jsonl" },
        ],
      });
    });

    // フィールド欠落: summary が無い -> heading は null (「見出しなし」を
    // 明示的に表す、空文字列に丸めない)。
    test("no <summary> tag -> heading null, other fields still listed", () => {
      const raw = "<task-notification>\n<task-id>x</task-id>\n</task-notification>";
      expect(parseSystemMessageFields("task-notification", raw)).toEqual({
        display: "fields",
        heading: null,
        fields: [{ name: "task-id", value: "x" }],
      });
    });

    // フィールド欠落 (極端形): 子タグが1つも無い -> fields:[] (SystemMessageRichView
    // が「(フィールドなし)」を出す入力)。
    test("no child tags at all -> empty fields array, heading null", () => {
      const raw =
        "<task-notification>\nIf this event is something the user would act on now...\n</task-notification>";
      expect(parseSystemMessageFields("task-notification", raw)).toEqual({
        display: "fields",
        heading: null,
        fields: [],
      });
    });

    // 壊れた入力: 閉じタグが無い (切り詰められた transcript 行等) —
    // unwrapOuterTag が outer wrapper を見つけられず null を返すので、
    // rawText 全体を対象に子タグ探索する fallback に落ちる。それでも
    // 独立して閉じている <task-id> は拾える (throw しない、部分的に有用な
    // 結果を返す)。
    test("missing closing </task-notification> tag -> no throw, still recovers well-formed child tags", () => {
      const raw = "<task-notification>\n<task-id>abc</task-id>\n<summary>unterminated";
      expect(() => parseSystemMessageFields("task-notification", raw)).not.toThrow();
      expect(parseSystemMessageFields("task-notification", raw)).toEqual({
        display: "fields",
        heading: null,
        fields: [{ name: "task-id", value: "abc" }],
      });
    });

    // 壊れた入力 (最悪形): タグが全く無いプレーンテキスト -> fields:[] のまま
    // (throw しない)。
    test("no tags at all (plain garbage text) -> empty fields, no throw", () => {
      expect(() => parseSystemMessageFields("task-notification", "not xml at all")).not.toThrow();
      expect(parseSystemMessageFields("task-notification", "not xml at all")).toEqual({
        display: "fields",
        heading: null,
        fields: [],
      });
    });
  });

  // peer-message: teammate-message / agent-message を共通の受信表示へ正規化し、
  // 実観測した JSON 制御メッセージは用途別に要約する。
  describe("peer-message", () => {
    test("teammate-message text -> peer display with sender and summary", () => {
      const raw =
        'Another Claude session sent a message:\n<teammate-message teammate_id="poc5" color="blue" summary="調査完了">\n本文\n</teammate-message>\n\nThis came from another Claude session...';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        from: "poc5",
        summary: "調査完了",
        category: "message",
        body: "本文",
      });
    });

    test("idle_notification JSON -> compact idle category", () => {
      const idleEvent = { type: "idle_notification", from: "a3", idleReason: "available" };
      const raw = `<teammate-message teammate_id="a3">${JSON.stringify(idleEvent)}</teammate-message>`;
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        from: "a3",
        summary: null,
        category: "idle",
        body: "待機通知 · available",
      });
    });

    test("task_assignment JSON -> task title and description", () => {
      const raw =
        '<teammate-message teammate_id="worker">{"type":"task_assignment","subject":"実装","description":"テストも追加"}</teammate-message>';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        from: "worker",
        summary: null,
        category: "task-assignment",
        body: "実装\nテストも追加",
      });
    });

    test("agent-message from attribute -> same peer display", () => {
      const raw = '<agent-message from="reviewer">確認結果です</agent-message>';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        from: "reviewer",
        summary: null,
        category: "message",
        body: "確認結果です",
      });
    });

    test("unrecognized JSON event -> unknown category with pretty-printed body", () => {
      const event = { type: "future_event", detail: "保持する" };
      const raw = `<agent-message from="future">${JSON.stringify(event)}</agent-message>`;
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        from: "future",
        summary: null,
        category: "unknown",
        body: JSON.stringify(event, null, 2),
      });
    });

    test("no attributes on the opening tag -> fallback agent identity", () => {
      const raw = "<teammate-message>\nhi\n</teammate-message>";
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        from: "agent",
        summary: null,
        category: "message",
        body: "hi",
      });
    });

    // 壊れた入力: <teammate-message> タグ自体が無い (将来の別 peer-message
    // 変種) -> text フォールバック、rawText がそのまま保持される (raw タブと
    // 同じ内容になる = 情報を失わない)。
    test("no <teammate-message> tag at all -> text fallback carrying the raw text unchanged", () => {
      const raw = "Another Claude session sent a message: some future shape with no tag";
      expect(() => parseSystemMessageFields("peer-message", raw)).not.toThrow();
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({ display: "text", text: raw });
    });
  });

  // spawn-prompt: agent 転写の先頭 user 行 (kawaz r46m28)。team-lead 経由の
  // spawn は <teammate-message> wrapper で来るので peer 表示 (from/summary) に
  // 載る。通常の Agent tool 直接呼び出しは plain text で来るので text 表示に
  // 落とす。両ケースで壊れず表示できることを保証する。
  describe("spawn-prompt", () => {
    test("<teammate-message> wrapper (team-lead spawn) -> peer display with from + body", () => {
      const raw =
        '<teammate-message teammate_id="team-lead" summary="translate bug">TL 翻訳バグを調査してください。</teammate-message>';
      expect(parseSystemMessageFields("spawn-prompt", raw)).toMatchObject({
        display: "peer",
        from: "team-lead",
        summary: "translate bug",
      });
    });

    test("plain text (bare Agent tool spawn) -> text display carrying the raw prompt unchanged", () => {
      const raw = "~/.claude/skills/thorough-review/reviewers/api-design.md を読み...";
      expect(parseSystemMessageFields("spawn-prompt", raw)).toEqual({ display: "text", text: raw });
    });
  });

  describe("slash-command-invocation", () => {
    // Representative case observed in classifyUserMessage's own test fixture:
    // command-name + command-message (no command-args).
    test("command-name + command-message -> chip label '/model', detail from command-message", () => {
      const raw = "<command-name>/model</command-name>\n<command-message>model</command-message>";
      expect(parseSystemMessageFields("slash-command-invocation", raw)).toEqual({
        display: "chip",
        label: "/model",
        detail: "model",
      });
    });

    // command-args がある場合は command-message より優先 (kawaz spec:
    // 「<command-name>/<command-args> をチップ風に」— args がより「実際に
    // 打たれた引数」に近いため message より優先表示する判断)。
    test("command-args takes priority over command-message when both are present", () => {
      const raw =
        "<command-name>/deploy</command-name>\n<command-args>--env staging</command-args>\n<command-message>deploy</command-message>";
      expect(parseSystemMessageFields("slash-command-invocation", raw)).toEqual({
        display: "chip",
        label: "/deploy",
        detail: "--env staging",
      });
    });

    // フィールド欠落: command-name だけ (引数なしのスラッシュコマンド) ->
    // detail は null。
    test("command-name only (no args/message) -> detail null", () => {
      const raw = "<command-name>/clear</command-name>";
      expect(parseSystemMessageFields("slash-command-invocation", raw)).toEqual({
        display: "chip",
        label: "/clear",
        detail: null,
      });
    });

    // 壊れた入力: command-name タグ自体が無い -> text フォールバック。
    test("missing <command-name> tag -> text fallback, no throw", () => {
      const raw = "<command-message>something without a name tag</command-message>";
      expect(() => parseSystemMessageFields("slash-command-invocation", raw)).not.toThrow();
      expect(parseSystemMessageFields("slash-command-invocation", raw)).toEqual({
        display: "text",
        text: raw,
      });
    });
  });

  describe("slash-command-stdout", () => {
    test("wrapped stdout -> unwrapped text, ANSI stripped", () => {
      const raw = "<local-command-stdout>Set model to \x1b[1mFable 5\x1b[0m</local-command-stdout>";
      expect(parseSystemMessageFields("slash-command-stdout", raw)).toEqual({
        display: "text",
        text: "Set model to Fable 5",
      });
    });

    // フィールド欠落/壊れた入力扱い: ラッパータグが無い (閉じタグ欠落等) ->
    // unwrapOuterTag が null を返すので rawText 全体を text として使う
    // (ANSI ストリップは引き続き適用、throw しない)。
    test("missing wrapper tag -> falls back to the raw text itself, still ANSI-stripped, no throw", () => {
      const raw = "\x1b[32mSet model to Fable 5\x1b[0m";
      expect(() => parseSystemMessageFields("slash-command-stdout", raw)).not.toThrow();
      expect(parseSystemMessageFields("slash-command-stdout", raw)).toEqual({
        display: "text",
        text: "Set model to Fable 5",
      });
    });
  });

  // system-caveat / その他 (kawaz spec bullet 5: 「定型文はそのまま <pre>
  // (rich と raw が同じでもタブは出して構造統一)」) — 専用レイアウトを持たない
  // 全 kind (system-caveat 自身に加え、tool-retry-hint / user-interrupt-marker
  // / unknown-meta / unknown-array / skill-invocation-preamble / tool-result /
  // kind 自体が undefined の場合) が同じ text フォールバックに落ちることを
  // 確認する。
  describe("fallback kinds (no dedicated layout) -> text carrying the raw text unchanged", () => {
    const raw =
      "<local-command-caveat>Caveat: The messages below were generated by the user while running local commands.";

    test.each([
      "system-caveat",
      "tool-retry-hint",
      "user-interrupt-marker",
      "unknown-meta",
      "unknown-array",
      "skill-invocation-preamble",
      "tool-result",
    ] as const)("kind '%s' -> {display:'text', text: rawText}", (kind) => {
      expect(() => parseSystemMessageFields(kind, raw)).not.toThrow();
      expect(parseSystemMessageFields(kind, raw)).toEqual({ display: "text", text: raw });
    });

    // kind が undefined (parseTranscriptLine を通らない手組み ParsedLine 等)
    // でも同じ fallback、throw しない。
    test("kind undefined -> text fallback, no throw", () => {
      expect(() => parseSystemMessageFields(undefined, raw)).not.toThrow();
      expect(parseSystemMessageFields(undefined, raw)).toEqual({ display: "text", text: raw });
    });

    // 空文字列 (segments が空、または text セグメントが無い line からの
    // 呼び出し — SystemMessageBody の rawText 計算が "" を渡すケース) も
    // throw しない。
    test("empty rawText -> text fallback with empty text, no throw", () => {
      expect(() => parseSystemMessageFields("system-caveat", "")).not.toThrow();
      expect(parseSystemMessageFields("system-caveat", "")).toEqual({ display: "text", text: "" });
    });
  });
});
