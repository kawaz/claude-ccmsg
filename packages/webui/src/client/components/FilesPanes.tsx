// SessionView Files-tab body: FileTree + resizable Splitter + FileViewer.
// Split out of SessionView.tsx so the pane-split state (ratio + which pane
// is folded) lives with the panes rather than the tab shell — SessionView
// itself stays a stateless dispatch between Files/Timeline. The ratio is
// axis-agnostic (see utils.paneRatioFromPointer): the same fraction drives
// both the desktop side-by-side (flex-direction: row) and the ≤720px stack
// (flex-direction: column, CSS media query in app.css), so a user who
// dragged the desktop split to 40/60 keeps a 40/60 top/bottom split when
// they rotate to portrait — the CSS flex-direction swap is the only thing
// that changes.
import { useEffect, useRef, useState } from "preact/hooks";
import type { PeerInfo } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import {
  clampPaneRatio,
  parsePaneCollapse,
  paneRatioFromPointer,
  SESSION_PANE_DEFAULT_RATIO,
  togglePaneCollapse,
  type PaneCollapse,
} from "../utils.ts";
import { FileTree } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";

// Persisted alongside Sidebar's ccmsg.peerSortKey (see Sidebar.tsx). Two
// separate keys instead of one JSON blob because they change on
// independent user actions (drag vs button click) — a single-blob save
// would rewrite both on every drag pointermove otherwise.
const PANE_RATIO_STORAGE = "ccmsg.sessionPaneRatio";
const PANE_COLLAPSE_STORAGE = "ccmsg.sessionPaneCollapse";

function loadPaneRatio(): number {
  try {
    const raw = localStorage.getItem(PANE_RATIO_STORAGE);
    if (raw !== null) return clampPaneRatio(Number.parseFloat(raw));
  } catch {
    // storage unavailable (private mode) — fall through to default
  }
  return SESSION_PANE_DEFAULT_RATIO;
}

function savePaneRatio(ratio: number): void {
  try {
    localStorage.setItem(PANE_RATIO_STORAGE, String(ratio));
  } catch {
    // storage unavailable — splitter still works, just doesn't persist
  }
}

function loadPaneCollapse(): PaneCollapse {
  try {
    return parsePaneCollapse(localStorage.getItem(PANE_COLLAPSE_STORAGE));
  } catch {
    return "none";
  }
}

function savePaneCollapse(state: PaneCollapse): void {
  try {
    localStorage.setItem(PANE_COLLAPSE_STORAGE, state);
  } catch {
    // storage unavailable — same rationale as savePaneRatio
  }
}

