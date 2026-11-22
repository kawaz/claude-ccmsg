// What a person sent, against the prompts the session's transcript holds
// (DR-0035 §5).
// 何を保証するか:
//   - 送った文と同じ文の発言だけが届いた証になる。harness が取る時に削る両端の
//     空白 (trim の範囲) は違いとして数えない。それ以外の違い (途中の空白・空行・
//     行頭の空白、別の文) は違う文
//   - 送った時刻より前に書かれた発言は証にならない (同じ時刻は証になる)
//   - 1 つの発言は 1 つの送信にだけ当たる。同じ文を 2 回送った時は、古い送信から
//     順に、まだ当たっていない最も早い発言に当たる
//   - 時刻の読めない送信・発言は何にも当たらない
//   - 頭 (空白の後) が `/` の文は、その `/` と直後の ASCII の語の文字 (`/\w*`) を
//     バッククォートで囲んで入れる (DR-0035 §1)。それ以外の文は変えない。囲む前の文と
//     囲んだ後の文は同じ文として照合される
import { describe, expect, test } from "bun:test";
import {
  pairLandedPrompts,
  promptTextKey,
  quoteLeadingSlash,
  sameLandedText,
} from "../src/landed-prompts.ts";

const at = (second: number): string => new Date(Date.UTC(2026, 10, 22, 1, 0, second)).toISOString();

describe("sameLandedText", () => {
  test("the text as sent, or without the whitespace at its ends", () => {
    expect(sameLandedText("hello", "hello")).toBe(true);
    expect(sameLandedText("hello \n\t\u3000", "hello")).toBe(true);
    expect(sameLandedText("  hello", "hello")).toBe(true);
    expect(sameLandedText("\n hello \n", "hello")).toBe(true);
    expect(promptTextKey(" a\n\tb \n")).toBe("a\n\tb");
  });

  test("anything else is another text", () => {
    expect(sameLandedText("hello", "hello!")).toBe(false);
    expect(sameLandedText("a\n\nb", "a\nb")).toBe(false);
    expect(sameLandedText("a\n  b", "a\nb")).toBe(false);
    expect(sameLandedText("a  b", "a b")).toBe(false);
  });
});

describe("quoteLeadingSlash", () => {
  test("a leading / and the ASCII word characters after it go in backquotes", () => {
    expect(quoteLeadingSlash("/rename red")).toBe("`/rename` red");
    expect(quoteLeadingSlash("/ 1文字のときは検索しない")).toBe("`/` 1文字のときは検索しない");
    expect(quoteLeadingSlash("/設計の話")).toBe("`/`設計の話");
    expect(quoteLeadingSlash("/foo/bar.ts を見て")).toBe("`/foo`/bar.ts を見て");
    expect(quoteLeadingSlash("/a:b x")).toBe("`/a`:b x");
    expect(quoteLeadingSlash("/abc\n続き")).toBe("`/abc`\n続き");
  });

  test("the whitespace before the / is kept, and the / after it is still quoted", () => {
    expect(quoteLeadingSlash(" /rename red")).toBe(" `/rename` red");
    expect(quoteLeadingSlash("\u3000\n/context")).toBe("\u3000\n`/context`");
  });

  test("a text that does not begin with / is left as it is", () => {
    expect(quoteLeadingSlash("hello /rename")).toBe("hello /rename");
    expect(quoteLeadingSlash("a\n/rename")).toBe("a\n/rename");
    expect(quoteLeadingSlash('{"comment":"c0001","body":"/rename"}')).toBe(
      '{"comment":"c0001","body":"/rename"}',
    );
    expect(quoteLeadingSlash("!ls")).toBe("!ls");
    expect(quoteLeadingSlash("")).toBe("");
  });

  test("a quoted text is left as it is", () => {
    expect(quoteLeadingSlash("`/rename` red")).toBe("`/rename` red");
    expect(quoteLeadingSlash(quoteLeadingSlash("/ x"))).toBe("`/` x");
  });

  test("the text as written and the text as it landed quoted are the same text", () => {
    expect(sameLandedText("/rename red", "`/rename` red")).toBe(true);
    expect(sameLandedText(" /rename red \n", "`/rename` red")).toBe(true);
    expect(sameLandedText("/rename red", "/rename red")).toBe(true);
    expect(promptTextKey(" /x y ")).toBe("`/x` y");
    expect(sameLandedText("/rename red", "`/rename` blue")).toBe(false);
    expect(sameLandedText("/rename red", "rename red")).toBe(false);
  });
});

describe("pairLandedPrompts", () => {
  test("a text sent with a leading / lands as the quoted prompt", () => {
    const send = { text: "/rename red", at: at(0) };
    const prompt = { text: "`/rename` red", at: at(30) };
    expect(pairLandedPrompts([send], [prompt])).toEqual([{ sent: send, landed: prompt }]);
  });

  test("a prompt of the same text written after the send lands it", () => {
    const send = { id: "s1", text: "go on", at: at(0) };
    const prompt = { uuid: "p1", text: "go on", at: at(30) };
    expect(pairLandedPrompts([send], [prompt])).toEqual([{ sent: send, landed: prompt }]);
  });

  test("a prompt of another text lands nothing", () => {
    const send = { text: "go on", at: at(0) };
    expect(pairLandedPrompts([send], [{ text: "stop", at: at(30) }])).toEqual([]);
  });

  test("a prompt written before the send lands nothing; one at the same time does", () => {
    const send = { text: "go on", at: at(10) };
    expect(pairLandedPrompts([send], [{ text: "go on", at: at(9) }])).toEqual([]);
    const same = { text: "go on", at: at(10) };
    expect(pairLandedPrompts([send], [same])).toEqual([{ sent: send, landed: same }]);
  });

  test("the same text sent twice: one prompt lands the older send, two land both", () => {
    const older = { id: "older", text: "go on", at: at(0) };
    const newer = { id: "newer", text: "go on", at: at(5) };
    const first = { uuid: "p1", text: "go on", at: at(20) };
    const second = { uuid: "p2", text: "go on", at: at(40) };
    // Given newest first, as the composer lists them.
    expect(pairLandedPrompts([newer, older], [first])).toEqual([{ sent: older, landed: first }]);
    expect(pairLandedPrompts([newer, older], [second, first])).toEqual([
      { sent: older, landed: first },
      { sent: newer, landed: second },
    ]);
  });

  test("a prompt between two sends of the same text lands the older only", () => {
    const older = { id: "older", text: "go on", at: at(0) };
    const newer = { id: "newer", text: "go on", at: at(20) };
    const between = { text: "go on", at: at(10) };
    expect(pairLandedPrompts([older, newer], [between])).toEqual([
      { sent: older, landed: between },
    ]);
  });

  test("times that do not read land nothing", () => {
    expect(pairLandedPrompts([{ text: "a", at: "x" }], [{ text: "a", at: at(1) }])).toEqual([]);
    expect(pairLandedPrompts([{ text: "a", at: at(0) }], [{ text: "a", at: "x" }])).toEqual([]);
  });
});
