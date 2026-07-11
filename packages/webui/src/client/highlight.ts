// Syntax highlighting via @speed-highlight/core (evaluated against prismjs /
// highlight.js: raw bundle-size deltas measured +24.5KB / +68.0KB / +107.1KB
// respectively for a comparable language set, gzip +8.8KB / +18.6KB /
// +24.6KB — see docs/decisions/DR-0008 §6 follow-up). Chosen for size and
// for exposing `tokenize()` as a callback API: tokens are rendered as JSX
// text nodes (highlight.ts -> FileViewer.tsx), never through the library's
// HTML-string / innerHTML path, so Preact's own text-node escaping is what
// protects against file content that happens to contain `<`/`&`.
import { tokenize, type ShjLanguage, type ShjToken } from "@speed-highlight/core";

// Files at or under this size get tokenized; larger ones fall back to plain
// rendering. `tokenize` walks the string performing regex matches per
// token, which is O(n) in content length but with a large constant factor
// (many candidate regexes tried per position) — above a few hundred KB this
// starts to show up as main-thread jank for a display-only feature ranked
// "任意" in the roadmap, so it stays conservative.
export const HIGHLIGHT_MAX_BYTES = 200 * 1024;

// Extension (lowercase, without the dot) -> speed-highlight language key.
// Only extensions actually expected in a typical repo tree are mapped;
// anything else (including dotfiles and extension-less files, e.g.
// `Dockerfile`) resolves to `null` and the plain viewer path is used.
const EXTENSION_LANGUAGE_MAP: Record<string, ShjLanguage> = {
  ts: "ts",
  mts: "ts",
  cts: "ts",
  tsx: "ts",
  js: "js",
  mjs: "js",
  cjs: "js",
  jsx: "js",
  json: "json",
  jsonc: "json",
  css: "css",
  html: "html",
  htm: "html",
  md: "md",
  markdown: "md",
  sh: "bash",
  bash: "bash",
  zsh: "bash",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  py: "py",
  rs: "rs",
  go: "go",
  java: "java",
  sql: "sql",
  xml: "xml",
  c: "c",
  h: "c",
};

export function detectLanguage(path: string): ShjLanguage | null {
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
  lang: ShjLanguage | null,
  content: string,
  binary: boolean,
): boolean {
  return lang !== null && !binary && content.length <= HIGHLIGHT_MAX_BYTES;
}

export interface HighlightSpan {
  text: string;
  type?: ShjToken;
}

// Re-flow speed-highlight's flat token callback stream into one span array
// per source line, so FileViewer can keep its existing per-line
// (line-number + content) row structure. Each token's text is split on
// "\n" independently of how the grammar chunked it, so line boundaries are
// always exact even when a token (e.g. a block comment) spans multiple
// lines — the concatenation of all token texts is defined by `tokenize` to
// reproduce `src` exactly.
export async function tokenizeLines(src: string, lang: ShjLanguage): Promise<HighlightSpan[][]> {
  const lines: HighlightSpan[][] = [[]];
  await tokenize(src, lang, (text, type) => {
    const parts = text.split("\n");
    for (let i = 0; i < parts.length; i++) {
      if (i > 0) lines.push([]);
      const part = parts[i];
      if (part) lines[lines.length - 1]!.push({ text: part, type });
    }
  });
  // Mirror FileViewer's plain-line splitting: a trailing "\n" produces one
  // trailing empty line that isn't a real line of content.
  if (src.endsWith("\n") && lines.length > 0 && lines[lines.length - 1]!.length === 0) {
    lines.pop();
  }
  return lines;
}
