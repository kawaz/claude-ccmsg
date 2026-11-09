// highlight.ts unit tests: extension -> language detection, the
// highlight-eligibility gate (size threshold + binary/no-lang fallback), and
// tokenizeLines' Shiki-token -> per-line span reflow (FileViewer.tsx renders
// these spans directly as JSX text nodes, never through an innerHTML path —
// see highlight.ts for why).
import { describe, expect, test } from "bun:test";
import type { GrammarState } from "shiki/core";
import {
  detectLanguage,
  grammarStatesEqual,
  HIGHLIGHT_MAX_BYTES,
  isHighlightEligible,
  loadBlockTokenizer,
  tokenizeLines,
  type HighlightLang,
} from "../src/client/highlight.ts";
import { defined } from "./helpers.ts";

describe("detectLanguage", () => {
  // Same-value axis: extensions that should resolve to their language.
  test("recognized extensions map to their Shiki language id", () => {
    expect(detectLanguage("src/foo.ts")).toBe("tsx");
    expect(detectLanguage("src/foo.tsx")).toBe("tsx");
    expect(detectLanguage("src/foo.js")).toBe("tsx");
    expect(detectLanguage("src/foo.jsx")).toBe("tsx");
    expect(detectLanguage("data.json")).toBe("json");
    expect(detectLanguage("style.css")).toBe("css");
    expect(detectLanguage("index.html")).toBe("html");
    expect(detectLanguage("README.md")).toBe("markdown");
    expect(detectLanguage("deploy.sh")).toBe("bash");
    expect(detectLanguage("config.yml")).toBe("yaml");
    expect(detectLanguage("config.yaml")).toBe("yaml");
    expect(detectLanguage("main.rs")).toBe("rust");
    expect(detectLanguage("main.go")).toBe("go");
    expect(detectLanguage("script.py")).toBe("python");
    expect(detectLanguage("Cargo.toml")).toBe("toml");
    expect(detectLanguage("change.diff")).toBe("diff");
  });

  test("extension matching is case-insensitive", () => {
    expect(detectLanguage("src/Foo.TS")).toBe("tsx");
    expect(detectLanguage("README.MD")).toBe("markdown");
  });

  test("unrecognized extension -> null (plain-viewer fallback)", () => {
    expect(detectLanguage("data.bin")).toBeNull();
    expect(detectLanguage("archive.tar.gz")).toBeNull(); // last segment ".gz" is unmapped
  });

  // Dotfiles: the leading dot is the filename, not an extension separator.
  test("dotfile with no further extension -> null", () => {
    expect(detectLanguage(".gitignore")).toBeNull();
    expect(detectLanguage(".env")).toBeNull();
  });

  test("dotfile with a recognized extension after the leading dot -> detected", () => {
    expect(detectLanguage(".prettierrc.json")).toBe("json");
  });

  test("extension-less filename -> null", () => {
    expect(detectLanguage("Dockerfile")).toBeNull();
    expect(detectLanguage("Makefile")).toBeNull();
  });

  test("nested path uses only the final path segment's extension", () => {
    expect(detectLanguage("packages/webui/src/client/highlight.ts")).toBe("tsx");
    // A dot in a directory segment must not leak into detection.
    expect(detectLanguage("v1.2/notes")).toBeNull();
  });
});

describe("isHighlightEligible", () => {
  // Decision table: {lang, binary, size vs threshold} -> eligible?
  test("recognized language, text, within threshold -> eligible", () => {
    expect(isHighlightEligible("tsx", "const x = 1;", false)).toBe(true);
  });

  test("no recognized language -> not eligible regardless of size", () => {
    expect(isHighlightEligible(null, "hello", false)).toBe(false);
  });

  test("binary file -> not eligible even with a recognized language", () => {
    expect(isHighlightEligible("json", "\x00\x01", true)).toBe(false);
  });

  // Boundary: exactly at HIGHLIGHT_MAX_BYTES is still eligible ("<=", not "<").
  test("content length exactly at HIGHLIGHT_MAX_BYTES -> eligible", () => {
    const content = "x".repeat(HIGHLIGHT_MAX_BYTES);
    expect(isHighlightEligible("tsx", content, false)).toBe(true);
  });

  test("content length one byte over HIGHLIGHT_MAX_BYTES -> not eligible (plain fallback)", () => {
    const content = "x".repeat(HIGHLIGHT_MAX_BYTES + 1);
    expect(isHighlightEligible("tsx", content, false)).toBe(false);
  });
});

