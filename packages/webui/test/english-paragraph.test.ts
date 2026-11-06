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

  // webui の Composer が本文に入れる添付のリンク (DR-0015 §2.4) は、名前も
  // パスも英数字が多いが人の書いた文ではない。
  test("a paragraph that is only an attachment link is not judged", () => {
    const attachment =
      "[FILE1:Screenshot 2026-11-06 at 10.15.42.png](/var/folders/ab/cdefgh0123456789/T/claude-ccmsg-501/attachment/0f4c2a8e-6b1d-4a57-9d2e-3c8b7e1f9a20.png)";
    expect(hasEnglishParagraph(`この画面を見て直して。\n\n${attachment}`)).toBe(false);
  });

  test("Japanese with many bare absolute paths stays original", () => {
    expect(
      hasEnglishParagraph(
        "/Users/someone/repos/example/main/packages/webui/src/client/translate.ts と /Users/someone/repos/example/main/docs/decisions/DR-0049-translation-tab.md と ~/repos/example/main/test/english-paragraph.test.ts を読んで、判定を直す。",
      ),
    ).toBe(false);
  });

  test("English with paths is still English", () => {
    expect(
      hasEnglishParagraph(
        "Read /Users/someone/repos/example/src/translate.ts and https://example.com/docs/plamo before changing the default tab rule.",
      ),
    ).toBe(true);
  });
});
