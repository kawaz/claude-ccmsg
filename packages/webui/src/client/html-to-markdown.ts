// 貼られた HTML を markdown の文字にする (DR-0065)。HTML は DOMParser で
// 文書の外の木にし、hast → mdast → markdown の文字と、木から木へ移すだけで
// 表示中の文書には入れない。最初の画面の bundle に入れず、貼り付けの handler
// (paste-html-as-markdown.ts) が最初に要る時に読み込む。
import type { Element, ElementContent, RootContent as HastContent } from "hast";
import { fromDom } from "hast-util-from-dom";
import { defaultHandlers, toMdast, type Handle } from "hast-util-to-mdast";
import type { Nodes as MdastNodes } from "mdast";
import { toMarkdown, type Options as MarkdownOptions } from "mdast-util-to-markdown";
import { gfmToMarkdown } from "./gfm-to-markdown.ts";
import { hasMarkdownStructure, keptUrl, parsePastedHtml } from "./pasted-html.ts";

/** 貼られた `html` を markdown の文字に直す。markdown に直す意味のある要素が
 * 無い HTML (hasMarkdownStructure) は直さず null (呼び手は text/plain を使う)。
 * 出力は markdown の文字だけで、HTML のタグは表のセルの中の改行の `<br>`
 * (DR-0010 §3) のほかに出さない。リンクと画像は URL を残せるもの (keptUrl)
 * だけで、それ以外は文言 (画像なら alt) だけを残す。 */
export function htmlToMarkdown(html: string): string | null {
  const doc = parsePastedHtml(html);
  if (!hasMarkdownStructure(doc)) return null;
  const hast = fromDom(doc);
  if (hast.type !== "root") return null;
  prepare(hast.children, null);
  const mdast = toMdast(hast, { handlers: HANDLERS, nodeHandlers: { comment: () => undefined } });
  dropEmptyParagraphs(mdast);
  return toMarkdown(mdast, MARKDOWN_OPTIONS).trim();
}

const MARKDOWN_OPTIONS: MarkdownOptions = {
  bullet: "-",
  rule: "-",
  fences: true,
  listItemIndent: "one",
  extensions: [gfmToMarkdown],
};

/** `pre` に prepare が付けるコードの言語 (hast の property。toMdast は木を
 * 写してから読むので、要素ではなく property で渡す)。 */
const LANGUAGE_PROPERTY = "dataPastedLanguage";

/** 太字の `<b>` / `<strong>` の handler を、`font-weight` を普通にしたもの
 * (ドキュメントの編集ソフトが全体を包む `<b style="font-weight:normal">`) は
 * 太字にしない形に包む。 */
function unlessNormalWeight(handle: Handle): Handle {
  return (state, node, parent) => {
    const style = node.properties.style;
    const normal =
      typeof style === "string" && /font-weight\s*:\s*(normal|lighter|[1-4]00)\b/i.test(style);
    return normal ? state.all(node) : handle(state, node, parent);
  };
}

/** リンク・画像を作る handler を、残せない URL のものは文言だけにする形に包む。
 * 文言の無いリンク (アイコンだけの見出しのアンカー等) は出さない。 */
function keepingUrls(handle: Handle): Handle {
  return (state, node, parent) => {
    const result = handle(state, node, parent);
    if (!result || Array.isArray(result)) return result;
    if (result.type === "link") {
      const url = keptUrl(result.url);
      if (url === null || !hasText(result.children)) return result.children;
      result.url = url;
      return result;
    }
    if (result.type === "image") {
      const url = keptUrl(result.url);
      if (url !== null) {
        result.url = url;
        return result;
      }
      return result.alt ? { type: "text", value: result.alt } : undefined;
    }
    return result;
  };
}

const link = keepingUrls(defaultHandlers.a);

// この webui の markdown の描画 (markdown-view.tsx) が作るリンクの class
// (`md-…-link`)。描画が足したリンク (ファイルのパス・issue・添付・コードの中の
// URL) とパスへのリンクは、行き先が webui の中なので文言だけに戻す。画像は
// 取りに行かず `🖼 alt` のリンクで描く (DR-0010 §5) ので、画像に戻す。
const WEBUI_LINK_CLASS = /^md-[a-z-]*link$/;
const WEBUI_IMAGE_LINK = "md-image-link";
const WEBUI_IMAGE_MARK = /^🖼\s*/u;

const HANDLERS: Record<string, Handle> = {
  // 画面の操作の部品 (コードのコピーのボタン等) は中身ではない。
  button: () => undefined,
  b: unlessNormalWeight(defaultHandlers.b),
  strong: unlessNormalWeight(defaultHandlers.strong),
  // 項目に段落 (`<p>`) が 2 つ以上ある時だけ loose (項目の間を空行で分ける)。
  // 段落 1 つは tight: この webui の描画のように、tight のリストの項目も
  // `<p>` で包む描画がある。
  li: (state, node) => {
    const result = defaultHandlers.li(state, node);
    result.spread = node.children.filter((child) => isElement(child, "p")).length >= 2;
    return result;
  },
  pre: (state, node) => {
    const result = defaultHandlers.pre(state, node);
    const lang = node.properties[LANGUAGE_PROPERTY];
    if (result.lang === null && typeof lang === "string") result.lang = lang;
    return result;
  },
  a: (state, node, parent) => {
    const made = classNames(node).filter((name) => WEBUI_LINK_CLASS.test(name));
    if (made.length === 0) return link(state, node, parent);
    if (made.includes(WEBUI_IMAGE_LINK)) {
      // パスの画像 (`md-path-link` も付く) の行き先は webui の中なので alt だけ。
      const href = node.properties.href;
      const url = made.length === 1 && typeof href === "string" ? keptUrl(href) : null;
      const alt = textOf(node).replace(WEBUI_IMAGE_MARK, "").trim();
      if (url !== null) return { type: "image", url, alt, title: null };
      return alt === "" ? undefined : { type: "text", value: alt };
    }
    return state.all(node);
  },
  img: keepingUrls(defaultHandlers.img),
  image: keepingUrls(defaultHandlers.image),
  iframe: keepingUrls(defaultHandlers.iframe),
  audio: keepingUrls(defaultHandlers.audio),
  video: keepingUrls(defaultHandlers.video),
};