describe("tokenizeLines", () => {
  test("single-line source with keyword and string tokens", async () => {
    const lines = await tokenizeLines('const x = "hi";', "tsx");
    expect(lines.length).toBe(1);
    // The exact token split is Shiki's grammar (implementation detail);
    // what matters is that the concatenation reproduces the source and at
    // least one token carries a style (i.e. isn't left unstyled).
    const line = defined(lines[0], "the only line");
    expect(line.map((s) => s.text).join("")).toBe('const x = "hi";');
    expect(line.some((s) => s.style !== undefined)).toBe(true);
  });

  // Dual-theme tokenization (getHighlighter in highlight.ts) means every
  // styled span carries both a light and a dark color in one inline style
  // string — a single call, no separate light/dark re-tokenization.
  test("styled span's inline style carries both light and dark theme colors", async () => {
    const lines = await tokenizeLines("const x = 1;", "tsx");
    const styled = defined(lines[0], "the only line").find((s) => s.style !== undefined);
    expect(styled).toBeDefined();
    expect(defined(styled, "a styled span").style).toContain("--shiki-light:");
    expect(defined(styled, "a styled span").style).toContain("--shiki-dark:");
  });

  test("multi-line source splits into one span-array per line", async () => {
    const src = "const a = 1;\nconst b = 2;\n";
    const lines = await tokenizeLines(src, "tsx");
    // Trailing "\n" does not produce an extra trailing empty line, mirroring
    // FileViewer's plain-line splitting (splitLines in FileViewer.tsx).
    expect(lines.length).toBe(2);
    expect(
      defined(lines[0], "the first line")
        .map((s) => s.text)
        .join(""),
    ).toBe("const a = 1;");
    expect(
      defined(lines[1], "the second line")
        .map((s) => s.text)
        .join(""),
    ).toBe("const b = 2;");
  });

  test("source without a trailing newline keeps the last line", async () => {
    const lines = await tokenizeLines("const a = 1;", "tsx");
    expect(lines.length).toBe(1);
  });

  test("a token spanning multiple lines (block comment) still lands on the correct lines", async () => {
    const src = "/* a\nb */\nconst c = 1;";
    const lines = await tokenizeLines(src, "tsx");
    expect(lines.length).toBe(3);
    expect(
      defined(lines[0], "the first line")
        .map((s) => s.text)
        .join(""),
    ).toBe("/* a");
    expect(
      defined(lines[1], "the second line")
        .map((s) => s.text)
        .join(""),
    ).toBe("b */");
    expect(
      defined(lines[2], "the third line")
        .map((s) => s.text)
        .join(""),
    ).toBe("const c = 1;");
  });

  // Each grammar is loaded the first time its language is asked for
  // (highlight.ts GRAMMARS), so a file in every language detectLanguage can
  // return must come out styled, including languages asked for together.
  test("every detectable language is highlighted once its grammar loads on demand", async () => {
    const samples: Record<string, string> = {
      "a.tsx": "const a = <b>{1}</b>;",
      "a.json": '{"a": 1}',
      "a.jsonc": '{"a": 1 // c\n}',
      "a.sh": 'echo "$HOME"',
      "a.rs": "fn main() {}",
      "a.go": "func main() {}",
      "a.py": "def f(): pass",
      "a.html": '<p class="a">x</p>',
      "a.css": "a { color: red; }",
      "a.md": "# title",
      "a.yaml": "a: 1",
      "a.toml": 'a = "b"',
      "a.diff": "+added",
    };
    const styled = await Promise.all(
      Object.entries(samples).map(async ([path, src]) => {
        const lang = detectLanguage(path);
        const lines = lang === null ? [] : await tokenizeLines(src, lang);
        return [lang, lines.flat().some((span) => span.style !== undefined)] as const;
      }),
    );
    expect(new Set(styled.map(([lang]) => lang))).toEqual(
      new Set<HighlightLang | null>([
        "tsx",
        "json",
        "jsonc",
        "bash",
        "rust",
        "go",
        "python",
        "html",
        "css",
        "markdown",
        "yaml",
        "toml",
        "diff",
      ]),
    );
    expect(styled.filter(([, isStyled]) => !isStyled)).toEqual([]);
  });

  test("empty source -> a single empty line (caller special-cases '' before calling this)", async () => {
    const lines = await tokenizeLines("", "tsx");
    expect(lines).toEqual([[]]);
  });

  test("source that is only a newline -> a single empty line, not two", async () => {
    const lines = await tokenizeLines("\n", "tsx");
    expect(lines).toEqual([[]]);
  });
});

