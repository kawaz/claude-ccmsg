// transcript-model unit tests (DR-0009): guards the pure jsonl-line -> render
// event fold that Timeline.tsx's effect calls into. Line shapes below mirror
// what a real Claude Code transcript jsonl contains (checked against a live
// personal-project transcript during implementation), not a guess — but per
// DR-0009's "jsonl フォーマットの安定性" note, the module must never assume
// only these shapes exist, hence the explicit unknown-type/unknown-segment
// coverage.
import { describe, expect, test } from "bun:test";
import {
  foldGroupLabel,
  groupTimelineLines,
  isUserTextTurn,
  lineByteOffsets,
  parseTranscriptLine,
  scrollPositionToUserTurnIndex,
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
      { kind: "tool-use", name: "Bash", input: { command: "ls" } },
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
// definition of "ユーザ発言" for both the chat-bubble styling and the
// "👤 N/M" nav counter — a tool_result-only "user" line must count as neither.
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
  // API-shaped turns): the presence of *any* text segment is enough to count
  // as a real utterance — "tool_result は除く" excludes the tool_result
  // segment from bubble styling, not the whole turn from the counter.
  test("user turn with text + tool_result -> true (has at least one text segment)", () => {
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
    expect(isUserTextTurn(line)).toBe(true);
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

// foldGroupLabel (webui Timeline "tools folding" UI improvement, kawaz spec):
// "▶︎ N tools" vs "▶︎ N items" wording — "tools" only when every folded entry
// is a tool-use/tool-result-only turn line, "items" for a mixed group
// (thinking / meta / broken lines involved).
describe("foldGroupLabel", () => {
  function entry(offset: number, line: ParsedLine): TimelineEntry {
    return { offset, line };
  }

  test("all tool-use/tool-result entries -> 'N tools'", () => {
    const entries = [
      entry(0, assistantToolUse("Bash")),
      entry(1, userToolResult("tu_1")),
      entry(2, assistantToolUse("Read")),
    ];
    expect(foldGroupLabel(entries)).toBe("3 tools");
  });

  test("a thinking entry mixed in -> 'N items' (not 'tools')", () => {
    const entries = [entry(0, assistantThinking("hmm")), entry(1, assistantToolUse("Bash"))];
    expect(foldGroupLabel(entries)).toBe("2 items");
  });

  test("a meta line mixed in -> 'N items'", () => {
    const entries = [entry(0, assistantToolUse("Bash")), entry(1, metaLine("mode-change"))];
    expect(foldGroupLabel(entries)).toBe("2 items");
  });

  test("single tool entry -> '1 tools' (count reflects entry count, not pluralization)", () => {
    expect(foldGroupLabel([entry(0, assistantToolUse("Bash"))])).toBe("1 tools");
  });
});
