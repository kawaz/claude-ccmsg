// 編集領域の着色を CSS Custom Highlight API に登録する (DR-0051)。
//
// - 色 (SyntaxPaint) ごとに Highlight の名前を 1 つ作り、`::highlight(名前)` の
//   規則を文書に足す。名前は文書の中で共有し、編集領域 (owner) ごとの範囲を
//   合わせて登録する (2 つの区画で同時に編集していても互いを消さない)
// - 範囲は StaticRange で作る。live Range を Highlight に登録すると、WebKit で
//   文書のどこかの DOM が変わるたびに描画が範囲の数に対して超線形に重くなる
//   (4281 本で 1 打鍵 2.6 秒、DR-0051 §2)。範囲は打鍵のたびに作り直すので、
//   DOM に追従する必要が無い
import type { SyntaxPaint } from "./highlight.ts";

const NAME_PREFIX = "ccmsg-syntax-";

interface HighlightRegistryLike {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

interface DocumentSyntax {
  registry: HighlightRegistryLike;
  HighlightCtor: new (...ranges: AbstractRange[]) => Highlight;
  StaticRangeCtor: new (init: StaticRangeInit) => StaticRange;
  sheet: CSSStyleSheet;
  rules: string[];
  nameByPaint: Map<string, string>;
  rangesByOwner: Map<object, Map<string, StaticRange[]>>;
  /** 今 Highlight を登録している名前 */
  registered: Set<string>;
}

const documents = new WeakMap<Document, DocumentSyntax>();

function documentSyntax(doc: Document): DocumentSyntax | null {
  const existing = documents.get(doc);
  if (existing) return existing;
  const win = doc.defaultView;
  // lib.dom は両方を宣言しているが、Custom Highlight API の無いブラウザには
  // どちらも無いので、無いかもしれない値として読む (rendered-text-search.ts と同じ)。
  const registry: HighlightRegistryLike | undefined = win?.CSS?.highlights;
  const HighlightCtor: (new (...ranges: AbstractRange[]) => Highlight) | undefined = win?.Highlight;
  if (!registry || !HighlightCtor || !win) return null;
  const StaticRangeCtor = win.StaticRange;
  const sheet = new win.CSSStyleSheet();
  doc.adoptedStyleSheets = [...doc.adoptedStyleSheets, sheet];
  const created: DocumentSyntax = {
    registry,
    HighlightCtor,
    StaticRangeCtor,
    sheet,
    rules: [],
    nameByPaint: new Map(),
    rangesByOwner: new Map(),
    registered: new Set(),
  };
  documents.set(doc, created);
  return created;
}

// テーマ由来の値 (`#24292e`、`underline`) だけを CSS の文字列に入れる。
const CSS_VALUE = /^[#\w\s(),.%-]*$/;

function declarations(color: string, decoration: string): string {
  const parts: string[] = [];
  if (color !== "" && CSS_VALUE.test(color)) parts.push(`color: ${color};`);
  if (decoration !== "" && CSS_VALUE.test(decoration))
    parts.push(`text-decoration: ${decoration};`);
  return parts.join(" ");
}

function paintKey(paint: SyntaxPaint): string {
  return [paint.light, paint.dark, paint.lightDecoration, paint.darkDecoration].join("|");
}

/** 色に対応する Highlight の名前。初めての色なら `::highlight()` の規則を足す。
 * 閲覧側の `.shiki-tok` と同じく、ダークテーマは prefers-color-scheme で切り替える。 */
function nameFor(state: DocumentSyntax, paint: SyntaxPaint): string {
  const key = paintKey(paint);
  const known = state.nameByPaint.get(key);
  if (known !== undefined) return known;
  const name = `${NAME_PREFIX}${state.nameByPaint.size}`;
  state.nameByPaint.set(key, name);
  state.rules.push(
    `::highlight(${name}) { ${declarations(paint.light, paint.lightDecoration)} }`,
    `@media (prefers-color-scheme: dark) { ::highlight(${name}) { ${declarations(paint.dark, paint.darkDecoration)} } }`,
  );
  state.sheet.replaceSync(state.rules.join("\n"));
  return name;
}

function syncRegistry(state: DocumentSyntax): void {
  const merged = new Map<string, StaticRange[]>();
  for (const byName of state.rangesByOwner.values()) {
    for (const [name, ranges] of byName) {
      const list = merged.get(name);
      if (list) list.push(...ranges);
      else merged.set(name, [...ranges]);
    }
  }
  for (const [name, ranges] of merged) {
    state.registry.set(name, new state.HighlightCtor(...ranges));
    state.registered.add(name);
  }
  for (const name of state.registered) {
    if (merged.has(name)) continue;
    state.registry.delete(name);
    state.registered.delete(name);
  }
}

/** 文字列の中の位置 (UTF-16 offset) を、それを含むテキストノードと、その中の
 * 位置に直す。編集領域の文字列はテキストノードを順に繋いだもの
 * (Enter で分かれる・WebKit がタブを span で包むので 1 つとは限らない)。 */
export interface TextSegment {
  node: Text;
  start: number;
}

export function textSegments(root: Element): { segments: TextSegment[]; text: string } {
  const segments: TextSegment[] = [];
  let text = "";
  const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    segments.push({ node, start: text.length });
    text += node.data;
  }
  return { segments, text };
}

/** 塗る範囲 1 つ: 文字列の中の [start, end) と色。 */
export interface PaintSpan {
  start: number;
  end: number;
  paint: SyntaxPaint;
}

function staticRanges(
  segments: readonly TextSegment[],
  spans: readonly PaintSpan[],
  state: DocumentSyntax,
): Map<string, StaticRange[]> {
  const byName = new Map<string, StaticRange[]>();
  // spans は start の昇順で来る前提で、テキストノードの位置を前から探す
  let index = 0;
  const locate = (offset: number): [Text, number] | null => {
    while (index + 1 < segments.length) {
      const following = segments[index + 1];
      if (following === undefined || following.start > offset) break;
      // offset がちょうどノードの境目の時は後ろのノードの頭にする
      index += 1;
    }
    const segment = segments[index];
    if (segment === undefined) return null;
    return [segment.node, Math.min(offset - segment.start, segment.node.data.length)];
  };
  for (const span of spans) {
    if (span.end <= span.start) continue;
    const start = locate(span.start);
    // 終わりは「end の直前の文字を含むノード」の中で取る
    const endAt = locate(span.end - 1);
    if (!start || !endAt) continue;
    const range = new state.StaticRangeCtor({
      startContainer: start[0],
      startOffset: start[1],
      endContainer: endAt[0],
      endOffset: endAt[1] + 1,
    });
    const name = nameFor(state, span.paint);
    const list = byName.get(name);
    if (list) list.push(range);
    else byName.set(name, [range]);
  }
  return byName;
}

/** `owner` の編集領域の着色を `spans` で置き換える。Custom Highlight API の
 * 無いブラウザでは何もしない (編集はできる、着色が無いだけ)。 */
export function paintSyntax(
  doc: Document,
  owner: object,
  segments: readonly TextSegment[],
  spans: readonly PaintSpan[],
): void {
  const state = documentSyntax(doc);
  if (!state) return;
  state.rangesByOwner.set(owner, staticRanges(segments, spans, state));
  syncRegistry(state);
}

/** `owner` の着色を外す (編集領域を閉じた時)。 */
export function clearSyntax(doc: Document, owner: object): void {
  const state = documents.get(doc);
  if (!state || !state.rangesByOwner.delete(owner)) return;
  syncRegistry(state);
}
