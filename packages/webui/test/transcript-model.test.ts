// transcript-model unit tests (DR-0009): guards the pure jsonl-line -> render
// event fold that Timeline.tsx's effect calls into. Line shapes below mirror
// what a real Claude Code transcript jsonl contains (checked against a live
// personal-project transcript during implementation), not a guess — but per
// DR-0009's "jsonl フォーマットの安定性" note, the module must never assume
// only these shapes exist, hence the explicit unknown-type/unknown-segment
// coverage.
import { describe, expect, test } from "bun:test";
import {
  attachmentDetail,
  parseNumberedSnippet,
  ccmsgDedupKey,
  ccmsgMessageCount,
  ccmsgRenderTargets,
  classifyAssistantMessage,
  classifyBoundaryLine,
  classifyUserMessage,
  extractCcmsgMessages,
  foldGroupLabel,
  foldGroupNeedsOuterFold,
  groupTimelineLines,
  isAgentCommunicationSegment,
  isApiErrorLine,
  isCacheKeepaliveReplyLine,
  isDirectFoldEntry,
  isPeerMessageLine,
  agentCommunicationCount,
  isSearchableSegment,
  isUserTextTurn,
  itemRawSourceOffsets,
  lineByteOffsets,
  parseBashInputText,
  parseBashOutputText,
  parseSystemMessageFields,
  pairQueuedTurns,
  parseTranscriptLine,
  resolveToolResults,
  parseTranscriptLines,
  rawTranscriptRows,
  truncateRawLine,
  RAW_LINE_PREVIEW_LIMIT,
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
  return {
    kind: "turn",
    ts: null,
    role: "user",
    segments: [{ kind: "text", role: "user", text }],
  };
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
  return {
    kind: "turn",
    ts: null,
    role: "assistant",
    segments: [{ kind: "thinking", text }],
  };
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
function bashUse(toolUseId: string, command: string): Segment {
  return {
    kind: "bash-use",
    toolUseId,
    command,
    description: "",
    background: false,
    result: null,
    hasResult: false,
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

// rawTranscriptRows (r55m68): Timeline の raw 表示のモデル。rich 表示が
// 集約 (複数行 -> 1 fold) や分解 (1 行 -> 複数 ccmsg バブル) をするのに対し、
// raw は「キャッシュ済みの行が 1 行ずつ、ファイル順に、原文のまま」を保証
// する — それが raw 表示の存在理由なので、その 1:1 性をテストで固定する。
describe("rawTranscriptRows", () => {
  test("各行に byte offset と 1 始まりの位置を付けて返す", () => {
    expect(rawTranscriptRows(100, ["ab", "cde"])).toEqual([
      { offset: 100, index: 1, text: "ab", bytes: 2 },
      { offset: 103, index: 2, text: "cde", bytes: 3 },
    ]);
  });

  test("空配列は空配列", () => {
    expect(rawTranscriptRows(42, [])).toEqual([]);
  });

  // bytes は文字数ではなく UTF-8 バイト長 ("あ" = 3 バイト)。offset の加算も
  // 同じ基準なので、両者が食い違うと gutter の表示と実ファイル位置がずれる。
  test("bytes は UTF-8 バイト長 (文字数ではない)", () => {
    expect(rawTranscriptRows(0, ["あ", "b"])).toEqual([
      { offset: 0, index: 1, text: "あ", bytes: 3 },
      { offset: 4, index: 2, text: "b", bytes: 1 },
    ]);
  });

  // 「1 行 = 1 行」の核心: rich 側が畳む・割る・降格する行 (JSON として壊れて
  // いる行を含む) でも、raw は解釈せず原文をそのまま 1 件ずつ出す。
  test("パースせず原文をそのまま保持する (壊れた JSON 行も 1 行として出る)", () => {
    const lines = ['{"type":"user"}', "{ broken", ""];
    const rows = rawTranscriptRows(0, lines);
    expect(rows.length).toBe(lines.length);
    expect(rows.map((r) => r.text)).toEqual(lines);
    expect(rows.map((r) => r.index)).toEqual([1, 2, 3]);
  });

  // offset は lineByteOffsets と同一の値でなければならない — rich 側の
  // Preact key がこの値なので、ずれると raw の行と rich のバブルを
  // 突き合わせるという raw 表示の狙いが崩れる。
  test("offset は rich 側の Preact key (lineByteOffsets) と一致する", () => {
    const lines = ["あ", "bc", "{}"];
    const rows = rawTranscriptRows(7, lines);
    expect(rows.map((r) => r.offset)).toEqual(lineByteOffsets(7, lines));
  });
});

// itemRawSourceOffsets (r55 m89): 項目ごとの jsonl トグルが「この項目は
// どの行から作られたか」を引く対応表。rich 表示は 1 行 = 1 項目とは限らない
// (tool_use + tool_result で 2 行 -> 1 カード、1 行 -> 複数 ccmsg バブル) の
// で、その 3 通りの輪郭を固定する。
describe("itemRawSourceOffsets", () => {
  // 一番普通のケース: 表示される項目はどれも自分の行だけを指す。
  test("1 対 1 の行はそれぞれ自分の offset だけを持つ", () => {
    const lines = [userText("hi"), assistantText("yo")];
    const offsets = [0, 100];
    expect(itemRawSourceOffsets(lines, offsets)).toEqual(
      new Map([
        [0, [0]],
        [100, [100]],
      ]),
    );
  });

  // kawaz r55 m69 の要件「両方の行を見せる」: tool_use のカードに畳み込まれた
  // tool_result 行は groupTimelineLines が表示から落とすので、tool_use 側の
  // 項目が両方の行を引けないと生 JSONL に到達する手段が無くなる。
  test("カードに畳まれた tool_result は tool_use 側の項目に両方の行として付く", () => {
    const lines = resolveFileToolResults([
      {
        kind: "turn",
        ts: null,
        role: "assistant",
        segments: [bashUse("t1", "ls")],
      },
      userToolResult("t1"),
    ]);
    const offsets = [0, 50];
    const sources = itemRawSourceOffsets(lines, offsets);
    expect(sources.get(0)).toEqual([0, 50]);
    // 畳まれた側は独立した項目としては描画されないので、自分のキーを持たない。
    expect(sources.has(50)).toBe(false);
  });

  // kawaz r76 m87: `! <cmd>` のカードは jsonl トグルが入力行しか出さず、畳まれた
  // 出力行が webui から到達できなかった。tool_use ペアと同じ扱いになることを固定する
  // (相関 id が無いので所有者は隣接 = 直前の行)。
  test("カードに畳まれた `! <cmd>` の出力行も入力行側の項目に両方の行として付く", () => {
    const bashLine = (kind: "bash-command-invocation" | "bash-command-stdout", text: string) =>
      ({
        kind: "turn",
        ts: null,
        role: "user",
        userMessageKind: kind,
        segments: [{ kind: "text", role: "user", text }],
      }) satisfies ParsedLine;
    const lines = resolveToolResults([
      bashLine("bash-command-invocation", "<bash-input>ls</bash-input>"),
      bashLine("bash-command-stdout", "<bash-stdout>bin</bash-stdout><bash-stderr></bash-stderr>"),
    ]);
    const sources = itemRawSourceOffsets(lines, [0, 40]);
    expect(sources.get(0)).toEqual([0, 40]);
    expect(sources.has(40)).toBe(false);
  });

  // 相方の来なかった出力行は単独の項目として描画される (hasCommand が立たない)
  // ので、自分の行を自分で引く — 引き取り手を探して消えたりしない。
  test("ペアにならなかった出力行は自分の offset を持つ", () => {
    const orphan = {
      kind: "turn",
      ts: null,
      role: "user",
      userMessageKind: "bash-command-stdout",
      segments: [{ kind: "text", role: "user", text: "<bash-stdout>bin</bash-stdout>" }],
    } satisfies ParsedLine;
    expect(itemRawSourceOffsets(resolveToolResults([orphan]), [9])).toEqual(new Map([[9, [9]]]));
  });

  // 1 行から複数バブル (ccmsg メッセージが複数載った 1 行) はどのバブルも
  // 同じ offset を引く — 呼び出し側が同じキーで引くだけで済むよう、対応表側に
  // バブルごとのエントリは作らない。
  test("1 行から複数バブルが出ても対応表は行単位のまま", () => {
    const lines = [userText("multi ccmsg line")];
    const sources = itemRawSourceOffsets(lines, [7]);
    expect(sources.get(7)).toEqual([7]);
    expect(sources.size).toBe(1);
  });

  // tool_use が読み込み範囲外 (load older 前) の tool_result は、rich 表示側も
  // 既に落としている — 引き取り先が無いので対応表にも現れない。
  test("対応する tool_use が範囲外の tool_result はどこにも付かない", () => {
    const lines = resolveFileToolResults([userToolResult("orphan")]);
    // bash-use が居ないので bash-result への昇格が起きず、tool-result のまま
    // = isConsumedToolResult ではない (単独の項目として描画される)。
    expect(itemRawSourceOffsets(lines, [12])).toEqual(new Map([[12, [12]]]));
  });

  test("空入力は空の対応表", () => {
    expect(itemRawSourceOffsets([], [])).toEqual(new Map());
  });
});

// truncateRawLine (r55m68): 貼り付け画像等で 1 行が数 MB の base64 になる
// ケースがあり、全行を全長描画すると raw 切替の瞬間にレイアウトが固まる。
describe("truncateRawLine", () => {
  test("limit 以下はそのまま (truncated=false)", () => {
    expect(truncateRawLine("abc", 5)).toEqual({
      text: "abc",
      truncated: false,
    });
  });

  test("limit 超過は limit 文字に切って truncated=true", () => {
    expect(truncateRawLine("abcdef", 3)).toEqual({
      text: "abc",
      truncated: true,
    });
  });

  test("ちょうど limit 丁度は切らない (境界)", () => {
    expect(truncateRawLine("abc", 3)).toEqual({
      text: "abc",
      truncated: false,
    });
  });

  // サロゲートペアの途中で切ると片割れが U+FFFD になって化ける。切り口が
  // high surrogate なら 1 つ手前まで下げる。"😀" は 2 code unit。
  test("サロゲートペアの途中では切らない", () => {
    const emoji = "😀"; // 2 code units
    const result = truncateRawLine("a" + emoji + "b", 2);
    // limit=2 は "a" + high surrogate の位置 — 1 下げて "a" だけにする。
    expect(result.text).toBe("a");
    expect(result.truncated).toBe(true);
    // 壊れた文字 (置換文字) が出ていないこと。
    expect(result.text).not.toContain("�");
  });

  test("既定の limit は RAW_LINE_PREVIEW_LIMIT", () => {
    const long = "x".repeat(RAW_LINE_PREVIEW_LIMIT + 10);
    expect(truncateRawLine(long)).toEqual({
      text: "x".repeat(RAW_LINE_PREVIEW_LIMIT),
      truncated: true,
    });
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
      {
        kind: "tool-result",
        toolUseId: "tu_1",
        isError: false,
        text: "42 files",
      },
    ]);
  });

  // is_error flag must survive into the segment so the UI can flag it.
  test("tool_result with is_error:true -> isError true", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_2",
              is_error: true,
              content: "boom",
            },
          ],
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
              input: {
                to: "reviewer",
                summary: "確認依頼",
                message: "見てください",
              },
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
              input: {
                recipient: "worker",
                content: "進めて",
                type: "message",
              },
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
      result: null,
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
            {
              type: "tool_use",
              id: "tu_read",
              name: "Read",
              input: { file_path: "a.ts" },
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
            {
              type: "tool_result",
              tool_use_id: "tu_read",
              content: "1\\talpha",
            },
          ],
        },
        toolUseResult: {
          type: "text",
          file: { filePath: "a.ts", content: "alpha\n" },
        },
      }),
    );
    const resolved = resolveFileToolResults([use, result]);
    expect(resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null).toEqual({
      kind: "file-read",
      toolUseId: "tu_read",
      path: "a.ts",
      offset: null,
      limit: null,
      result: { kind: "text", content: "alpha\n" },
    });
    expect(groupTimelineLines(resolved, [10, 20])).toEqual([
      { kind: "fold", entries: [{ offset: 10, line: resolved[0] }] },
    ]);
  });

  // 画像ファイルの Read は toolUseResult に file.content を持たず、base64 +
  // mime + 表示寸法だけが載る (実測 2026-07-30、ローカルの session corpus で
  // Read 結果 254 件中 15 件)。text 前提のままだと結果なし扱いになり、カードが
  // 「(空のファイル)」+「範囲外」を出したうえに、300KB の base64 が独立した
  // tool_result fold として TL に並ぶ (kawaz r76 m90 の報告)。
  test("画像 Read の結果は image として Read カードに畳まれる", () => {
    const use = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_img",
              name: "Read",
              input: { file_path: "/tmp/shot.png" },
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
            {
              type: "tool_result",
              tool_use_id: "tu_img",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    data: "iVBOR",
                    media_type: "image/png",
                  },
                },
              ],
            },
          ],
        },
        toolUseResult: {
          type: "image",
          file: {
            base64: "iVBOR",
            type: "image/png",
            originalSize: 91572,
            dimensions: {
              originalWidth: 1776,
              originalHeight: 287,
              displayWidth: 888,
              displayHeight: 143,
            },
          },
        },
      }),
    );
    const resolved = resolveFileToolResults([use, result]);
    expect(resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null).toEqual({
      kind: "file-read",
      toolUseId: "tu_img",
      path: "/tmp/shot.png",
      offset: null,
      limit: null,
      // 寸法は base64 側の実寸 (harness が縮小した後の display 寸法)。
      result: {
        kind: "image",
        mediaType: "image/png",
        base64: "iVBOR",
        width: 888,
        height: 143,
      },
    });
    // 結果行は Read カードに畳まれ、単独の tool_result としては描画されない。
    expect(groupTimelineLines(resolved, [10, 20])).toEqual([
      { kind: "fold", entries: [{ offset: 10, line: resolved[0] }] },
    ]);
  });

  // toolUseResult サイドカーが無い行 (別バージョンの harness) でも、
  // tool_result ブロック自身が同じ base64 を持っているので画像として出す。
  test("toolUseResult が無くても tool_result の image ブロックから読む", () => {
    const use = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_img2",
              name: "Read",
              input: { file_path: "/tmp/a.gif" },
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
            {
              type: "tool_result",
              tool_use_id: "tu_img2",
              content: [
                {
                  type: "image",
                  source: {
                    type: "base64",
                    data: "R0lGOD",
                    media_type: "image/gif",
                  },
                },
              ],
            },
          ],
        },
      }),
    );
    const resolved = resolveFileToolResults([use, result]);
    const segment = resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null;
    expect(segment?.kind === "file-read" ? segment.result : null).toEqual({
      kind: "image",
      mediaType: "image/gif",
      base64: "R0lGOD",
      width: null,
      height: null,
    });
  });

  // 失敗した Read ("File does not exist.") は file payload を持たないので
  // 汎用 tool_result として届く。カード側に畳まないと「結果は読み込み範囲外」
  // と誤報しつつ、理由が別項目に分かれて出る。
  test("失敗した Read の結果は error として Read カードに畳まれる", () => {
    const use = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              id: "tu_err",
              name: "Read",
              input: { file_path: "/tmp/gone.png" },
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
            {
              type: "tool_result",
              tool_use_id: "tu_err",
              is_error: true,
              content: "File does not exist.",
            },
          ],
        },
      }),
    );
    const resolved = resolveFileToolResults([use, result]);
    const segment = resolved[0]?.kind === "turn" ? resolved[0].segments[0] : null;
    expect(segment?.kind === "file-read" ? segment.result : null).toEqual({
      kind: "error",
      message: "File does not exist.",
    });
    expect(groupTimelineLines(resolved, [10, 20])).toEqual([
      { kind: "fold", entries: [{ offset: 10, line: resolved[0] }] },
    ]);
  });

  // 対応する Read が読み込み範囲外なら畳む先が無い — エラーは単独の
  // tool_result 項目として見えたままにする (握りつぶさない)。
  test("Read が範囲外のエラー tool_result は単独項目として残る", () => {
    const result = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "tu_orphan",
              is_error: true,
              content: "File does not exist.",
            },
          ],
        },
      }),
    );
    const resolved = resolveFileToolResults([result]);
    expect(resolved[0]?.kind === "turn" ? resolved[0].segments[0]?.kind : null).toBe("tool-result");
    expect(groupTimelineLines(resolved, [10])).toEqual([
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
            {
              type: "tool_result",
              tool_use_id: "tu_bg",
              is_error: true,
              content: "failed",
            },
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
            {
              type: "tool_use",
              id: "tu_pending",
              name: "Bash",
              input: { command: "job" },
            },
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

  // API の display:"omitted" (thinking:"" + signature) と redacted_thinking は
  // 「思考は起きたが本文が無い」同じ状況。signature は本文の暗号化コピーで
  // 表示に使えないので、segment には持ち込まず reason だけを残す。
  test("a body-less thinking block becomes thinking-hidden and drops the signature", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        timestamp: "t",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "", signature: "CAISugIKiAEIEBgC" },
            { type: "thinking", thinking: "   \n  ", signature: "sig" },
            { type: "redacted_thinking", data: "EncryptedBlob" },
          ],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.segments).toEqual([
      { kind: "thinking-hidden", reason: "omitted" },
      { kind: "thinking-hidden", reason: "omitted" },
      { kind: "thinking-hidden", reason: "redacted" },
    ]);
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
            {
              type: "tool_use",
              id: "tu_1",
              name: "Bash",
              input: { command: "ls" },
            },
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

