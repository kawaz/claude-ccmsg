// Comments on a quote inside a Timeline bubble (DR-0062 §2, §3, §12, P31):
// the 💬 that comes out beside a choice made in a bubble (SelectionToolbar),
// and, on a bubble, the quotes its comments are on found again in what it
// draws now, highlighted, with a 💬 after each (QuoteMarks).
//
// A bubble that can be commented on is a region: the element its 返信 row
// (CommentReplyRow) is in, registered with what a comment on it is on
// (TimelineComments.regions). What a region draws for a quote is the text of
// its elements marked `data-comment-text` (the markdown of a response, a
// ccmsg message's msg tab, an agent's card, a task-notification's fields, a
// comment's text). The source tab, a ccmsg message's raw tab, the jsonl and
// a bubble's head are not marked: a choice there makes no 💬.
import { useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { timelineHref } from "../../locator.ts";
import { choiceButtonPlace, choiceIn, findQuote, type Box } from "../../comment-quote.ts";
import { commentSelectionKey, quotesOn, quoteTargetOf } from "../../comment-view.ts";
import { useEffectEvent } from "../../useEffectEvent.ts";
import { TimelinePositionContext } from "./context.ts";
import { TimelineCommentsContext, type CommentTarget } from "./comment-context.ts";

/** A region's drawn text: its marked elements' text nodes joined, a line
 * break between blocks, and where each node starts in it. */
interface DrawnText {
  text: string;
  pieces: Array<{ node: Text; start: number }>;
}

/** Elements whose text starts a new line in what a region draws. */
const BLOCK_TAGS = new Set([
  "ADDRESS",
  "ARTICLE",
  "ASIDE",
  "BLOCKQUOTE",
  "DD",
  "DETAILS",
  "DIV",
  "DL",
  "DT",
  "FIGCAPTION",
  "FIGURE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "HR",
  "LI",
  "OL",
  "P",
  "PRE",
  "SECTION",
  "SUMMARY",
  "TABLE",
  "TD",
  "TH",
  "TR",
  "UL",
]);
/** Elements whose text is not what is read (a copy button's label, the
 * source a formula is drawn from). */
const SKIPPED_TAGS = new Set(["BUTTON", "SCRIPT", "STYLE", "TEMPLATE", "ANNOTATION"]);

const COMMENT_TEXT = "[data-comment-text]";

/** The block `node` is in, under `container`. */
function blockOf(node: Node, container: Element): Element {
  for (let at = node.parentElement; at !== null && at !== container; at = at.parentElement) {
    if (BLOCK_TAGS.has(at.tagName)) return at;
  }
  return container;
}

function skipped(node: Node, container: Element): boolean {
  for (let at = node.parentElement; at !== null && at !== container; at = at.parentElement) {
    if (SKIPPED_TAGS.has(at.tagName.toUpperCase())) return true;
  }
  return false;
}

/** What `region` draws for quotes (see the head of this file). */
export function drawnTextOf(region: Element): DrawnText {
  const doc = region.ownerDocument;
  let text = "";
  const pieces: DrawnText["pieces"] = [];
  const breakLine = () => {
    if (text !== "" && !text.endsWith("\n")) text += "\n";
  };
  for (const container of region.querySelectorAll(COMMENT_TEXT)) {
    // A marked element inside another is read with it.
    const outer = container.parentElement?.closest(COMMENT_TEXT);
    if (outer !== undefined && outer !== null && region.contains(outer)) continue;
    breakLine();
    const walker = doc.createTreeWalker(container, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    let block: Element | null = null;
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof Element) {
        if (node.tagName === "BR") text += "\n";
        continue;
      }
      if (!(node instanceof Text) || skipped(node, container)) continue;
      const at = blockOf(node, container);
      if (block !== null && at !== block) breakLine();
      block = at;
      pieces.push({ node, start: text.length });
      text += node.data;
    }
  }
  return { text, pieces };
}

/** Where the point (`container`, `offset`) is in `drawn`: inside a node of it,
 * or before the first of its nodes after the point. */
function offsetAt(drawn: DrawnText, container: Node, offset: number): number {
  const own = drawn.pieces.find((piece) => piece.node === container);
  if (own !== undefined) return own.start + Math.min(offset, own.node.data.length);
  const point = container.ownerDocument?.createRange();
  if (point === undefined) return drawn.text.length;
  point.setStart(container, offset);
  point.collapse(true);
  const next = drawn.pieces.find((piece) => point.comparePoint(piece.node, 0) >= 0);
  return next === undefined ? drawn.text.length : next.start;
}

