// Syntax highlighting via Shiki, driven through a hand-picked fine-grained
// bundle (@shikijs/core + @shikijs/engine-javascript, DR-0008 §6 follow-up)
// rather than the full `shiki` package or its default oniguruma/wasm engine:
// the JS regex engine avoids shipping a wasm binary, and importing only the
// language grammars this app actually needs (see EXTENSION_LANGUAGE_MAP)
// avoids paying for grammars this UI never displays.
//
// This is NOT a small addition even after trimming: the ts/js/jsx family is
// collapsed onto the single `tsx` grammar (see EXTENSION_LANGUAGE_MAP) because
// the four grammars are ~185KB raw each of near-duplicate JSON, but the
// remaining grammar set + the oniguruma-to-es regex engine still dominate the
// serve-time single-file bundle (no code-splitting). Measure with `bun build
// --minify` when touching this list; splitting highlighting into a
// lazily-loaded chunk stays an open option (DR-0008 §6 follow-up).
//
// Tokens are rendered as JSX text nodes carrying an inline `style` string
// (highlight.ts -> FileViewer.tsx / CodeBlock.tsx), never through Shiki's
// `codeToHtml()`/innerHTML path, so Preact's own text-node escaping is what
// protects against file content that happens to contain `<`/`&`.
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import themeGithubLight from "shiki/themes/github-light.mjs";
import themeGithubDark from "shiki/themes/github-dark.mjs";
import langTsx from "shiki/langs/tsx.mjs";
import langJson from "shiki/langs/json.mjs";
import langJsonc from "shiki/langs/jsonc.mjs";
import langBash from "shiki/langs/bash.mjs";
import langRust from "shiki/langs/rust.mjs";
import langGo from "shiki/langs/go.mjs";
import langPython from "shiki/langs/python.mjs";
import langHtml from "shiki/langs/html.mjs";
import langCss from "shiki/langs/css.mjs";
import langMarkdown from "shiki/langs/markdown.mjs";
import langYaml from "shiki/langs/yaml.mjs";
import langToml from "shiki/langs/toml.mjs";
import langDiff from "shiki/langs/diff.mjs";

// Shiki language ids this bundle actually loads (grammar `name`, not
// necessarily the alias used to select it -- e.g. "bash" resolves to the
// "shellscript" grammar via its built-in aliases). Kept as a union (rather
// than plain `string`) so EXTENSION_LANGUAGE_MAP can't drift from the set of
// grammars actually bundled below.
export type HighlightLang =
  | "tsx"
  | "json"
  | "jsonc"
  | "bash"
  | "rust"
  | "go"
  | "python"
  | "html"
  | "css"
  | "markdown"
  | "yaml"
  | "toml"
  | "diff";

// Files at or under this size get tokenized; larger ones fall back to plain
// rendering. Shiki's textmate tokenizer is O(n) in content length but with a
// large constant factor (many candidate regexes tried per position) — above
// a few hundred KB this starts to show up as main-thread jank for a
// display-only feature ranked "任意" in the roadmap, so it stays conservative.
export const HIGHLIGHT_MAX_BYTES = 200 * 1024;

// Extension (lowercase, without the dot) -> Shiki language id. Only
// extensions actually expected in a typical repo tree, restricted to the
// language grammars bundled above (bundle-size discipline per DR-0008 §6);
// anything else (including dotfiles and extension-less files, e.g.
// `Dockerfile`) resolves to `null` and the plain viewer path is used.
const EXTENSION_LANGUAGE_MAP: Record<string, HighlightLang> = {
  // ts/js/jsx 系は全部 tsx グラマー 1 本で代表させる: typescript/javascript/
  // jsx の各グラマーはそれぞれ ~185KB raw の独立 JSON 定義でほぼ重複しており、
  // 4 本積むと bundle が +560KB raw 膨らむ。tsx は TS + JSX の上位互換文法で、
  // 差異は極端なエッジケース (TS の `<T>x` 山括弧キャスト等) の誤ハイライトのみ。
  ts: "tsx",
  mts: "tsx",
  cts: "tsx",
  tsx: "tsx",
  js: "tsx",
  mjs: "tsx",
  cjs: "tsx",
  jsx: "tsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  py: "python",
  rs: "rust",
  go: "go",
  diff: "diff",
  patch: "diff",
};

export function detectLanguage(path: string): HighlightLang | null {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null; // no extension, or a dotfile like ".gitignore"
  const ext = base.slice(dot + 1).toLowerCase();
  return EXTENSION_LANGUAGE_MAP[ext] ?? null;
}

