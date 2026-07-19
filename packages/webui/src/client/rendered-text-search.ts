import { collectHighlightRanges, unitMatchesQuery, type SearchWord } from "./in-view-search.ts";

interface HighlightRegistryLike {
  set(name: string, highlight: Highlight): void;
  delete(name: string): boolean;
}

interface HighlightWindow extends Window {
  CSS?: typeof CSS & { highlights?: HighlightRegistryLike };
  Highlight?: new (...ranges: AbstractRange[]) => Highlight;
}

interface RootHighlights {
  byColor: Range[][];
  all: Range[];
  current: boolean;
  clickListener: (event: MouseEvent) => void;
}

const rootsByDocument = new Map<Document, Map<HTMLElement, RootHighlights>>();
const scheduledDocuments = new Set<Document>();
const HIGHLIGHT_PREFIX = "ccmsg-search-";
const CURRENT_HIGHLIGHT = `${HIGHLIGHT_PREFIX}current`;

export interface TextNodeSpan {
  nodeIndex: number;
  start: number;
  end: number;
}

/** Projects a range in concatenated text back onto the contributing nodes. */
export function projectRangeToTextNodes(
  nodeLengths: readonly number[],
  start: number,
  end: number,
): TextNodeSpan[] {
  const spans: TextNodeSpan[] = [];
  let nodeStart = 0;
  nodeLengths.forEach((length, nodeIndex) => {
    const nodeEnd = nodeStart + length;
    if (start < nodeEnd && end > nodeStart) {
      spans.push({
        nodeIndex,
        start: Math.max(0, start - nodeStart),
        end: Math.min(length, end - nodeStart),
      });
    }
    nodeStart = nodeEnd;
  });
  return spans;
}

export interface RenderedHighlightSpan extends TextNodeSpan {
  colorIndex: number;
}

export function collectRenderedTextSpans(
  nodeTexts: readonly string[],
  words: readonly SearchWord[],
): { matched: boolean; spans: RenderedHighlightSpan[] } {
  const text = nodeTexts.join("");
  if (!unitMatchesQuery(text, words)) return { matched: false, spans: [] };
  const lengths = nodeTexts.map((node) => node.length);
  return {
    matched: true,
    spans: collectHighlightRanges(text, words).flatMap((range) =>
      projectRangeToTextNodes(lengths, range.start, range.end).map((span) => ({
        ...span,
        colorIndex: range.colorIndex,
      })),
    ),
  };
}

function highlightApi(doc: Document): {
  registry: HighlightRegistryLike;
  HighlightCtor: new (...ranges: AbstractRange[]) => Highlight;
} | null {
  const win = doc.defaultView as HighlightWindow | null;
  const registry = (win?.CSS as (typeof CSS & { highlights?: HighlightRegistryLike }) | undefined)
    ?.highlights;
  const HighlightCtor = win?.Highlight;
  return registry && HighlightCtor ? { registry, HighlightCtor } : null;
}

function syncDocumentHighlights(doc: Document): void {
  const api = highlightApi(doc);
  if (!api) return;
  const roots = rootsByDocument.get(doc);
  for (let i = 0; i < 6; i += 1) {
    const ranges = roots ? [...roots.values()].flatMap((root) => root.byColor[i] ?? []) : [];
    const name = `${HIGHLIGHT_PREFIX}${i + 1}`;
    if (ranges.length > 0) api.registry.set(name, new api.HighlightCtor(...ranges));
    else api.registry.delete(name);
  }
  const current = roots
    ? [...roots.values()].filter((root) => root.current).flatMap((root) => root.all)
    : [];
  if (current.length > 0) api.registry.set(CURRENT_HIGHLIGHT, new api.HighlightCtor(...current));
  else api.registry.delete(CURRENT_HIGHLIGHT);
}

function scheduleHighlightSync(doc: Document): void {
  if (scheduledDocuments.has(doc)) return;
  scheduledDocuments.add(doc);
  queueMicrotask(() => {
    scheduledDocuments.delete(doc);
    syncDocumentHighlights(doc);
  });
}

function rangeAtPoint(doc: Document, event: MouseEvent): Range | null {
  if (typeof doc.caretRangeFromPoint === "function") {
    return doc.caretRangeFromPoint(event.clientX, event.clientY);
  }
  const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (!position) return null;
  const range = doc.createRange();
  range.setStart(position.offsetNode, position.offset);
  range.collapse(true);
  return range;
}

function pointFallsInRange(point: Range, range: Range): boolean {
  try {
    return range.isPointInRange(point.startContainer, point.startOffset);
  } catch {
    return false;
  }
}

/**
 * Searches the rendered text below `root` and registers non-destructive CSS
 * Custom Highlight ranges. Matches may cross any number of inline elements.
 */
export function highlightRenderedText(
  root: HTMLElement,
  words: readonly SearchWord[],
  onMatchClick: () => void,
): boolean {
  removeRenderedTextHighlights(root);
  if (words.length === 0) return false;

  const doc = root.ownerDocument;
  const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(root, showText);
  const nodes: Text[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const textNode = node as Text;
    nodes.push(textNode);
    text += textNode.data;
  }
  if (!unitMatchesQuery(text, words)) return false;

  const byColor = Array.from({ length: 6 }, () => [] as Range[]);
  const all: Range[] = [];
  for (const match of collectHighlightRanges(text, words)) {
    const spans = projectRangeToTextNodes(
      nodes.map((node) => node.data.length),
      match.start,
      match.end,
    );
    if (spans.length === 0) continue;
    const first = spans[0]!;
    const last = spans[spans.length - 1]!;
    const range = doc.createRange();
    range.setStart(nodes[first.nodeIndex]!, first.start);
    range.setEnd(nodes[last.nodeIndex]!, last.end);
    byColor[match.colorIndex]!.push(range);
    all.push(range);
  }

  const clickListener = (event: MouseEvent) => {
    const point = rangeAtPoint(doc, event);
    if (point && all.some((range) => pointFallsInRange(point, range))) onMatchClick();
  };
  root.addEventListener("click", clickListener);
  let roots = rootsByDocument.get(doc);
  if (!roots) {
    roots = new Map();
    rootsByDocument.set(doc, roots);
  }
  roots.set(root, { byColor, all, current: false, clickListener });
  scheduleHighlightSync(doc);
  return true;
}

export function setRenderedTextCurrent(root: HTMLElement, current: boolean): void {
  const entry = rootsByDocument.get(root.ownerDocument)?.get(root);
  if (!entry || entry.current === current) return;
  entry.current = current;
  scheduleHighlightSync(root.ownerDocument);
}

export function removeRenderedTextHighlights(root: HTMLElement): void {
  const roots = rootsByDocument.get(root.ownerDocument);
  const entry = roots?.get(root);
  if (!entry) return;
  root.removeEventListener("click", entry.clickListener);
  roots!.delete(root);
  if (roots!.size === 0) rootsByDocument.delete(root.ownerDocument);
  scheduleHighlightSync(root.ownerDocument);
}