/** The DOM range of `start`..`end` in `drawn`. Null when no node holds it. */
function rangeIn(drawn: DrawnText, start: number, end: number): Range | null {
  const first = drawn.pieces.find((piece) => start < piece.start + piece.node.data.length);
  const last = drawn.pieces.findLast((piece) => end > piece.start);
  if (first === undefined || last === undefined) return null;
  const range = first.node.ownerDocument.createRange();
  range.setStart(first.node, Math.max(0, start - first.start));
  range.setEnd(last.node, Math.min(last.node.data.length, end - last.start));
  return range;
}

function boxesOf(range: Range): DOMRect[] {
  return Array.from(range.getClientRects()).filter((box) => box.width > 0 || box.height > 0);
}

// --- the highlight of the quotes (P31) ---

const HIGHLIGHT = "ccmsg-comment";
const quoteRanges = new Map<Element, Range[]>();
let syncScheduled = false;

/** Paints every region's quotes under the one highlight name, once per turn
 * of the event loop (as rendered-text-search.ts does the search's). */
function scheduleSync(doc: Document): void {
  if (syncScheduled) return;
  syncScheduled = true;
  queueMicrotask(() => {
    syncScheduled = false;
    const win = doc.defaultView;
    // lib.dom declares both, but a browser without the CSS Custom Highlight
    // API has neither, so they are read as possibly absent.
    const registry: HighlightRegistry | undefined = win?.CSS?.highlights;
    const HighlightCtor: (new (...ranges: AbstractRange[]) => Highlight) | undefined =
      win?.Highlight;
    if (registry === undefined || HighlightCtor === undefined) return;
    const ranges = [...quoteRanges.values()].flat();
    if (ranges.length > 0) registry.set(HIGHLIGHT, new HighlightCtor(...ranges));
    else registry.delete(HIGHLIGHT);
  });
}

function setQuoteRanges(region: Element, ranges: Range[]): void {
  if (ranges.length === 0 && !quoteRanges.has(region)) return;
  if (ranges.length === 0) quoteRanges.delete(region);
  else quoteRanges.set(region, ranges);
  scheduleSync(region.ownerDocument);
}

// --- a region's quotes ---

/** A quote's 💬, where it goes in its region (its padding box). */
interface QuoteMark {
  cid: string;
  left: number;
  top: number;
}

function sameMarks(a: readonly QuoteMark[], b: readonly QuoteMark[]): boolean {
  return (
    a.length === b.length &&
    a.every((mark, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        mark.cid === other.cid &&
        mark.left === other.left &&
        mark.top === other.top
      );
    })
  );
}

/** The quotes the comments on `region`'s bubble are on (DR-0062 §12, P31):
 * found again in what the bubble draws now (§2), highlighted, and a 💬 after
 * the last line of each, in a layer of its own over the region. The layer
 * holds no text (each 💬 is a CSS label with an aria-label), so what the
 * bubble draws, the search and a choice are as they were. Found again when
 * the region changes size or what it draws changes (a translation tab, a
 * drawing that comes late). A quote not found has no mark, and its comment is
 * reported lost (the 💬 filter says so). Pressing a 💬 goes to the 💬 filter
 * with that comment selected. */
