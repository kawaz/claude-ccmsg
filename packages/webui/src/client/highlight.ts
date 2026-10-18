// Syntax highlighting via Shiki, driven through a hand-picked fine-grained
// bundle (@shikijs/core + @shikijs/engine-javascript, DR-0008 §6 follow-up)
// rather than the full `shiki` package or its default oniguruma/wasm engine:
// the JS regex engine avoids shipping a wasm binary, and importing only the
// language grammars this app actually needs (see EXTENSION_LANGUAGE_MAP)
// avoids paying for grammars this UI never displays.
//
// Nothing of Shiki is in the first-load bundle: the highlighter (core, regex
// engine, themes) and each language grammar are dynamic imports, which the
// serve-time build (src/index.ts) splits into their own chunks. The core is
// fetched the first time anything is highlighted, and a grammar the first
// time a block in that language is (GRAMMARS below). The grammars are the
// bulk of it (tsx alone is ~180KB raw); until they arrive the callers
// (FileViewer / CodeBlock) show the plain text, which tokenizeLines' result
// later replaces in place. The ts/js/jsx family is collapsed onto the single
// `tsx` grammar (see EXTENSION_LANGUAGE_MAP) so that one chunk serves them
// all.
//
// Tokens are rendered as JSX text nodes carrying an inline `style` string
// (highlight.ts -> FileViewer.tsx / CodeBlock.tsx), never through Shiki's
// `codeToHtml()`/innerHTML path, so Preact's own text-node escaping is what
// protects against file content that happens to contain `<`/`&`.
import type { HighlighterCore, LanguageInput } from "shiki/core";

// Shiki language ids this module can load (grammar `name`, not necessarily
// the alias used to select it -- e.g. "bash" resolves to the "shellscript"
// grammar via its built-in aliases). Kept as a union (rather than plain
// `string`) so EXTENSION_LANGUAGE_MAP and GRAMMARS can't drift from each
// other.
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
// language grammars listed in GRAMMARS (bundle-size discipline per DR-0008 §6);
// anything else (including dotfiles and extension-less files, e.g.
// `Dockerfile`) resolves to `null` and the plain viewer path is used.
const EXTENSION_LANGUAGE_MAP: Record<string, HighlightLang> = {
  // ts/js/jsx 系は全部 tsx グラマー 1 本で代表させる: typescript/javascript/
  // jsx の各グラマーはそれぞれ ~185KB raw の独立 JSON 定義でほぼ重複しており、
  // 4 本積むと chunk が +560KB raw 膨らむ。tsx は TS + JSX の上位互換文法で、
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

// One dynamic import per grammar, so each becomes its own chunk and is
// fetched only when a block in that language is first highlighted. The
// specifiers stay literal (not built from `lang`) so the bundler can see and
// split every one of them.
const GRAMMARS: Record<HighlightLang, LanguageInput> = {
  tsx: () => import("shiki/langs/tsx.mjs"),
  json: () => import("shiki/langs/json.mjs"),
  jsonc: () => import("shiki/langs/jsonc.mjs"),
  bash: () => import("shiki/langs/bash.mjs"),
  rust: () => import("shiki/langs/rust.mjs"),
  go: () => import("shiki/langs/go.mjs"),
  python: () => import("shiki/langs/python.mjs"),
  html: () => import("shiki/langs/html.mjs"),
  css: () => import("shiki/langs/css.mjs"),
  markdown: () => import("shiki/langs/markdown.mjs"),
  yaml: () => import("shiki/langs/yaml.mjs"),
  toml: () => import("shiki/langs/toml.mjs"),
  diff: () => import("shiki/langs/diff.mjs"),
};

// A failed load (a chunk that did not arrive, an initialization error) must
// not stay memoized as a rejected promise: every later call would reuse the
// rejection and highlighting would be off for good. The memo is dropped
// before re-throwing, so the next call loads again (tokenizeLines' catch
// renders the plain fallback meanwhile).
function forgetOnFailure<T>(promise: Promise<T>, forget: () => void): Promise<T> {
  return promise.catch((err: unknown) => {
    forget();
    throw err;
  });
}

// The highlighter (core + regex engine + both themes) has no per-call state,
// so it's built once per page and reused. Both themes are loaded up front so
// every call below can request the light/dark pair together (dual-theme
// tokenization, see tokenizeLines) rather than re-tokenizing per theme.
let highlighterPromise: Promise<HighlighterCore> | null = null;
function getHighlighter(): Promise<HighlighterCore> {
  highlighterPromise ??= forgetOnFailure(
    (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }, light, dark] =
        await Promise.all([
          import("shiki/core"),
          import("shiki/engine/javascript"),
          import("shiki/themes/github-light.mjs"),
          import("shiki/themes/github-dark.mjs"),
        ]);
      return createHighlighterCore({
        themes: [light, dark],
        langs: [],
        // JS-regex engine (no wasm) — see module doc comment.
        engine: createJavaScriptRegexEngine(),
      });
    })(),
    () => {
      highlighterPromise = null;
    },
  );
  return highlighterPromise;
}

// Grammar registration is per language and memoized the same way, so blocks
// in the same language that render together share one fetch and one compile.
const grammarLoads = new Map<HighlightLang, Promise<void>>();
function loadGrammar(highlighter: HighlighterCore, lang: HighlightLang): Promise<void> {
  let load = grammarLoads.get(lang);
  if (load === undefined) {
    load = forgetOnFailure(highlighter.loadLanguage(GRAMMARS[lang]), () => {
      grammarLoads.delete(lang);
    });
    grammarLoads.set(lang, load);
  }
  return load;
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
    // ハイライタ構築・文法読み込みの失敗 (chunk が届かない場合を含む) も
    // codeToTokens の失敗も、同じ「plain fallback」で扱う — どれも呼び出し側
    // (FileViewer/CodeBlock) を「loading」のまま止めない。読み込みの失敗は
    // forgetOnFailure が memo を解放するので、次回呼び出しで読み直される。
    const highlighter = await getHighlighter();
    await loadGrammar(highlighter, lang);
    const { tokens } = highlighter.codeToTokens(src, {
      lang,
      themes: { light: "github-light", dark: "github-dark" },
      defaultColor: false,
    });
    if (src.endsWith("\n") && tokens.at(-1)?.length === 0) {
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
