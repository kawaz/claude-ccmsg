// Lean 4 の色付け: shiki に同梱の Lean の文法を、属性の 2 つの規則と行コメントの
// 規則だけ差し替えて使う (src/client/lean-grammar.ts)。属性と行コメントの場合は、
// 差し替えが効いていないと (shiki の版が上がって置き換える先の規則が見つからない
// 時も) 落ちる。
import { describe, expect, test } from "bun:test";
import { createHighlighterCore, type LanguageRegistration } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import upstreamLean from "shiki/langs/lean.mjs";
import githubLight from "shiki/themes/github-light.mjs";
import { tokenizeLines, type HighlightSpan } from "../src/client/highlight.ts";
import { withLeanFixes } from "../src/client/lean-grammar.ts";
import { defined } from "./helpers.ts";

/** 1 文字ごとの着色 (明るい配色と暗い配色の組)。色の無い文字は空文字。 */
function charColors(spans: HighlightSpan[]): string[] {
  const out: string[] = [];
  for (const span of spans) {
    const light = /--shiki-light:([^;]+)/.exec(span.style ?? "")?.[1] ?? "";
    const dark = /--shiki-dark:([^;]+)/.exec(span.style ?? "")?.[1] ?? "";
    for (let i = 0; i < span.text.length; i++) out.push(light || dark ? `${light}/${dark}` : "");
  }
  return out;
}

async function colorsOf(src: string): Promise<string[][]> {
  return (await tokenizeLines(src, "lean")).map(charColors);
}

/** `line` の `part` (最初に現れる所) の文字の色。 */
function colorsAt(line: string, colors: string[], part: string, from = 0): string[] {
  const start = line.indexOf(part, from);
  if (start < 0) throw new Error(`expected ${JSON.stringify(part)} in ${JSON.stringify(line)}`);
  return colors.slice(start, start + part.length);
}

/** 属性の色 (`storage.modifier.lean4`)。差し替えていない規則 (`private` 等の
 * 修飾子) で取る。 */
async function modifierColor(): Promise<string> {
  const line = defined((await colorsOf("private def x := 1"))[0], "the only line");
  return defined(line[0], "the color of `private`");
}

/** 宣言の名前の色 (`entity.name.function.lean4`)。 */
async function declNameColor(): Promise<string> {
  const line = defined((await colorsOf("def g := 1"))[0], "the only line");
  return defined(line[4], "the color of `g`");
}

describe("属性は閉じ括弧までが 1 つの属性 (上流の規則は最初の空白で切れる)", () => {
  const cases: [string, string][] = [
    ["@[simp] def g := 1", "@[simp]"],
    ["@[simp, inline] def f := 1", "@[simp, inline]"],
    ["attribute [local simp] Nat.add_comm", "attribute [local simp]"],
  ];
  for (const [src, attr] of cases) {
    test(src, async () => {
      const modifier = await modifierColor();
      const line = defined((await colorsOf(src))[0], "the only line");
      expect(colorsAt(src, line, attr)).toEqual(Array<string>(attr.length).fill(modifier));
      // 閉じ括弧の後ろは属性の色ではない
      expect(line[attr.length]).not.toBe(modifier);
    });
  }

  test("行をまたぐ属性", async () => {
    const modifier = await modifierColor();
    const [first, second] = await colorsOf("@[reducible,\n  simp] def h := 2");
    const line0 = defined(first, "the first line");
    const line1 = defined(second, "the second line");
    expect(line0).toEqual(Array<string>("@[reducible,".length).fill(modifier));
    expect(colorsAt("  simp] def h := 2", line1, "simp]")).toEqual(Array<string>(5).fill(modifier));
    // 閉じ括弧の後ろは属性の色ではなく、宣言は属性が無い時と同じ色
    expect(line1["  simp]".length]).not.toBe(modifier);
    const plain = defined((await colorsOf("def h := 2"))[0], "the plain line");
    expect(line1.slice("  simp] ".length)).toEqual(plain);
  });

  test("属性の後ろの宣言の色は、属性が無い時と同じ", async () => {
    const after = "def f := 1";
    const plain = defined((await colorsOf(after))[0], "the plain line");
    for (const src of ["@[simp, inline] def f := 1", "@[simp] def f := 1"]) {
      const line = defined((await colorsOf(src))[0], "the attributed line");
      expect(line.slice(src.length - after.length)).toEqual(plain);
    }
  });

  test("上流の規則のままだと @[simp, inline] は 1 つの属性にならない (直ったら差し替えを外す)", async () => {
    const highlighter = await createHighlighterCore({
      themes: [githubLight],
      langs: [upstreamLean],
      engine: createJavaScriptRegexEngine(),
    });
    const src = "@[simp, inline] def f := 1";
    const tokens = defined(
      highlighter.codeToTokens(src, { lang: "lean", theme: "github-light" }).tokens[0],
      "the only line",
    );
    const colors = tokens.flatMap((t) => Array<string>(t.content.length).fill(t.color ?? ""));
    const modifier = defined(colors[0], "the color of `@`");
    expect(colorsAt(src, colors, "@[simp, inline]").every((c) => c === modifier)).toBe(false);
  });
});

