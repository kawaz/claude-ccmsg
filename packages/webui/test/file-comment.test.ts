// A comment on a quote in a file the Files tab shows (DR-0062 §2, §4, §7,
// P20, P26): where in the file the choice is, finding it again in what the
// file holds now, and the path the comment names the file by.
// 何を保証するか:
//   - ソースの選択は、選んだ文字 (両端の空白を除く)・前後の文字・始まりの行と列 (1 から、
//     見た目の 1 文字で数える)・終わりの行 (始まりと同じ行なら持たない)・始まりの行の文
//     (行末の \r を除く) になる
//   - プレビューの選択の行は、選んだ文字の始まりを含む md の塊の元の始まりの行で、終わり
//     の行は終わりを含む塊の元の終わりの行。列は持たない。行の文はソースのその行
//   - 探し直しは文字で行う: 行がずれても同じ箇所に出る。選んだ文字が消えたら見つからない。
//     同じ文字が何か所にもある時は前後の文字で決まり、前後も同じなら元の行に近い方。
//     前後が変わっても選んだ文字が 1 か所だけなら見つかる
//   - コメントの指すパスは、セッションの cwd の中なら cwd からの相対、外なら絶対。
//     Files のパス (repo_root ?? cwd からの相対か絶対) との行き来で同じファイルに戻る
import { describe, expect, test } from "bun:test";
import {
  fileAnchorPathOf,
  fileTreePathOf,
  findPreviewQuote,
  findSourceQuote,
  previewQuoteOf,
  sourceQuoteOf,
  type PreviewPiece,
} from "../src/client/file-comment.ts";

const SOURCE = ["# 問い", "", "## 裁定待ち", "", "(なし)", "", "## 確認待ち", ""].join("\n");

describe("sourceQuoteOf", () => {
  test("a choice on one line is its line and column, and no end line", () => {
    const start = SOURCE.indexOf("裁定");
    expect(sourceQuoteOf(SOURCE, start, start + 2)).toEqual({
      text: "裁定",
      before: "# 問い ## ",
      after: "待ち (なし) ## 確認待ち",
      line: 3,
      col: 4,
      line_text: "## 裁定待ち",
    });
  });

  test("a choice over lines ends on the line of its last character, the spaces at its ends left out", () => {
    // From the line break before 「## 裁定待ち」 to the one after 「(なし)」.
    const start = SOURCE.indexOf("## 裁定待ち") - 1;
    const end = SOURCE.indexOf("(なし)") + "(なし)".length + 1;
    expect(sourceQuoteOf(SOURCE, start, end)).toMatchObject({
      text: "## 裁定待ち\n\n(なし)",
      line: 3,
      end_line: 5,
      col: 1,
    });
  });

  test("the column counts characters as one sees them, and a \\r ends no line's text", () => {
    const content = "👍👍 x\r\nnext\r\n";
    const start = content.indexOf("x");
    expect(sourceQuoteOf(content, start, start + 1)).toMatchObject({
      line: 1,
      col: 4,
      line_text: "👍👍 x",
    });
  });

  test("nothing but spaces chosen is no choice", () => {
    expect(sourceQuoteOf(SOURCE, 1, 1)).toBeNull();
    expect(sourceQuoteOf(SOURCE, SOURCE.indexOf("\n\n"), SOURCE.indexOf("\n\n") + 2)).toBeNull();
  });
});

describe("findSourceQuote", () => {
  const chosen = (content: string, text: string) => {
    const start = content.indexOf(text);
    const quote = sourceQuoteOf(content, start, start + text.length);
    if (quote === null) throw new Error("expected a choice");
    return quote;
  };

  test("lines put before it move it, and it is found by its characters", () => {
    const quote = chosen(SOURCE, "(なし)");
    const now = `前書き\n\n${SOURCE}`;
    const at = findSourceQuote(now, quote);
    expect(at).toEqual({
      start: now.indexOf("(なし)"),
      end: now.indexOf("(なし)") + 4,
    });
  });

  test("a quote whose text is gone is not found", () => {
    const quote = chosen(SOURCE, "(なし)");
    expect(findSourceQuote(SOURCE.replace("(なし)", "- Q1: 答えた"), quote)).toBeNull();
  });

  test("of the same text in several places, the characters around it tell which", () => {
    const content = "A: 済み\nB: 未定\nC: 済み\n";
    const at = content.lastIndexOf("済み");
    const quote = sourceQuoteOf(content, at, at + 2);
    if (quote === null) throw new Error("expected a choice");
    expect(quote).toMatchObject({
      text: "済み",
      before: "A: 済み B: 未定 C: ",
      line: 3,
    });
    // The first 「済み」 moved nearer to where the chosen one was: still the C's.
    const now = "C の前\nA: 済み\nB: 未定\nC: 済み\n";
    expect(findSourceQuote(now, quote)).toEqual({
      start: now.lastIndexOf("済み"),
      end: now.lastIndexOf("済み") + 2,
    });
  });

  test("the same text with the same around it is the one nearest its line", () => {
    // Ten blocks alike: the 30 characters around the 5th and the 6th quote
    // are the same, so only the line tells them apart.
    const content = "## 問い\n(なし)\n## 次\n".repeat(10);
    const nth = (text: string, n: number): number => {
      let at = -1;
      for (let i = 0; i < n; i += 1) at = text.indexOf("(なし)", at + 1);
      return at;
    };
    const fifth = nth(content, 5);
    const quote = sourceQuoteOf(content, fifth, fifth + 4);
    if (quote === null) throw new Error("expected a choice");
    expect(quote.line).toBe(14);
    expect(sourceQuoteOf(content, nth(content, 6), nth(content, 6) + 4)).toMatchObject({
      before: quote.before,
      after: quote.after,
    });
    // A line put before them all: still the 5th, not the 4th or the 6th.
    const now = `x\n${content}`;
    expect(findSourceQuote(now, quote)).toEqual({
      start: nth(now, 5),
      end: nth(now, 5) + 4,
    });
  });

  test("the characters around it changed, its text alone in one place is found", () => {
    const quote = chosen(SOURCE, "(なし)");
    const now = SOURCE.replace("## 裁定待ち", "## 決めること").replace("## 確認待ち", "## 他");
    expect(findSourceQuote(now, quote)).toEqual({
      start: now.indexOf("(なし)"),
      end: now.indexOf("(なし)") + 4,
    });
  });
});