// A queued message is written to the transcript twice: once as a bare
// `queue-operation` enqueue row (content only — no promptSource/origin/isMeta)
// and again as the `type:"user"` row that delivered it, which is the copy
// carrying the metadata classifyUserMessage needs. Fixtures below are reduced
// from the kuu 38095e85 transcript (2026-07-25), where the harness notice at
// lines 1357/1361 rendered as a green user bubble because only the metadata-
// less queued copy reached the classifier.
// Timeline.tsx does not call parseTranscriptLines: to avoid re-parsing the
// whole transcript on every live-tail append it parses lines one at a time
// (caching the ones that did not change) and runs the cross-line pairing pass
// separately. That split is only safe while the two spellings agree, including
// on the pairing that reaches across lines.
describe("parseTranscriptLines / per-line + cross-line split", () => {
  test("parsing line by line and pairing afterwards matches the whole-window call", () => {
    const raws = [
      JSON.stringify({
        type: "queue-operation",
        operation: "enqueue",
        timestamp: "t1",
        content: "hello",
      }),
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
        timestamp: "t2",
        promptSource: "system",
        origin: { kind: "task-notification" },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "hi" },
        timestamp: "t3",
      }),
      "{ not json",
    ];
    expect(pairQueuedTurns(raws.map(parseTranscriptLine), raws)).toEqual(
      parseTranscriptLines(raws),
    );
  });
});

describe("parseTranscriptLines / queued-vs-delivered pairing", () => {
  const STOPPED = '2 background agents were stopped by the user: "worker-a", "worker-b".';
  const enqueue = (content: string) =>
    JSON.stringify({
      type: "queue-operation",
      operation: "enqueue",
      timestamp: "2026-07-25T07:30:44.555Z",
      content,
    });
  const delivered = (content: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      type: "user",
      message: { role: "user", content },
      timestamp: "2026-07-25T07:30:44.593Z",
      ...extra,
    });

  // The reported bug: the queued copy classified as user-prompt (green
  // bubble) while the delivered row right after it was already folded as a
  // task-notification. Only the metadata-bearing copy may survive as a turn.
  test("a harness notice delivered with system metadata folds its queued copy", () => {
    const lines = parseTranscriptLines([
      enqueue(STOPPED),
      delivered(STOPPED, {
        promptSource: "system",
        origin: { kind: "task-notification" },
        queuePriority: "later",
      }),
    ]);
    expect(lines[0]).toEqual({
      kind: "meta",
      ts: "2026-07-25T07:30:44.555Z",
      type: "queue-operation",
      summary: "queue-operation: enqueue",
      raw: enqueue(STOPPED),
    });
    const kept = lines[1]!;
    expect(kept.kind).toBe("turn");
    if (kept.kind !== "turn") return;
    expect(kept.userMessageKind).toBe("task-notification");
    expect(isUserTextTurn(kept)).toBe(false);
  });

  // The opposite edge: a real prompt the user typed while Claude was busy is
  // queued and delivered exactly the same way, so the pass must not eat it —
  // the delivered copy stays the green bubble.
  test("a real queued human prompt keeps exactly one user-prompt turn", () => {
    const lines = parseTranscriptLines([
      enqueue("スキル見える？"),
      delivered("スキル見える？", {
        promptSource: "queued",
        origin: { kind: "human" },
      }),
    ]);
    expect(lines[0]!.kind).toBe("meta");
    const kept = lines[1]!;
    expect(kept.kind).toBe("turn");
    if (kept.kind !== "turn") return;
    expect(kept.userMessageKind).toBe("user-prompt");
    expect(isUserTextTurn(kept)).toBe(true);
  });

  // A queued prompt the user cancelled before it ran (interrupt pops the
  // queue) has no delivered row at all — 3649 of 12425 sampled enqueues.
  // The queued copy is then the only record of that text and must render.
  test("a queued prompt never delivered stays a rendered turn", () => {
    const lines = parseTranscriptLines([enqueue("pr用のブランチとか")]);
    const only = lines[0]!;
    expect(only.kind).toBe("turn");
    if (only.kind !== "turn") return;
    expect(only.userMessageKind).toBe("user-prompt");
  });

  // The delivered peer relay wraps the queued block in a fixed banner plus a
  // trailing instruction paragraph, so pairing has to compare bodies rather
  // than whole strings (255/255 sampled relays have this exact shape).
  test("a peer relay pairs across the delivered banner and trailer", () => {
    const block = '<agent-message from="tl-impl">\n本文\n</agent-message>';
    const lines = parseTranscriptLines([
      enqueue(block),
      delivered(
        `Another Claude session sent a message:\n${block}\n\nThis came from another Claude session — not typed by your user...`,
        {
          promptSource: "system",
          origin: { kind: "peer" },
        },
      ),
    ]);
    expect(lines[0]!.kind).toBe("meta");
    const kept = lines[1]!;
    expect(kept.kind).toBe("turn");
    if (kept.kind !== "turn") return;
    expect(kept.userMessageKind).toBe("peer-message");
  });

  // Claude Code のネイティブ session 間配送 (SendMessage/ListAgents) も同じ
  // 「queue 済みは裸のタグ / 配送行は banner + 末尾注意書き」形で 2 度書かれる。
  // 閉じタグ一覧に cross-session-message が無いと同じ本文が Timeline に 2 回
  // 出る (queued の裸コピーがそのまま turn として残る)。
  // 実測 (CC 2.1.241): queued コピーの開始タグには `hop-chain` が乗り、配送側は
  // それを落とす (本文はバイト一致)。生ブロック同士の比較ではここで外れて同じ
  // メッセージが Timeline に 2 度出るので、両側とも「送り主 + summary + 本文」
  // に正規化してから突き合わせる。
  test("a cross-session relay pairs even though the queued copy carries hop-chain", () => {
    const body = "\n本文\n";
    const queued = `<cross-session-message from="uds:/tmp/cc-socks/1234.sock" hop-chain="3c221584a9432809c02e4539" from-name="probe" from-mode="prompting">${body}</cross-session-message>`;
    const deliveredBlock = `<cross-session-message from="uds:/tmp/cc-socks/1234.sock" from-name="probe" from-mode="prompting">${body}</cross-session-message>`;
    const lines = parseTranscriptLines([
      enqueue(queued),
      delivered(
        `Another Claude session sent a message:\n${deliveredBlock}\n\nThis came from another Claude session — not typed by your user...`,
        { promptSource: "system", origin: { kind: "peer" } },
      ),
    ]);
    expect(lines[0]!.kind).toBe("meta");
    const kept = lines[1]!;
    expect(kept.kind).toBe("turn");
    if (kept.kind !== "turn") return;
    expect(kept.userMessageKind).toBe("peer-message");
  });

  // 正規化しても「別々の 2 通」は畳まない: 送り主が違えば別の key になる。
  test("two cross-session relays from different peers keep both rows", () => {
    const block = (name: string) =>
      `<cross-session-message from-name="${name}">同じ本文</cross-session-message>`;
    const lines = parseTranscriptLines([
      enqueue(block("probe-a")),
      enqueue(block("probe-b")),
      delivered(`Another Claude session sent a message:\n${block("probe-a")}\n\ntrailer`, {
        promptSource: "system",
        origin: { kind: "peer" },
      }),
    ]);
    // probe-a の queued だけが配送とペアになり、probe-b の queued は残る。
    expect(lines.map((l) => l.kind)).toEqual(["meta", "turn", "turn"]);
  });

  // idle 通知は banner を持たないので本文一致でそのままペアになる。
  test("a cross-session idle notice pairs on its identical body", () => {
    const notice =
      '[Cross-session idle notice] "probe", which you asked to be notified about, is idle now.';
    const lines = parseTranscriptLines([
      enqueue(notice),
      delivered(notice, { promptSource: "system", isMeta: true }),
    ]);
    expect(lines[0]!.kind).toBe("meta");
    const kept = lines[1]!;
    expect(kept.kind).toBe("turn");
    if (kept.kind !== "turn") return;
    expect(kept.userMessageKind).toBe("cross-session-notice");
  });

  // Two genuinely separate sends of the same text must not collapse into one:
  // each queued copy may only cancel against its own delivery.
  test("the same text queued twice keeps both deliveries", () => {
    const lines = parseTranscriptLines([
      enqueue("続けて"),
      delivered("続けて", {
        promptSource: "queued",
        origin: { kind: "human" },
      }),
      enqueue("続けて"),
      delivered("続けて", {
        promptSource: "queued",
        origin: { kind: "human" },
      }),
    ]);
    expect(lines.map((l) => l.kind)).toEqual(["meta", "turn", "meta", "turn"]);
  });

  // Ordering matters: the queue row is written when the message arrives, the
  // user row when it is dequeued. A delivered row that only appears *before*
  // the enqueue is a different send and must not cancel it.
  test("a delivery preceding the enqueue does not cancel it", () => {
    const lines = parseTranscriptLines([
      delivered("もう一回", {
        promptSource: "typed",
        origin: { kind: "human" },
      }),
      enqueue("もう一回"),
    ]);
    expect(lines.map((l) => l.kind)).toEqual(["turn", "turn"]);
  });

  // Index alignment is load-bearing: Timeline.tsx keys every entry by the
  // matching `lineByteOffsets` index, so a paired row is demoted to meta
  // rather than removed from the array.
  test("output stays index-aligned with the input lines", () => {
    const raws = [
      enqueue(STOPPED),
      delivered(STOPPED, {
        promptSource: "system",
        origin: { kind: "task-notification" },
      }),
    ];
    expect(parseTranscriptLines(raws)).toHaveLength(raws.length);
  });

  // Non-queue lines must be untouched by the new pass — same verdict as the
  // single-line entry point for every shape it already handled.
  test("agrees with parseTranscriptLine on lines with no queued copy", () => {
    const raws = [
      delivered("hello", { promptSource: "typed", origin: { kind: "human" } }),
      JSON.stringify({
        type: "queue-operation",
        operation: "dequeue",
        timestamp: "t",
      }),
      "{ not json",
    ];
    expect(parseTranscriptLines(raws)).toEqual(raws.map(parseTranscriptLine));
  });
});

