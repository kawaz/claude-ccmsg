// useJsonStringCopy の対象判定 (`parseJsonStringToken`) の検証。hook 本体は
// DOM + clipboard 前提で bun test から回せないため、コピー可否と値を決める
// pure な判定だけを切り出して回す (use-fab-popup.test.ts と同じ流儀)。
import { describe, expect, test } from "bun:test";
import { parseJsonStringToken } from "../src/client/json-string-token.ts";

describe("parseJsonStringToken", () => {
  test("JSON 文字列リテラルは parse 後の値を返す", () => {
    expect(parseJsonStringToken('"hello"')).toBe("hello");
  });

  test("エスケープが解除される (これがこの UI の目的)", () => {
    // 見た目は `"C:\\tmp\n"`、コピーしたいのは実際のバックスラッシュ 1 個と改行。
    expect(parseJsonStringToken('"C:\\\\tmp\\n"')).toBe("C:\\tmp\n");
    expect(parseJsonStringToken('"\\u3042"')).toBe("あ");
    expect(parseJsonStringToken('"say \\"hi\\""')).toBe('say "hi"');
  });

  test("前後の空白 (インデントを含むトークン) は無視する", () => {
    expect(parseJsonStringToken('  "x" ')).toBe("x");
  });

  test("空文字列リテラルも対象 (コピー結果は空文字)", () => {
    expect(parseJsonStringToken('""')).toBe("");
  });

  test("クオートで囲まれていないトークンは対象外", () => {
    expect(parseJsonStringToken("123")).toBeNull();
    expect(parseJsonStringToken("true")).toBeNull();
    expect(parseJsonStringToken("{")).toBeNull();
    expect(parseJsonStringToken('"')).toBeNull(); // クオート 1 個
    expect(parseJsonStringToken('"abc')).toBeNull();
    expect(parseJsonStringToken('abc"')).toBeNull();
  });

  test("途中で切れた / 壊れたリテラルは null (= ボタンを出さない)", () => {
    // 行分割されたトークンや不正なエスケープ。黙って壊れた値をコピーさせない。
    expect(parseJsonStringToken('"unterminated \\"')).toBeNull();
    expect(parseJsonStringToken('"bad \\q escape"')).toBeNull();
  });

  test("両端がクオートでも単一リテラルでなければ null", () => {
    expect(parseJsonStringToken('"a", "b"')).toBeNull();
  });

  test("null / undefined / 空文字は null", () => {
    expect(parseJsonStringToken(null)).toBeNull();
    expect(parseJsonStringToken(undefined)).toBeNull();
    expect(parseJsonStringToken("")).toBeNull();
    expect(parseJsonStringToken("   ")).toBeNull();
  });
});
