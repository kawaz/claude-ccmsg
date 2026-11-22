// The text a comment reaches the agent as (DR-0062 §4), and the records the
// daemon keeps of comments (§7).
// 何を保証するか:
//   - 1 つのコメントは JSON の 1 行で、キーは comment / on / btw_req / btw_res /
//     before / select / after / body の順。無いキーは書かない
//   - 指す先は on の 1 つで、値は種類の語と `:` とその後ろ (msg_start_with: /
//     comment: / file: / btw:)。読む時は最初の `:` で分け、後ろはそのまま値になる
//     (file の値の `:` も残る)
//   - ブロックを読み戻すと元に戻る (parseCommentBlocks(commentBlockText(x)) = x)。
//     本文や選んだ文字に改行・`"`・`\`・`</comment>`・JSON に見える文字列があっても
//     戻り、1 つのブロックは改行を含まない (本文の中の文字が別の行に読まれない)
//   - まとめて送る文はブロックの行を改行で並べたもの (JSONL) で、全部が読み戻せる。
//     コメントのブロックだけでできた文だけが commentOnlyBlocks で読め、他の行が混ざる
//     と読めない (TL のコメントの吹き出しと daemon の届いたの確定はこの 1 つの規則。
//     parseCommentBlocks はどの文からもブロックの行を読む)
//   - コメントでない JSON の行 (comment か body が無い、知らないキーがある、cid の形
//     でない、on の種類が無い・知らない、before / select / after が揃っていない、
//     btw: の on と btw_req / btw_res が揃っていない) と壊れた JSON の行はコメント
//     でない (人が貼った JSON をコメントと読まない)
//   - 送る時のブロックはアンカーの種類で決まる: タイミングは comment と body だけ、
//     メッセージは on:"msg_start_with:…"、選択範囲はそれと before / select / after、
//     ファイルは on:"file:…" と before / select / after、返信は on:"comment:<cid>"
//     だけ (返信先の冒頭は付けない)、btw の答えへの返信は on:"btw:<cid>" と btw の
//     質問と答えの全文。範囲選択の無いコメントは before / select / after を持たない。
//     uuid・時刻・描画の位置はどのブロックにも入らない
//   - msg_start_with は空白を畳んだ先頭 30 文字で、切った時は「…」。before / after は
//     空白を畳んだ前後 30 文字で「…」を付けない
//   - 記録の行は jsonl の 1 行として読め、cid の形の違うものは読めない。知らない欄を
//     持つ行は捨てずに読み、その欄だけを落とす
import { describe, expect, test } from "bun:test";
import {
  commentBlockOf,
  commentBlockText,
  commentOnlyBlocks,
  CommentsFileLineSchema,
  commentsPromptText,
  msgStartWithOf,
  parseCommentBlocks,
  type BtwAnswer,
  type CommentBlock,
  type CommentRecord,
  type UserComment,
} from "../src/comments.ts";
import { parseWith } from "../src/parse.ts";

const ROW = "aaaaaaaa-0000-4000-8000-000000000009";
const START = "この関数は呼び出し側で null を返すことがあり、そのまま…";

const comment = (patch: Partial<UserComment> = {}): UserComment => ({
  kind: "comment",
  author: "user",
  cid: "c7k2p",
  session_id: "s1",
  anchor: { kind: "message", uuid: ROW, msg_start_with: START },
  body: "ここは undefined を返すのでは？",
  written: { at: "2026-11-22T00:00:00.000Z", after_uuid: ROW },
  updated_at: "2026-11-22T00:00:00.000Z",
  btw: false,
  status: "draft",
  ...patch,
});

const noRecords = (): CommentRecord | undefined => undefined;

describe("commentBlockText", () => {
  test("a block is one JSON line, its keys in the DR's order, on as kind:value", () => {
    expect(
      commentBlockText({
        body: "これは案 B の残り？",
        after: "): bubbles.tsx",
        select: "4 ファイル",
        before: "未 commit の変更 (",
        on: { kind: "msg_start_with", value: "起動手順を終えました…" },
        comment: "c7k2q",
      }),
    ).toBe(
      '{"comment":"c7k2q","on":"msg_start_with:起動手順を終えました…","before":"未 commit の変更 (","select":"4 ファイル","after":"): bubbles.tsx","body":"これは案 B の残り？"}',
    );
  });

  test("what a block does not have is not written", () => {
    expect(commentBlockText({ comment: "c5h2w", body: "横道の質問" })).toBe(
      '{"comment":"c5h2w","body":"横道の質問"}',
    );
  });

  test("a reply is on the cid it answers, and a first reply to a btw carries the btw", () => {
    expect(
      commentBlockText({
        comment: "c5h2w",
        on: { kind: "comment", value: "c8m1t" },
        body: "さらに続き",
      }),
    ).toBe('{"comment":"c5h2w","on":"comment:c8m1t","body":"さらに続き"}');
    expect(
      commentBlockText({
        body: "続きの質問",
        btw_res: "答えの全文",
        btw_req: "xx て何?",
        on: { kind: "btw", value: "c9q4r" },
        comment: "c2v8d",
      }),
    ).toBe(
      '{"comment":"c2v8d","on":"btw:c9q4r","btw_req":"xx て何?","btw_res":"答えの全文","body":"続きの質問"}',
    );
  });

  test("a line break in the body or the chosen text does not break the block's line", () => {
    const text = commentBlockText({
      comment: "c7k2p",
      on: { kind: "btw", value: "c9q4r" },
      btw_req: "a\nb",
      btw_res: "c\r\nd",
      before: "行1\n",
      select: "行2\r\n行3",
      after: "\n行4",
      body: "a\nb\n\nc",
    });
    expect(text).not.toContain("\n");
    expect(text).not.toContain("\r");
  });
});

