// transcript-model unit tests (DR-0009): guards the pure jsonl-line -> render
// event fold that Timeline.tsx's effect calls into. Line shapes below mirror
// what a real Claude Code transcript jsonl contains (checked against a live
// personal-project transcript during implementation), not a guess — but per
// DR-0009's "jsonl フォーマットの安定性" note, the module must never assume
// only these shapes exist, hence the explicit unknown-type/unknown-segment
// coverage.
import { describe, expect, test } from "bun:test";
import {
  classifyBoundaryLine,
  classifyUserMessage,
  extractCcmsgMessages,
  foldGroupLabel,
  groupTimelineLines,
  isUserTextTurn,
  lineByteOffsets,
  parseSystemMessageFields,
  parseTranscriptLine,
  scrollPositionToUserTurnIndex,
  stripAnsiEscapes,
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
// definition of "ユーザ発言" for the chat-bubble styling, the "👤 N/M" nav
// counter, and (U2) groupTimelineLines' boundary test — a tool_result-only
// "user" line, or (U2) any other classifyUserMessage verdict besides
// "user-prompt", must count as none of the three. See the dedicated
// "system-origin user messages fold (U2)" describe block below for the
// classification-driven cases (teammate-message etc.); this block covers the
// pre-existing segment-shape cases.
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

// foldGroupLabel (webui Timeline display-unification task, kawaz spec,
// 2026-07-12 revision): "N thinkings + M items" wording — thinking-only
// entries are counted out on their own noun ("thinkings"), every other
// folded entry kind (tool_use/tool_result/meta/broken) is lumped into the
// generic "items" count. Supersedes the previous "N tools"/"N items" split
// (tool_use/tool_result no longer get their own noun — kawaz: 「▶ 3
// thinkings + 10 items」).
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

  // Every entry is thinking-only -> "N thinkings", no "+ 0 items" suffix.
  test("every entry is thinking-only -> 'N thinkings' (no '+ 0 items')", () => {
    const entries = [entry(0, assistantThinking("a")), entry(1, assistantThinking("b"))];
    expect(foldGroupLabel(entries)).toBe("2 thinkings");
  });

  // Mixed: one thinking + one non-thinking -> "1 thinkings + 1 items".
  test("thinking mixed with a non-thinking entry -> 'N thinkings + M items'", () => {
    const entries = [entry(0, assistantThinking("hmm")), entry(1, assistantToolUse("Bash"))];
    expect(foldGroupLabel(entries)).toBe("1 thinkings + 1 items");
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

  // Multiple thinkings + multiple items together -> both counts shown.
  test("multiple thinkings + multiple items -> both counts", () => {
    const entries = [
      entry(0, assistantThinking("a")),
      entry(1, assistantThinking("b")),
      entry(2, assistantToolUse("Bash")),
      entry(3, metaLine("mode-change")),
    ];
    expect(foldGroupLabel(entries)).toBe("2 thinkings + 2 items");
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

// extractCcmsgMessages (webui Timeline chat-bubble task, kawaz spec):
// recovers ccmsg room messages (`type:"msg"` events) embedded inside a
// system-injected "type:user" line, regardless of which wrapper carries them
// — a Task-tool `teammate-message` relay, or a Monitor-tool
// `task-notification`'s `<event>` jsonl body. Fixtures below use
// parseTranscriptLine (not hand-built ParsedLine) so the text actually goes
// through parseSegments/classifyUserMessage the same way a live transcript
// line would.
describe("extractCcmsgMessages", () => {
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

  // 対極 (誤爆防止): truncated marker があっても msg event でない行 (kind 等)
  // や、必須 field (r) が切り落とされた断片は bubble にしない。
  test("a truncated non-msg or r-less fragment stays out of bubbles", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content:
            '<task-notification>\n<event>{"type":"member","id":"a1","sid":"x...(truncated)</event>\n</task-notification>',
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
      { from: "u1", to: ["a1"], room: "r2", msg: "確認して", ts: "2026-07-12T02:00:00.000Z" },
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
      { from: "a1", to: undefined, room: "r1", msg: "one", ts: "t1" },
      { from: "a2", to: undefined, room: "r1", msg: "two", ts: "t2" },
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
});

// classifyBoundaryLine (webui Timeline chat-bubble task, kawaz spec): the
// single source of truth both `isBoundaryLine` (fold/no-fold split) and
// Timeline.tsx (which bubble to render) key off of. Only the "ccmsg" branch
// is new here — "user-prompt"/"assistant-response" are already covered by
// the isUserTextTurn/groupTimelineLines describe blocks above via
// isBoundaryLine's behavior.
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
      messages: [{ from: "a1", to: undefined, room: "r1", msg: "hi", ts: "t1" }],
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

  // peer-message (デリゲーション spec の "teammate-message" — 上のファイル
  // コメント参照): <teammate-message teammate_id=... color=...> ラッパーの
  // 属性 + ボディを整形。
  describe("peer-message", () => {
    test("representative fixture -> attrs + plain-text body as fields", () => {
      const raw =
        'Another Claude session sent a message:\n<teammate-message teammate_id="poc5" color="blue">\n本文\n</teammate-message>\n\nThis came from another Claude session...';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "fields",
        heading: null,
        fields: [
          { name: "teammate_id", value: "poc5" },
          { name: "color", value: "blue" },
          { name: "body", value: "本文" },
        ],
      });
    });

    // ボディが JSON (例: idle_notification イベント) なら pretty-print される
    // (kawaz spec: 「ボディが JSON なら pretty-print」)。type:"msg" イベント
    // は classifyBoundaryLine が先に ccmsg 境界として吹き出し化するのでここ
    // には来ない (transcript-model.ts のドキュメントコメント参照) —
    // idle_notification のような non-msg イベントが代表例。
    test("JSON body (e.g. idle_notification) is pretty-printed, not left as one line", () => {
      const idleEvent = { type: "idle_notification", from: "a3", idleReason: "available" };
      const raw = `Another Claude session sent a message:\n<teammate-message teammate_id="a3" color="blue">\n${JSON.stringify(idleEvent)}\n</teammate-message>\n\nThis came from another Claude session...`;
      const result = parseSystemMessageFields("peer-message", raw);
      expect(result.display).toBe("fields");
      if (result.display !== "fields") return;
      const bodyField = result.fields.find((f) => f.name === "body");
      expect(bodyField?.value).toBe(JSON.stringify(idleEvent, null, 2));
    });

    // フィールド欠落: 属性なし (teammate_id/color 無し) でもボディだけの
    // fields で描画できる。
    test("no attributes on the opening tag -> only a body field", () => {
      const raw = "<teammate-message>\nhi\n</teammate-message>";
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "fields",
        heading: null,
        fields: [{ name: "body", value: "hi" }],
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
