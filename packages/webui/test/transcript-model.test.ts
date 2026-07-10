// transcript-model unit tests (DR-0009): guards the pure jsonl-line -> render
// event fold that Timeline.tsx's effect calls into. Line shapes below mirror
// what a real Claude Code transcript jsonl contains (checked against a live
// personal-project transcript during implementation), not a guess — but per
// DR-0009's "jsonl フォーマットの安定性" note, the module must never assume
// only these shapes exist, hence the explicit unknown-type/unknown-segment
// coverage.
import { describe, expect, test } from "bun:test";
import {
  lineByteOffsets,
  parseTranscriptLine,
  type Segment,
} from "../src/client/transcript-model.ts";

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