export function QuoteMarks({ region, target }: { region: Element; target: CommentTarget }) {
  const comments = useContext(TimelineCommentsContext);
  const position = useContext(TimelinePositionContext)?.position ?? "head";
  const records = comments?.records;
  const report = comments?.reportLost;
  // What the bubble is, as plain values: the target is a new object each
  // render of the item.
  const { anchor } = target;
  const onCid = anchor.kind === "comment" ? anchor.cid : undefined;
  const onUuid = anchor.kind === "comment" ? undefined : anchor.uuid;
  const onStart = anchor.kind === "comment" ? undefined : anchor.msg_start_with;
  const quotes = useMemo(
    () => (records === undefined ? [] : quotesOn(records, quoteTargetOf(onCid, onUuid, onStart))),
    [records, onCid, onUuid, onStart],
  );
  const [marks, setMarks] = useState<QuoteMark[]>([]);
  const layerRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    const doc = region.ownerDocument;
    let scheduled = false;
    let gone = false;
    const place = () => {
      scheduled = false;
      if (gone) return;
      const drawn = drawnTextOf(region);
      const box = region.getBoundingClientRect();
      const found: QuoteMark[] = [];
      const ranges: Range[] = [];
      const lost: string[] = [];
      for (const { cid, quote } of quotes) {
        const at = findQuote(drawn.text, quote);
        const range = at === null ? null : rangeIn(drawn, at.start, at.end);
        if (range === null) {
          lost.push(cid);
          continue;
        }
        ranges.push(range);
        const last = boxesOf(range).at(-1);
        found.push({
          cid,
          left: last === undefined ? 0 : Math.round(last.right - box.left - region.clientLeft),
          top:
            last === undefined
              ? 0
              : Math.round(last.top + last.height / 2 - box.top - region.clientTop),
        });
      }
      setQuoteRanges(region, ranges);
      setMarks((before) => (sameMarks(before, found) ? before : found));
      report?.(region, lost);
    };
    const schedule = () => {
      if (scheduled) return;
      scheduled = true;
      queueMicrotask(place);
    };
    place();
    const win = doc.defaultView;
    const resized =
      quotes.length === 0 || win?.ResizeObserver === undefined
        ? null
        : new win.ResizeObserver(() => schedule());
    resized?.observe(region);
    // The marks' own layer changes with them: not a change of what is drawn.
    const changed =
      quotes.length === 0 || win?.MutationObserver === undefined
        ? null
        : new win.MutationObserver((changes) => {
            const layer = layerRef.current;
            if (changes.some((change) => layer === null || !layer.contains(change.target))) {
              schedule();
            }
          });
    changed?.observe(region, { subtree: true, childList: true, characterData: true });
    return () => {
      gone = true;
      resized?.disconnect();
      changed?.disconnect();
      setQuoteRanges(region, []);
      report?.(region, null);
    };
  }, [region, quotes, report]);
  if (comments === null || quotes.length === 0) return null;
  return (
    <div class="tl-comment-quote-marks" ref={layerRef}>
      {marks.map((mark) => (
        <a
          key={mark.cid}
          class="tl-comment-quote-mark"
          href={timelineHref(comments.sid, position, "comment")}
          aria-label={`コメント ${mark.cid} — 押すとこのコメントを 💬 のフィルタで表示`}
          title={`コメント ${mark.cid}`}
          style={{ left: `${String(mark.left)}px`, top: `${String(mark.top)}px` }}
          onClick={() => comments.select(commentSelectionKey(mark.cid))}
        />
      ))}
    </div>
  );
}

// --- the 💬 beside a choice (DR-0062 §3) ---

/** The button's side: a finger's press on a phone (as Apple's guidance has
 * it, 44 points). */
const BUTTON_SIZE = 44;

/** A choice made in a region, and the comment form it would open. */
interface Chosen {
  form: CommentTarget;
  region: Element;
  range: Range;
}

/** The region `node` is in: the nearest element of it registered. */
function regionOf(node: Node, regions: WeakMap<Element, CommentTarget>): Element | null {
  for (let at: Node | null = node; at !== null; at = at.parentNode) {
    if (at instanceof Element && regions.has(at)) return at;
  }
  return null;
}

let choiceSeq = 0;

/** What the selection of `doc` chooses in a region, and the form of a comment
 * on it (DR-0062 §2): a quote in a message, or in a comment (a cid's). The
 * form's key is the choice's own, so each choice opens a new form. Null when
 * the selection is in no region or chooses nothing it draws. */
