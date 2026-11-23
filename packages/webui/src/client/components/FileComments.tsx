// Comments on a quote in a file the Files tab shows (DR-0062 §2, §3, §12,
// P20, P26, P31): the 💬 beside a choice made in the file's source or its
// markdown preview (FileChoiceButton), the comments on it found again in what
// the file holds now, highlighted, with a 💬 after each (FileQuoteMarks), and
// the comment form while one on a file is open (FileCommentFormFloat).
//
// What a view draws for a quote: the source's is the file's content, one
// `.viewer-line` a line (its `.viewer-text`; the line numbers are not read);
// the preview's is the joined text of the markdown drawn (as a Timeline
// bubble's, comment-quotes.tsx), each block marked with its lines in the
// source (MarkdownView's `sourceLines`).
//
// The read view only: the 編集 mode (TextFileEditor) is another component,
// whose text is the person's unsaved one, so no comment is made there.
import { useContext, useLayoutEffect, useMemo, useRef, useState } from "preact/hooks";
import { urlWithRememberedTimelinePosition } from "../navigation.ts";
import { timelineHref } from "../locator.ts";
import type { CommentRecord, FileAnchor } from "@ccmsg/protocol";
import { choiceButtonPlace, type Box } from "../comment-quote.ts";
import { commentSelectionKey } from "../comment-view.ts";
import {
  findPreviewQuote,
  findSourceQuote,
  lineStartsOf,
  previewQuoteOf,
  sourceQuoteOf,
  type PreviewPiece,
} from "../file-comment.ts";
import { mdSourceLinesOf } from "../md-source-lines.ts";
import { scrollBehaviorFor } from "../scroll-motion.ts";
import { useStoreState } from "../useStore.ts";
import { useApp } from "../context.ts";
import { CommentFormFloatOf } from "./timeline/comments.tsx";
import { SessionCommentsContext } from "./timeline/comment-context.ts";
import {
  boxesOf,
  BUTTON_SIZE,
  CHOICE_BAR_HEIGHT,
  ChoiceButton,
  drawnTextOfAll,
  floatingBoxes,
  offsetAt,
  rangeIn,
  sameMarks,
  setQuoteRanges,
  type DrawnText,
  type QuoteMark,
} from "./timeline/comment-quotes.tsx";

export type FileView = FileAnchor["view"];

const NO_RECORDS: ReadonlyMap<string, CommentRecord> = new Map();

/** The session's comments, as the store holds them. */
function useSessionRecords(sid: string): ReadonlyMap<string, CommentRecord> {
  const { store } = useApp();
  return useStoreState(store, (s) => s.comments.get(sid)) ?? NO_RECORDS;
}

/** What the source view `region` (the viewer's `<pre>`) draws: the file's
 * `content`, each line's text nodes at their place in it. */
function sourceDrawnOf(region: Element, content: string): DrawnText {
  const starts = lineStartsOf(content);
  const pieces: DrawnText["pieces"] = [];
  const lines = region.querySelectorAll(":scope > .viewer-line > .viewer-text");
  lines.forEach((line, index) => {
    let at = starts[index];
    if (at === undefined) return;
    const walker = region.ownerDocument.createTreeWalker(line, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (!(node instanceof Text)) continue;
      pieces.push({ node, start: at });
      at += node.data.length;
    }
  });
  return { text: content, pieces };
}

/** The pieces of a preview's drawn text with the lines in the source of the
 * innermost block each is in (mdSourceLinesOf). A piece in no block is left
 * out. */
function previewPiecesOf(region: Element, drawn: DrawnText): PreviewPiece[] {
  const pieces: PreviewPiece[] = [];
  for (const piece of drawn.pieces) {
    const lines = mdSourceLinesOf(piece.node, region);
    if (lines !== null) pieces.push({ start: piece.start, ...lines });
  }
  return pieces;
}

/** What `region` (the `view` of the file `content`) draws, and where a
 * quote kept of it is in that now. */
function viewOf(
  region: Element,
  view: FileView,
  content: string,
): {
  drawn: DrawnText;
  find: (anchor: FileAnchor) => { start: number; end: number } | null;
  quoteOf: (start: number, end: number) => ReturnType<typeof sourceQuoteOf>;
} {
  if (view === "source") {
    const drawn = sourceDrawnOf(region, content);
    return {
      drawn,
      find: (anchor) => findSourceQuote(content, anchor),
      quoteOf: (start, end) => sourceQuoteOf(content, start, end),
    };
  }
  const drawn = drawnTextOfAll(region);
  const pieces = previewPiecesOf(region, drawn);
  return {
    drawn,
    find: (anchor) => findPreviewQuote(drawn.text, pieces, anchor),
    quoteOf: (start, end) => previewQuoteOf(drawn.text, start, end, pieces, content),
  };
}