describe("previewQuoteOf / findPreviewQuote", () => {
  // The preview draws 「問い」 (line 1), 「裁定待ち」 (3), a paragraph of two
  // source lines 「一行目 二行目」 (5-6), 「確認待ち」 (8).
  const source = ["# 問い", "", "## 裁定待ち", "", "一行目", "二行目", "", "## 確認待ち"].join(
    "\n",
  );
  const drawn = "問い\n裁定待ち\n一行目\n二行目\n確認待ち";
  const pieces: PreviewPiece[] = [
    { start: 0, line: 1, endLine: 1 },
    { start: drawn.indexOf("裁定待ち"), line: 3, endLine: 3 },
    { start: drawn.indexOf("一行目"), line: 5, endLine: 6 },
    { start: drawn.indexOf("確認待ち"), line: 8, endLine: 8 },
  ];

  test("a choice in a block is the block's first line in the source, with no column", () => {
    const start = drawn.indexOf("二行目");
    expect(previewQuoteOf(drawn, start, start + 3, pieces, source)).toEqual({
      text: "二行目",
      before: "問い 裁定待ち 一行目 ",
      after: " 確認待ち",
      line: 5,
      end_line: 6,
      line_text: "一行目",
    });
  });

  test("a choice over blocks ends on the last line of the block its end is in", () => {
    const start = drawn.indexOf("待ち");
    const end = drawn.indexOf("一行目") + 1;
    expect(previewQuoteOf(drawn, start, end, pieces, source)).toMatchObject({
      line: 3,
      end_line: 6,
      line_text: "## 裁定待ち",
    });
    const heading = drawn.indexOf("確認");
    const one = previewQuoteOf(drawn, heading, heading + 2, pieces, source);
    expect(one).not.toHaveProperty("end_line");
    expect(one).not.toHaveProperty("col");
  });

  test("the same text in two blocks is found at the block nearest its line", () => {
    const twice = "待ち\n待ち";
    const twicePieces: PreviewPiece[] = [
      { start: 0, line: 3, endLine: 3 },
      { start: 3, line: 8, endLine: 8 },
    ];
    expect(
      findPreviewQuote(twice, twicePieces, {
        text: "待ち",
        before: "",
        after: "",
        line: 8,
      }),
    ).toEqual({
      start: 3,
      end: 5,
    });
    expect(
      findPreviewQuote(twice, twicePieces, {
        text: "待ち",
        before: "",
        after: "",
        line: 3,
      }),
    ).toEqual({
      start: 0,
      end: 2,
    });
    expect(
      findPreviewQuote(twice, twicePieces, {
        text: "済み",
        before: "",
        after: "",
        line: 3,
      }),
    ).toBeNull();
  });
});

describe("fileAnchorPathOf / fileTreePathOf", () => {
  test("a file inside the cwd is relative to it, one outside is absolute", () => {
    expect(fileAnchorPathOf("docs/QUESTIONS.md", "/r", "/r")).toBe("docs/QUESTIONS.md");
    // The tree is the repo's, the cwd a directory in it.
    expect(fileAnchorPathOf("pkg/a/src/x.ts", "/r", "/r/pkg/a")).toBe("src/x.ts");
    expect(fileAnchorPathOf("README.md", "/r", "/r/pkg/a")).toBe("/r/README.md");
    expect(fileAnchorPathOf("/etc/hosts", "/r", "/r")).toBe("/etc/hosts");
    expect(fileAnchorPathOf("/r/pkg/a/b.md", "/r", "/r/pkg/a/")).toBe("b.md");
    // A sibling whose name starts as the cwd's is not in it.
    expect(fileAnchorPathOf("/r/pkg/ab/c.md", "/r", "/r/pkg/a")).toBe("/r/pkg/ab/c.md");
    expect(fileAnchorPathOf("a.md", "/r", undefined)).toBeNull();
    expect(fileAnchorPathOf("a.md", undefined, "/r")).toBeNull();
  });

  test("the path a comment names is the Files tab's path of the same file", () => {
    for (const [tree, root, cwd] of [
      ["docs/QUESTIONS.md", "/r", "/r"],
      ["pkg/a/src/x.ts", "/r", "/r/pkg/a"],
      ["README.md", "/r", "/r/pkg/a"],
      ["/etc/hosts", "/r", "/r"],
    ] as const) {
      const named = fileAnchorPathOf(tree, root, cwd);
      if (named === null) throw new Error("expected a path");
      expect(fileTreePathOf(named, root, cwd)).toBe(tree);
    }
    expect(fileTreePathOf("a.md", "/r", undefined)).toBeNull();
  });
});