/** 文字の無い段落 (ブロックの間の `<br>` から出来る) を外す。空行が重なるだけなので。 */
function dropEmptyParagraphs(node: MdastNodes): void {
  if (!("children" in node)) return;
  for (const child of node.children) dropEmptyParagraphs(child);
  const kept = (c: MdastNodes): boolean => c.type !== "paragraph" || hasText(c.children);
  if (node.type === "root") node.children = node.children.filter(kept);
  else if (node.type === "blockquote") node.children = node.children.filter(kept);
  else if (node.type === "listItem") node.children = node.children.filter(kept);
}

function hasText(nodes: readonly MdastNodes[]): boolean {
  return nodes.some((n) =>
    "value" in n
      ? n.value.trim() !== ""
      : n.type === "image" || ("children" in n && hasText(n.children)),
  );
}

const LANGUAGE_CLASS = /^language-([\w+#-]+)$/;
// GitHub の描画のコードの塊: `<div class="highlight highlight-source-ts"><pre>`。
const GITHUB_HIGHLIGHT_CLASS = /^highlight-source-([\w+#-]+)$/;

/** toMdast の前に木を整える。
 * - コードの言語を hast-util-to-mdast が読む `<pre><code class="language-…">` の
 *   他の書き方からも取り、`pre` に付ける: `pre` 自身の `language-…`、囲む要素の
 *   GitHub の `highlight-source-…`
 * - コードの外の改行しない空白 (U+00A0) を空白にする。WebKit はコピーした
 *   HTML の要素の境目の空白を U+00A0 で書く (実測)
 * - リストの直下のリスト (ドキュメントの編集ソフトの入れ子の書き方) を、前の
 *   項目の中に移す
 * - 見出しの行 (`th`) の無い表 (表計算のコピー) は、最初の行を見出しにする。
 *   markdown の表は見出しの行が要り、無いと空の見出しの行が付く */
function prepare(nodes: (HastContent | ElementContent)[], lang: string | null): void {
  for (const node of nodes) {
    if (node.type === "text") {
      node.value = node.value.replaceAll(NBSP, " ");
    } else if (node.type === "element") {
      if (node.tagName === "pre") {
        const own = classMatch(node, LANGUAGE_CLASS) ?? lang;
        if (own !== null) node.properties[LANGUAGE_PROPERTY] = own;
        continue;
      }
      if (node.tagName === "ul" || node.tagName === "ol") nestStrayLists(node);
      if (node.tagName === "table") headFirstRow(node);
      prepare(node.children, classMatch(node, GITHUB_HIGHLIGHT_CLASS) ?? lang);
    }
  }
}

const NBSP = "\u00a0";

function nestStrayLists(list: Element): void {
  const kept: ElementContent[] = [];
  for (const child of list.children) {
    const previous = kept.findLast((c) => c.type === "element");
    if (
      (isElement(child, "ul") || isElement(child, "ol")) &&
      previous?.type === "element" &&
      previous.tagName === "li"
    ) {
      previous.children.push(child);
    } else {
      kept.push(child);
    }
  }
  list.children = kept;
}

function headFirstRow(table: Element): void {
  const rows = elementsIn(table, ["thead", "tbody", "tfoot"]).filter((el) => el.tagName === "tr");
  if (rows.some((row) => row.children.some((cell) => isElement(cell, "th")))) return;
  if (elementsIn(table, []).some((el) => el.tagName === "thead")) return;
  for (const cell of rows[0]?.children ?? []) {
    if (cell.type === "element" && cell.tagName === "td") cell.tagName = "th";
  }
}

/** `parent` の子の要素。`through` の要素はその子に置き換えて (1 段) 数える。 */
function elementsIn(parent: Element, through: readonly string[]): Element[] {
  return parent.children.flatMap((child) => {
    if (child.type !== "element") return [];
    return through.includes(child.tagName)
      ? child.children.filter((c): c is Element => c.type === "element")
      : [child];
  });
}

function classNames(node: Element): string[] {
  const classes = node.properties.className;
  return Array.isArray(classes) ? classes.map(String) : [];
}

function classMatch(node: Element, pattern: RegExp): string | null {
  for (const name of classNames(node)) {
    const m = pattern.exec(name);
    if (m?.[1] !== undefined) return m[1];
  }
  return null;
}

function textOf(node: ElementContent): string {
  if (node.type === "text") return node.value;
  return node.type === "element" ? node.children.map(textOf).join("") : "";
}

function isElement(node: ElementContent, tagName: string): boolean {
  return node.type === "element" && node.tagName === tagName;
}
