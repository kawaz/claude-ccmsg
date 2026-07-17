// SessionView Files-tab body: FileTree + resizable Splitter + FileViewer.
// Split out of SessionView.tsx so the pane-split state (ratio) lives with
// the panes rather than the tab shell — SessionView itself stays a
// stateless dispatch between Files/Timeline. The ratio is axis-agnostic
// (see utils.paneRatioFromPointer): the same fraction drives both the
// desktop side-by-side (flex-direction: row) and the ≤720px stack
// (flex-direction: column, CSS media query in app.css), so a user who
// dragged the desktop split to 40/60 keeps a 40/60 top/bottom split when
// they rotate to portrait — the CSS flex-direction swap is the only thing
// that changes. The splitter is drag-only: pane fold buttons were removed
// per kawaz (no demand for hiding the viewer; the twin ◀/▶ affordance
// read as noise).
import { useEffect, useRef, useState } from "preact/hooks";
import type { PeerInfo } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { fileHref } from "../locator.ts";
import {
  clampPaneRatio,
  errorMessage,
  fileAncestorDirectories,
  paneRatioFromPointer,
  SESSION_PANE_DEFAULT_RATIO,
} from "../utils.ts";
import { FileTree } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { PaneSplitter } from "./PaneSplitter.tsx";

// Persisted alongside Sidebar's ccmsg.peerSortKey (see Sidebar.tsx).
const PANE_RATIO_STORAGE = "ccmsg.sessionPaneRatio";

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

export function FilesPanes({
  sid,
  tree,
  peer,
  externalFiles,
}: {
  sid: string;
  tree: SessionTreeState;
  peer: PeerInfo | undefined;
  /** DR-0024 transcript-derived absolute paths, already allowlisted by daemon. */
  externalFiles: readonly string[];
}) {
  const { store, ws } = useApp();
  const [ratio, setRatio] = useState<number>(loadPaneRatio);
  // The memo editor is a view mode spanning both panes: FileTree launches it,
  // FileViewer renders it, and a successful save reloads the matching tree
  // directory before navigating to the created file. FilesPanes is therefore
  // the narrowest owner that can coordinate the transition without putting
  // network/navigation effects in the reducer (the same component-effect
  // boundary used by FileTree/FileViewer for fs_list/fs_read).
  const [memoEditorOpen, setMemoEditorOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Persist on change (drag settles). Effect over "save inside the
  // handler" so the save reflects the state React actually committed,
  // not the closure-captured value of the handler.
  useEffect(() => {
    savePaneRatio(ratio);
  }, [ratio]);

  // A draft is intentionally ephemeral: switching session or selecting a
  // different file exits the editor without confirmation. Opening the editor
  // itself does not change selectedPath, so this effect does not immediately
  // undo the launch action.
  useEffect(() => {
    setMemoEditorOpen(false);
  }, [sid, tree.selectedPath]);

  async function onMemoCreated(createdPath: string): Promise<void> {
    // fs_write may have created docs/ and inbox/ as well as the file. Refresh
    // every affected listing so an already-cached empty ancestor does not hide
    // the new path; the response path is root-relative, matching fs_list.
    await Promise.all(
      fileAncestorDirectories(createdPath).map(async (dirPath) => {
        try {
          const res = await ws.fsList(sid, dirPath);
          if (res.ok) {
            store.dispatch({ type: "fs/dir-loaded", sid, path: dirPath, entries: res.entries });
          } else {
            store.dispatch({ type: "fs/dir-loaded", sid, path: dirPath, error: res.error.msg });
          }
        } catch (err) {
          store.dispatch({ type: "fs/dir-loaded", sid, path: dirPath, error: errorMessage(err) });
        }
      }),
    );
    setMemoEditorOpen(false);
    location.assign(fileHref(sid, createdPath));
  }

  // Drag plumbing lives in the shared PaneSplitter (kawaz r26 mid=76) — this
  // callback only owns the layout interpretation. Which axis to measure comes
  // from the container's own computed flex-direction — desktop row layout
  // uses clientX / rect.left / .width, mobile column layout uses clientY /
  // rect.top / .height. Reading getComputedStyle lets the CSS @media query in
  // app.css stay the source of truth for the breakpoint (no duplicate
  // window.matchMedia check here).
  const onSplitterDrag = (e: PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const isVertical = getComputedStyle(container).flexDirection === "column";
    const rect = container.getBoundingClientRect();
    const next = isVertical
      ? paneRatioFromPointer(e.clientY, rect.top, rect.height)
      : paneRatioFromPointer(e.clientX, rect.left, rect.width);
    setRatio(next);
  };

  // Style: tree pane gets a flex-basis derived from the ratio, viewer
  // gets flex:1 to fill the remainder.
  const treeStyle = { flex: `0 0 ${(ratio * 100).toFixed(4)}%` };

  return (
    <div class="session-panes" ref={containerRef}>
      <div class="session-pane session-pane-tree" style={treeStyle}>
        <FileTree
          sid={sid}
          tree={tree}
          peer={peer}
          externalFiles={externalFiles}
          onNewMemo={() => setMemoEditorOpen(true)}
        />
      </div>
      <PaneSplitter class="session-splitter" ariaOrientation="vertical" onDrag={onSplitterDrag} />
      <div class="session-pane session-pane-viewer" style={{ flex: "1 1 auto" }}>
        <FileViewer
          sid={sid}
          tree={tree}
          memoEditorOpen={memoEditorOpen}
          onMemoCancel={() => setMemoEditorOpen(false)}
          onMemoCreated={onMemoCreated}
        />
      </div>
    </div>
  );
}
