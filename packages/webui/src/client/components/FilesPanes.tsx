// SessionView Files-tab body: FileTree + resizable Splitter + FileViewer.
// Split out of SessionView.tsx so the pane-split state (ratio) lives with
// the panes rather than the tab shell — SessionView itself stays a
// stateless dispatch between Files/Timeline. The two panes sit side by side
// at every width (kawaz 2026-11-23: 狭い幅でもサイドバーと同じ左右の並び),
// so the ratio is the tree's share of the container's width. The splitter is
// drag-only; the tree is hidden and shown by the ☰ at the left of the
// session's header (SessionPaneToggle), and hidden by the button under it
// (PaneHideButton).
import { useEffect, useRef, useState } from "preact/hooks";
import type { PeerInfo, TouchedFile, WorkspaceFolder } from "@ccmsg/protocol";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { fileHref } from "../locator.ts";
import { replaceNavigation } from "../navigation.ts";
import { canonicalViewerPath, paneRatioFromPointer, parsePaneRatio } from "../utils.ts";
import { filesLayout } from "../files-sections.ts";
import { FileTree } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { PaneHideButton } from "./PaneTreeToggle.tsx";
import { FileCommentFormFloat } from "./FileComments.tsx";
import { readLayoutStorage, writeLayoutStorage } from "../storage.ts";

// Persisted alongside Sidebar's ccmsg.peerSortKey (see Sidebar.tsx).
const PANE_RATIO_STORAGE = "ccmsg.sessionPaneRatio";

function loadPaneRatio(): number {
  return parsePaneRatio(readLayoutStorage(PANE_RATIO_STORAGE));
}

function savePaneRatio(ratio: number): void {
  writeLayoutStorage(PANE_RATIO_STORAGE, String(ratio));
}

export function FilesPanes({
  sid,
  tree,
  peer,
  touchedFiles,
  workspaceFolders,
}: {
  sid: string;
  tree: SessionTreeState;
  peer: PeerInfo | undefined;
  /** DR-0024 files the transcript says the session touched (session_status
   * touched_files), each carrying the origin the tree filters them by. */
  touchedFiles: readonly TouchedFile[];
  /** DR-0026 `.code-workspace` folders published on session_status; drives
   * both the FileTree "ワークスペース" section and FileViewer's fs_read_workspace
   * routing (an absolute path inside any allowlisted folder uses workspace ops
   * rather than fs_read_external) — except the folder at the cwd, whose files
   * both panes address through the containment root (`filesLayout`). */
  workspaceFolders: readonly WorkspaceFolder[];
}) {
  const { store } = useApp();
  const [ratio, setRatio] = useState<number>(loadPaneRatio);
  // 消す / 出すのはセッションのヘッダの ☰ (SessionPaneToggle)。消すのは hidden
  // だけで FileTree は残す (開いたディレクトリとスクロール位置を保つ)。
  const treeOpen = useStoreState(store, (s) => s.paneTreesOpen.files);
  const containerRef = useRef<HTMLDivElement>(null);

  // FilesPanes owns which spelling the two panes address, so an in-project
  // absolute selection is rebased to the root-relative form here rather than in
  // each pane (see `canonicalViewerPath` for why it would otherwise 403).
  const layout = filesLayout(peer, workspaceFolders);
  const selectedPath = tree.selectedPath;
  // A `~/` selection (a home-relative link) expands with the daemon's home,
  // which arrives with the handshake's ping reply.
  const home = useStoreState(store, (s) => s.daemonInfo?.home);
  const canonicalPath =
    selectedPath === null
      ? null
      : canonicalViewerPath(selectedPath, layout.containmentRoot, layout.routed, home);
  // Replace rather than push: the absolute spelling is the same destination,
  // so it should not cost a back-button step.
  const selectedLineRange = tree.selectedLineRange;
  const selectedFrom = tree.selectedFrom;
  const selectedSection = tree.selectedSection;
  useEffect(() => {
    if (canonicalPath === null || canonicalPath === selectedPath) return;
    replaceNavigation(
      fileHref(sid, canonicalPath, {
        lineRange: selectedLineRange,
        from: selectedFrom,
        section: selectedSection,
        // Not in the store: the place inside the file is the URL's own.
        fragment: location.hash.slice(1),
      }),
    );
  }, [sid, selectedPath, canonicalPath, selectedLineRange, selectedFrom, selectedSection]);
  // Panes read the canonical spelling immediately, so the doomed external read
  // never fires while the URL replacement is still in flight.
  const paneTree = canonicalPath === selectedPath ? tree : { ...tree, selectedPath: canonicalPath };

  // Drag plumbing lives in the shared PaneSplitter (kawaz r26 mid=76) — this
  // callback only owns the layout interpretation: the tree pane is at the
  // container's left edge, so the ratio is measured from there.
  const onSplitterDrag = (e: PointerEvent) => {
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    const next = paneRatioFromPointer(e.clientX, rect.left, rect.width);
    setRatio(next);
    // 書くのは人がスプリッターを動かした時だけ (storage.ts の「レイアウト寸法」:
    // 動かしていない窓は何も書かず、最後にどこかの窓で使った値か既定を引き続ける)。
    savePaneRatio(next);
  };

  // Style: tree pane gets a flex-basis derived from the ratio, viewer gets
  // the remainder from a zero basis. The tree may shrink so the viewer keeps
  // its floor (app.css --pane-body-min); the zero basis keeps a viewer with
  // wide content from taking the tree's room otherwise.
  const treeStyle = { flex: `0 1 ${(ratio * 100).toFixed(4)}%` };

  return (
    <div class="session-panes" ref={containerRef}>
      <div class="session-pane session-pane-tree" style={treeStyle} hidden={!treeOpen}>
        {/* Keyed by the favorites root (the session's cwd, "" until the peer
         * is known): FileTree reads that root's favorites once at mount. */}
        <FileTree
          key={peer ? peer.cwd : ""}
          sid={sid}
          tree={paneTree}
          peer={peer}
          touchedFiles={touchedFiles}
          layout={layout}
        />
        <PaneHideButton pane="files" />
      </div>
      {treeOpen ? (
        <PaneSplitter class="session-splitter" ariaOrientation="vertical" onDrag={onSplitterDrag} />
      ) : null}
      <div class="session-pane session-pane-viewer" style={{ flex: "1 1 0" }}>
        <FileViewer sid={sid} tree={paneTree} peer={peer} workspaceFolders={layout.routed} />
      </div>
      <FileCommentFormFloat sid={sid} />
    </div>
  );
}
