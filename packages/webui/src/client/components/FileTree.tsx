// Lazy-loading directory tree for SessionView (DR-0008). Directories fetch
// their listing (fs_list) the first time they're expanded and the result is
// cached in state.sessionTrees[sid].dirs, so re-collapsing/re-expanding never
// re-fetches. This file owns the fs_list round trip; the reducer only stores
// what it's told (DR-0005 §1: effects in components, not the reducer).
import type { FsEntry } from "@ccmsg/protocol";
import { useEffect } from "preact/hooks";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { fileHref } from "../locator.ts";

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

// Directories first, then everything else, alphabetical within each group —
// the ordering every conventional file-manager / editor tree uses.
function sortEntries(entries: FsEntry[]): FsEntry[] {
  return [...entries].sort((a, b) => {
    const rank = (e: FsEntry) => (e.type === "dir" ? 0 : 1);
    const r = rank(a) - rank(b);
    return r !== 0 ? r : a.name.localeCompare(b.name);
  });
}

function DirNode({
  sid,
  path,
  name,
  depth,
  tree,
  selectedPath,
}: {
  sid: string;
  path: string;
  name: string;
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
}) {
  const { store, ws } = useApp();
  const expanded = tree.expanded.has(path);
  const entries = tree.dirs.get(path);
  const error = tree.dirErrors.get(path);

  function toggle() {
    store.dispatch({ type: "fs/dir-toggled", sid, path });
    if (!expanded && entries === undefined) {
      void ws.fsList(sid, path).then((res) => {
        if (res.ok) store.dispatch({ type: "fs/dir-loaded", sid, path, entries: res.entries });
        else store.dispatch({ type: "fs/dir-loaded", sid, path, error: res.error.msg });
      });
    }
  }

  return (
    <li>
      <button
        type="button"
        class="tree-row tree-dir"
        style={{ paddingLeft: `${depth}rem` }}
        onClick={toggle}
      >
        <span class="tree-caret">{expanded ? "▾" : "▸"}</span> {name}
      </button>
      {expanded ? (
        <ul class="tree-children">
          {error ? (
            <li class="tree-error" style={{ paddingLeft: `${depth + 1}rem` }}>
              {error}
            </li>
          ) : entries === undefined ? (
            <li class="tree-loading" style={{ paddingLeft: `${depth + 1}rem` }}>
              loading…
            </li>
          ) : (
            <Nodes
              sid={sid}
              parentPath={path}
              entries={entries}
              depth={depth + 1}
              tree={tree}
              selectedPath={selectedPath}
            />
          )}
        </ul>
      ) : null}
    </li>
  );
}

function FileNode({
  sid,
  path,
  name,
  depth,
  selected,
  symlink,
}: {
  sid: string;
  path: string;
  name: string;
  depth: number;
  selected: boolean;
  symlink: boolean;
}) {
  // Judgment call (DR-0008): fs_list reports type "symlink" for the link
  // itself and never resolves whether the target is a file or a directory
  // (see FsEntry doc comment in @ccmsg/protocol). Rather than guess with a
  // second op, every symlink is treated as file-navigable here; if it
  // actually points at a directory, fs_read's error response surfaces in
  // FileViewer same as any other read failure.
  return (
    <li>
      <a
        class={
          "tree-row tree-file" +
          (selected ? " tree-selected" : "") +
          (symlink ? " tree-symlink" : "")
        }
        style={{ paddingLeft: `${depth}rem` }}
        href={fileHref(sid, path)}
      >
        {name}
      </a>
    </li>
  );
}

function Nodes({
  sid,
  parentPath,
  entries,
  depth,
  tree,
  selectedPath,
}: {
  sid: string;
  parentPath: string;
  entries: FsEntry[];
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
}) {
  return (
    <>
      {sortEntries(entries).map((entry) => {
        const path = joinPath(parentPath, entry.name);
        if (entry.type === "dir") {
          return (
            <DirNode
              key={path}
              sid={sid}
              path={path}
              name={entry.name}
              depth={depth}
              tree={tree}
              selectedPath={selectedPath}
            />
          );
        }
        if (entry.type === "other") {
          return (
            <li key={path}>
              <span class="tree-row tree-other" style={{ paddingLeft: `${depth}rem` }}>
                {entry.name}
              </span>
            </li>
          );
        }
        return (
          <FileNode
            key={path}
            sid={sid}
            path={path}
            name={entry.name}
            depth={depth}
            selected={selectedPath === path}
            symlink={entry.type === "symlink"}
          />
        );
      })}
    </>
  );
}

export function FileTree({ sid, tree }: { sid: string; tree: SessionTreeState }) {
  const { store, ws } = useApp();
  const rootEntries = tree.dirs.get("");
  const rootError = tree.dirErrors.get("");

  // Root listing loads eagerly on mount / session switch — everything below
  // it is lazy, click-driven (see DirNode.toggle above).
  useEffect(() => {
    if (rootEntries !== undefined || rootError !== undefined) return;
    void ws.fsList(sid).then((res) => {
      if (res.ok) store.dispatch({ type: "fs/dir-loaded", sid, path: "", entries: res.entries });
      else store.dispatch({ type: "fs/dir-loaded", sid, path: "", error: res.error.msg });
    });
  }, [sid, rootEntries, rootError]);

  return (
    <div class="file-tree">
      {rootError ? (
        <p class="tree-error">{rootError}</p>
      ) : rootEntries === undefined ? (
        <p class="tree-loading">loading…</p>
      ) : (
        <ul class="tree-root">
          <Nodes
            sid={sid}
            parentPath=""
            entries={rootEntries}
            depth={0}
            tree={tree}
            selectedPath={tree.selectedPath}
          />
        </ul>
      )}
    </div>
  );
}