describe("parseTranscriptLine / meta lines (non-turn types)", () => {
  // A type with an `operation` field (queue-operation, observed in a real
  // transcript): summary should surface it without a per-type whitelist.
  test("queue-operation folds to a one-line summary including the operation", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "queue-operation",
        operation: "dequeue",
        timestamp: "t",
      }),
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
      JSON.stringify({
        type: "file-history-snapshot",
        isSnapshotUpdate: true,
        snapshot: {},
      }),
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
        message: {
          role: "assistant",
          content: [{ type: "brand_new_block_kind", foo: "bar" }],
        },
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
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: [] },
      }),
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
    expect(
      segmentSearchText({
        kind: "tool-use",
        name: "Read",
        input: { path: "a.ts" },
      }),
    ).toBe(JSON.stringify({ path: "a.ts" }, null, 2));
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

  // 本文が無い = どのクエリにも当たらないので、ai を on にしても数えない
  // (highlight も scroll 先も無い ghost match になるため)。
  test("a body-less thinking segment is never searchable", () => {
    const seg: Segment = { kind: "thinking-hidden", reason: "omitted" };
    expect(isSearchableSegment(seg, ALL_ON)).toBe(false);
    expect(segmentSearchText(seg)).toBe("");
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
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
      }),
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

  // 本文の無い thinking も「思考した」事実としては同じなので thinking と
  // して数える (items に落とすと fold の内訳が実態とずれる)。
  test("a body-less thinking entry counts as thinking", () => {
    const hidden: ParsedLine = {
      kind: "turn",
      ts: null,
      role: "assistant",
      segments: [{ kind: "thinking-hidden", reason: "omitted" }],
    };
    expect(foldGroupLabel([entry(0, assistantThinking("a")), entry(1, hidden)])).toBe("2 thinking");
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
            {
              type: "tool_use",
              name: "SendMessage",
              input: { to: "worker", message: "go" },
            },
          ],
        },
      }),
    );
    const peer = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          content: '<agent-message from="worker">done</agent-message>',
        },
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

    describe("引数付き slash command (kawaz r244m18)", () => {
      // 実レコード形 (kawaz 提供): /clear に次タスクの本文をそのまま渡した形。
      // 配管ではなくユーザが書いた文章なので、TL では通常のユーザ発話として
      // 扱う (fold に沈めない)。
      const REAL_CONTENT =
        "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>mainロールのスキルロードは省略して良い。8月の勤怠表を出力してください。</command-args>";

      test("非空 command-args -> slash-command-prompt", () => {
        expect(
          classifyUserMessage({
            isMeta: true,
            message: { role: "user", content: REAL_CONTENT },
          }),
        ).toBe("slash-command-prompt");
        // isMeta なしで届く形 (slash-command-invocation と同じ 2 経路) も同じ判定。
        expect(
          classifyUserMessage({
            message: { role: "user", content: REAL_CONTENT },
          }),
        ).toBe("slash-command-prompt");
      });

      test("引数が空 / 空白のみ / タグ自体が無い -> 従来の slash-command-invocation", () => {
        for (const args of ["", "   ", "\n"]) {
          const content = `<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>${args}</command-args>`;
          expect(
            classifyUserMessage({
              isMeta: true,
              message: { role: "user", content },
            }),
          ).toBe("slash-command-invocation");
        }
        expect(
          classifyUserMessage({
            isMeta: true,
            message: {
              role: "user",
              content: "<command-name>/clear</command-name>",
            },
          }),
        ).toBe("slash-command-invocation");
      });

      test("本文が text segment、コマンド名は prefix segment", () => {
        const line = parseTranscriptLine(
          JSON.stringify({
            type: "user",
            uuid: "u-1",
            parentUuid: "p-1",
            isMeta: true,
            timestamp: "2026-09-01T03:02:23.224Z",
            message: { role: "user", content: REAL_CONTENT },
          }),
        );
        expect(line.kind).toBe("turn");
        if (line.kind !== "turn") return;
        expect(line.userMessageKind).toBe("slash-command-prompt");
        expect(line.segments).toEqual([
          { kind: "slash-command-prefix", command: "/clear" },
          {
            kind: "text",
            role: "user",
            text: "mainロールのスキルロードは省略して良い。8月の勤怠表を出力してください。",
          },
        ]);
        // 通常のユーザ発話と同じ扱い = fold されず boundary バブルになる。
        expect(isUserTextTurn(line)).toBe(true);
        expect(classifyBoundaryLine(line)).toEqual({ kind: "user-prompt" });
      });

      test("args に markup が入っていても本文として拾う", () => {
        const content =
          "<command-name>/clear</command-name>\n<command-args>直して: <div>a</div> の件</command-args>";
        expect(classifyUserMessage({ message: { role: "user", content } })).toBe(
          "slash-command-prompt",
        );
      });

      test("引数なし slash command は従来どおり fold 内 (boundary ではない)", () => {
        const line = parseTranscriptLine(
          JSON.stringify({
            type: "user",
            isMeta: true,
            timestamp: "2026-09-01T03:02:23.224Z",
            message: {
              role: "user",
              content:
                "<command-name>/clear</command-name>\n<command-message>clear</command-message>",
            },
          }),
        );
        if (line.kind !== "turn") throw new Error("expected turn");
        expect(line.userMessageKind).toBe("slash-command-invocation");
        expect(isUserTextTurn(line)).toBe(false);
        expect(classifyBoundaryLine(line)).toBeNull();
      });
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

    // TUI の `! <cmd>` (bash モード)。実 transcript では isMeta なしで届く
    // (2026-07-25 実観測)。
    test("<bash-input> without isMeta -> bash-command-invocation", () => {
      const entry = {
        parentUuid: "p",
        message: { role: "user", content: "<bash-input>ls</bash-input>" },
      };
      expect(classifyUserMessage(entry)).toBe("bash-command-invocation");
    });

    test("<bash-stdout> + <bash-stderr> -> bash-command-stdout", () => {
      const entry = {
        parentUuid: "p",
        message: {
          role: "user",
          content: "<bash-stdout>bin\nbun.lock</bash-stdout><bash-stderr></bash-stderr>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("bash-command-stdout");
    });

    // stdout が空で stderr だけ返るケース (コマンド失敗時) も同じ kind。
    test("<bash-stderr>-leading content -> bash-command-stdout", () => {
      const entry = {
        parentUuid: "p",
        message: {
          role: "user",
          content: "<bash-stderr>no such file</bash-stderr>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("bash-command-stdout");
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
            {
              type: "text",
              text: "Base directory for this skill: /path/to/skill\n\n# タスク...",
            },
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
      const entry = {
        isMeta: true,
        message: { role: "user", content: "some future injection" },
      };
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
        message: {
          role: "user",
          content: "<task-notification>\n<task-id>x</task-id>",
        },
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
        message: {
          role: "user",
          content: '<agent-message from="a1">report</agent-message>',
        },
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

    // 「N background agents were stopped by the user: ...」はハーネス注入だが、
    // 本文だけを見て仕分けてはいけない — 配送された type:"user" 行は
    // promptSource:"system" を持ち上の分岐で task-notification になる (実
    // jsonl 確認済み)。本文が同じ文でも meta が無ければ人間の発話として扱う
    // のが正で、二重記録の queue-operation 側は parseTranscriptLines が畳む。
    test("harness-shaped sentence without system metadata stays user-prompt", () => {
      const entry = {
        message: {
          role: "user",
          content: '2 background agents were stopped by the user: "worker-a", "worker-b".',
        },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // Claude Code のネイティブ session 間配送 (SendMessage / ListAgents)。配送行は
    // 既存の relay と同じ banner + `origin.kind:"peer"` を持つので、分類自体は
    // peer-message のまま — 変わるのは中身のパース (from-name / channel) だけ。
    test("a cross-session relay row -> peer-message", () => {
      const entry = {
        type: "user",
        promptSource: "system",
        isMeta: true,
        origin: {
          kind: "peer",
          name: "probe",
          from: "uds:/tmp/cc-socks/1234.sock",
        },
        message: {
          role: "user",
          content:
            'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/1234.sock" from-name="probe" from-mode="prompting">\n本文\n</cross-session-message>\n\nThis came from another Claude session...',
        },
      };
      expect(classifyUserMessage(entry)).toBe("peer-message");
    });

    // 裸の `<cross-session-message>` (queue-operation に書かれる queued コピー) は
    // origin を持たないので、既存 relay タグと同じ prefix 判定で拾う。
    test("bare <cross-session-message> prefix -> peer-message", () => {
      const entry = {
        type: "user",
        message: {
          role: "user",
          content: '<cross-session-message from-name="probe">hi</cross-session-message>',
        },
      };
      expect(classifyUserMessage(entry)).toBe("peer-message");
    });

    // idle 購読の通知は「自セッションの harness が入れた通知」なので相手を指す
    // origin が無い。角括弧ラベルだけが wire 上の signal。
    test("'[Cross-session idle notice]' -> cross-session-notice", () => {
      const entry = {
        type: "user",
        promptSource: "system",
        isMeta: true,
        message: {
          role: "user",
          content:
            '[Cross-session idle notice] "probe", which you asked to be notified about, is idle now — it finished a turn at 10:04.',
        },
      };
      expect(classifyUserMessage(entry)).toBe("cross-session-notice");
    });

    // 同族の別文言 (購読が idle より先に期限切れした場合) も同じ 1 行表示へ。
    // 文言そのものではなく `[Cross-session …]` の形で拾うのは、拾う側を包含的に
    // 書いて「知らない変種は unknown-meta の raw fold」に落とさないため。
    test("a sibling [Cross-session …] notice -> cross-session-notice", () => {
      const entry = {
        type: "user",
        promptSource: "system",
        isMeta: true,
        message: {
          role: "user",
          content:
            '[Cross-session subscription expired] "probe" never went idle within the subscription window.',
        },
      };
      expect(classifyUserMessage(entry)).toBe("cross-session-notice");
    });

    // queued コピーには promptSource / origin / isMeta が一切無い。
    test("a queued cross-session notice with no metadata -> cross-session-notice", () => {
      const entry = {
        type: "user",
        message: {
          role: "user",
          content: '[Cross-session idle notice] "probe" is idle now.',
        },
      };
      expect(classifyUserMessage(entry)).toBe("cross-session-notice");
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
          content: [
            {
              type: "text",
              text: "[Request interrupted by user for tool use]",
            },
          ],
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
        message: {
          role: "user",
          content: [{ type: "some_future_block", foo: "bar" }],
        },
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
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "..." },
            },
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
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "a" },
            },
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "b" },
            },
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
            {
              type: "image",
              source: { type: "base64", media_type: "image/png", data: "a" },
            },
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
        message: {
          role: "user",
          content: "<foo>これはただのユーザ入力です</foo>",
        },
      };
      expect(classifyUserMessage(entry)).toBe("user-prompt");
    });

    // isMeta:true が明示的に false でも同じ扱い (isMeta === true のみが
    // "isMeta 立っている" とみなされる、report のロジック通り)。
    test("isMeta:false with plain text -> user-prompt", () => {
      const entry = {
        isMeta: false,
        message: { role: "user", content: "hello" },
      };
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
        message: {
          role: "user",
          content: "<command-name>/model</command-name>",
        },
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
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
      }),
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

// classifyAssistantMessage / assistantMessageKind wiring: Claude Code writes a
// *synthesized* assistant line when a turn is cut short instead of answered
// (context overflow, API failure, usage limit, ...). It wears the wire
// "assistant" role, so without this classification the Timeline renders the
// CLI's own interruption report as something the agent said (kawaz: 「これを
// 見分けられるようにしたい」). Fixtures below are reduced from real observed
// lines, keeping their wire metadata; the *text* varies freely upstream and is
// never matched on, so each variant must be caught by the flag alone.
describe("classifyAssistantMessage / api-error lines", () => {
  function apiErrorRaw(
    text: string,
    over: { stopReason?: string; error?: string | null } = {},
  ): string {
    const error = over.error === undefined ? "invalid_request" : over.error;
    return JSON.stringify({
      type: "assistant",
      isSidechain: false,
      timestamp: "2026-07-27T10:11:12.000Z",
      message: {
        model: "<synthetic>",
        role: "assistant",
        stop_reason: over.stopReason ?? "stop_sequence",
        content: [{ type: "text", text }],
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
      ...(error === null ? {} : { error }),
      isApiErrorMessage: true,
    });
  }

  // Categorically different upstream shapes. Each (text, error, stop_reason)
  // triple is taken from lines actually present in local transcripts
  // (2026-07-27 sweep of ~/.claude*/projects): across the ~700 flagged lines
  // there, the top-level `error` value takes 8 forms (invalid_request /
  // rate_limit / unknown / authentication_failed / server_error /
  // model_not_found / billing_error / field absent), `stop_reason` two, and
  // the wording differs in every one — the flag is the only invariant, which
  // is exactly why classification reads nothing else.
  const variants: [
    name: string,
    text: string,
    over?: { stopReason?: string; error?: string | null },
  ][] = [
    ["context overflow", "Prompt is too long", { error: "invalid_request" }],
    ["usage limit", "You're out of extra usage · resets 7pm (Asia/Tokyo)", { error: "rate_limit" }],
    [
      "transport failure",
      "API Error: Unable to connect to API (ConnectionRefused)",
      { error: "unknown" },
    ],
    ["login required", "Not logged in · Please run /login", { error: "authentication_failed" }],
    [
      "unparseable tool call (no top-level error field)",
      "The model's tool call could not be parsed (retry also failed).",
      { error: null },
    ],
    [
      "safeguard refusal",
      "API Error: Fable 5's safeguards flagged this message (request id: abc123)",
      { stopReason: "refusal", error: "invalid_request" },
    ],
  ];

  for (const [name, text, over] of variants) {
    test(`${name} -> api-error, text still extracted, boundary renders as api-error`, () => {
      const raw = apiErrorRaw(text, over ?? {});
      expect(classifyAssistantMessage(JSON.parse(raw))).toBe("api-error");

      const line = parseTranscriptLine(raw);
      expect(line.kind).toBe("turn");
      if (line.kind !== "turn") return;
      expect(line.role).toBe("assistant");
      expect(line.assistantMessageKind).toBe("api-error");
      expect(isApiErrorLine(line)).toBe(true);
      // segments 側は従来どおり: 本文は text segment として取れる
      // (ApiErrorNotice がそこから本文を組み立てる)。
      expect(line.segments).toEqual([{ kind: "text", role: "assistant", text }]);
      // text segment を持つので、api-error 判定が無ければ
      // "assistant-response" (= 紫の発話バブル) に落ちていた行。
      expect(classifyBoundaryLine(line)).toEqual({ kind: "api-error" });
    });
  }

  test("an ordinary assistant response -> assistant-response, unchanged boundary", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-5",
          role: "assistant",
          stop_reason: "end_turn",
          content: [{ type: "text", text: "Prompt is too long" }],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    // 同じ文言でも flag が無ければ本物の発話 (文字列マッチ判定でないことの担保)。
    expect(line.assistantMessageKind).toBe("assistant-response");
    expect(isApiErrorLine(line)).toBe(false);
    expect(classifyBoundaryLine(line)).toEqual({ kind: "assistant-response" });
  });

  // ハーネスは error でない合成行も書く (`model:"<synthetic>"` だが
  // `isApiErrorMessage:false`)。ローカル transcript には "No response
  // requested." だけでなく **本物のアシスタント文面**を載せた flag:false の
  // synthetic 行も 300 件超あるので、`<synthetic>` を見て判定すると通常の
  // 発話まで error 扱いになる。
  test("non-error synthetic line (isApiErrorMessage:false) -> assistant-response", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        isApiErrorMessage: false,
        message: {
          model: "<synthetic>",
          role: "assistant",
          stop_reason: "stop_sequence",
          content: [{ type: "text", text: "No response requested." }],
          usage: { input_tokens: 0, output_tokens: 0 },
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.assistantMessageKind).toBe("assistant-response");
    expect(isApiErrorLine(line)).toBe(false);
  });

  test("an assistant turn with only tool_use segments is still assistant-response (not a boundary)", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "Read",
              input: { file_path: "a" },
            },
          ],
        },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.assistantMessageKind).toBe("assistant-response");
    expect(classifyBoundaryLine(line)).toBeNull();
  });

  test("a user line gets no assistantMessageKind (classification never runs for user)", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
      }),
    );
    expect(line.kind).toBe("turn");
    if (line.kind !== "turn") return;
    expect(line.assistantMessageKind).toBeUndefined();
  });

  // api-error 行は fold group に沈めず standalone entry のまま
  // (turn が終わった位置を示す構造的役割は assistant-response と同じ)。
  test("an api-error line stays a standalone boundary entry, splitting the surrounding fold group", () => {
    const thinking = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "hmm" }],
        },
      }),
    );
    const apiError = parseTranscriptLine(apiErrorRaw("Prompt is too long"));
    expect(groupTimelineLines([thinking, apiError], [10, 20])).toEqual([
      { kind: "fold", entries: [{ offset: 10, line: thinking }] },
      { kind: "entry", offset: 20, line: apiError },
    ]);
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
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "real question" },
      }),
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
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "follow-up question" },
      }),
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

