// The text a comment reaches the agent as (DR-0062 §4), and the records the
// daemon keeps of comments (§7).
// 何を保証するか:
//   - 1 つのコメントは `<comment cid=… on=… quote=…>` の 1 つのブロックで、選んだ文字は
//     `<selection>`、本文はその後。無い項目は書かない
//   - ブロックを読み戻すと元に戻る (parseCommentBlocks(commentBlockText(x)) = x)。
//     本文や引用に `<comment>` / `</comment>` / `&` / `"` / 改行があっても戻り、本文の
//     中の文字がブロックの区切りに読まれない
//   - まとめて送る文はブロックを空行で区切ったもので、全部が読み戻せる。コメントの
//     ブロックだけでできた文だけが commentOnlyBlocks で読め、他の文が混ざると読めない
//   - 送る時のブロックはアンカーの種類で決まる: タイミングは on も quote も無い、
//     メッセージは on と quote、返信は reply_to と返信先の種類の on
//   - 引用は空白を畳んだ先頭 40 文字で、切った時は「…」
//   - 記録の行は jsonl の 1 行として読め、cid の形の違うものは読めない
import { describe, expect, test } from "bun:test";
import {
  commentBlockOf,
  commentBlockText,
  commentOnlyBlocks,
  CommentsFileLineSchema,
  commentsPromptText,
  parseCommentBlocks,
  quoteOf,
  type CommentBlock,
  type CommentRecord,
  type UserComment,
} from "../src/comments.ts";
import { parseWith } from "../src/parse.ts";

const comment = (patch: Partial<UserComment> = {}): UserComment => ({
  kind: "comment",
  author: "user",
  cid: "c7k2p",
  session_id: "s1",
  anchor: { kind: "message", uuid: "u-9", on: "応答" },
  quote: "この関数は呼び出し側で null を返すことがあり、そのまま…",
  body: "ここは undefined を返すのでは？",
  written: { at: "2026-11-22T00:00:00.000Z", after_uuid: "u-9" },
  updated_at: "2026-11-22T00:00:00.000Z",
  btw: false,
  status: "draft",
  ...patch,
});

describe("commentBlockText", () => {
  test("a block names the comment, what it is on, the quote, the chosen text and the body", () => {
    expect(
      commentBlockText({
        cid: "c7k2p",
        on: "応答",
        quote: "この関数は",
        selection: "null を返す",
        body: "ここは?",
      }),
    ).toBe(
      [
        '<comment cid="c7k2p" on="応答" quote="この関数は">',
        "<selection>null を返す</selection>",
        "ここは?",
        "</comment>",
      ].join("\n"),
    );
  });

  test("what a block does not have is not written", () => {
    expect(commentBlockText({ cid: "c5h2w", body: "横道の質問" })).toBe(
      '<comment cid="c5h2w">\n横道の質問\n</comment>',
    );
  });

  test("a reply names the comment it answers", () => {
    expect(
      commentBlockText({ cid: "c3xq9", reply_to: "c8m1t", on: "エージェントの返信", body: "了解" }),
    ).toBe('<comment cid="c3xq9" reply_to="c8m1t" on="エージェントの返信">\n了解\n</comment>');
  });
});

