// 編集領域 (CodeEditor) とファイルの本文の間の変換 (DR-0051 §4)。
//
// - 改行コード: 編集は LF で行い、保存の時にファイルの改行コードへ戻す。
//   ファイルの改行コードを編集で勝手に変えない
// - 末尾の番兵: contenteditable は末尾の改行の後ろにキャレットを置ける行を
//   作らない。textarea と同じ「末尾改行の後ろの空行」を出すため、DOM には
//   本文の後ろに改行を 1 つ足して置き、取り出す時に 1 つ落とす

export type LineEnding = "\n" | "\r\n";

/** 本文の改行コード。改行が全部 CRLF の時だけ CRLF。LF と CRLF が混ざって
 * いる・改行が無い時は LF (混在は LF に揃えて保存する、DR-0051 §4)。 */
export function detectLineEnding(fileText: string): LineEnding {
  let sawNewline = false;
  for (let i = fileText.indexOf("\n"); i !== -1; i = fileText.indexOf("\n", i + 1)) {
    if (i === 0 || fileText[i - 1] !== "\r") return "\n";
    sawNewline = true;
  }
  return sawNewline ? "\r\n" : "\n";
}

/** ファイルの本文 → 編集する本文 (改行は全部 LF) と、保存の時に戻す改行
 * コード。混在するファイルの CRLF も LF にするので、保存すると LF に揃う。 */
export function toEditorText(fileText: string): { text: string; lineEnding: LineEnding } {
  return { text: fileText.replaceAll("\r\n", "\n"), lineEnding: detectLineEnding(fileText) };
}

/** 編集した本文 → 保存する本文。 */
export function toFileText(editorText: string, lineEnding: LineEnding): string {
  return lineEnding === "\r\n" ? editorText.replaceAll("\n", "\r\n") : editorText;
}

/** 編集する本文 → 編集領域の DOM に置く文字列 (末尾に番兵の改行)。 */
export function toEditorDom(editorText: string): string {
  return `${editorText}\n`;
}

/** 編集領域の DOM の文字列 → 編集した本文。番兵の改行を 1 つ落とす。打鍵で
 * 番兵が消えていることがある (最終行に文字を打つとブラウザが末尾の改行を
 * 置き換える) ので、末尾が改行の時だけ落とす。 */
export function fromEditorDom(domText: string): string {
  return domText.endsWith("\n") ? domText.slice(0, -1) : domText;
}

/** 編集領域の DOM に置く 1 つのテキストノードの行数。
 *
 * Design rationale: 本文を 1 つのテキストノードに入れると、1 打鍵ごとの
 * ブラウザの編集処理 (beforeinput → input) がキャレットのあるノードの大きさに
 * 比例して重くなる (4800 行・185KB で Chromium 24ms / WebKit 12ms)。200 行
 * ごとに分けると Chromium 5〜6ms / WebKit 5〜6ms になる。1 行ずつに分けると
 * 段落の挿入 (execCommand の insertParagraph) が極端に重くなった (4800
 * ノードで 12 秒) ので、行単位にはしない (DR-0051 §2)。 */
export const EDITOR_TEXT_NODE_LINES = 200;

/** 編集領域の DOM に置く文字列を、テキストノードごとの文字列に分ける。
 * 繋ぐと元に戻る。 */
export function splitEditorDom(
  domText: string,
  linesPerNode: number = EDITOR_TEXT_NODE_LINES,
): string[] {
  const parts: string[] = [];
  let start = 0;
  let lines = 0;
  for (let i = domText.indexOf("\n"); i !== -1; i = domText.indexOf("\n", i + 1)) {
    lines += 1;
    if (lines === linesPerNode) {
      parts.push(domText.slice(start, i + 1));
      start = i + 1;
      lines = 0;
    }
  }
  if (start < domText.length || parts.length === 0) parts.push(domText.slice(start));
  return parts;
}