// fold group の中身の分類 (kawaz r151 m38 で 2 段目グルーピングを廃止): 開けば
// 全 entry が 1 行ずつ並ぶので、残る判断は「閉じた summary が何と名指すか」
// — thinking / ccmsg / agent 通信は自分のカテゴリ名で、それ以外は「N items」。
describe("isDirectFoldEntry / foldGroupLabel", () => {
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

  // 何を保証するか: thinking は自分のカテゴリで数えられ、間の tool 群は
  // 位置に関係なく単一の items カウントに合流する (run に分かれない)。
  test("thinking is named by category; every tool entry counts into one items tally", () => {
    const entries = [toolEntry(1), toolEntry(2), thinkingEntry(3), toolEntry(4), thinkingEntry(5)];
    expect(entries.map(isDirectFoldEntry)).toEqual([false, false, true, false, true]);
    expect(foldGroupLabel(entries)).toBe("2 thinking + 3 items");
  });

  // 何を保証するか (kawaz r17 mid=49 の実観測): thinking と tool_use が
  // 同一 turn 行に混在するケースは thinking 側 — items に数えると summary が
  // thinking の在処を示せなくなる。
  test("a mixed thinking+tool turn counts as thinking, not items", () => {
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
    expect(isDirectFoldEntry(mixed)).toBe(true);
    expect(foldGroupLabel([toolEntry(1), mixed, toolEntry(3)])).toBe("1 thinking + 2 items");
  });

  // 何を保証するか (境界): 片方のカテゴリしか無い group では、無い側の
  // 項が summary から落ちる。
  test("all-tools labels only items; all-thinking labels only thinking", () => {
    expect(foldGroupLabel([toolEntry(1), toolEntry(2)])).toBe("2 items");
    expect(foldGroupLabel([thinkingEntry(1), thinkingEntry(2)])).toBe("2 thinking");
  });

  test("agent send, spawn, and peer messages are named by category, not counted as items", () => {
    const parsedEntry = (offset: number, raw: Record<string, unknown>): TimelineEntry => ({
      offset,
      line: parseTranscriptLine(JSON.stringify(raw)),
    });
    const send = parsedEntry(2, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "SendMessage",
            input: { to: "worker", message: "go" },
          },
        ],
      },
    });
    const spawn = parsedEntry(4, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            name: "Agent",
            input: { name: "reviewer", prompt: "review" },
          },
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

    // Agent 通信は summary で自分のカテゴリを名乗るが、外側 fold と
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

    expect(entries.map(isDirectFoldEntry)).toEqual([false, true, false, true, false, true, false]);
    expect(foldGroupLabel(entries)).toBe("3 agent messages + 4 items");
    expect(foldGroupNeedsOuterFold(entries)).toBe(true);
  });

  // 何を保証するか (kawaz r76 m49 の実データ形状): subscribe 通知で届く
  // peer 発のルームメッセージ (`<task-notification>` に `<event>` の jsonl が
  // 載る形) は summary で ccmsg として名指される — thinking と同じ扱い。
  // classifyBoundaryLine 側は r55 m14 どおり null (u1 発を含まないので
  // トップレベルの主役バブルにはしない) のままであることも同時に固定する。
  test("a peer-sent ccmsg room message is named as ccmsg, not counted as an item", () => {
    const event = {
      type: "msg",
      mid: 2,
      from: "a2",
      ts: "2026-07-28T12:00:00.000Z",
      to: ["a1"],
      r: "r90",
      seq: 7,
      msg: "届いています",
    };
    const peerCcmsg: TimelineEntry = {
      offset: 2,
      line: parseTranscriptLine(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: `<task-notification>\n<event>${JSON.stringify(event)}</event>\n</task-notification>`,
          },
        }),
      ),
    };
    const entries = [toolEntry(1), peerCcmsg, toolEntry(3)];

    expect(ccmsgMessageCount(peerCcmsg)).toBe(1);
    expect(isDirectFoldEntry(peerCcmsg)).toBe(true);
    expect(classifyBoundaryLine(peerCcmsg.line)).toBeNull();
    expect(foldGroupLabel(entries)).toBe("1 ccmsg + 2 items");
  });

  test("idle_notification peer messages count as plain items", () => {
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
    expect(entries.map(isDirectFoldEntry)).toEqual([false, false, false]);
    expect(foldGroupLabel(entries)).toBe("3 items");
  });

  // The harness batches everything that arrived while the session was busy into
  // one injected turn, so a real report routinely shares a line with idle
  // notifications. Counting the line as idle would hide the report entirely.
  test("a report batched with idle notifications still counts as agent communication", () => {
    const batched: TimelineEntry = {
      offset: 2,
      line: parseTranscriptLine(
        JSON.stringify({
          type: "user",
          message: {
            role: "user",
            content: [
              "Another Claude session sent a message:",
              '<teammate-message teammate_id="a">{"type":"idle_notification","from":"a","idleReason":"available"}</teammate-message>',
              '<teammate-message teammate_id="b" summary="完了報告">本文</teammate-message>',
              '<teammate-message teammate_id="c">{"type":"idle_notification","from":"c","idleReason":"available"}</teammate-message>',
            ].join("\n"),
          },
        }),
      ),
    };
    const entries = [toolEntry(1), batched, toolEntry(3)];

    expect(agentCommunicationCount(batched)).toBe(1);
    expect(entries.map(isDirectFoldEntry)).toEqual([false, true, false]);
    expect(foldGroupLabel(entries)).toBe("1 agent messages + 2 items");
  });
});