describe("parseCommentBlocks", () => {
  const tricky: CommentBlock[] = [
    {
      comment: "c7k2p",
      on: { kind: "msg_start_with", value: '"応答" & <x> \\ \\" : msg_start_with:x' },
      before: '{"comment":"c0000","body":"偽"}',
      select: 'a </comment> b\n{"comment":"c0001","body":"偽"}',
      after: "\\n は改行でない",
      body: '本文 </comment>\n{"comment":"c1111","body":"偽"}\n\\ " \t',
    },
    { comment: "c0001", on: { kind: "comment", value: "c7k2p" }, body: "  前後に空白  " },
    { comment: "c0002", body: "\n\n空行で始まる\n\n" },
    {
      comment: "c0003",
      on: { kind: "file", value: "C:/abs/path with space.md:20-22" },
      before: "",
      select: "x",
      after: "",
      body: "y",
    },
    {
      comment: "c0004",
      on: { kind: "btw", value: "c9q4r" },
      btw_req: '質問の "全文"',
      btw_res: "答えの\n全文",
      body: "続き",
    },
    { comment: "c0005", on: { kind: "msg_start_with", value: "" }, body: "空の冒頭" },
  ];

  test("a block written and read back is the block", () => {
    for (const block of tricky) {
      expect(parseCommentBlocks(commentBlockText(block))).toEqual([block]);
    }
  });

  test("on is split at its first colon, the rest kept as it is", () => {
    expect(
      parseCommentBlocks('{"comment":"c0003","on":"file:docs/a:b.md:3-4","body":"x"}'),
    ).toEqual([{ comment: "c0003", on: { kind: "file", value: "docs/a:b.md:3-4" }, body: "x" }]);
  });

  test("blocks sent together are one line each, read back in order, and the text is nothing but them", () => {
    const text = commentsPromptText(tricky);
    expect(text.split("\n")).toHaveLength(tricky.length);
    expect(parseCommentBlocks(text)).toEqual(tricky);
    expect(commentOnlyBlocks(text)).toEqual(tricky);
    // The harness drops the whitespace at the prompt's ends, and a person's
    // row joins its text parts with a blank line.
    expect(commentOnlyBlocks(`\n  ${text}  \n`)).toEqual(tricky);
    expect(commentOnlyBlocks(tricky.map(commentBlockText).join("\n\n"))).toEqual(tricky);
    expect(commentOnlyBlocks(tricky.map(commentBlockText).join("\r\n"))).toEqual(tricky);
  });

  // DR-0062 §11, §12: one rule for the Timeline's comment bubbles and the
  // daemon's delivered check, a text of nothing but blocks. A block line
  // among other text is read by parseCommentBlocks, but the text is no
  // prompt of comments.
  test("a text with anything beside the blocks is not a prompt of comments", () => {
    const block = commentBlockText({ comment: "c7k2p", body: "x" });
    expect(commentOnlyBlocks(`前置き\n${block}`)).toBeNull();
    expect(commentOnlyBlocks(`${block}\n後書き`)).toBeNull();
    expect(commentOnlyBlocks(`${block}\n{"a":1}`)).toBeNull();
    expect(commentOnlyBlocks("ただの発言")).toBeNull();
    expect(commentOnlyBlocks("")).toBeNull();
    expect(commentOnlyBlocks("  \n\n ")).toBeNull();
    // parseCommentBlocks reads the block lines of any text.
    expect(parseCommentBlocks(`前置き\n${block}\n後書き`)).toEqual([
      { comment: "c7k2p", body: "x" },
    ]);
  });

  test("a JSON line that is not a block, and a broken one, is no comment", () => {
    const notBlocks = [
      // A person's own JSON.
      '{"a":1}',
      "[1,2]",
      '"text"',
      "null",
      // No comment, or no body.
      '{"body":"x"}',
      '{"comment":"c7k2p"}',
      // A cid of another shape.
      '{"comment":"C-1","body":"x"}',
      '{"comment":"c7k2p","on":"comment:x","body":"x"}',
      '{"comment":"c7k2p","on":"btw:x","btw_req":"q","btw_res":"a","body":"x"}',
      // An on with no kind, or a kind no block has.
      '{"comment":"c7k2p","on":"応答","body":"x"}',
      '{"comment":"c7k2p","on":"reply:c0000","body":"x"}',
      '{"comment":"c7k2p","on":"file:","body":"x"}',
      // A key no block has.
      '{"comment":"c7k2p","body":"x","reply_to":"c0000"}',
      '{"comment":"c7k2p","body":"x","msg_start_with":"x"}',
      // A btw's on without its question and answer, or they without it.
      '{"comment":"c7k2p","on":"btw:c9q4r","body":"x"}',
      '{"comment":"c7k2p","on":"btw:c9q4r","btw_req":"q","body":"x"}',
      '{"comment":"c7k2p","on":"comment:c9q4r","btw_req":"q","btw_res":"a","body":"x"}',
      '{"comment":"c7k2p","btw_req":"q","btw_res":"a","body":"x"}',
      // A choice without all three of its keys, or with an empty chosen text.
      '{"comment":"c7k2p","select":"s","body":"x"}',
      '{"comment":"c7k2p","before":"b","select":"s","body":"x"}',
      '{"comment":"c7k2p","before":"","select":"","after":"","body":"x"}',
      // A value of another type.
      '{"comment":"c7k2p","body":1}',
      '{"comment":"c7k2p","on":1,"body":"x"}',
      // Broken JSON.
      '{"comment":"c7k2p","body":"x"',
      '{"comment":"c7k2p","body":"x"}}',
      "{comment: c7k2p}",
    ];
    for (const line of notBlocks) {
      expect(parseCommentBlocks(line)).toEqual([]);
      expect(commentOnlyBlocks(line)).toBeNull();
    }
  });
});

