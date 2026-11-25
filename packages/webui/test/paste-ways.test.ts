// 貼り付けのボタンの入れ方ごとの文字 (DR-0065 §8、kawaz 2026-11-25)。
// 何を保証するか:
//   - plain はクリップボードの文字のまま
//   - markdown は、行の途中なら前に改行 1 つ、後ろに常に改行 1 つ。中身は変えない
//   - quote は各行の頭に `> ` (空の行は `>`)。行の途中なら前に改行 2 つ、行の頭 (欄の先頭・
//     前が空行も含む) なら 1 つ。後ろに改行 2 つ
//   - block は ```lang と ``` で囲む。中にバッククォートの並びがあれば囲みはその最長より
//     1 つ多い。前後の改行は markdown と同じ
//   - 終わりの改行は quote・block の行を作らない
//   - lang の見当は shebang・JSON・`<` で始まる HTML/XML・典型の行の頭で、当たらなければ無し
//   - 添付の大きさの文言は UTF-8 のバイト数で、1,000 の境で数字だけと切り上げた `#,###k` に分かれる
// 「入れる所の前の文字」は、選択があればその始まりより前 (呼び手が渡す)。選択の置き換えは
// 欄への挿し込みの側 (PasteButton の dom test と e2e) が見る。
import { describe, expect, test } from "bun:test";
import { attachmentSizeLabel, codeLanguageOf, pastedText } from "../src/client/paste-ways.ts";

/** 入れる所の前の文字の場合: 欄の先頭、行の頭 (改行の直後)、前が空行、行の途中。 */
const AT_START = "";
const LINE_HEAD = "a\n";
const AFTER_BLANK = "a\n\n";
const MID_LINE = "a";

describe("plain", () => {
  test.each([AT_START, LINE_HEAD, MID_LINE])("is the text as it is (before %p)", (before) => {
    expect(pastedText("plain", "x\n  y\n", before)).toBe("x\n  y\n");
  });
});

describe("markdown", () => {
  test.each([
    [AT_START, "# t\n- a\n"],
    [LINE_HEAD, "# t\n- a\n"],
    [AFTER_BLANK, "# t\n- a\n"],
    [MID_LINE, "\n# t\n- a\n"],
  ])("before %p: a line break before only mid-line, one always after", (before, expected) => {
    expect(pastedText("markdown", "# t\n- a", before)).toBe(expected);
  });

  test("keeps the text as it is, its own last line break too", () => {
    expect(pastedText("markdown", "a  \n\tb\n", AT_START)).toBe("a  \n\tb\n\n");
  });
});

describe("quote", () => {
  test.each([
    [AT_START, "\n> a\n> b\n\n"],
    [LINE_HEAD, "\n> a\n> b\n\n"],
    [AFTER_BLANK, "\n> a\n> b\n\n"],
    [MID_LINE, "\n\n> a\n> b\n\n"],
  ])("before %p: two line breaks before mid-line, else one; two after", (before, expected) => {
    expect(pastedText("quote", "a\nb", before)).toBe(expected);
  });

  test("an empty line is `>`", () => {
    expect(pastedText("quote", "a\n\nb", AT_START)).toBe("\n> a\n>\n> b\n\n");
  });

  test("the text's last line break makes no line", () => {
    expect(pastedText("quote", "a\nb\n", AT_START)).toBe("\n> a\n> b\n\n");
  });

  test("CRLF line breaks", () => {
    expect(pastedText("quote", "a\r\nb\r\n", AT_START)).toBe("\n> a\n> b\n\n");
  });
});

describe("block", () => {
  test.each([
    [AT_START, "```\nhello\n```\n"],
    [LINE_HEAD, "```\nhello\n```\n"],
    [MID_LINE, "\n```\nhello\n```\n"],
  ])("before %p: the line breaks as markdown's", (before, expected) => {
    expect(pastedText("block", "hello", before)).toBe(expected);
  });

  test("the text's last line break makes no empty line in the block", () => {
    expect(pastedText("block", "hello\n", AT_START)).toBe("```\nhello\n```\n");
  });

  test("the language guessed goes after the fence", () => {
    expect(pastedText("block", '{"a": 1}', AT_START)).toBe('```json\n{"a": 1}\n```\n');
  });

  test.each([
    ["a ``` b", "````\na ``` b\n````\n"],
    ["````\nx\n````", "`````\n````\nx\n````\n`````\n"],
    ["`one` and ``two``", "```\n`one` and ``two``\n```\n"],
  ])("a fence longer than the longest run of backticks in %p", (text, expected) => {
    expect(pastedText("block", text, AT_START)).toBe(expected);
  });
});

describe("codeLanguageOf", () => {
  test.each([
    ["#!/bin/sh\necho a", "sh"],
    ["#!/usr/bin/env bash\nset -e", "sh"],
    ["#!/usr/bin/env python3\nprint(1)", "python"],
    ["#!/usr/bin/env bun\nconsole.log(1)", "ts"],
    ["#!/usr/bin/env node\nconsole.log(1)", "js"],
    ['{"a": [1, 2]}', "json"],
    ["[1, 2]", "json"],
    ["<!doctype html>\n<p>a</p>", "html"],
    ["<div>a</div>", "html"],
    ['<?xml version="1.0"?>\n<a/>', "xml"],
    ["diff --git a/x b/x\n--- a/x", "diff"],
    ["@@ -1,2 +1,2 @@\n-a\n+b", "diff"],
    ["fn main() {\n}", "rust"],
    ["let mut a = 1;", "rust"],
    ["use std::io;", "rust"],
    ["package main\n\nfunc main() {}", "go"],
    ["def f(x):\n    return x", "python"],
    ["from os import path", "python"],
    ["import os\nimport sys", "python"],
    ['import { a } from "./a.ts";', "ts"],
    ["export const a = 1;", "ts"],
    ["const a = 1;", "ts"],
    ["$ ls -la", "sh"],
    ["git status", "sh"],
    ["just test", "sh"],
    ["export PATH=/usr/bin", "sh"],
  ])("%p is %p", (text, language) => {
    expect(codeLanguageOf(text)).toBe(language);
  });

  test.each([["This is a sentence."], ["{not json"], ["#!/usr/bin/env unknown-thing"], [""]])(
    "%p has none",
    (text) => {
      expect(codeLanguageOf(text)).toBeNull();
    },
  );
});

describe("attachmentSizeLabel", () => {
  test.each([
    ["", "0"],
    ["a".repeat(512), "512"],
    ["a".repeat(999), "999"],
    ["a".repeat(1000), "1k"],
    ["a".repeat(1001), "2k"],
    ["a".repeat(1_999), "2k"],
    ["a".repeat(1_234_000), "1,234k"],
    ["a".repeat(1_234_001), "1,235k"],
  ])("a text of %#: %p", (text, label) => {
    expect(attachmentSizeLabel(text)).toBe(label);
  });

  test("counts UTF-8 bytes, not characters", () => {
    // 「あ」は UTF-8 で 3 バイト: 333 文字で 999、334 文字で 1,002。
    expect(attachmentSizeLabel("あ".repeat(333))).toBe("999");
    expect(attachmentSizeLabel("あ".repeat(334))).toBe("2k");
  });
});
