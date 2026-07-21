// editorLineCount is FileViewer 編集モードの行番号ガター用ヘルパ。textarea の
// 視覚行 (= カーソル可能な行) と 1:1 対応させる必要があり、`splitLines` (閲覧側で
// 末尾改行を吸収する) とは意味論が違うことをテストで固定する。
import { describe, expect, test } from "bun:test";
import { editorLineCount } from "../src/client/utils.ts";

describe("editorLineCount", () => {
  test("空文字でも 1 行 (textarea は常に 1 行以上表示する)", () => {
    expect(editorLineCount("")).toBe(1);
  });

  test("改行なしの 1 行", () => {
    expect(editorLineCount("abc")).toBe(1);
  });

  test("改行が n 個で n+1 行", () => {
    expect(editorLineCount("a\nb")).toBe(2);
    expect(editorLineCount("a\nb\nc")).toBe(3);
  });

  test("末尾改行はその後ろの空行を 1 行として数える (splitLines との違い)", () => {
    expect(editorLineCount("a\n")).toBe(2);
    expect(editorLineCount("a\nb\n")).toBe(3);
  });

  test("連続改行も個別に数える", () => {
    expect(editorLineCount("\n\n\n")).toBe(4);
  });
});