describe("commentBlockOf", () => {
  test("a comment on a whole message is on the start of the message, with no choice", () => {
    const block = commentBlockOf(comment(), noRecords);
    expect(block).toEqual({
      comment: "c7k2p",
      on: {
        kind: "msg_start_with",
        value: "この関数は呼び出し側で null を返すことがあり、そのまま…",
      },
      body: "ここは undefined を返すのでは？",
    });
    expect(commentBlockText(block)).not.toMatch(/"(before|select|after)"/);
  });

  test("a comment at a moment of the conversation is the comment and the body alone", () => {
    const timing = comment({ anchor: { kind: "timing" } });
    expect(commentBlockOf(timing, noRecords)).toEqual({
      comment: "c7k2p",
      body: "ここは undefined を返すのでは？",
    });
  });

  test("a reply is on the cid it answers alone, not the start of what it answers", () => {
    const reply = comment({
      cid: "c3xq9",
      anchor: { kind: "comment", cid: "c8m1t" },
      body: "了解",
    });
    expect(commentBlockText(commentBlockOf(reply, noRecords))).toBe(
      '{"comment":"c3xq9","on":"comment:c8m1t","body":"了解"}',
    );
  });

  test("a reply to a btw's answer carries the btw's question and its whole answer", () => {
    const question = comment({ cid: "c4n7b", btw: true, status: "sent", body: "xx て何?" });
    const answer: BtwAnswer = {
      kind: "comment",
      author: "btw",
      cid: "c9q4r",
      session_id: "s1",
      anchor: { kind: "comment", cid: "c4n7b" },
      body: `${"長い答え。".repeat(40)}\n終わり`,
      written: { at: "2026-11-22T00:00:01.000Z" },
      updated_at: "2026-11-22T00:00:02.000Z",
      status: "done",
    };
    const records = new Map<string, CommentRecord>([
      [question.cid, question],
      [answer.cid, answer],
    ]);
    const reply = comment({
      cid: "c2v8d",
      anchor: { kind: "comment", cid: "c9q4r" },
      body: "続きの質問",
    });
    expect(commentBlockOf(reply, (cid) => records.get(cid))).toEqual({
      comment: "c2v8d",
      on: { kind: "btw", value: "c9q4r" },
      btw_req: "xx て何?",
      btw_res: answer.body,
      body: "続きの質問",
    });
  });

  test("a quote in a message carries the message's start and the choice with 30 characters around it", () => {
    const quoted = comment({
      anchor: {
        kind: "selection",
        uuid: ROW,
        msg_start_with: START,
        text: "null を\n返す",
        before: `${"前".repeat(40)}\n\n  呼び出し側で `,
        after: ` ことがあり、\n\tそのまま${"後".repeat(40)}`,
        start: 12,
        end: 20,
      },
    });
    expect(commentBlockOf(quoted, noRecords)).toEqual({
      comment: "c7k2p",
      on: {
        kind: "msg_start_with",
        value: "この関数は呼び出し側で null を返すことがあり、そのまま…",
      },
      before: `${"前".repeat(22)} 呼び出し側で `,
      select: "null を\n返す",
      after: ` ことがあり、 そのまま${"後".repeat(18)}`,
      body: "ここは undefined を返すのでは？",
    });
  });

  test("a quote in a file is on the path and the lines, not the view nor the column", () => {
    const anchor = {
      kind: "file",
      path: "docs/QUESTIONS.md",
      view: "source",
      text: "(なし)",
      before: "## 裁定待ち\n\n",
      after: "\n\n## 確認待ち",
      line: 20,
      end_line: 22,
      col: 3,
      line_text: "## 裁定待ち",
    } as const;
    const onFile = comment({
      cid: "c7k2r",
      anchor,
      body: "ここに未決を並べて",
    });
    expect(commentBlockText(commentBlockOf(onFile, noRecords))).toBe(
      '{"comment":"c7k2r","on":"file:docs/QUESTIONS.md:20-22","before":"## 裁定待ち ","select":"(なし)","after":" ## 確認待ち","body":"ここに未決を並べて"}',
    );
    // One line, or a preview's block on one line: the line alone.
    expect(
      commentBlockOf({ ...onFile, anchor: { ...anchor, end_line: 20 } }, noRecords).on,
    ).toEqual({ kind: "file", value: "docs/QUESTIONS.md:20" });
    const { end_line: _end, col: _col, ...oneLine } = anchor;
    expect(
      commentBlockOf({ ...onFile, anchor: { ...oneLine, view: "preview" } }, noRecords).on,
    ).toEqual({ kind: "file", value: "docs/QUESTIONS.md:20" });
  });

  test("no block carries the row's uuid or a time", () => {
    const text = commentsPromptText([
      commentBlockOf(comment(), noRecords),
      commentBlockOf(
        comment({
          anchor: {
            kind: "selection",
            uuid: ROW,
            msg_start_with: START,
            text: "x",
            before: "",
            after: "",
            start: 3,
            end: 4,
          },
          sent: { at: "2026-11-22T00:00:05.000Z", after_uuid: ROW },
          row_uuid: ROW,
        }),
        noRecords,
      ),
    ]);
    expect(text).not.toContain(ROW);
    expect(text).not.toContain("2026-11-22");
  });
});