// 編集領域の着色 (DR-0051): 片ごとのトークン化と、増分トークン化の打ち切り条件。
describe("loadBlockTokenizer", () => {
  test("トークンの位置は渡したコード片の中の位置で、閲覧側と同じ 2 テーマの色を持つ", async () => {
    const tokenize = defined(await loadBlockTokenizer("tsx"), "the tsx tokenizer");
    const code = "const a = 1;\nlet b = 'x';";
    const { tokens } = tokenize(code, undefined);
    const keyword = defined(
      tokens.find((t) => code.slice(t.start, t.end) === "let"),
      "the let token",
    );
    expect(keyword.paint.light).toMatch(/^#/);
    expect(keyword.paint.dark).toMatch(/^#/);
    // 2 行目のトークンも本文の先頭からではなく片の先頭からの位置
    expect(keyword.start).toBe(code.indexOf("let"));
  });

  test("前の片の終わりの状態を渡すと続きとしてトークン化する (コメントの中)", async () => {
    const tokenize = defined(await loadBlockTokenizer("tsx"), "the tsx tokenizer");
    const opened = tokenize("/* open", undefined);
    const inside = tokenize("const x = 1;", opened.endState);
    const fresh = tokenize("const x = 1;", undefined);
    // コメントの中なら 1 行まるごと 1 つの色、続きでなければ const が別の色
    expect(new Set(inside.tokens.map((t) => t.paint.light)).size).toBe(1);
    expect(new Set(fresh.tokens.map((t) => t.paint.light)).size).toBeGreaterThan(1);
  });
});

describe("grammarStatesEqual (shiki の内部 API への依存をここで固定する)", () => {
  // この describe が落ちたら shiki の内部 (GrammarState.getInternalStack /
  // StateStack.equals) が変わった。その間も grammarStatesEqual は false を返して
  // 全体の再トークン化に退避するので色は正しいが、編集が重くなる。
  test("別々にトークン化しても同じ文脈で終わった状態は等しい", async () => {
    const tokenize = defined(await loadBlockTokenizer("tsx"), "the tsx tokenizer");
    const a = tokenize("const a = 1;", undefined).endState;
    const b = tokenize("let b = 2;", undefined).endState;
    expect(a).not.toBe(b);
    expect(grammarStatesEqual(a, b)).toBe(true);
  });

  test("コメントの中で終わった状態とコードで終わった状態は等しくない", async () => {
    const tokenize = defined(await loadBlockTokenizer("tsx"), "the tsx tokenizer");
    const code = tokenize("const a = 1;", undefined).endState;
    const comment = tokenize("/* open", undefined).endState;
    expect(grammarStatesEqual(code, comment)).toBe(false);
  });

  test("状態が無い (先頭・トークン化に失敗した片) なら等しくない", async () => {
    const tokenize = defined(await loadBlockTokenizer("tsx"), "the tsx tokenizer");
    const state = tokenize("const a = 1;", undefined).endState;
    expect(grammarStatesEqual(undefined, state)).toBe(false);
    expect(grammarStatesEqual(state, undefined)).toBe(false);
    expect(grammarStatesEqual(undefined, undefined)).toBe(false);
  });

  test("内部の状態が取れない・例外を投げる時は等しくない (全体の再トークン化へ退避)", async () => {
    const tokenize = defined(await loadBlockTokenizer("tsx"), "the tsx tokenizer");
    const real = defined(tokenize("const a = 1;", undefined).endState, "a grammar state");
    const base = {
      lang: "tsx",
      theme: "github-light",
      themes: ["github-light", "github-dark"],
      getScopes: () => [],
    };
    const missing: GrammarState = { ...base, getInternalStack: () => undefined };
    const throwing: GrammarState = {
      ...base,
      getInternalStack: () => {
        throw new Error("internal API changed");
      },
    };
    expect(grammarStatesEqual(real, missing)).toBe(false);
    expect(grammarStatesEqual(throwing, real)).toBe(false);
  });
});