/** Where on the page a quote's 💬 goes (P31): in the preview, the top right
 * corner of the quote's last line (in the gap between the lines, as in a
 * Timeline bubble); in the source, whose lines have no gap between them,
 * after the end of the text of the quote's last line, on that line (it hides
 * no character of the file). Null when the quote has no box. */
function markPlaceOf(view: FileView, range: Range): { left: number; top: number } | null {
  const last = boxesOf(range).at(-1);
  if (last === undefined) return null;
  if (view === "preview") return { left: last.right, top: last.top };
  const lineText = range.endContainer.parentElement
    ?.closest(".viewer-line")
    ?.querySelector(".viewer-text")
    ?.getBoundingClientRect();
  return { left: Math.max(last.right, lineText?.right ?? last.right), top: last.top };
}

/** The comments on the file `path` (as a comment names it) made in `view`. */
function quotesOnFile(
  records: ReadonlyMap<string, CommentRecord>,
  path: string,
  view: FileView,
): Array<{ cid: string; anchor: FileAnchor }> {
  const quotes: Array<{ cid: string; anchor: FileAnchor }> = [];
  for (const record of records.values()) {
    if (record.author !== "user") continue;
    const { anchor } = record;
    if (anchor.kind === "file" && anchor.path === path && anchor.view === view) {
      quotes.push({ cid: record.cid, anchor });
    }
  }
  return quotes;
}

/** The comments on the file `path` shown as `view` in `region` (DR-0062 §12,
 * P20, P31): found again by their characters in what the file holds now,
 * highlighted (the one `ccmsg-comment` highlight the Timeline's quotes are
 * painted with), and a 💬 at the top right corner of the last line of each,
 * in a layer of its own in the region that holds no text. Found again when
 * the region changes size or what it draws changes (the source's coloring
 * that comes late, the search's marks, a fold opened). A comment not found
 * has no mark, and the 💬 filter says its place is gone. Pressing a 💬 goes
 * to the 💬 filter with that comment selected. The comment Files is asked to
 * show (「コメントした場所へ」) is brought into view once found, a short
 * smooth move (the person asked for it). */
export function FileQuoteMarks({
  sid,
  region,
  view,
  content,
  path,
}: {
  sid: string;
  region: Element;
  view: FileView;
  content: string;
  path: string;
}) {
  const host = useContext(SessionCommentsContext);
  const records = useSessionRecords(sid);
  const quotes = useMemo(() => quotesOnFile(records, path, view), [records, path, view]);
  const [marks, setMarks] = useState<QuoteMark[]>([]);
  const layerRef = useRef<HTMLDivElement | null>(null);
  const report = host?.reportLostFile;
  const reveal = host?.reveal ?? null;
  const revealFile = host?.revealFile;
  useLayoutEffect(() => {
    const doc = region.ownerDocument;
    let scheduled = false;
    let gone = false;
    const place = () => {
      scheduled = false;
      if (gone) return;
      const { drawn, find } = viewOf(region, view, content);
      const box = region.getBoundingClientRect();
      const found: QuoteMark[] = [];
      const ranges: Range[] = [];
      const lost: string[] = [];
      for (const { cid, anchor } of quotes) {
        const at = find(anchor);
        const range = at === null ? null : rangeIn(drawn, at.start, at.end);
        if (range === null) {
          lost.push(cid);
          continue;
        }
        ranges.push(range);
        // A quote in a folded section of the preview is not drawn: no mark.
        const holder = range.startContainer.parentElement;
        if (holder?.checkVisibility?.() !== false) {
          const at = markPlaceOf(view, range);
          // The layer scrolls with what the region holds.
          found.push({
            cid,
            left:
              at === null
                ? 0
                : Math.round(at.left - box.left - region.clientLeft + region.scrollLeft),
            top:
              at === null ? 0 : Math.round(at.top - box.top - region.clientTop + region.scrollTop),
          });
        }
        if (reveal?.value === cid) {
          revealFile?.(null);
          range.startContainer.parentElement?.scrollIntoView({
            block: "center",
            behavior: scrollBehaviorFor("user"),
          });
        }
      }
      if (reveal !== null && lost.includes(reveal.value)) revealFile?.(null);
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
    changed?.observe(region, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["open"],
    });
    return () => {
      gone = true;
      resized?.disconnect();
      changed?.disconnect();
      setQuoteRanges(region, []);
      report?.(region, null);
    };
  }, [region, view, content, quotes, report, reveal, revealFile]);
  if (host === null || quotes.length === 0) return null;
  return (
    <div
      class={`tl-comment-quote-marks${view === "source" ? " file-quote-marks-line" : ""}`}
      ref={layerRef}
    >
      {marks.map((mark) => (
        <a
          key={mark.cid}
          class="tl-comment-quote-mark"
          href={urlWithRememberedTimelinePosition(timelineHref(sid, "head", "comment"), sid)}
          aria-label={`コメント ${mark.cid} — 押すとこのコメントを 💬 のフィルタで表示`}
          title={`コメント ${mark.cid}`}
          style={{
            left: `${String(mark.left)}px`,
            top: `${String(mark.top)}px`,
          }}
          onClick={() => host.select(commentSelectionKey(mark.cid))}
        />
      ))}
    </div>
  );
}

