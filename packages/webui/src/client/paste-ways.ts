// 貼り付けのボタン (DR-0065 §8) の入れ方ごとの文字。クリップボードの文字と、
// 入れる所の前の文字 (選択があればその始まりより前) を受けて、欄に入れる文字を
// 返す純関数。欄への入れ方 (undo を保つ挿し込み) は呼び手が持つ。

/** 文字で入れる入れ方。添付 (attachment) は文字にしないのでここに無い。 */
export type PasteWay = "plain" | "markdown" | "quote" | "block";

/** `before` (入れる所より前の欄の文字) の終わりが行の途中か。欄の先頭と
 * 改行の直後は行の頭。 */
function midLine(before: string): boolean {
  return before !== "" && !before.endsWith("\n");
}

/** `text` の行。終わりの改行は行を作らない (`"a\n"` は `["a"]`)。 */
function linesOf(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.length > 1 && lines.at(-1) === "") lines.pop();
  return lines;
}

/** `way` で `text` を `before` の後ろに入れる時の文字。
 * - plain: `text` のまま
 * - markdown: `text` (markdown の文字)。行の途中なら前に改行 1 つ、後ろに常に改行 1 つ
 * - quote: 各行の頭に `> ` (空の行は `>`)。行の途中なら前に改行 2 つ、行の頭なら 1 つ。
 *   後ろに改行 2 つ
 * - block: ` ```lang ` と ` ``` ` で囲む (中の最長のバッククォートの並びより 1 つ多い数、
 *   最低 3 つ)。前後の改行は markdown と同じ */
export function pastedText(way: PasteWay, text: string, before: string): string {
  switch (way) {
    case "plain":
      return text;
    case "markdown":
      return `${midLine(before) ? "\n" : ""}${text}\n`;
    case "quote": {
      const quoted = linesOf(text)
        .map((line) => (line === "" ? ">" : `> ${line}`))
        .join("\n");
      return `${midLine(before) ? "\n\n" : "\n"}${quoted}\n\n`;
    }
    case "block": {
      const fence = "`".repeat(Math.max(3, longestBacktickRun(text) + 1));
      const body = linesOf(text).join("\n");
      return `${midLine(before) ? "\n" : ""}${fence}${codeLanguageOf(text) ?? ""}\n${body}\n${fence}\n`;
    }
  }
}

function longestBacktickRun(text: string): number {
  let longest = 0;
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length);
  return longest;
}

/** shebang の interpreter → 言語。 */
const SHEBANG_LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/\b(?:ba|z|da|k)?sh\b/, "sh"],
  [/\bpython\d*(?:\.\d+)?\b/, "python"],
  [/\b(?:bun|deno)\b/, "ts"],
  [/\bnode\b/, "js"],
  [/\bruby\b/, "ruby"],
  [/\bperl\b/, "perl"],
];

/** 典型の行の頭 → 言語。上から見て最初に当たったもの。 */
const LINE_LANGUAGES: ReadonlyArray<readonly [RegExp, string]> = [
  [/^(?:diff --git |@@ -\d)/m, "diff"],
  [/^\s*(?:pub )?fn \w|^\s*let mut |^use (?:std|crate)::/m, "rust"],
  [/^package \w+\s*$|^func /m, "go"],
  [
    /^\s*def \w+\(.*\)\s*(?:->.*)?:\s*$|^from [\w.]+ import |^import [\w.]+(?: as \w+)?\s*$/m,
    "python",
  ],
  [
    /^\s*(?:import [\w{*]|import ["']|export (?:const|let|function|default|type|interface|class|async|\{|\*)|(?:const|let) \w+\s*[:=]|interface \w+|type \w+\s*=)/m,
    "ts",
  ],
  [
    /^(?:\$ |(?:git|jj|bun|bunx|npm|npx|pnpm|yarn|brew|cd|ls|cat|echo|export|curl|mkdir|rm|cp|mv|sudo|just|cargo|go|make|docker|ssh|chmod|grep|sed|awk) )/,
    "sh",
  ],
];

/** `text` のコードの言語の見当 (雑な判定)。当たらなければ null。 */
export function codeLanguageOf(text: string): string | null {
  const head = text.trimStart();
  const shebang = /^#!(.*)/.exec(head)?.[1];
  if (shebang !== undefined) {
    return SHEBANG_LANGUAGES.find(([pattern]) => pattern.test(shebang))?.[1] ?? null;
  }
  if (/^[[{]/.test(head) && isJson(head)) return "json";
  if (head.startsWith("<")) return /^<\?xml\b/i.test(head) ? "xml" : "html";
  return LINE_LANGUAGES.find(([pattern]) => pattern.test(head))?.[1] ?? null;
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** 添付のボタンの文言の大きさ: `text` の UTF-8 のバイト数。1,000 未満は数字だけ
 * (`512`)、1,000 以上は 1,000 で割って切り上げた `#,###k` (`2k`、`1,234k`)。 */
export function attachmentSizeLabel(text: string): string {
  const bytes = new TextEncoder().encode(text).length;
  if (bytes < 1000) return String(bytes);
  return `${Math.ceil(bytes / 1000).toLocaleString("en-US")}k`;
}
