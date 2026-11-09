// 編集領域とファイルの本文の間の変換 (editor-text.ts、DR-0051 §4): 改行コードは
// 開いた時の本文で決めて保存の時に戻し、編集領域の DOM には末尾の番兵の改行を
// 足して置く。
import { describe, expect, test } from "bun:test";
import {
  detectLineEnding,
  fromEditorDom,
  splitEditorDom,
  toEditorDom,
  toEditorText,
  toFileText,
} from "../src/client/editor-text.ts";

describe("改行コード", () => {
  test("改行が全部 CRLF のファイルは CRLF と判定する", () => {
    expect(detectLineEnding("a\r\nb\r\n")).toBe("\r\n");
    expect(detectLineEnding("a\r\nb")).toBe("\r\n");
  });

  test("LF だけ・改行なし・空のファイルは LF", () => {
    expect(detectLineEnding("a\nb\n")).toBe("\n");
    expect(detectLineEnding("abc")).toBe("\n");
    expect(detectLineEnding("")).toBe("\n");
    expect(detectLineEnding("\n")).toBe("\n");
  });

  test("LF と CRLF が混ざったファイルは LF (どちらが先でも)", () => {
    expect(detectLineEnding("a\r\nb\nc\r\n")).toBe("\n");
    expect(detectLineEnding("a\nb\r\n")).toBe("\n");
  });

  // 開いて編集せずに保存しても、ファイルの改行コードは変わらない
  test.each([
    ["LF", "const a = 1;\nconst b = 2;\n"],
    ["CRLF", "const a = 1;\r\nconst b = 2;\r\n"],
    ["CRLF で末尾改行なし", "a\r\nb"],
    ["改行なし", "abc"],
    ["空", ""],
  ])("%s のファイルは編集せずに保存すると元の本文に戻る", (_label, file) => {
    const { text, lineEnding } = toEditorText(file);
    expect(text.includes("\r\n")).toBe(false);
    expect(toFileText(text, lineEnding)).toBe(file);
  });

  test("CRLF のファイルに LF で足した行は CRLF で保存される", () => {
    const { text, lineEnding } = toEditorText("a\r\nb\r\n");
    expect(toFileText(`${text}c\n`, lineEnding)).toBe("a\r\nb\r\nc\r\n");
  });

  test("混在するファイルは LF に揃えて保存される", () => {
    const { text, lineEnding } = toEditorText("a\r\nb\nc\r\n");
    expect(text).toBe("a\nb\nc\n");
    expect(toFileText(text, lineEnding)).toBe("a\nb\nc\n");
  });

  test("CR だけの改行は改行として扱わず、そのまま残す", () => {
    const { text, lineEnding } = toEditorText("a\rb\n");
    expect(text).toBe("a\rb\n");
    expect(toFileText(text, lineEnding)).toBe("a\rb\n");
  });
});

describe("末尾の番兵", () => {
  test.each(["", "abc", "abc\n", "abc\n\n", "a\n\tb  c\n"])(
    "DOM に置いて取り出すと元の本文に戻る: %j",
    (text) => {
      expect(fromEditorDom(toEditorDom(text))).toBe(text);
    },
  );

  // ブラウザは最終行に文字を打つと末尾の改行を置き換えることがある
  // (DOM "abc\n\n" の 2 行目に d を打つと "abc\nd")。その時は落とさない。
  test("番兵が消えた DOM はそのまま本文にする", () => {
    expect(fromEditorDom("abc\nd")).toBe("abc\nd");
  });

  test("全部消して DOM に番兵だけが残ったら空", () => {
    expect(fromEditorDom("\n")).toBe("");
  });
});

describe("テキストノードへの分割", () => {
  test("繋ぐと元の文字列に戻り、各ノードは指定の行数ずつ", () => {
    const dom = toEditorDom(Array.from({ length: 450 }, (_, i) => `line ${i}`).join("\n"));
    const parts = splitEditorDom(dom, 200);
    expect(parts.join("")).toBe(dom);
    expect(parts.map((part) => part.split("\n").length - 1)).toEqual([200, 200, 50]);
  });

  test("行数ちょうどで終わる文字列は余分な空のノードを作らない", () => {
    expect(splitEditorDom("a\nb\n", 2)).toEqual(["a\nb\n"]);
  });

  test("空の文字列は空のノード 1 つ", () => {
    expect(splitEditorDom("", 200)).toEqual([""]);
  });
});