/** What of `region` is seen: within the viewer's scroller under its header,
 * within what the screen shows (the keyboard of a phone takes the rest). */
function seenOf(region: Element): Box {
  const win = region.ownerDocument.defaultView;
  const viewport = win?.visualViewport;
  const scroller = region.closest(".file-viewer");
  const box = scroller?.getBoundingClientRect();
  const header = scroller?.querySelector(".viewer-header")?.getBoundingClientRect();
  const own = region.getBoundingClientRect();
  const top = viewport?.offsetTop ?? 0;
  const bottom = top + (viewport?.height ?? win?.innerHeight ?? 0);
  return {
    top: Math.max(header?.bottom ?? box?.top ?? top, own.top, top),
    bottom: Math.min(box?.bottom ?? bottom, own.bottom, bottom),
    left: own.left,
    right: own.right,
  };
}

/** The inner box of `region` that holds its text: its right end inside the
 * viewer's scroller and before a scroll bar of its own. */
function textBoxOf(region: Element): Box {
  const own = region.getBoundingClientRect();
  const scroller = region.closest(".file-viewer");
  const scrollerRight =
    scroller === null
      ? own.right
      : scroller.getBoundingClientRect().left + scroller.clientLeft + scroller.clientWidth;
  const right = Math.min(own.left + region.clientLeft + region.clientWidth, scrollerRight);
  return { top: own.top, bottom: own.bottom, left: own.left, right };
}

/** A choice made in a file's view, and the quote a comment on it is on. */
interface FileChosen {
  range: Range;
  quote: NonNullable<ReturnType<typeof sourceQuoteOf>>;
}

let fileChoiceSeq = 0;

/** The 💬 beside a choice made in the file `path` shown as `view` in
 * `region` (DR-0062 §3, P9): pressing it opens the comment form on the quote
 * (a quote in a file: its path, the view, the text and what is around it, its
 * lines and column). A file has no bubble, so the button is over the right
 * end of the view's text, at the middle of the choice's height as in the
 * Timeline (the system's menu of the choice is above or below it, and its
 * handles at its ends), off what floats over the tab (the session's input,
 * the comment form) and off the text chosen: a choice that reaches the right
 * end there (a line filled to the end, a phone's narrow preview) has it at
 * the nearest place above or below it in that column. */
export function FileChoiceButton({
  region,
  view,
  content,
  path,
}: {
  region: Element;
  view: FileView;
  content: string;
  path: string;
}) {
  const host = useContext(SessionCommentsContext);
  if (host === null) return null;
  const { openForm } = host;
  return (
    <ChoiceButton<FileChosen>
      read={() => {
        const selection = region.ownerDocument.getSelection();
        if (selection === null || selection.isCollapsed || selection.rangeCount === 0) {
          return null;
        }
        const range = selection.getRangeAt(0);
        if (!region.contains(range.commonAncestorContainer)) return null;
        const { drawn, quoteOf } = viewOf(region, view, content);
        const quote = quoteOf(
          offsetAt(drawn, range.startContainer, range.startOffset),
          offsetAt(drawn, range.endContainer, range.endOffset),
        );
        return quote === null ? null : { range: range.cloneRange(), quote };
      }}
      place={(chosen) => {
        const text = textBoxOf(region);
        const choice = boxesOf(chosen.range);
        return choiceButtonPlace({
          choice,
          item: text,
          bubble: text,
          seen: seenOf(region),
          // Over the text, the button keeps off the text chosen too.
          avoid: [...floatingBoxes(region.ownerDocument), ...choice],
          size: BUTTON_SIZE,
          height: CHOICE_BAR_HEIGHT,
        });
      }}
      press={(chosen, btw) => {
        fileChoiceSeq += 1;
        openForm(
          {
            key: `f:${path}#${String(fileChoiceSeq)}`,
            anchor: { kind: "file", path, view, ...chosen.quote },
            btw,
          },
          null,
        );
      }}
    />
  );
}

/** The comment form while one on a file is open (DR-0062 §3): over the Files
 * tab, as the Timeline's is over the Timeline. */
export function FileCommentFormFloat({ sid }: { sid: string }) {
  const host = useContext(SessionCommentsContext);
  const records = useSessionRecords(sid);
  const form = host?.form ?? null;
  if (host === null || form === null || form.target.anchor.kind !== "file") return null;
  return <CommentFormFloatOf sid={sid} form={form} records={records} onClose={host.closeForm} />;
}