describe("parseCommentBlocks", () => {
  const tricky: CommentBlock[] = [
    {
      cid: "c7k2p",
      on: '"応答" & <x>',
      quote: "行1\n行2\t</comment>",
      selection: 'a </selection> b & <comment cid="c0000">',
      body: '本文 </comment>\n<comment cid="c11111">\n偽\n</comment>\n& &amp;',
    },
    { cid: "c0001", reply_to: "c7k2p", body: "  前後に空白  " },
    { cid: "c0002", body: "\n\n空行で始まる\n\n" },
  ];

  test("a block written and read back is the block", () => {
    for (const block of tricky) {
      expect(parseCommentBlocks(commentBlockText(block))).toEqual([block]);
    }
  });

  test("blocks sent together read back in order, and the text is nothing but them", () => {
    const text = commentsPromptText(tricky);
    expect(parseCommentBlocks(text)).toEqual(tricky);
    expect(commentOnlyBlocks(text)).toEqual(tricky);
    // The harness drops the whitespace at the prompt's ends.
    expect(commentOnlyBlocks(`\n  ${text}  \n`)).toEqual(tricky);
  });

  test("a text with anything beside the blocks is not a prompt of comments", () => {
    const block = commentBlockText({ cid: "c7k2p", body: "x" });
    expect(commentOnlyBlocks(`前置き\n${block}`)).toBeNull();
    expect(commentOnlyBlocks(`${block}\n後書き`)).toBeNull();
    expect(commentOnlyBlocks("ただの発言")).toBeNull();
    expect(parseCommentBlocks(`前置き\n${block}\n後書き`)).toEqual([{ cid: "c7k2p", body: "x" }]);
  });

  test("a block whose cid is not a comment id is not read", () => {
    expect(parseCommentBlocks('<comment cid="C-1">\nx\n</comment>')).toEqual([]);
    expect(parseCommentBlocks('<comment on="応答">\nx\n</comment>')).toEqual([]);
  });
});

describe("commentBlockOf", () => {
  const records = new Map<string, CommentRecord>();
  const recordOf = (cid: string) => records.get(cid);

  test("a comment on a message says what it is on and quotes it", () => {
    expect(commentBlockOf(comment(), recordOf)).toEqual({
      cid: "c7k2p",
      on: "応答",
      quote: "この関数は呼び出し側で null を返すことがあり、そのまま…",
      body: "ここは undefined を返すのでは？",
    });
  });

  test("a comment at a moment of the conversation is the body alone", () => {
    const { quote: _quote, ...timing } = comment({ anchor: { kind: "timing" } });
    expect(commentBlockOf(timing, recordOf)).toEqual({
      cid: "c7k2p",
      body: "ここは undefined を返すのでは？",
    });
  });

  test("a reply names the comment it answers and what kind that was", () => {
    records.set("c8m1t", {
      kind: "comment",
      author: "agent",
      cid: "c8m1t",
      session_id: "s1",
      anchor: { kind: "comment", cid: "c7k2p" },
      quote: "そうです",
      written: { at: "2026-11-22T00:00:09.000Z" },
      updated_at: "2026-11-22T00:00:09.000Z",
    });
    const reply = comment({
      cid: "c3xq9",
      anchor: { kind: "comment", cid: "c8m1t" },
      quote: "そうです",
      body: "了解",
    });
    expect(commentBlockOf(reply, recordOf)).toEqual({
      cid: "c3xq9",
      reply_to: "c8m1t",
      on: "エージェントの返信",
      quote: "そうです",
      body: "了解",
    });
  });

  test("a quote in a file names the file and the line", () => {
    const onFile = comment({
      anchor: {
        kind: "file",
        path: "docs/QUESTIONS.md",
        view: "preview",
        text: "XX-Q2",
        before: "## ",
        after: "\n",
        line: 42,
        line_text: "## XX-Q2",
      },
      quote: "## XX-Q2",
    });
    expect(commentBlockOf(onFile, recordOf)).toEqual({
      cid: "c7k2p",
      on: "ファイル docs/QUESTIONS.md:42 (プレビュー)",
      quote: "## XX-Q2",
      selection: "XX-Q2",
      body: "ここは undefined を返すのでは？",
    });
  });
});

describe("quoteOf", () => {
  test("the first 40 characters with the spaces folded, and … when cut", () => {
    expect(quoteOf("  a\n\n b\tc  ")).toBe("a b c");
    const long = "あ".repeat(41);
    expect(quoteOf(long)).toBe(`${"あ".repeat(40)}…`);
    expect(quoteOf("あ".repeat(40))).toBe("あ".repeat(40));
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

  test("a record whose cid is not a comment id does not read", () => {
    expect(parseWith(CommentsFileLineSchema, JSON.stringify(comment({ cid: "x" }))).ok).toBe(false);
  });
});
