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
  words: readonly SearchWord[];
  clickListener: (event: MouseEvent) => void;
}

const rootsByDocument = new Map<Document, Map<HTMLElement, RootHighlights>>();
const toggleListenersByDocument = new Map<Document, EventListener>();
const scheduledDocuments = new Set<Document>();
const scheduledRefreshDocuments = new Set<Document>();
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

interface RenderedHighlightRange {
  colorIndex: number;
  spans: TextNodeSpan[];
}

function collectRenderedTextRangeSpans(
  nodeTexts: readonly string[],
  words: readonly SearchWord[],
  nodeVisible: readonly boolean[],
): { matched: boolean; ranges: RenderedHighlightRange[] } {
  const text = nodeTexts.join("");
  if (!unitMatchesQuery(text, words)) return { matched: false, ranges: [] };
  const lengths = nodeTexts.map((node) => node.length);
  return {
    matched: true,
    ranges: collectHighlightRanges(text, words).flatMap((range) => {
      const spans = projectRangeToTextNodes(lengths, range.start, range.end);
      return spans.length === 0 || spans.some((span) => !nodeVisible[span.nodeIndex])
        ? []
        : [{ colorIndex: range.colorIndex, spans }];
    }),
  };
}

export function collectRenderedTextSpans(
  nodeTexts: readonly string[],
  words: readonly SearchWord[],
  nodeVisible: readonly boolean[] = nodeTexts.map(() => true),
): { matched: boolean; spans: RenderedHighlightSpan[] } {
  const result = collectRenderedTextRangeSpans(nodeTexts, words, nodeVisible);
  return {
    matched: result.matched,
    spans: result.ranges.flatMap((range) =>
      range.spans.map((span) => ({ ...span, colorIndex: range.colorIndex })),
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

function isTextNodeVisible(node: Text): boolean {
  let element = node.parentElement;
  while (element) {
    if (element.tagName === "DETAILS" && !(element as HTMLDetailsElement).open) {
      const summary = Array.from(element.children).find((child) => child.tagName === "SUMMARY");
      if (!summary?.contains(node)) return false;
    }
    element = element.parentElement;
  }
  return true;
}

function collectRootRanges(
  root: HTMLElement,
  words: readonly SearchWord[],
): { matched: boolean; byColor: Range[][]; all: Range[] } {
  const doc = root.ownerDocument;
  const showText = doc.defaultView?.NodeFilter.SHOW_TEXT ?? 4;
  const walker = doc.createTreeWalker(root, showText);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);

  const result = collectRenderedTextRangeSpans(
    nodes.map((node) => node.data),
    words,
    nodes.map((node) => isTextNodeVisible(node)),
  );
  const byColor = Array.from({ length: 6 }, () => [] as Range[]);
  const all: Range[] = [];
  for (const match of result.ranges) {
    if (match.spans.length === 0) continue;
    const first = match.spans[0]!;
    const last = match.spans[match.spans.length - 1]!;
    const range = doc.createRange();
    range.setStart(nodes[first.nodeIndex]!, first.start);
    range.setEnd(nodes[last.nodeIndex]!, last.end);
    byColor[match.colorIndex]!.push(range);
    all.push(range);
  }
  return { matched: result.matched, byColor, all };
}

function scheduleRootRefresh(doc: Document): void {
  if (scheduledRefreshDocuments.has(doc)) return;
  scheduledRefreshDocuments.add(doc);
  queueMicrotask(() => {
    scheduledRefreshDocuments.delete(doc);
    const roots = rootsByDocument.get(doc);
    if (!roots) return;
    for (const [root, entry] of roots) {
      const ranges = collectRootRanges(root, entry.words);
      entry.byColor = ranges.byColor;
      entry.all = ranges.all;
    }
    scheduleHighlightSync(doc);
  });
}

function ensureToggleListener(doc: Document): void {
  if (toggleListenersByDocument.has(doc)) return;
  const listener = (event: Event) => {
    const DetailsCtor = doc.defaultView?.HTMLDetailsElement;
    if (!DetailsCtor || !(event.target instanceof DetailsCtor)) return;
    scheduleRootRefresh(doc);
  };
  doc.addEventListener("toggle", listener, true);
  toggleListenersByDocument.set(doc, listener);
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
  const ranges = collectRootRanges(root, words);
  if (!ranges.matched) return false;

  const entry: RootHighlights = {
    byColor: ranges.byColor,
    all: ranges.all,
    current: false,
    words,
    clickListener: () => undefined,
  };
  entry.clickListener = (event: MouseEvent) => {
    const point = rangeAtPoint(doc, event);
    if (point && entry.all.some((range) => pointFallsInRange(point, range))) onMatchClick();
  };
  root.addEventListener("click", entry.clickListener);
  let roots = rootsByDocument.get(doc);
  if (!roots) {
    roots = new Map();
    rootsByDocument.set(doc, roots);
    ensureToggleListener(doc);
  }
  roots.set(root, entry);
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
  if (roots!.size === 0) {
    const doc = root.ownerDocument;
    rootsByDocument.delete(doc);
    const toggleListener = toggleListenersByDocument.get(doc);
    if (toggleListener) {
      doc.removeEventListener("toggle", toggleListener, true);
      toggleListenersByDocument.delete(doc);
    }
  }
  scheduleHighlightSync(root.ownerDocument);
}
