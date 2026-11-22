// SVG の文字を図 (img) として見せるための材料 (DR-0010 §12)。
// 図は `<img>` の data URL で描く: img として読ませた SVG は script・イベント
// 属性・外部参照を動かさないので、応答に第三者の入力が写っていても webui の
// 文書には何も入らない。ここは文字から img に渡す値を作るだけで、DOM には触れない。

const SVG_NS = "http://www.w3.org/2000/svg";

/** img に渡す値。 */
export interface SvgFigure {
  /** `data:image/svg+xml;charset=utf-8,` + 中身の percent-encode。 */
  src: string;
  /** 根の `<title>` の文字。無ければ「<label> の図」。 */
  alt: string;
  /** 根の `<svg>` が自分の幅 (長さの `width`) を持つか。持たない図 (viewBox
   * だけ、`width="100%"`) は img としての大きさが無く、表示側が既定の幅を
   * 与える。 */
  sized: boolean;
}

/** 根の要素が名前空間を持たない `<svg>` の時、最初の `<svg` の直後に
 * `xmlns` を足した文字を返す。img は SVG を XML として読むので、`xmlns` の
 * 無い `<svg>` は SVG の要素にならず、壊れた画像になる (HTML の中に直に書く
 * `<svg>` は `xmlns` を省けるので、書き手は省きがち)。 */
function withSvgNamespace(code: string, root: Element): string {
  if (root.localName !== "svg" || root.namespaceURI !== null) return code;
  const at = code.search(/<svg(?=[\s/>])/);
  if (at < 0) return code;
  const end = at + "<svg".length;
  return `${code.slice(0, end)} xmlns="${SVG_NS}"${code.slice(end)}`;
}

function titleOf(root: Element): string | null {
  for (const child of Array.from(root.children)) {
    if (child.localName !== "title") continue;
    const text = (child.textContent ?? "").trim();
    return text === "" ? null : text;
  }
  return null;
}

function hasOwnWidth(root: Element): boolean {
  const width = (root.getAttribute("width") ?? "").trim();
  return width !== "" && !width.endsWith("%");
}

/** data URL は percent-encode で作る (base64 にしない)。中身は UTF-8 の文字で、
 * `btoa` は Latin-1 しか受けないので base64 には一度バイト列へ直す手間が要り、
 * 英数字の多い SVG では percent-encode の方が短い。`charset=utf-8` は、
 * percent-encode したバイト列が UTF-8 であることを XML の読み手に伝える
 * (中身の `<?xml encoding=…?>` より MIME の charset が優先される)。 */
export function svgDataUrl(code: string): string {
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(code)}`;
}

/** SVG の文字から img の材料を作る。XML として読めない中身もそのまま
 * data URL にする: 読めるかどうかは img の読み込み (error の event) が決め、
 * 表示側はその時にコードの表示に落とす。 */
export function svgFigure(code: string, label: string): SvgFigure {
  const untitled = `${label} の図`;
  const doc = new DOMParser().parseFromString(code, "image/svg+xml");
  const root = doc.documentElement;
  const parsed = doc.getElementsByTagName("parsererror").length === 0;
  if (!parsed) return { src: svgDataUrl(code), alt: untitled, sized: false };
  return {
    src: svgDataUrl(withSvgNamespace(code, root)),
    alt: titleOf(root) ?? untitled,
    sized: hasOwnWidth(root),
  };
}
