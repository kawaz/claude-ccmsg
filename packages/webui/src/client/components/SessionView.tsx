// Top-level "session" screen (DR-0008): FileTree pane + FileViewer pane for
// browsing a connected session's cwd. Selected via the `#s<sid>[:<path>]`
// locator (App.tsx routes here instead of RoomView when state.view === "session").
import type { AppState, SessionTreeState } from "../store.ts";
import { FileTree } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";

const EMPTY_TREE: SessionTreeState = {
  dirs: new Map(),
  dirErrors: new Map(),
  expanded: new Set(),
  selectedPath: null,
  file: null,
};

export function SessionView({ state }: { state: AppState }) {
  const sid = state.currentSid;

  if (!sid) {
    return (
      <main id="session-view">
        <p id="empty-state">session を選んでください</p>
      </main>
    );
  }

  // The reducer always creates a tree on the locator/changed that sets
  // currentSid, so this fallback is type-safety only, never hit in practice.
  const tree = state.sessionTrees.get(sid) ?? EMPTY_TREE;

  return (
    <main id="session-view">
      <div class="session-panes">
        <FileTree sid={sid} tree={tree} />
        <FileViewer sid={sid} tree={tree} />
      </div>
    </main>
  );
}