describe("行コメント -- は行末までがコメント", () => {
  /** コメントの色。差し替えていない規則 (ブロックコメント) で取る。 */
  async function commentColor(): Promise<string> {
    const line = defined((await colorsOf("/- c -/"))[0], "the only line");
    return defined(line[0], "the color of `/-`");
  }

  const cases: [string, string][] = [
    ["-- x", "-- x"],
    ["x -- end", "-- end"],
    ["#eval add 1 2 -- 3", "-- 3"],
    // Lean では `--` はどこでも行コメントを始める (演算子の一部にならない)
    ["a --b", "--b"],
    ["def f := 1 -- c", "-- c"],
  ];
  for (const [src, comment] of cases) {
    test(src, async () => {
      const color = await commentColor();
      const line = defined((await colorsOf(src))[0], "the only line");
      expect(colorsAt(src, line, comment)).toEqual(Array<string>(comment.length).fill(color));
      // コメントの前はコメントの色ではない
      expect(line.slice(0, src.indexOf(comment))).not.toContain(color);
    });
  }

  test("行コメントは次の行に続かない", async () => {
    const color = await commentColor();
    const [, second] = await colorsOf("-- x\ndef f := 1");
    const plain = defined((await colorsOf("def f := 1"))[0], "the plain line");
    expect(defined(second, "the second line")).toEqual(plain);
    expect(plain).not.toContain(color);
  });

  test("文字列の中の -- はコメントにならない", async () => {
    const color = await commentColor();
    const src = 'def s := "a -- b"';
    const line = defined((await colorsOf(src))[0], "the only line");
    expect(colorsAt(src, line, '"a -- b"')).not.toContain(color);
  });

  test("/-- doc -/ と /- block -/ は今までどおり", async () => {
    const color = await commentColor();
    const blocks: [string, string][] = [
      ["/-- doc -/ def x := 1", "/-- doc -/"],
      ["/- block -/ def x := 1", "/- block -/"],
      ["/-! mod -/", "/-! mod -/"],
      ["/- a /- b -/ c -/ def x := 1", "/- a /- b -/ c -/"],
    ];
    for (const [src, comment] of blocks) {
      const line = defined((await colorsOf(src))[0], "the only line");
      expect(colorsAt(src, line, comment)).toEqual(Array<string>(comment.length).fill(color));
      expect(line.slice(comment.length)).not.toContain(color);
    }
  });

  test("上流の規則のままだと -- x はコメントにならない (直ったら差し替えを外す)", async () => {
    const highlighter = await createHighlighterCore({
      themes: [githubLight],
      langs: [upstreamLean],
      engine: createJavaScriptRegexEngine(),
    });
    const line = (src: string) =>
      defined(
        highlighter.codeToTokens(src, { lang: "lean", theme: "github-light" }).tokens[0],
        "the only line",
      );
    const comment = defined(line("/- c -/")[0], "the block comment").color;
    expect(line("-- x").map((t) => t.color)).not.toContain(comment);
  });
});

describe("withLeanFixes", () => {
  test("属性の 2 つの規則と行コメントの規則だけを置き換え、他の規則は同じものを使う", () => {
    const upstream = defined(upstreamLean[0], "the upstream grammar");
    const wrapped = defined(withLeanFixes(upstreamLean)[0], "the wrapped grammar");
    expect(wrapped.patterns.length).toBe(upstream.patterns.length);
    const changed = wrapped.patterns.filter((rule, i) => rule !== upstream.patterns[i]);
    expect(changed.map((rule) => rule.name)).toEqual([
      "storage.modifier.lean4",
      "storage.modifier.lean4",
    ]);
    const upstreamRepo = defined(upstream.repository, "the upstream repository");
    const wrappedRepo = defined(wrapped.repository, "the wrapped repository");
    expect(Object.keys(wrappedRepo)).toEqual(Object.keys(upstreamRepo));
    const changedRepo = Object.keys(upstreamRepo).filter(
      (key) => wrappedRepo[key] !== upstreamRepo[key],
    );
    expect(changedRepo).toEqual(["dashComment"]);
  });

  test("置き換える先の規則が無い文法はそのまま返す (属性と行コメントのテストが落ちて気づく)", () => {
    const grammar: LanguageRegistration = {
      name: "lean",
      scopeName: "source.lean4",
      patterns: [{ match: "\\bdef\\b", name: "keyword" }],
      repository: {},
    };
    expect(withLeanFixes([grammar])).toEqual([grammar]);
  });
});

describe("宣言の名前の色は、名前の 1 語だけ (structure X where の後を巻き込まない)", () => {
  test("structure / inductive / def", async () => {
    const src =
      "structure P where\n  x : Nat\nderiving Repr\n\ninductive C where\n  | red\n\ndef f (n : Nat) : Nat := n";
    const name = await declNameColor();
    const lines = src.split("\n");
    const colors = await colorsOf(src);
    const at = (i: number, part: string, from = 0): string[] =>
      colorsAt(defined(lines[i], "a line"), defined(colors[i], "a line's colors"), part, from);
    expect(at(0, "P")).toEqual([name]);
    expect(at(0, "where")).not.toContain(name);
    expect(at(1, "x : Nat")).not.toContain(name);
    expect(at(2, "deriving Repr")).not.toContain(name);
    expect(at(4, "C")).toEqual([name]);
    expect(at(4, "where")).not.toContain(name);
    expect(at(5, "| red")).not.toContain(name);
    expect(at(7, "f", "def ".length)).toEqual([name]);
    expect(at(7, "(n : Nat) : Nat := n")).not.toContain(name);
  });
});
