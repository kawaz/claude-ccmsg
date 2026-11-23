// A quote a comment is made on inside a Timeline bubble (DR-0062 §2, §3).
// 何を保証するか:
//   - 選んだ文字は両端の空白を落とし、前後の文字は空白を畳んで 30 文字まで (描画の
//     両端の空白は前後の文字に入れない)。空白だけの選択は選択でない
//   - 探し直しは今描かれている文字の中で、選んだ文字とその前後の文字の並びで探す。
//     位置がずれても同じ箇所に当たり、選んだ文字が消えたら見つからない。同じ文字が
//     2 か所あっても前後の文字で決まり、前後が変わって同じ文字が 2 か所なら見つから
//     ない (前後が変わっても 1 か所だけなら当たる)。空白と改行の違いでは外れない
//   - 範囲選択の 💬 は項目の右端の帯に、選択範囲の縦の真ん中に置く。画面より高い
//     選択では見えている部分の真ん中、見えていなければ置かない。帯の下に浮いている
//     もの (入力の FAB・パネル・コメントのフォーム) とは重ねず、その上に置く
import { describe, expect, test } from "bun:test";
import { choiceButtonPlace, choiceIn, findQuote } from "../src/client/comment-quote.ts";

const DRAWN = "起動手順を終えました。\n次は状態ファイルを書き直すことです。";

describe("choiceIn", () => {
  test("the text chosen, and up to 30 characters around it with spaces folded", () => {
    const start = DRAWN.indexOf("状態");
    expect(choiceIn(DRAWN, start, start + 6)).toEqual({
      text: "状態ファイル",
      before: "起動手順を終えました。 次は",
      after: "を書き直すことです。",
      start,
      end: start + 6,
    });
    const long = `${"前".repeat(40)}選ぶ${"後".repeat(40)}`;
    const chosen = choiceIn(long, 40, 42);
    expect(chosen?.before).toBe("前".repeat(30));
    expect(chosen?.after).toBe("後".repeat(30));
  });

  test("spaces at its ends are left out; spaces alone choose nothing", () => {
    const text = "あ  いう  え";
    expect(choiceIn(text, 1, 7)).toMatchObject({ text: "いう", start: 3, end: 5 });
    expect(choiceIn(text, 1, 3)).toBeNull();
    // The ends of what is drawn are no characters around it.
    expect(choiceIn("\n選ぶ\n", 1, 3)).toMatchObject({ before: "", after: "" });
  });
});

describe("findQuote", () => {
  const chosen = choiceIn(DRAWN, DRAWN.indexOf("状態"), DRAWN.indexOf("状態") + 6);
  if (chosen === null) throw new Error("expected a choice");

  test("the same place when the text moves", () => {
    const moved = `前に足された段落。\n\n${DRAWN}`;
    const at = findQuote(moved, chosen);
    expect(at === null ? null : moved.slice(at.start, at.end)).toBe("状態ファイル");
    expect(at?.start).toBe(moved.indexOf("状態"));
  });

  test("nowhere when the text chosen is gone", () => {
    expect(findQuote("起動手順を終えました。次は設定を書き直すことです。", chosen)).toBeNull();
  });

  test("of the same text in two places, the one its characters around stand by", () => {
    const twice = "状態ファイルは古い。起動手順を終えました。次は状態ファイルを書き直すことです。";
    const at = findQuote(twice, chosen);
    expect(at?.start).toBe(twice.lastIndexOf("状態"));
    // Without those around it, two places are none.
    expect(
      findQuote(twice, { text: "状態ファイル", before: "別の前", after: "別の後" }),
    ).toBeNull();
    // One place is found whatever is around it.
    expect(
      findQuote("ここだけに状態ファイルがある", { text: "状態ファイル", before: "x", after: "y" }),
    ).toEqual({ start: 5, end: 11 });
  });

  test("spaces and line breaks do not count", () => {
    const rewrapped = "起動手順を 終えました。次は状態\nファイル を書き直す\n\nことです。";
    const at = findQuote(rewrapped, chosen);
    expect(at === null ? null : rewrapped.slice(at.start, at.end)).toBe("状態\nファイル");
  });

  test("of several places with the same characters around, the nearest to where it was", () => {
    const same = "AB選ぶCD / AB選ぶCD / AB選ぶCD";
    const quote = { text: "選ぶ", before: "AB", after: "CD" };
    expect(findQuote(same, { ...quote, start: 14 })?.start).toBe(11);
    expect(findQuote(same, quote)?.start).toBe(2);
  });
});

describe("choiceButtonPlace", () => {
  const item = { top: 0, bottom: 2000, left: 0, right: 1000 };
  const seen = { top: 100, bottom: 900, left: 0, right: 1000 };

  test("at the right end of the item, the middle of the choice's height", () => {
    expect(
      choiceButtonPlace({
        choice: [
          { top: 300, bottom: 320, left: 100, right: 600 },
          { top: 320, bottom: 340, left: 0, right: 200 },
        ],
        item,
        seen,
        size: 44,
      }),
    ).toEqual({ left: 956, top: 298 });
  });

  test("a choice taller than what is seen: the middle of what is seen of it", () => {
    expect(
      choiceButtonPlace({
        choice: [{ top: -500, bottom: 1500, left: 0, right: 500 }],
        item,
        seen,
        size: 44,
      }),
    ).toEqual({ left: 956, top: 478 });
    // Its lower part seen: the middle of that part.
    expect(
      choiceButtonPlace({
        choice: [{ top: 0, bottom: 300, left: 0, right: 500 }],
        item,
        seen,
        size: 44,
      }),
    ).toEqual({ left: 956, top: 178 });
  });

  test("none of the choice seen: nowhere", () => {
    expect(
      choiceButtonPlace({
        choice: [{ top: 950, bottom: 980, left: 0, right: 500 }],
        item,
        seen,
        size: 44,
      }),
    ).toBeNull();
    expect(choiceButtonPlace({ choice: [], item, seen, size: 44 })).toBeNull();
  });

  test("what floats over the band's bottom (the input's button) keeps the button above it, off the middle if need be", () => {
    const fab = { top: 820, bottom: 876, left: 940, right: 996 };
    expect(
      choiceButtonPlace({
        choice: [{ top: 830, bottom: 850, left: 0, right: 500 }],
        item,
        seen,
        floating: [fab],
        size: 44,
      }),
    ).toEqual({ left: 956, top: 776 });
    expect(
      choiceButtonPlace({
        choice: [{ top: 700, bottom: 820, left: 0, right: 500 }],
        item,
        seen,
        floating: [fab],
        size: 44,
      }),
    ).toEqual({ left: 956, top: 738 });
    // Not in the band: no matter.
    expect(
      choiceButtonPlace({
        choice: [{ top: 830, bottom: 850, left: 0, right: 500 }],
        item,
        seen,
        floating: [{ ...fab, left: 100, right: 156 }],
        size: 44,
      }),
    ).toEqual({ left: 956, top: 818 });
  });

  test("a short choice at the edge of what is seen keeps the button inside it", () => {
    expect(
      choiceButtonPlace({
        choice: [{ top: 100, bottom: 110, left: 0, right: 500 }],
        item,
        seen,
        size: 44,
      }),
    ).toEqual({ left: 956, top: 100 });
  });
});