describe("foldGroupNeedsOuterFold", () => {
  function parsedEntry(offset: number, raw: Record<string, unknown>): TimelineEntry {
    return { offset, line: parseTranscriptLine(JSON.stringify(raw)) };
  }
  const bash = (offset: number) =>
    parsedEntry(offset, {
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          {
            type: "tool_use",
            id: "tu_1",
            name: "Bash",
            input: { command: "pwd" },
          },
        ],
      },
    });
  const bashResult = (offset: number) =>
    parsedEntry(offset, {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
    });

  // 単独の plain item を「1 items」fold で包むと、開く手間だけが増えて
  // 得るものがない (kawaz r38 mid=44)。entry 自身が tool カードの fold を
  // 持っているので、そのまま timeline に出す。
  test("a lone plain item is hoisted instead of getting a fold", () => {
    expect(foldGroupNeedsOuterFold([bash(10)])).toBe(false);
  });

  // 実 transcript と同じ assistant tool_use / user tool_result の交互列。
  // thinking の節目が無くても、2 件以上あれば畳める価値がある。
  test("a tool-only run of several entries folds under one items fold", () => {
    const entries = [bash(10), bashResult(20)];
    expect(foldGroupLabel(entries)).toBe("2 items");
    expect(foldGroupNeedsOuterFold(entries)).toBe(true);
  });

  // 単独でも thinking / agent 通信は fold を持つ: 中身が長く、既定閉で
  // 畳んでおくこと自体に意味がある。
  test("a lone thinking entry still gets its fold", () => {
    const entries = [
      parsedEntry(1, {
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "thinking", thinking: "inspect" }],
        },
      }),
    ];
    expect(foldGroupLabel(entries)).toBe("1 thinking");
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

  // DR-0003 §5 Addendum: 自分の post は本文なしの軽量エコー (msg_via + echo:true、
  // reply_via なし) として自分の subscribe stream に返る。TL の自 post バブルは
  // これを拾って描画し、本文は CcmsgBubble が (room, mid) で lazy read する
  // (2026-07-29-self-ccmsg-post-bubbles-missing)。msg_via 経路と同じ placeholder
  // を作れば足りるので、echo フィールド自体は抽出側では読まない。
  test("self-post echo frame (msg_via + echo, no reply_via) becomes a lazy-read placeholder", () => {
    const echoEvent = {
      type: "msg",
      r: "r40",
      mid: 5,
      from: "a2",
      seq: 11,
      msg_via: "Use `ccmsg read r40m5`",
      echo: true,
      ts: "2026-07-29T01:00:00.000Z",
    };
    const line = userLine(
      `<task-notification>\n<event>${JSON.stringify(echoEvent)}</event>\n</task-notification>`,
    );
    expect(extractCcmsgMessages(line)).toEqual([
      {
        from: "a2",
        to: undefined,
        room: "r40",
        msg: "",
        ts: "2026-07-29T01:00:00.000Z",
        mid: 5,
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
    const e1 = {
      type: "msg",
      mid: 1,
      from: "a1",
      r: "r1",
      ts: "t1",
      msg: "one",
    };
    const e2 = {
      type: "msg",
      mid: 2,
      from: "a2",
      r: "r1",
      ts: "t2",
      msg: "two",
    };
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
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
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

// ccmsgDedupKey が (room, mid) canonical キーを返すので、同じ msg が別経路で
// 2 度抽出されても (自 post の軽量エコーと、同じ行に載った完全 event 等)
// 1 件に collapse される (kawaz r15 mid=21 dedup の拡張、DR-0027 §2.2)。
describe("DR-0027 dedup: (room, mid) canonical key collapses duplicate extractions", () => {
  test("ccmsgDedupKey uses `${room}|m${mid}` when mid is present", () => {
    const m: CcmsgMessage = {
      from: "a1",
      room: "r5",
      msg: "",
      ts: "",
      mid: 42,
    };
    expect(ccmsgDedupKey(m)).toBe("r5|m42");
  });

  test("ccmsgDedupKey falls back to the ts|from|msg form when mid is absent (pre-DR-0027 shape)", () => {
    const m: CcmsgMessage = { from: "u1", room: "r5", msg: "hi", ts: "t" };
    expect(ccmsgDedupKey(m)).toBe("r5|t|u1|hi");
  });

  test("bodyless echo placeholder and wrapper-parsed message with same (room, mid) collapse", () => {
    const placeholder: CcmsgMessage = {
      from: "a1",
      room: "r5",
      msg: "",
      ts: "ts1",
      mid: 42,
    };
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
// ccmsgRenderTargets: 「どの ccmsg バブルを描画するか」の唯一の決定点。
// dedup を render の副作用から追い出したのがこの関数の存在理由なので、
// 「同じ groups なら何度呼んでも同じ答え」を明示的に固定する — 旧実装は
// render 中に共有 Set を mutate していたため、fold group の開閉 (子局所
// re-render) で 2 回目以降の判定が変わり、peer 発バブルが消えていた
// (docs/issue/2026-07-29-fold-toggle-drops-peer-ccmsg-bubble)。
describe("ccmsgRenderTargets", () => {
  // 1 行が複数の <teammate-message> を運ぶ形 (実観測: 相手が続けて idle に
  // なった等) も扱えるよう、events を可変長で受ける。
  function ccmsgLine(...events: (CcmsgMessage & { mid: number })[]): ParsedLine {
    const tags = events
      .map((message) => {
        const event = {
          type: "msg",
          mid: message.mid,
          from: message.from,
          r: message.room,
          ts: message.ts,
          msg: message.msg,
        };
        return `<teammate-message teammate_id="${message.from}">\n${JSON.stringify(event)}\n</teammate-message>`;
      })
      .join("\n");
    return parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Another Claude session sent a message:\n${tags}`,
        },
      }),
    );
  }

  test("peer 発は fold placement、u1 発は boundary placement で document 順に並ぶ", () => {
    const peer = {
      from: "a1",
      room: "r1",
      ts: "t1",
      msg: "peer message",
      mid: 1,
    };
    const user = {
      from: "u1",
      room: "r1",
      ts: "t2",
      msg: "user message",
      mid: 2,
    };
    const groups = groupTimelineLines(
      [ccmsgLine(peer), ccmsgLine(user), assistantText("done")],
      [10, 20, 30],
    );

    expect(
      ccmsgRenderTargets(groups).map(({ key, offset, messageIndex, placement }) => ({
        key,
        offset,
        messageIndex,
        placement,
      })),
    ).toEqual([
      { key: "10-ccmsg-0", offset: 10, messageIndex: 0, placement: "fold" },
      { key: "20-ccmsg-0", offset: 20, messageIndex: 0, placement: "boundary" },
    ]);
  });

  // 同じ (room, mid) が fold group 内と boundary の両方から抽出される場面:
  // peer 発 event が単独行にも、後続の u1 発 event と同じ行にも載っている
  // (task-notification の echo)。残るのは transcript で先に現れた fold 側で、
  // Preact が boundary を先に render することには引きずられない (render 順
  // ではなく document 順が正 — in-view search の unit 列と同じ規則)。
  // boundary 側で index 0 が落ちても index 1 の key は 1 のまま = messageIndex
  // は「その行の message 配列上の位置」であって描画順の連番ではない。
  test("経路をまたぐ重複は document 順で先の 1 件だけが残る", () => {
    const peer = {
      from: "a1",
      room: "r1",
      ts: "t1",
      msg: "peer message",
      mid: 7,
    };
    const user = {
      from: "u1",
      room: "r1",
      ts: "t2",
      msg: "user message",
      mid: 8,
    };
    const groups = groupTimelineLines([ccmsgLine(peer), ccmsgLine(peer, user)], [10, 20]);

    expect(
      ccmsgRenderTargets(groups).map(({ key, messageIndex, placement }) => ({
        key,
        messageIndex,
        placement,
      })),
    ).toEqual([
      { key: "10-ccmsg-0", messageIndex: 0, placement: "fold" },
      { key: "20-ccmsg-1", messageIndex: 1, placement: "boundary" },
    ]);
  });

  // 本命の回帰: fold の開閉は Timeline 本体を再実行しないので、判定関数は
  // 同じ入力に対して何度でも同じ答えを返さなければならない。
  test("同じ groups で繰り返し呼んでも結果が変わらない (fold 開閉で消えない)", () => {
    const peer = {
      from: "a1",
      room: "r1",
      ts: "t1",
      msg: "peer message",
      mid: 1,
    };
    const user = {
      from: "u1",
      room: "r1",
      ts: "t2",
      msg: "user message",
      mid: 2,
    };
    const groups = groupTimelineLines(
      [userText("prompt"), ccmsgLine(peer), ccmsgLine(user)],
      [10, 20, 30],
    );

    const first = ccmsgRenderTargets(groups).map((target) => target.key);
    expect(first).toEqual(["20-ccmsg-0", "30-ccmsg-0"]);
    expect(ccmsgRenderTargets(groups).map((target) => target.key)).toEqual(first);
    expect(ccmsgRenderTargets(groups).map((target) => target.key)).toEqual(first);
  });
});

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
    const agentCcmsg = {
      from: "a1",
      room: "r1",
      ts: "t2",
      msg: "agent message",
    };
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
  // u1 (ADMIN) 発 ccmsg は本物のユーザ発話と同格に扱う (r55 m14) — boundary。
  test("a system-origin line carrying a u1-sent ccmsg -> {kind:'ccmsg', messages:[...]}", () => {
    const msgEvent = {
      type: "msg",
      mid: 1,
      from: "u1",
      r: "r1",
      ts: "t1",
      msg: "hi",
    };
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Another Claude session sent a message:\n<teammate-message teammate_id="u1">\n${JSON.stringify(msgEvent)}\n</teammate-message>`,
        },
      }),
    );
    expect(classifyBoundaryLine(line)).toEqual({
      kind: "ccmsg",
      messages: [{ from: "u1", to: undefined, room: "r1", msg: "hi", ts: "t1", mid: 1 }],
    });
  });

  // r55 m14: peer 発 (u1 以外) ccmsg は boundary にせず fold group 内で
  // thinking/agent と同格の direct 要素として描画する。
  test("a system-origin line carrying a peer-sent ccmsg -> null (folds)", () => {
    const msgEvent = {
      type: "msg",
      mid: 1,
      from: "a1",
      r: "r1",
      ts: "t1",
      msg: "hi",
    };
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Another Claude session sent a message:\n<teammate-message teammate_id="a1">\n${JSON.stringify(msgEvent)}\n</teammate-message>`,
        },
      }),
    );
    expect(classifyBoundaryLine(line)).toBeNull();
  });

  // u1 ccmsg-carrying line は境界として standalone、peer ccmsg-carrying line
  // は fold group に入る。
  test("u1 ccmsg-carrying line stands alone as a boundary in groupTimelineLines", () => {
    const msgEvent = {
      type: "msg",
      mid: 1,
      from: "u1",
      r: "r1",
      ts: "t1",
      msg: "hi",
    };
    const ccmsgLine = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: `Another Claude session sent a message:\n<teammate-message teammate_id="u1">\n${JSON.stringify(msgEvent)}\n</teammate-message>`,
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

  test("peer ccmsg-carrying line folds into surrounding group, not boundary", () => {
    const msgEvent = {
      type: "msg",
      mid: 1,
      from: "a1",
      r: "r1",
      ts: "t1",
      msg: "hi",
    };
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
      { kind: "fold", entries: [{ offset: 1, line: ccmsgLine }] },
      { kind: "entry", offset: 2, line: lines[2] },
    ]);
  });

  test("a real user prompt -> {kind:'user-prompt'}", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "hello" },
      }),
    );
    expect(classifyBoundaryLine(line)).toEqual({ kind: "user-prompt" });
  });

  test("an assistant text turn -> {kind:'assistant-response'}", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
        },
      }),
    );
    expect(classifyBoundaryLine(line)).toEqual({ kind: "assistant-response" });
  });

  test("a non-boundary line (thinking-only assistant turn) -> null", () => {
    expect(classifyBoundaryLine(assistantThinking("hmm"))).toBeNull();
  });
});

// LLM gateway の prompt-cache keepalive marker への応答 (`LLMGW-KEEPALIVE-
// <nonce>` トークン 1 個だけの assistant text) は gateway の帳簿であって会話
// ではないので、notify 側 (system-origin user メッセージ) と同じく fold 内の
// 1 行に落とす。
describe("isCacheKeepaliveReplyLine / cache-keepalive replies fold", () => {
  const assistantContent = (content: unknown[]) =>
    parseTranscriptLine(
      JSON.stringify({ type: "assistant", message: { role: "assistant", content } }),
    );
  const reply = (text: string) => assistantContent([{ type: "text", text }]);

  test("the exact token on its own -> not a boundary (folds)", () => {
    const line = reply("LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3");
    expect(isCacheKeepaliveReplyLine(line)).toBe(true);
    expect(classifyBoundaryLine(line)).toBeNull();
  });

  // marker の指示どおりならトークン 1 個だけ。前後に文章が付く / 別の行が
  // 続く応答は指示に従っていない = 隠さない。
  const notReplies: [string, string][] = [
    ["extra prose after", "LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3\nok, done"],
    ["prose before", "Sure:\nLLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3"],
    [
      "merely mentioning the token",
      "I replied with LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3 earlier.",
    ],
    ["no nonce", "LLMGW-KEEPALIVE-"],
    ["nonce shorter than 43", "LLMGW-KEEPALIVE-n1"],
    ["nonce longer than 43", `LLMGW-KEEPALIVE-${"a".repeat(44)}`],
    [
      "nonce with an out-of-alphabet character",
      "LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3!",
    ],
    ["trailing space", "LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3 "],
    ["lowercased token", "llmgw-keepalive-n1"],
  ];
  for (const [name, text] of notReplies) {
    test(`${name} -> a normal assistant bubble`, () => {
      const line = reply(text);
      expect(isCacheKeepaliveReplyLine(line)).toBe(false);
      expect(classifyBoundaryLine(line)).toEqual({ kind: "assistant-response" });
    });
  }

  test("thinking alongside the reply -> a normal assistant bubble", () => {
    const line = assistantContent([
      { type: "thinking", thinking: "hmm" },
      { type: "text", text: "LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3" },
    ]);
    expect(isCacheKeepaliveReplyLine(line)).toBe(false);
    expect(classifyBoundaryLine(line)).toEqual({ kind: "assistant-response" });
  });

  test("a tool call alongside the reply -> a normal assistant bubble", () => {
    const line = assistantContent([
      { type: "text", text: "LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3" },
      { type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "a" } },
    ]);
    expect(isCacheKeepaliveReplyLine(line)).toBe(false);
    expect(classifyBoundaryLine(line)).toEqual({ kind: "assistant-response" });
  });

  // 旧 marker (`... reply with exactly "ok".`) への応答は gateway 側が文言を
  // 変える前のもの。ccmsg は新形式だけ扱うので、素の "ok" はバブルのまま。
  test("a bare 'ok' -> a normal assistant bubble", () => {
    expect(isCacheKeepaliveReplyLine(reply("ok"))).toBe(false);
  });

  // fold される = 前後の中間エントリと 1 つの fold group にまとまる
  // (standalone entry として turn を切らない)。
  test("the reply joins the surrounding fold group instead of splitting it", () => {
    const lines = [
      assistantThinking("hmm"),
      reply("LLMGW-KEEPALIVE-Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3-_xY9Ab3"),
    ];
    const groups = groupTimelineLines(lines, [0, 1]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.kind).toBe("fold");
    expect(groups[0]!.kind === "fold" ? groups[0]!.entries : []).toHaveLength(2);
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
        relays: [
          {
            from: "poc5",
            channel: "teammate",
            summary: "調査完了",
            category: "message",
            body: "本文",
          },
        ],
      });
    });

    test("idle_notification JSON -> compact idle category", () => {
      const idleEvent = {
        type: "idle_notification",
        from: "a3",
        channel: "teammate",
        idleReason: "available",
      };
      const raw = `<teammate-message teammate_id="a3">${JSON.stringify(idleEvent)}</teammate-message>`;
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "a3",
            channel: "teammate",
            summary: null,
            category: "idle",
            body: "待機通知 · available",
          },
        ],
      });
    });

    // 実観測 (2597 relay 行中 296 行) では 1 行が複数の relay を運ぶ。以前は
    // 先頭タグだけを見ていたため、idle 通知と同じターンに届いた報告が丸ごと
    // 見えなくなっていた (先頭が idle なら行全体が idle 行へ demote された)。
    test("several teammate-message tags on one line -> one relay each, in order", () => {
      const idle = (from: string) =>
        `<teammate-message teammate_id="${from}">{"type":"idle_notification","from":"${from}","idleReason":"available"}</teammate-message>`;
      const raw = [
        "Another Claude session sent a message:",
        idle("a"),
        '<teammate-message teammate_id="b" summary="完了報告">本文</teammate-message>',
        idle("c"),
      ].join("\n");
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "a",
            channel: "teammate",
            summary: null,
            category: "idle",
            body: "待機通知 · available",
          },
          {
            from: "b",
            channel: "teammate",
            summary: "完了報告",
            category: "message",
            body: "本文",
          },
          {
            from: "c",
            channel: "teammate",
            summary: null,
            category: "idle",
            body: "待機通知 · available",
          },
        ],
      });
    });

    // failureReason は失敗した idle 通知にしか乗らず、idle 本文の中で唯一
    // 読む価値のある部分なので、compact 行を開いたときに見えるよう本文に残す。
    test("a failed idle notification keeps its failure reason in the body", () => {
      const raw =
        '<teammate-message teammate_id="a3">{"type":"idle_notification","from":"a3","idleReason":"failed","failureReason":"API Error: 500"}</teammate-message>';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "a3",
            channel: "teammate",
            summary: null,
            category: "idle",
            body: "待機通知 · failed · API Error: 500",
          },
        ],
      });
    });

    test("task_assignment JSON -> task title and description", () => {
      const raw =
        '<teammate-message teammate_id="worker">{"type":"task_assignment","subject":"実装","description":"テストも追加"}</teammate-message>';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "worker",
            channel: "teammate",
            summary: null,
            category: "task-assignment",
            body: "実装\nテストも追加",
          },
        ],
      });
    });

    test("agent-message from attribute -> same peer display", () => {
      const raw = '<agent-message from="reviewer">確認結果です</agent-message>';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "reviewer",
            channel: "teammate",
            summary: null,
            category: "message",
            body: "確認結果です",
          },
        ],
      });
    });

    test("unrecognized JSON event -> unknown category with pretty-printed body", () => {
      const event = { type: "future_event", detail: "保持する" };
      const raw = `<agent-message from="future">${JSON.stringify(event)}</agent-message>`;
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "future",
            channel: "teammate",
            summary: null,
            category: "unknown",
            body: JSON.stringify(event, null, 2),
          },
        ],
      });
    });

    test("no attributes on the opening tag -> fallback agent identity", () => {
      const raw = "<teammate-message>\nhi\n</teammate-message>";
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "agent",
            channel: "teammate",
            summary: null,
            category: "message",
            body: "hi",
          },
        ],
      });
    });

    // ネイティブ session 間メッセージ。`from` は相手の unix socket (pid 込みで
    // セッション終了とともに死ぬ) なので、UI が addressing に使う `from-name`
    // を送り主に採る。channel で in-process relay と区別できる。
    test("cross-session-message -> from-name as sender and the cross-session channel", () => {
      const raw =
        'Another Claude session sent a message:\n<cross-session-message from="uds:/tmp/cc-socks/62395.sock" from-name="probe" from-mode="prompting">\n本文\n</cross-session-message>\n\nThis came from another Claude session...';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "probe",
            channel: "cross-session",
            summary: null,
            category: "message",
            body: "本文",
          },
        ],
      });
    });

    // from-name が無い形が来ても socket path で識別だけは残す (揮発だが、
    // 「送り主不明」より情報が多い)。
    test("cross-session-message without from-name -> falls back to the socket path", () => {
      const raw =
        '<cross-session-message from="uds:/tmp/cc-socks/62395.sock" from-mode="prompting">hi</cross-session-message>';
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "uds:/tmp/cc-socks/62395.sock",
            channel: "cross-session",
            summary: null,
            category: "message",
            body: "hi",
          },
        ],
      });
    });

    // 1 行に in-process relay と cross-session relay が混在しても、channel は
    // タグごとに決まる (行単位で 1 つに畳まない)。
    test("mixed teammate and cross-session tags on one line -> per-tag channel", () => {
      const raw = [
        '<teammate-message teammate_id="a" summary="完了報告">本文A</teammate-message>',
        '<cross-session-message from-name="b">本文B</cross-session-message>',
      ].join("\n");
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "a",
            channel: "teammate",
            summary: "完了報告",
            category: "message",
            body: "本文A",
          },
          {
            from: "b",
            channel: "cross-session",
            summary: null,
            category: "message",
            body: "本文B",
          },
        ],
      });
    });

    // 壊れた入力: <teammate-message> タグ自体が無い (将来の別 peer-message
    // 変種) -> text フォールバック、rawText がそのまま保持される (raw タブと
    // 同じ内容になる = 情報を失わない)。
    test("no <teammate-message> tag at all -> text fallback carrying the raw text unchanged", () => {
      const raw = "Another Claude session sent a message: some future shape with no tag";
      expect(() => parseSystemMessageFields("peer-message", raw)).not.toThrow();
      expect(parseSystemMessageFields("peer-message", raw)).toEqual({
        display: "text",
        text: raw,
      });
    });
  });

  // cross-session-notice: idle 購読の通知。会話ではなく運用ノイズなので、idle
  // relay と同じ形に落として既存の compact 1 行表示 (IdlePeerRow) を再利用する。
  describe("cross-session-notice", () => {
    test("an idle notice -> one idle relay named after the quoted session", () => {
      const raw =
        '[Cross-session idle notice] "probe", which you asked to be notified about, is idle now — it finished a turn at 10:04.';
      expect(parseSystemMessageFields("cross-session-notice", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "probe",
            channel: "cross-session",
            summary: null,
            category: "idle",
            body: raw,
          },
        ],
      });
    });

    // 通知本文はあくまで散文なので、名前が引用符で書かれない変種でも行を落と
    // さない (送り主欄だけ役割名に degrade する)。
    test("a notice quoting no session name -> generic sender, body kept whole", () => {
      const raw = "[Cross-session idle notice] the subscription expired before anyone went idle.";
      expect(parseSystemMessageFields("cross-session-notice", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "相手セッション",
            channel: "cross-session",
            summary: null,
            category: "idle",
            body: raw,
          },
        ],
      });
    });
  });

  // spawn-prompt: agent 転写の先頭 user 行 (kawaz r46m28)。実質は親から届いた
  // agent message なので、wrapper の有無に関わらず peer 表示 = AgentCard に
  // 載せる (kawaz r55m155)。wrapper 付きは from/summary を wire から取り、
  // plain text は送り主が wire に無いので「親」を当てる。
  describe("spawn-prompt", () => {
    test("<teammate-message> wrapper (team-lead spawn) -> peer display with from + body", () => {
      const raw =
        '<teammate-message teammate_id="team-lead" summary="translate bug">TL 翻訳バグを調査してください。</teammate-message>';
      expect(parseSystemMessageFields("spawn-prompt", raw)).toMatchObject({
        display: "peer",
        relays: [{ from: "team-lead", channel: "teammate", summary: "translate bug" }],
      });
    });

    test("plain text (bare Agent tool spawn) -> peer display で本文を保ったまま送り主は「親」", () => {
      // r55m155 以前は text 表示に落ちて素の <pre> になっていた。実データでは
      // 73 件中 39 件がこの plain 形だったので、ここが揃わないと「spawn prompt
      // だけ見た目が違う」状態が過半で残る。
      const raw = "~/.claude/skills/thorough-review/reviewers/api-design.md を読み...";
      expect(parseSystemMessageFields("spawn-prompt", raw)).toEqual({
        display: "peer",
        relays: [
          {
            from: "親",
            channel: "teammate",
            summary: null,
            category: "message",
            body: raw,
          },
        ],
      });
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

  describe("bash-command-invocation / bash-command-stdout", () => {
    test("bash-input -> command with no output fields", () => {
      const raw = "<bash-input>  ls -la</bash-input>";
      expect(parseSystemMessageFields("bash-command-invocation", raw)).toEqual({
        display: "bash",
        command: "ls -la",
        output: null,
      });
    });

    // 空の stderr は null に落として描画側に出させない (kawaz spec:
    // 「stderr は空なら出さない」)。
    test("bash-stdout with empty bash-stderr -> stderr null", () => {
      const raw = "<bash-stdout>bin\nbun.lock</bash-stdout><bash-stderr></bash-stderr>";
      expect(parseSystemMessageFields("bash-command-stdout", raw)).toEqual({
        display: "bash",
        command: null,
        output: { stdout: "bin\nbun.lock", stderr: null, persisted: null },
      });
    });

    test("non-empty stderr is kept, ANSI stripped on both streams", () => {
      const raw =
        "<bash-stdout>\x1b[32mok\x1b[0m</bash-stdout><bash-stderr>\x1b[31mboom\x1b[0m</bash-stderr>";
      expect(parseSystemMessageFields("bash-command-stdout", raw)).toEqual({
        display: "bash",
        command: null,
        output: { stdout: "ok", stderr: "boom", persisted: null },
      });
    });

    // 壊れた入力: タグが無い -> text フォールバック (throw しない)。
    test("missing bash-input tag -> text fallback, no throw", () => {
      const raw = "ls";
      expect(() => parseSystemMessageFields("bash-command-invocation", raw)).not.toThrow();
      expect(parseSystemMessageFields("bash-command-invocation", raw)).toEqual({
        display: "text",
        text: "ls",
      });
    });

    test("neither bash-stdout nor bash-stderr tag -> text fallback", () => {
      const raw = "unexpected shape";
      expect(parseSystemMessageFields("bash-command-stdout", raw)).toEqual({
        display: "text",
        text: "unexpected shape",
      });
    });
  });

  // Claude Code 実機 (v2.1.220, 2026-07-29 実測) は ~50KB 超の `! <cmd>` 出力を
  // <persisted-output> (注記 + サイドカーの絶対パス + 2KB プレビュー) に差し替える。
  // 30KB はそのまま inline、60KB / 4.8MB は差し替えを確認済み。
  describe("persisted-output (oversized `! <cmd>` results)", () => {
    const persistedRaw =
      "<bash-stdout><persisted-output>\n" +
      "Output too large (4.8MB). Full output saved to: /tmp/p/tool-results/bv1.txt\n" +
      "\nPreview (first 2KB):\n" +
      "xxx\nyyy\n" +
      "</persisted-output></bash-stdout><bash-stderr></bash-stderr>";

    test("splits the stub into note / sidecar path / preview instead of showing it verbatim", () => {
      expect(parseBashOutputText(persistedRaw)).toEqual({
        stdout: null,
        stderr: null,
        persisted: {
          note: "Output too large (4.8MB). Full output saved to: /tmp/p/tool-results/bv1.txt",
          path: "/tmp/p/tool-results/bv1.txt",
          preview: "xxx\nyyy",
        },
      });
    });

    // 上流が注記の文言を変えてパスを取れなくなっても、丸ごと raw に落とすのではなく
    // 「リンク無しの通常出力」に劣化させる (バイトは決して隠さない)。
    test("a stub with no recoverable path degrades to plain stdout, not to a dropped block", () => {
      const raw =
        "<bash-stdout><persisted-output>\nSomething else\n\nPreview (first 2KB):\nzz\n</persisted-output></bash-stdout>";
      const out = parseBashOutputText(raw);
      expect(out?.persisted).toBeNull();
      expect(out?.stdout).toContain("Something else");
    });

    // CC 2.1.220 実測 (78KB payload): 差し替えブロックの注記もプレビューも
    // エスケープされずに入る (`line 0 <tag> & amp "q"` がそのまま)。ここを
    // デコードすると、本当に "&lt;" と印字した出力を壊す。
    test("the substituted block is left undecoded (the harness stores it raw)", () => {
      const raw =
        "<bash-stdout><persisted-output>\n" +
        "Output too large (78KB). Full output saved to: /tmp/p/bu5.txt\n" +
        "\nPreview (first 2KB):\n" +
        "line 0 <tag> & amp &lt;kept&gt;\n" +
        "</persisted-output></bash-stdout>";
      expect(parseBashOutputText(raw)?.persisted?.preview).toBe("line 0 <tag> & amp &lt;kept&gt;");
    });
  });

  // kawaz r76 m84: `! <cmd>` の出力が実体参照のまま表示されていた。ハーネスは
  // bash-stdout/stderr の本文に入れる時だけ `&` `<` `>` をエスケープする
  // (CC 2.1.220 実測: payload `PROBE <a> &amp; & "q" 's' &lt; -> a<b>c &#65;` が
  // `PROBE &lt;a&gt; &amp;amp; &amp; "q" 's' &amp;lt; -&gt; a&lt;b&gt;c &amp;#65;`
  // として保存された)。`"` `'` は素通し、数値参照は使われない。
  describe("harness entity escaping in bash output", () => {
    test("decodes the three escaped characters back to the printed bytes", () => {
      expect(
        parseBashOutputText(
          "<bash-stdout>PROBE &lt;a&gt; &amp;amp; &amp; \"q\" 's' &amp;lt; -&gt; a&lt;b&gt;c &amp;#65;</bash-stdout><bash-stderr></bash-stderr>",
        )?.stdout,
      ).toBe(`PROBE <a> &amp; & "q" 's' &lt; -> a<b>c &#65;`);
    });

    test("decodes stderr too", () => {
      expect(
        parseBashOutputText(
          "<bash-stdout></bash-stdout><bash-stderr>usage: hyoui &lt;subcommand&gt;</bash-stderr>",
        )?.stderr,
      ).toBe("usage: hyoui <subcommand>");
    });

    // `&` もエスケープされる = 逆変換は推測ではなく厳密な逆写像。出力が本当に
    // "&lt;" と印字していたら保存形は "&amp;lt;" なので、&amp; を最後に戻せば
    // &lt; 規則に先取りされず元に戻る。
    test("a literally printed entity survives the round trip", () => {
      expect(
        parseBashOutputText("<bash-stdout>&amp;lt;&amp;gt;&amp;amp;</bash-stdout>")?.stdout,
      ).toBe("&lt;&gt;&amp;");
    });

    // quotes は素通しなので、"&quot;" と印字した出力を実体参照と誤認しない。
    test("does not decode quote entities the harness never produces", () => {
      expect(parseBashOutputText("<bash-stdout>&amp;quot;x&amp;apos;</bash-stdout>")?.stdout).toBe(
        "&quot;x&apos;",
      );
    });

    // CSI のパラメータバイトには `<` `=` `>` が入りうる (SGR マウス報告は
    // `ESC [ <…M`)。先に ANSI 除去すると escape 済みで一致せず素通ししてしまう
    // ので、デコード → ANSI 除去の順であることを固定する。
    test("decoding precedes ANSI stripping so escaped CSI parameter bytes still match", () => {
      expect(parseBashOutputText("<bash-stdout>a\u001b[&lt;0;1;2Mb</bash-stdout>")?.stdout).toBe(
        "ab",
      );
    });

    test("leaves the input command alone (the harness stores it verbatim)", () => {
      expect(parseBashInputText(`<bash-input> head f # <tag> & "q" 's'</bash-input>`)).toBe(
        `head f # <tag> & "q" 's'`,
      );
    });
  });

  describe("`! <cmd>` invocation/output pairing (resolveToolResults)", () => {
    const bashLine = (kind: "bash-command-invocation" | "bash-command-stdout", text: string) =>
      ({
        kind: "turn",
        ts: null,
        role: "user",
        userMessageKind: kind,
        segments: [{ kind: "text", role: "user", text }],
      }) satisfies ParsedLine;

    const invocation = bashLine("bash-command-invocation", "<bash-input>ls</bash-input>");
    const output = bashLine(
      "bash-command-stdout",
      "<bash-stdout>bin</bash-stdout><bash-stderr></bash-stderr>",
    );

    test("the adjacent output row merges into the command's own segment", () => {
      const [merged] = resolveToolResults([invocation, output]);
      expect(merged).toMatchObject({
        segments: [
          {
            kind: "bash-command",
            command: "ls",
            output: { stdout: "bin", stderr: null },
          },
        ],
      });
    });

    // 取り込まれた側は groupTimelineLines が落とす (= 同じ出力が二重に出ない)。
    // 行自体は配列に残るので transcript の byte offset は保たれる。
    test("the consumed output row is dropped from the rendered groups but keeps its offset slot", () => {
      const lines = resolveToolResults([invocation, output]);
      expect(lines).toHaveLength(2);
      const groups = groupTimelineLines(lines, [0, 100]);
      expect(groups).toHaveLength(1);
      expect(groups[0]).toMatchObject({ kind: "entry", offset: 0 });
    });

    // 隣が出力行でなければ無関係な行を飲み込まず、結果なしのコマンドとして描く。
    test("an invocation whose next line is unrelated keeps output null and swallows nothing", () => {
      const other = {
        kind: "turn",
        ts: null,
        role: "assistant",
        segments: [{ kind: "text", role: "assistant", text: "hi" }],
      } satisfies ParsedLine;
      const [merged, kept] = resolveToolResults([invocation, other]);
      expect(merged).toMatchObject({
        segments: [{ kind: "bash-command", output: null }],
      });
      expect(kept).toBe(other);
    });

    // kawaz r76m20: 「それ自体は確実にユーザが入力したもの」なので、他のシステム由来
    // メッセージのように fold へ沈めず、ユーザ側の流れに standalone で出す。
    test("a `! <cmd>` run is a boundary (stands alone) rather than folding away", () => {
      const [merged] = resolveToolResults([invocation, output]);
      expect(classifyBoundaryLine(merged!)).toMatchObject({
        kind: "bash-command",
      });
    });

    // 相方の来なかった出力行も同様に standalone (= バイトを黙って隠さない)。
    test("an orphaned output row still stands alone instead of sinking into a fold", () => {
      const [only] = resolveToolResults([output]);
      expect(classifyBoundaryLine(only!)).toMatchObject({
        kind: "bash-command-output",
      });
      expect(groupTimelineLines([only!], [0])).toMatchObject([{ kind: "entry" }]);
    });

    test("parseBashInputText trims the command", () => {
      expect(parseBashInputText("<bash-input>  ls -la  </bash-input>")).toBe("ls -la");
      expect(parseBashInputText("ls")).toBeNull();
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
      expect(parseSystemMessageFields(kind, raw)).toEqual({
        display: "text",
        text: raw,
      });
    });

    // kind が undefined (parseTranscriptLine を通らない手組み ParsedLine 等)
    // でも同じ fallback、throw しない。
    test("kind undefined -> text fallback, no throw", () => {
      expect(() => parseSystemMessageFields(undefined, raw)).not.toThrow();
      expect(parseSystemMessageFields(undefined, raw)).toEqual({
        display: "text",
        text: raw,
      });
    });

    // 空文字列 (segments が空、または text セグメントが無い line からの
    // 呼び出し — SystemMessageBody の rawText 計算が "" を渡すケース) も
    // throw しない。
    test("empty rawText -> text fallback with empty text, no throw", () => {
      expect(() => parseSystemMessageFields("system-caveat", "")).not.toThrow();
      expect(parseSystemMessageFields("system-caveat", "")).toEqual({
        display: "text",
        text: "",
      });
    });
  });
});

// attachment 行 (`type:"attachment"`) の type 別詳細化。閉じた fold が全部
// 「attachment」に見えないよう、共通 chrome (type 名) + type 別の従属ラベル /
// フィールドを出す。行形状は実 transcript 実測 (2026-08-02) に準拠。
describe("attachmentDetail", () => {
  test("hook_success -> hookName が従属ラベル、実行結果がフィールドに展開される", () => {
    const detail = attachmentDetail(
      {
        type: "hook_success",
        hookName: "gh-monitor",
        hookEvent: "PostToolUse",
        command: "hooks/notify.sh",
        exitCode: 0,
        durationMs: 12,
        stdout: "ok",
        stderr: "",
        content: "…",
      },
      null,
    );
    expect(detail.type).toBe("hook_success");
    expect(detail.trailing).toBe("gh-monitor");
    expect(detail.fields).toEqual([
      { name: "event", value: "PostToolUse" },
      { name: "command", value: "hooks/notify.sh" },
      { name: "exitCode", value: "0" },
      { name: "durationMs", value: "12" },
      { name: "stdout", value: "ok" },
    ]);
  });

  // hook_additional_context は command/exitCode を持たない。欠けたフィールドは
  // 空行を作らず落ちる (空文字の stderr も同様)。
  test("hook_additional_context -> 存在するフィールドだけが並ぶ", () => {
    const detail = attachmentDetail(
      {
        type: "hook_additional_context",
        hookName: "ccmsg",
        hookEvent: "UserPromptSubmit",
      },
      null,
    );
    expect(detail.trailing).toBe("ccmsg");
    expect(detail.fields).toEqual([{ name: "event", value: "UserPromptSubmit" }]);
  });

  test("edited_text_file -> ファイルパスが従属ラベル、cwd 配下なら相対表示", () => {
    const detail = attachmentDetail(
      {
        type: "edited_text_file",
        filename: "/repo/main/src/a.ts",
        snippet: "…",
      },
      "/repo/main",
    );
    expect(detail.type).toBe("edited_text_file");
    expect(detail.trailing).toBe("src/a.ts");
    expect(detail.fields).toEqual([]);
  });

  // kawaz r99 m35: file 系 attachment は Read カードと同じプレビューを出す。
  // snippet は行番号付きなので、番号を剥がして startLine に移す (剥がさないと
  // ビューアの行番号と本文中の番号が二重に出る)。
  test("edited_text_file -> 行番号付き snippet を本文 + startLine に分解する", () => {
    const detail = attachmentDetail(
      {
        type: "edited_text_file",
        filename: "/tmp/a.ts",
        snippet: "21\tconst a = 1;\n22\tconst b = 2;",
      },
      null,
    );
    expect(detail.file).toEqual({
      path: "/tmp/a.ts",
      content: "const a = 1;\nconst b = 2;",
      startLine: 21,
    });
  });

  // 番号として解釈できない snippet は本文をそのまま出す (列を 1 つ失うより
  // 素のまま見せる方が安全)。
  test("edited_text_file -> 番号形でない snippet はそのまま 1 行目から表示", () => {
    const detail = attachmentDetail(
      {
        type: "edited_text_file",
        filename: "/tmp/a.ts",
        snippet: "no numbers here",
      },
      null,
    );
    expect(detail.file).toEqual({
      path: "/tmp/a.ts",
      content: "no numbers here",
      startLine: 1,
    });
  });

  test("file -> content.file.content をそのままプレビューに使う", () => {
    const detail = attachmentDetail(
      {
        type: "file",
        filename: "/tmp/b.sh",
        content: {
          type: "text",
          file: { filePath: "/tmp/b.sh", content: "#!/bin/sh\n", startLine: 1 },
        },
      },
      null,
    );
    expect(detail.file).toEqual({
      path: "/tmp/b.sh",
      content: "#!/bin/sh\n",
      startLine: 1,
    });
  });

  // 画像の file attachment には text body が無い。プレビューを出さず従来どおり
  // raw JSON に落ちる。
  test("file -> テキスト本文が無ければプレビューを出さない", () => {
    const detail = attachmentDetail(
      {
        type: "file",
        filename: "/tmp/c.png",
        content: {
          type: "image",
          source: { data: "…", media_type: "image/png" },
        },
      },
      null,
    );
    expect(detail.file).toBeUndefined();
    expect(detail.trailing).toBe("/tmp/c.png");
  });

  test("cwd 外のファイルは絶対パスのまま", () => {
    const detail = attachmentDetail(
      { type: "edited_text_file", filename: "/tmp/x.ts" },
      "/repo/main",
    );
    expect(detail.trailing).toBe("/tmp/x.ts");
  });

  // 未知 type は spec なしでも type 名だけで成立する (今後 Claude Code が
  // attachment type を増やしても壊れない、というのが本設計の前提)。
  test("未知 type -> type 名のみ、従属ラベル・フィールドなし", () => {
    expect(attachmentDetail({ type: "brand_new_thing", whatever: 1 }, null)).toEqual({
      type: "brand_new_thing",
      trailing: null,
      fields: [],
    });
  });

  // spec のない type でもパス項目を持つなら拾う (file 系 attachment が増えた
  // ときに個別 spec なしで読める形になる)。
  test("spec のない type でも path 項目があれば従属ラベルになる", () => {
    expect(
      attachmentDetail({ type: "future_file_thing", path: "/repo/main/b.ts" }, "/repo/main")
        .trailing,
    ).toBe("b.ts");
  });

  test("parseNumberedSnippet: 番号が連続しない / 一部行に番号が無いなら剥がさない", () => {
    // 部分一致で剥がすと、本文の先頭が数字+タブだった行だけ列が欠けたり、
    // 行番号が実ファイルとずれたまま表示されたりする。全行揃った時だけ採る。
    expect(parseNumberedSnippet("1\ta\n3\tb")).toBeNull();
    expect(parseNumberedSnippet("1\ta\nb")).toBeNull();
    expect(parseNumberedSnippet("")).toBeNull();
    expect(parseNumberedSnippet("0\ta")).toBeNull();
    // 末尾の改行は本文側の空行であって番号の抜けではない。
    expect(parseNumberedSnippet("7\ta\n8\tb\n")).toEqual({
      content: "a\nb\n",
      startLine: 7,
    });
    // 本文にタブが含まれていても、剥がすのは先頭の 1 個だけ。
    expect(parseNumberedSnippet("1\ta\tb")).toEqual({
      content: "a\tb",
      startLine: 1,
    });
  });

  test("attachment が欠落・非オブジェクトでも壊れない", () => {
    for (const bad of [undefined, null, "x", 3, []]) {
      expect(attachmentDetail(bad, null)).toEqual({
        type: "?",
        trailing: null,
        fields: [],
      });
    }
  });

  test("parseTranscriptLine が attachment 行に detail を付ける", () => {
    const line = parseTranscriptLine(
      JSON.stringify({
        type: "attachment",
        timestamp: "2026-08-02T00:00:00.000Z",
        cwd: "/repo/main",
        attachment: {
          type: "edited_text_file",
          filename: "/repo/main/src/a.ts",
        },
      }),
    );
    expect(line.kind).toBe("meta");
    if (line.kind !== "meta") return;
    expect(line.attachment).toEqual({
      type: "edited_text_file",
      trailing: "src/a.ts",
      fields: [],
    });
  });

  // attachment 以外の meta 行は従来どおり detail を持たない (= 描画も従来のまま)。
  test("attachment 以外の meta 行には detail が付かない", () => {
    const line = parseTranscriptLine(JSON.stringify({ type: "system", subtype: "info" }));
    expect(line.kind).toBe("meta");
    if (line.kind !== "meta") return;
    expect(line.attachment).toBeUndefined();
    expect(line.summary).toBe("system: info");
  });
});