// Gate for whether FileViewer should attempt tokenization at all: a
// recognized language and a size within HIGHLIGHT_MAX_BYTES. Binary files
// never reach this (FileViewer branches on `res.binary` first) but the
// check is included here too so the predicate is correct standalone.
export function isHighlightEligible(
  lang: HighlightLang | null,
  content: string,
  binary: boolean,
): boolean {
  return lang !== null && !binary && content.length <= HIGHLIGHT_MAX_BYTES;
}

export interface HighlightSpan {
  text: string;
  // Inline `--shiki-light`/`--shiki-dark` (+ optional `-font-style`/
  // `-font-weight`) custom-property declarations for this token, already
  // theme-paired by Shiki's dual-theme tokenization (see getHighlighter
  // below). `undefined` for whitespace/plain runs with no styling.
  style?: string;
}

// Highlighter instance is expensive to construct (compiles every bundled
// grammar's textmate patterns) and has no per-call state, so it's built once
// per process and reused — same module-level-memo shape as
// src/index.ts's bundleClient(). Both themes are loaded up front so every
// call below can request the light/dark pair together (dual-theme
// tokenization, see tokenizeLines) rather than re-tokenizing per theme.
let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= createHighlighterCore({
    themes: [themeGithubLight, themeGithubDark],
    langs: [
      langTsx,
      langJson,
      langJsonc,
      langBash,
      langRust,
      langGo,
      langPython,
      langHtml,
      langCss,
      langMarkdown,
      langYaml,
      langToml,
      langDiff,
    ],
    // JS-regex engine (no wasm) — see module doc comment.
    engine: createJavaScriptRegexEngine(),
  }).catch((err: unknown) => {
    // 構築失敗 (grammar/engine の初期化エラー等) を rejected promise のまま
    // memo すると、以降の全呼び出しが同じ rejection を再利用して恒久的に
    // ハイライトが無効化される。次回呼び出しで再構築を試みられるよう memo を
    // 解放してから re-throw する (tokenizeLines 側の catch で plain fallback)。
    highlighterPromise = null;
    throw err;
  });
  return highlighterPromise;
}

function styleString(htmlStyle: Record<string, string>): string {
  return Object.entries(htmlStyle)
    .map(([prop, value]) => `${prop}:${value}`)
    .join(";");
}

// Plain-line split used only as the tokenization-failure fallback below;
// mirrors FileViewer's own splitLines (a trailing "\n" doesn't produce an
// extra trailing empty line).
function splitContentLines(src: string): string[] {
  const lines = src.split("\n");
  if (src.endsWith("\n")) lines.pop();
  return lines;
}

// Re-flow Shiki's per-line token arrays into HighlightSpan[][], so
// FileViewer can keep its existing per-line (line-number + content) row
// structure. `codeToTokens` already segments by "\n" (including a trailing
// empty line when `src` ends with "\n", popped below to match
// FileViewer/CodeBlock's plain-line splitting) and keeps multi-line tokens
// (e.g. a block comment) correctly attributed to each line they span.
export async function tokenizeLines(src: string, lang: HighlightLang): Promise<HighlightSpan[][]> {
  try {
    // ハイライタ構築の失敗 (getHighlighter) も codeToTokens の失敗も、
    // 同じ「plain fallback」で扱う — どちらも呼び出し側 (FileViewer/
    // CodeBlock) を「loading」のまま止めない。construction 失敗は
    // getHighlighter 側で memo を解放するので、次回呼び出しで再構築される。
    const highlighter = await getHighlighter();
    const { tokens } = highlighter.codeToTokens(src, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    if (src.endsWith("\n") && tokens.length > 0 && tokens[tokens.length - 1]!.length === 0) {
      tokens.pop();
    }
    return tokens.map((line) =>
      line.map((tok) => ({
        text: tok.content,
        style:
          tok.htmlStyle && Object.keys(tok.htmlStyle).length > 0
            ? styleString(tok.htmlStyle)
            : undefined,
      })),
    );
  } catch {
    // Pathological input the grammar can't tokenize (regex-engine guard
    // trip, malformed embedded-language fence, etc.) — degrade to plain,
    // unstyled lines rather than reject and leave the caller stuck on its
    // "loading" state forever.
    return splitContentLines(src).map((line) => (line === "" ? [] : [{ text: line }]));
  }
}