export function FilesPanes({
  sid,
  tree,
  peer,
}: {
  sid: string;
  tree: SessionTreeState;
  peer: PeerInfo | undefined;
}) {
  const [ratio, setRatio] = useState<number>(loadPaneRatio);
  const [collapse, setCollapse] = useState<PaneCollapse>(loadPaneCollapse);
  const containerRef = useRef<HTMLDivElement>(null);
  // Ref (not state) because pointer-drag state doesn't need to trigger
  // re-renders — only the ratio it produces does. Kept in sync via the
  // pointerdown/up handlers rather than a useState pair.
  const draggingRef = useRef(false);

  // Persist on change (drag settles, fold button clicked). Effect over
  // "save inside the handler" so the save reflects the state React
  // actually committed, not the closure-captured value of the handler.
  useEffect(() => {
    savePaneRatio(ratio);
  }, [ratio]);
  useEffect(() => {
    savePaneCollapse(collapse);
  }, [collapse]);

  const onSplitterPointerDown = (e: PointerEvent) => {
    // Never enter drag mode when a pane is folded — the splitter still
    // renders (as a restore affordance) but the ratio isn't visible so
    // dragging it would move an invisible boundary. The fold buttons
    // stopPropagation their own pointerdown, so this only fires for a
    // grab on the splitter bar proper.
    if (collapse !== "none") return;
    if (!containerRef.current) return;
    draggingRef.current = true;
    // Pointer capture keeps pointermove/pointerup coming even after the
    // pointer leaves the splitter's own hitbox — otherwise a fast drag
    // out into the FileTree would strand the splitter mid-move. Handles
    // mouse and touch through the same pointer-events pipeline.
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
  };

  const onSplitterPointerMove = (e: PointerEvent) => {
    if (!draggingRef.current) return;
    const container = containerRef.current;
    if (!container) return;
    // Which axis to measure comes from the container's own computed
    // flex-direction — desktop row layout uses clientX / rect.left /
    // .width, mobile column layout uses clientY / rect.top / .height.
    // Reading getComputedStyle lets the CSS @media query in app.css
    // stay the source of truth for the breakpoint (no duplicate
    // window.matchMedia check here).
    const isVertical = getComputedStyle(container).flexDirection === "column";
    const rect = container.getBoundingClientRect();
    const next = isVertical
      ? paneRatioFromPointer(e.clientY, rect.top, rect.height)
      : paneRatioFromPointer(e.clientX, rect.left, rect.width);
    setRatio(next);
  };

  const onSplitterPointerUp = (e: PointerEvent) => {
    if (!draggingRef.current) return;
    draggingRef.current = false;
    (e.currentTarget as Element).releasePointerCapture(e.pointerId);
  };

  // Style: tree pane gets a flex-basis derived from the ratio, viewer
  // gets flex:1 to fill the remainder. When a pane is folded, its
  // flex-basis collapses to 0 and CSS hides its overflow — kept in
  // inline style rather than a full second class per state to keep the
  // ratio driving the value in one place.
  const treeStyle =
    collapse === "tree"
      ? { flex: "0 0 0px" }
      : collapse === "viewer"
        ? { flex: "1 1 auto" }
        : { flex: `0 0 ${(ratio * 100).toFixed(4)}%` };
  const viewerStyle =
    collapse === "viewer"
      ? { flex: "0 0 0px" }
      : collapse === "tree"
        ? { flex: "1 1 auto" }
        : { flex: "1 1 auto" };

  return (
    <div class={`session-panes collapse-${collapse}`} ref={containerRef}>
      <div class="session-pane session-pane-tree" style={treeStyle}>
        <FileTree sid={sid} tree={tree} peer={peer} />
      </div>
      <div
        class={`session-splitter${collapse !== "none" ? " session-splitter-folded" : ""}`}
        role="separator"
        aria-orientation="vertical"
        onPointerDown={onSplitterPointerDown}
        onPointerMove={onSplitterPointerMove}
        onPointerUp={onSplitterPointerUp}
        onPointerCancel={onSplitterPointerUp}
      >
        {/* Fold buttons: two buttons instead of one so their meaning
         * stays local ("hide THIS pane" / "restore THIS pane"), no
         * inference from surrounding state required. Wrapped in a
         * pointerdown-stopper so a click on the button never opens the
         * drag mode of the splitter behind it. The ◀/▶ glyphs stay as
         * left/right arrows on both layouts — on the ≤720px column
         * layout app.css only re-anchors the two buttons horizontally
         * (left instead of top) so they sit side-by-side across the
         * 4px-tall bar; the glyphs themselves aren't rotated (the
         * button labels' title/aria-label carry the "hide/restore"
         * meaning independently of the arrow direction). The pointer
         * axis IS rotated: getComputedStyle().flexDirection above
         * picks clientY vs clientX to follow the CSS flex direction. */}
        <button
          type="button"
          class="session-splitter-btn session-splitter-btn-tree"
          title={collapse === "tree" ? "ツリーを展開" : "ツリーを隠す"}
          aria-label={collapse === "tree" ? "ツリーを展開" : "ツリーを隠す"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapse((c) => togglePaneCollapse(c, "tree"))}
        >
          {collapse === "tree" ? "▶" : "◀"}
        </button>
        <button
          type="button"
          class="session-splitter-btn session-splitter-btn-viewer"
          title={collapse === "viewer" ? "ビューアを展開" : "ビューアを隠す"}
          aria-label={collapse === "viewer" ? "ビューアを展開" : "ビューアを隠す"}
          onPointerDown={(e) => e.stopPropagation()}
          onClick={() => setCollapse((c) => togglePaneCollapse(c, "viewer"))}
        >
          {collapse === "viewer" ? "◀" : "▶"}
        </button>
      </div>
      <div class="session-pane session-pane-viewer" style={viewerStyle}>
        <FileViewer sid={sid} tree={tree} />
      </div>
    </div>
  );
}
