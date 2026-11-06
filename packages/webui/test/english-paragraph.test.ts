// hasEnglishParagraph (DR-0049 §8): 既定のタブを ja(plamo) にするかの判定。
// コードを除いた本文を段落に分け、20 文字以上の段落のうち日本語比率 2 割未満の
// ものが 1 つでもあれば true。
import { describe, expect, test } from "bun:test";
import { hasEnglishParagraph } from "../src/client/translate.ts";

const ENGLISH = "I will read the file first, then run the whole test suite again.";

describe("hasEnglishParagraph", () => {
  test("an English body has one", () => {
    expect(hasEnglishParagraph(ENGLISH)).toBe(true);
  });

  test("one English paragraph among many Japanese paragraphs is enough", () => {
    const japanese = [
      "まずファイルを読む。",
      "次にテストを走らせる。",
      "最後に結果をまとめて報告する。",
    ];
    expect(hasEnglishParagraph([...japanese, ENGLISH, ...japanese].join("\n\n"))).toBe(true);
  });

  test("short English lines alone do not count", () => {
    expect(hasEnglishParagraph("OK\n\nDone.\n\nLGTM, thanks")).toBe(false);
  });

  test("a Japanese-only body has none", () => {
    expect(hasEnglishParagraph("まずファイルを読む。\n\n次にテストを走らせる。")).toBe(false);
  });

  test("a short Japanese quote inside an English paragraph keeps it English", () => {
    expect(
      hasEnglishParagraph('kawaz said "作り直す" so I will rebuild the parser from scratch.'),
    ).toBe(true);
  });

  test("a paragraph around half Japanese is not English", () => {
    expect(hasEnglishParagraph("ファイルを読んで中身を確認する read the whole file now")).toBe(
      false,
    );
  });

  test("fenced and inline code do not count", () => {
    const code =
      "```ts\nconst someVeryLongIdentifierName = anotherVeryLongFunctionCall();\n\nreturn x;\n```";
    expect(hasEnglishParagraph(`${code}\n\n日本語の説明だけがある。`)).toBe(false);
    expect(
      hasEnglishParagraph("`someVeryLongIdentifierNameThatIsEnglish` を呼んでから確認する。"),
    ).toBe(false);
  });

  test("an unterminated fence runs to the end of the body", () => {
    expect(hasEnglishParagraph(`日本語の段落。\n\n\`\`\`\n${ENGLISH}\n\n${ENGLISH}`)).toBe(false);
  });
});
