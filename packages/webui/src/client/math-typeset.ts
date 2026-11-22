// TeX を MathML にする (DR-0010 §14)。webui の本体の bundle に入れず、数式が
// 出た時だけ math-render.ts が dynamic import する (Bun.build が別の chunk に
// 分ける)。Temml・DOMPurify・Temml の stylesheet はこの chunk に入る。
//
// Temml は `temml.render` で DOM として組み立て (MathML の名前空間付き)、それを
// その場で DOMPurify (MathML の profile) に通す。文字列 (`renderToString`) で
// 受けて HTML として読み直すと、`mo` の中に置かれた MathML の要素が HTML の
// 要素として読まれ、サニタイズで消えるため。サニタイズした DOM は文書に入れず、
// タグ・属性・文字の木 (MathTree) にして返し、Preact がそれを描く。
import DOMPurify, { type Config } from "dompurify";
import temml, { type Options } from "temml";
import temmlCss from "temml/dist/Temml-Local.css" with { type: "text" };

/** MathML の 1 要素。属性の値も文字も、サニタイズを通ったもの。 */
export interface MathTree {
  tag: string;
  attrs: [string, string][];
  children: (MathTree | string)[];
}

export type TypesetResult = { ok: true; tree: MathTree } | { ok: false; message: string };

/**
 * DOMPurify の MathML の profile が落とすもののうち、Temml が使うものだけを
 * 足す: `semantics` / `annotation` と `encoding` (TeX の原文。落とすと原文が
 * 数式の横に文字として出る)、`class` / `style` (Temml の CSS と、間隔・色・
 * 枠)、`form` (演算子の前後の間隔)、`span` (式番号を入れる `mtext` の中の
 * 要素)。`id` (`\label` から来る) は落とし、webui の要素の id と重ならない
 * ようにする。
 */
const MATH_PURIFY: Config & { IN_PLACE: true } = {
  USE_PROFILES: { mathMl: true },
  ADD_TAGS: ["semantics", "annotation", "span"],
  ADD_ATTR: ["class", "style", "encoding", "form"],
  FORBID_ATTR: ["id"],
  IN_PLACE: true,
};

/** `trust: false` は `\href`・`\url`・`\includegraphics`・`\class`・`\style`・
 * `\id`・`\data` を断る。`maxExpand` はマクロの暴走 (`\def\a{\a\a}\a`) を
 * 止め、`maxSize` は利用者が書く大きさ (`\rule`・`\raisebox`) を 50em /
 * 600pt に抑える。 */
const TEMML_OPTIONS: Options = {
  annotate: true,
  throwOnError: true,
  trust: false,
  maxExpand: 1000,
  maxSize: [50, 600],
};

function treeOf(element: Element): MathTree {
  const children: (MathTree | string)[] = [];
  for (const child of Array.from(element.childNodes)) {
    if (child instanceof Element) children.push(treeOf(child));
    else if (child.nodeType === child.TEXT_NODE) children.push(child.textContent ?? "");
  }
  return {
    tag: element.localName,
    attrs: Array.from(element.attributes, (attr): [string, string] => [attr.name, attr.value]),
    children,
  };
}

/** `tex` の MathML か、描けない理由 (Temml のエラー文の 1 行目)。 */
export function typesetMath(tex: string, display: boolean): TypesetResult {
  const box = document.createElement("span");
  try {
    temml.render(tex, box, { ...TEMML_OPTIONS, displayMode: display });
    const math = box.firstElementChild;
    if (box.childNodes.length !== 1 || math === null || math.localName !== "math") {
      return { ok: false, message: "Temml の出力が想定と違う" };
    }
    DOMPurify.sanitize(math, MATH_PURIFY);
    if (math.parentNode !== box) return { ok: false, message: "サニタイズで数式が消えた" };
    return { ok: true, tree: treeOf(math) };
  } catch (err) {
    // Temml のエラー文は、誤りの周りの原文 (結合下線で印を付けたもの) で
    // 終わる。ここでは 1 行目で足りる。
    const first = (err instanceof Error ? err.message : String(err)).split("\n")[0] ?? "";
    return { ok: false, message: first.trim().replace(/:$/, "") };
  }
}

/** Temml の stylesheet を文書に足す (1 回だけ)。フォントは OS の数式フォント
 * に任せ、`\mathscr` 用の Temml.woff2 だけを data URL で埋める (webui の
 * Bun.build の plugin が stylesheet の文字の中で置き換える)。色は文字の色を
 * 継ぐので light / dark の両方で読める。 */
let styled = false;
export function installMathStyles(): void {
  if (styled) return;
  styled = true;
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(temmlCss);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
}
