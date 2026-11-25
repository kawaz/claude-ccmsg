// メッセージを書く入力欄 (textarea) の paste: クリップボードの text/html に
// markdown に直す意味のある要素があれば、直した markdown をカーソルの位置
// (選択があれば置き換え) に入れる (DR-0065)。それ以外 (text/html が無い、
// ⌘⇧V の「スタイルを合わせて貼り付け」、エディタやターミナルの色付けだけの
// HTML) はブラウザの貼り付けのまま。変換の部品は最初に要る時に読み込む。
import { hasMarkdownStructure, parsePastedHtml } from "./pasted-html.ts";

/** 入力欄の `onPaste`。先に貼り付けを引き受けた handler (添付) があれば
 * (`defaultPrevented`) 何もしない。 */
export function pasteHtmlAsMarkdown(e: ClipboardEvent): void {
  const el = e.currentTarget;
  if (e.defaultPrevented || !(el instanceof HTMLTextAreaElement)) return;
  if (el.readOnly || el.disabled) return;
  const html = e.clipboardData?.getData("text/html") ?? "";
  if (html === "" || !hasMarkdownStructure(parsePastedHtml(html))) return;
  e.preventDefault();
  // クリップボードの中身はこのイベントの間しか読めないので、読み込みを待つ前に取る。
  const plain = e.clipboardData?.getData("text/plain") ?? "";
  const at = { value: el.value, start: el.selectionStart, end: el.selectionEnd };
  void markdownOf(html, plain).then((text) => {
    if (!el.isConnected) return;
    if (el.ownerDocument.activeElement !== el) el.focus();
    // 待つ間に中身が変わっていなければ、貼った時の選択に入れる。
    if (el.value === at.value) el.setSelectionRange(at.start, at.end);
    // Design rationale: 非推奨の execCommand を使うのは、textarea の undo の
    // 履歴に積んだまま文字を入れる手段がこれしか無いため。value や
    // setRangeText で入れると ⌘Z で戻らない (Chromium・WebKit で実測、
    // DR-0065 §3)。入れると input イベントが出て、欄の onInput が中身を受ける。
    el.ownerDocument.execCommand("insertText", false, text);
  });
}

/** `html` を直した markdown。直せない時 (部品の読み込みや変換の失敗) は
 * 貼り付けを落とさないよう text/plain の文字。 */
async function markdownOf(html: string, plain: string): Promise<string> {
  try {
    const { htmlToMarkdown } = await import("./html-to-markdown.ts");
    return htmlToMarkdown(html) ?? plain;
  } catch (err) {
    console.error("貼られた HTML を markdown に直せなかったので、そのままの文字を入れた", err);
    return plain;
  }
}
