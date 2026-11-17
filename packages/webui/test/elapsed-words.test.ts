// The words of the Timeline's marks of time gone by (DR-0054), as kawaz asked
// for them (2026-11-17): 「9日（9d3h） とかで良い。`（9d3h）` 部分は色を薄めて
// 良い。3時間（3h20m） のような感じで」. The main words are the largest unit in
// Japanese, rounded down; the detail in parentheses is the Timeline's elapsed
// time (`formatDuration`), left out under a minute, where it would say the
// same as the main words. What the mark means is left to where it stands, so
// no ぶり / 空き / 最後のターンから in what is shown; assistive technology gets
// a sentence that says it.
import { describe, expect, test } from "bun:test";
import { gapWords, idleWords, largestUnit, spokenDuration } from "../src/client/elapsed-words.ts";

const S = 1000;
const M = 60 * S;
const H = 60 * M;
const D = 24 * H;

describe("largestUnit", () => {
  // Each unit starts at exactly one of it; below, the next unit down.
  test("the largest unit, rounded down, from its exact start", () => {
    expect(largestUnit(0)).toBe("0秒");
    expect(largestUnit(59 * S + 999)).toBe("59秒");
    expect(largestUnit(M)).toBe("1分");
    expect(largestUnit(H - 1)).toBe("59分");
    expect(largestUnit(H)).toBe("1時間");
    expect(largestUnit(D - 1)).toBe("23時間");
    expect(largestUnit(D)).toBe("1日");
    expect(largestUnit(9 * D + 3 * H)).toBe("9日");
  });

  // A clock a little behind the row's time gives a negative elapsed time:
  // it reads as none rather than a negative number.
  test("a negative time is none", () => {
    expect(largestUnit(-5 * S)).toBe("0秒");
  });
});

describe("spokenDuration", () => {
  // The two units formatDuration shows, in words.
  test("the two largest units in words", () => {
    expect(spokenDuration(12 * S)).toBe("12秒");
    expect(spokenDuration(8 * M + 5 * S)).toBe("8分5秒");
    expect(spokenDuration(3 * H + 20 * M)).toBe("3時間20分");
    expect(spokenDuration(9 * D + 3 * H)).toBe("9日3時間");
  });
});

describe("idleWords", () => {
  test("the largest unit with formatDuration after it", () => {
    expect(idleWords(3 * H + 20 * M)).toEqual({
      main: "3時間",
      detail: "3h20m",
      spoken: "最後のターンから3時間20分",
    });
    expect(idleWords(8 * M + 5 * S)).toMatchObject({ main: "8分", detail: "8m5s" });
    expect(idleWords(9 * D + 3 * H)).toMatchObject({ main: "9日", detail: "9d3h" });
    // Exactly a unit still shows the detail: it says the minutes are 0.
    expect(idleWords(H)).toMatchObject({ main: "1時間", detail: "1h0m" });
  });

  // Under a minute `12秒` and `12s` say the same: no parentheses.
  test("no detail under a minute", () => {
    expect(idleWords(12 * S)).toEqual({
      main: "12秒",
      detail: null,
      spoken: "最後のターンから12秒",
    });
    expect(idleWords(M)).toMatchObject({ main: "1分", detail: "1m0s" });
  });
});

describe("gapWords", () => {
  // The main words count calendar days, as the band does; the detail is the
  // time that went by, which may be fewer whole days (two calendar days can
  // be 1d2h apart).
  test("calendar days, with the time that went by", () => {
    expect(gapWords(9, 9 * D + 3 * H)).toEqual({
      main: "9日",
      detail: "9d3h",
      spoken: "前の項目から9日（9日3時間）",
    });
    expect(gapWords(2, D + 2 * H)).toMatchObject({ main: "2日", detail: "1d2h" });
  });
});