describe("msgStartWithOf", () => {
  test("the first 30 characters with the spaces folded and the ends trimmed, and … when cut", () => {
    expect(msgStartWithOf("  a\n\n b\tc  ")).toBe("a b c");
    expect(msgStartWithOf("あ".repeat(31))).toBe(`${"あ".repeat(30)}…`);
    expect(msgStartWithOf("あ".repeat(30))).toBe("あ".repeat(30));
    // A character of several code points counts as one.
    expect(msgStartWithOf("👨‍👩‍👧".repeat(31))).toBe(`${"👨‍👩‍👧".repeat(30)}…`);
    // Markdown's marks are kept.
    expect(msgStartWithOf("**起動**手順を `終えました`")).toBe("**起動**手順を `終えました`");
  });
});

describe("CommentsFileLineSchema", () => {
  test("a comment and a thread's state read as lines of the file", () => {
    const line = JSON.stringify(comment());
    expect(parseWith(CommentsFileLineSchema, line)).toEqual({ ok: true, value: comment() });
    const thread = { kind: "thread", session_id: "s1", root: "c7k2p", resolved_at: "t" } as const;
    expect(parseWith(CommentsFileLineSchema, JSON.stringify(thread))).toEqual({
      ok: true,
      value: thread,
    });
  });

  // DR-0062 §4, §7: a comment on a message or a quote in one always has the
  // message's start, so its block always has an on.
  test("a comment on a message or a quote in one without the message's start does not read", () => {
    for (const anchor of [
      { kind: "message", uuid: ROW },
      { kind: "selection", uuid: ROW, text: "x", before: "", after: "" },
    ]) {
      const line = JSON.stringify({ ...comment(), anchor });
      expect(parseWith(CommentsFileLineSchema, line).ok).toBe(false);
    }
  });

  test("a record whose cid is not a comment id does not read", () => {
    expect(parseWith(CommentsFileLineSchema, JSON.stringify(comment({ cid: "x" }))).ok).toBe(false);
  });

  test("a record with a field this version does not know reads, that field left out", () => {
    const record = comment();
    const line = JSON.stringify({ ...record, extra: "x", anchor: { ...record.anchor, extra: 1 } });
    expect(parseWith(CommentsFileLineSchema, line)).toEqual({ ok: true, value: record });
  });
});