function chosenIn(doc: Document, regions: WeakMap<Element, CommentTarget>): Chosen | null {
  const selection = doc.getSelection();
  if (selection === null || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const region = regionOf(range.commonAncestorContainer, regions);
  const target = region === null ? undefined : regions.get(region);
  if (region === null || target === undefined) return null;
  const drawn = drawnTextOf(region);
  const choice = choiceIn(
    drawn.text,
    offsetAt(drawn, range.startContainer, range.startOffset),
    offsetAt(drawn, range.endContainer, range.endOffset),
  );
  if (choice === null) return null;
  const quote = {
    text: choice.text,
    before: choice.before,
    after: choice.after,
    start: choice.start,
    end: choice.end,
  };
  const { anchor } = target;
  choiceSeq += 1;
  const key = `${target.key}#${String(choiceSeq)}`;
  switch (anchor.kind) {
    case "message":
      return {
        form: {
          key,
          anchor: {
            kind: "selection",
            uuid: anchor.uuid,
            msg_start_with: anchor.msg_start_with,
            ...quote,
          },
        },
        region,
        range: range.cloneRange(),
      };
    case "comment":
      return {
        form: { key, anchor: { kind: "comment", cid: anchor.cid, ...quote } },
        region,
        range: range.cloneRange(),
      };
    case "selection":
      return null;
  }
}

/** What of the Timeline is seen: its scroller under its toolbar, within what
 * the screen shows (the keyboard of a phone takes the rest). */
function seenOf(region: Element): Box {
  const win = region.ownerDocument.defaultView;
  const viewport = win?.visualViewport;
  const scroller = region.closest(".timeline-view");
  const box = scroller?.getBoundingClientRect();
  const toolbar = scroller?.querySelector(".tl-toolbar")?.getBoundingClientRect();
  const top = viewport?.offsetTop ?? 0;
  const bottom = top + (viewport?.height ?? win?.innerHeight ?? 0);
  return {
    top: Math.max(toolbar?.bottom ?? box?.top ?? top, top),
    bottom: Math.min(box?.bottom ?? bottom, bottom),
    left: box?.left ?? 0,
    right: box?.right ?? 0,
  };
}

/** What floats over the bottom right of the Timeline, shown: the session's
 * input button and panel, and the comment form. */
const FLOATING = ".session-input-fab, .session-input-panel, .tl-comment-float";

function floatingBoxes(doc: Document): DOMRect[] {
  return Array.from(doc.querySelectorAll(FLOATING), (el) => el.getBoundingClientRect()).filter(
    (box) => box.width > 0 && box.height > 0,
  );
}

/** Puts `button` at (`left`, `top`) of the page: it is position: fixed, whose
 * box may be another element's (#app is, by contain: layout), so where it
 * lands is read back and the difference taken off. */
function putAt(button: HTMLElement, left: number, top: number): void {
  button.style.left = `${String(left)}px`;
  button.style.top = `${String(top)}px`;
  const landed = button.getBoundingClientRect();
  button.style.left = `${String(2 * left - landed.left)}px`;
  button.style.top = `${String(2 * top - landed.top)}px`;
}

/** The 💬 beside a choice made in a bubble that can be commented on (DR-0062
 * §3, kawaz 2026-11-23): pressing it opens the comment form on the quote. It
 * is in the band at the right of the item, outside the bubble, at the middle
 * of the choice's height (choiceButtonPlace), so the system's menu of the
 * choice and its handles leave it seen; it is put again at once as the
 * choice changes, the Timeline scrolls and the screen changes size.
 *
 * Design rationale: placed by script from the choice's boxes, not by CSS
 * anchor positioning, which anchors to elements and not to a Range.
 *
 * Pressing it keeps the choice: its pointerdown takes no default (the press
 * moves no focus nor selection where it can), and while it is pressed a
 * change of the selection (a phone's tap clears it first) does not take it
 * away. The quote is the one read when the choice was made, so the press
 * uses it whatever the selection is by then. */
export function SelectionToolbar() {
  const comments = useContext(TimelineCommentsContext);
  const regions = comments?.regions;
  const openForm = comments?.openForm;
  const [chosen, setChosen] = useState<Chosen | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const pressing = useRef(false);

  const place = useEffectEvent(() => {
    const button = buttonRef.current;
    if (button === null || chosen === null) return;
    const item = chosen.region.closest(".tl-item") ?? chosen.region;
    const at = choiceButtonPlace({
      choice: boxesOf(chosen.range),
      item: item.getBoundingClientRect(),
      seen: seenOf(chosen.region),
      floating: floatingBoxes(chosen.region.ownerDocument),
      size: BUTTON_SIZE,
    });
    button.style.visibility = at === null ? "hidden" : "";
    if (at !== null) putAt(button, at.left, at.top);
  });

  useEffect(() => {
    if (regions === undefined) return;
    const doc = document;
    const read = () => {
      if (pressing.current) return;
      setChosen(chosenIn(doc, regions));
    };
    const released = () => {
      pressing.current = false;
    };
    const viewport = doc.defaultView?.visualViewport;
    doc.addEventListener("selectionchange", read);
    doc.addEventListener("scroll", place, true);
    doc.addEventListener("pointerup", released, true);
    doc.addEventListener("pointercancel", released, true);
    doc.defaultView?.addEventListener("resize", place);
    viewport?.addEventListener("resize", place);
    viewport?.addEventListener("scroll", place);
    return () => {
      doc.removeEventListener("selectionchange", read);
      doc.removeEventListener("scroll", place, true);
      doc.removeEventListener("pointerup", released, true);
      doc.removeEventListener("pointercancel", released, true);
      doc.defaultView?.removeEventListener("resize", place);
      viewport?.removeEventListener("resize", place);
      viewport?.removeEventListener("scroll", place);
    };
  }, [regions]);
  useLayoutEffect(() => place(), [chosen]);

  if (chosen === null || openForm === undefined) return null;
  return (
    <button
      type="button"
      ref={buttonRef}
      class="tl-comment-choice"
      aria-label="選んだ箇所にコメントする"
      title="選んだ箇所にコメントする"
      aria-haspopup="dialog"
      onPointerDown={(event) => {
        event.preventDefault();
        pressing.current = true;
      }}
      onClick={() => {
        pressing.current = false;
        openForm(chosen.form, null);
      }}
    />
  );
}
