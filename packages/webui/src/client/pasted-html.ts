// 入力欄に貼られた HTML の読み方 (DR-0065): markdown に直すかどうかの判定と、
// 直した文字に残してよい URL。貼り付けの handler (paste-html-as-markdown.ts、
// 最初の画面の bundle) と変換 (html-to-markdown.ts、遅れて読む chunk) が同じ
// ものを使う。HTML は DOMParser で文書の外の木にして読むだけで、表示中の文書
// には入れない (DOMParser の文書では script は走らず、画像も取りに行かない)。

/** 直した markdown に残すリンク・画像の URL の scheme。 */
const KEPT_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

/** `url` を直した markdown のリンク・画像に残してよいなら、その URL (URL の
 * 決まりで整えたもの)。相対 URL (貼った先では行き先が無い) と http(s)・mailto
 * 以外の scheme は null で、呼び手は文言 (画像なら alt) だけを残す。 */
export function keptUrl(url: string): string | null {
  const parsed = URL.parse(url.trim());
  return parsed !== null && KEPT_PROTOCOLS.has(parsed.protocol) ? parsed.href : null;
}

const XHTML = "http://www.w3.org/1999/xhtml";

/** 変換を始める引き金の要素。どれも無い HTML (エディタ・ターミナルからの
 * コピーの、色付けの span / div と段落・改行・太字だけのもの) は変換しない。 */
const TRIGGERS =
  "a[href], img[src], ul, ol, table, h1, h2, h3, h4, h5, h6, blockquote, pre, code, hr";

/** `doc` に markdown に直す意味のある要素があるか。リンクと画像は URL が
 * 残せるもの (keptUrl) だけを数える。 */
export function hasMarkdownStructure(doc: Document): boolean {
  return Array.from(doc.body.querySelectorAll(TRIGGERS)).some(isTrigger);
}

function isTrigger(el: Element): boolean {
  if (el.namespaceURI !== XHTML) return false;
  if (el.localName === "a") return keptUrl(el.getAttribute("href") ?? "") !== null;
  if (el.localName === "img") return keptUrl(el.getAttribute("src") ?? "") !== null;
  return true;
}

/** 貼られた HTML を文書の外の木にする (scripting の無い文書、DR-0065 §安全)。 */
export function parsePastedHtml(html: string): Document {
  return new DOMParser().parseFromString(html, "text/html");
}
