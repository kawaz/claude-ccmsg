// raw JSONL 表示の pretty モード (kawaz r76 m91) の model 単体テスト:
// 整形結果・失敗の 2 理由 (壊れた行 / 上限超過)・永続値の解決。
import { describe, expect, test } from "bun:test";
import {
  canPrettyRawLine,
  parseRawViewPretty,
  prettyRawLine,
  serializeRawViewPretty,
  RAW_PRETTY_MAX_CHARS,
} from "../src/client/raw-view-mode.ts";

describe("prettyRawLine", () => {
  test("formats a jsonl object with 2-space indentation", () => {
    const got = prettyRawLine('{"type":"user","message":{"role":"user","content":"hi"}}');
    expect(got).toEqual({
      ok: true,
      text: [
        "{",
        '  "type": "user",',
        '  "message": {',
        '    "role": "user",',
        '    "content": "hi"',
        "  }",
        "}",
      ].join("\n"),
    });
  });

  // 整形は表示のための投影であって元データではない: パースを通した時点で
  // key 順は保たれるが空白は失われる = raw に戻せることが前提 (呼び出し側は
  // 常に row.text を保持している)。
  test("keeps key order and expands nested arrays", () => {
    const got = prettyRawLine('{"b":[1,2],"a":null}');
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.text).toBe('{\n  "b": [\n    1,\n    2\n  ],\n  "a": null\n}');
  });

  test("reports invalid-json for a truncated or non-JSON line", () => {
    expect(prettyRawLine('{"type":"user"')).toEqual({ ok: false, reason: "invalid-json" });
    expect(prettyRawLine("")).toEqual({ ok: false, reason: "invalid-json" });
    expect(prettyRawLine("not json at all")).toEqual({ ok: false, reason: "invalid-json" });
  });

  test("reports too-large above the limit without parsing", () => {
    // 上限判定は parse より先 — 巨大な base64 行で JSON.parse を走らせない
    // ことが上限の目的なので、内容が妥当な JSON でも too-large になる。
    const big = `{"a":"${"x".repeat(50)}"}`;
    expect(prettyRawLine(big, 10)).toEqual({ ok: false, reason: "too-large" });
    // 上限ちょうどは通す (境界は含む)。
    const exact = '{"a":1}';
    expect(prettyRawLine(exact, exact.length).ok).toBe(true);
  });

  test("defaults to a 200KB limit shared with the highlighter's cutoff", () => {
    expect(RAW_PRETTY_MAX_CHARS).toBe(200 * 1024);
    expect(prettyRawLine(`{"a":"${"x".repeat(RAW_PRETTY_MAX_CHARS)}"}`)).toEqual({
      ok: false,
      reason: "too-large",
    });
  });

  // JSON のスカラーも「JSON として妥当な 1 行」なので整形自体は成功する
  // (結果は raw と同じ文字列)。ここで弾くと「壊れた行だけ raw に落ちる」と
  // いう表示上の意味付けがぶれる。
  test("accepts scalar top-level JSON", () => {
    expect(prettyRawLine("123")).toEqual({ ok: true, text: "123" });
    expect(prettyRawLine('"s"')).toEqual({ ok: true, text: '"s"' });
  });
});

describe("canPrettyRawLine", () => {
  test("agrees with prettyRawLine on success and both failure modes", () => {
    expect(canPrettyRawLine('{"a":1}')).toBe(true);
    expect(canPrettyRawLine('{"a":1')).toBe(false);
    expect(canPrettyRawLine('{"a":1}', 3)).toBe(false);
  });
});

describe("raw view pretty persistence", () => {
  test('resolves to raw for anything but an explicit "1"', () => {
    expect(parseRawViewPretty(null)).toBe(false);
    expect(parseRawViewPretty("0")).toBe(false);
    expect(parseRawViewPretty("garbage")).toBe(false);
    expect(parseRawViewPretty("1")).toBe(true);
  });

  test("round-trips through serialize", () => {
    expect(parseRawViewPretty(serializeRawViewPretty(true))).toBe(true);
    expect(parseRawViewPretty(serializeRawViewPretty(false))).toBe(false);
  });
});
