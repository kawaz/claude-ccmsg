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
import type { ExternalFile, PeerInfo, WorkspaceFolder } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { fileHref } from "../locator.ts";
import { pushNavigation, replaceNavigation } from "../navigation.ts";
import {
  canonicalViewerPath,
  clampPaneRatio,
  fileAncestorDirectories,
  paneRatioFromPointer,
  SESSION_PANE_DEFAULT_RATIO,
} from "../utils.ts";
import { FileTree, loadDir } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { paneAxisMetrics, readPaneAxis } from "../pane-axis.ts";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { readLayoutStorage, writeLayoutStorage } from "../storage.ts";

// Persisted alongside Sidebar's ccmsg.peerSortKey (see Sidebar.tsx).
const PANE_RATIO_STORAGE = "ccmsg.sessionPaneRatio";

function loadPaneRatio(): number {
  const raw = readLayoutStorage(PANE_RATIO_STORAGE);
  if (raw !== null) return clampPaneRatio(Number.parseFloat(raw));
  return SESSION_PANE_DEFAULT_RATIO;
}

function savePaneRatio(ratio: number): void {
  writeLayoutStorage(PANE_RATIO_STORAGE, String(ratio));
}

export function FilesPanes({
  sid,
  tree,
  peer,
  externalFiles,
  workspaceFolders,
}: {
  sid: string;
  tree: SessionTreeState;
  peer: PeerInfo | undefined;
  /** DR-0024 transcript-derived absolute paths, already allowlisted by daemon,
   * each carrying the origin the tree groups them by. */
  externalFiles: readonly ExternalFile[];
  /** DR-0026 `.code-workspace` folders published on session_status; drives
   * both the FileTree "ワークスペース" section and FileViewer's fs_read_workspace
   * routing (an absolute path inside any allowlisted folder uses workspace ops
   * rather than fs_read_external). */
  workspaceFolders: readonly WorkspaceFolder[];
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

  // FilesPanes owns which spelling the two panes address, so an in-project
  // absolute selection is rebased to the root-relative form here rather than in
  // each pane (see `canonicalViewerPath` for why it would otherwise 403).
  const selectedPath = tree.selectedPath;
  const canonicalPath =
    selectedPath === null
      ? null
      : canonicalViewerPath(selectedPath, peer?.repo_root ?? peer?.cwd, workspaceFolders);
  // Replace rather than push: the absolute spelling is the same destination,
  // so it should not cost a back-button step.
  useEffect(() => {
    if (canonicalPath === null || canonicalPath === selectedPath) return;
    replaceNavigation(
      fileHref(
        sid,
        canonicalPath,
        tree.selectedLineRange ?? undefined,
        tree.selectedFrom ?? undefined,
      ),
    );
  }, [sid, selectedPath, canonicalPath]);
  // Panes read the canonical spelling immediately, so the doomed external read
  // never fires while the URL replacement is still in flight.
  const paneTree = canonicalPath === selectedPath ? tree : { ...tree, selectedPath: canonicalPath };

  async function onMemoCreated(createdPath: string): Promise<void> {
    // fs_write may have created docs/ and inbox/ as well as the file. Refresh
    // every affected listing so an already-cached empty ancestor does not hide
    // the new path; the response path is root-relative, matching fs_list.
    await Promise.all(
      fileAncestorDirectories(createdPath).map((dirPath) => loadDir(store, ws, sid, dirPath)),
    );
    setMemoEditorOpen(false);
    pushNavigation(fileHref(sid, createdPath));
  }

  // Drag plumbing lives in the shared PaneSplitter (kawaz r26 mid=76) — this
  // callback only owns the layout interpretation, and even the axis comes from
  // the container's own computed flex-direction (pane-axis.ts), so the CSS
  // @media query in app.css stays the source of truth for the breakpoint.
  // The tree pane is at the near end on both axes, so the ratio is always
  // measured from the container's start edge.
  const onSplitterDrag = (e: PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const m = paneAxisMetrics(readPaneAxis(container), container.getBoundingClientRect(), e);
    setRatio(paneRatioFromPointer(m.pointer, m.start, m.size));
  };

  // Style: tree pane gets a flex-basis derived from the ratio, viewer
  // gets flex:1 to fill the remainder.
  const treeStyle = { flex: `0 0 ${(ratio * 100).toFixed(4)}%` };

  return (
    <div class="session-panes" ref={containerRef}>
      <div class="session-pane session-pane-tree" style={treeStyle}>
        <FileTree
          sid={sid}
          tree={paneTree}
          peer={peer}
          externalFiles={externalFiles}
          workspaceFolders={workspaceFolders}
          onNewMemo={() => setMemoEditorOpen(true)}
        />
      </div>
      <PaneSplitter class="session-splitter" ariaOrientation="vertical" onDrag={onSplitterDrag} />
      <div class="session-pane session-pane-viewer" style={{ flex: "1 1 auto" }}>
        <FileViewer
          sid={sid}
          tree={paneTree}
          peer={peer}
          workspaceFolders={workspaceFolders}
          memoEditorOpen={memoEditorOpen}
          onMemoCancel={() => setMemoEditorOpen(false)}
          onMemoCreated={onMemoCreated}
        />
      </div>
    </div>
  );
}
