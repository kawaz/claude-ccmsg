// Lazy-loading directory tree for SessionView (DR-0008). Directories fetch
// their listing (fs_list) the first time they're expanded and the result is
// cached in state.sessionTrees[sid].dirs, so re-collapsing/re-expanding never
// re-fetches. This file owns the fs_list round trip; the reducer only stores
// what it's told (DR-0005 §1: effects in components, not the reducer).
import type { FsEntry, PeerInfo } from "@ccmsg/protocol";
import { useEffect, useRef } from "preact/hooks";
import type { Store } from "../useStore.ts";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { fileHref } from "../locator.ts";
import type { WsHandle } from "../ws.ts";
import { errorMessage, ownWorkspaceSegment, repoRootLabel } from "../utils.ts";

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** fs_list round trip for one directory, shared by DirNode's click-to-expand
 * and FileTree's auto-expand-own-workspace effect below — both just need
 * "dispatch the loaded entries or error", differing only in when they call
 * it. Kept out of the reducer per DR-0005 §1 (effects live in components). */
function loadDir(store: Store, ws: WsHandle, sid: string, path: string): void {
  void ws
    .fsList(sid, path)
    .then((res) => {
      if (res.ok) store.dispatch({ type: "fs/dir-loaded", sid, path, entries: res.entries });
      else store.dispatch({ type: "fs/dir-loaded", sid, path, error: res.error.msg });
    })
    // A rejection here (e.g. the socket dropped/hasn't opened yet, see
    // ws.ts send()) must still resolve the "loading…" placeholder above
    // into something the user can act on, same as an ok:false reply.
    .catch((err) => {
      store.dispatch({ type: "fs/dir-loaded", sid, path, error: errorMessage(err) });
    });
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
  ownWsPath,
}: {
  sid: string;
  path: string;
  name: string;
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
  ownWsPath: string | null;
}) {
  const { store, ws } = useApp();
  const expanded = tree.expanded.has(path);
  const entries = tree.dirs.get(path);
  const error = tree.dirErrors.get(path);
  const isOwnWs = ownWsPath !== null && path === ownWsPath;

  function toggle() {
    store.dispatch({ type: "fs/dir-toggled", sid, path });
    if (!expanded && entries === undefined) loadDir(store, ws, sid, path);
  }

  return (
    <li>
      <button
        type="button"
        class={"tree-row tree-dir" + (isOwnWs ? " tree-own-ws" : "")}
        style={{ paddingLeft: `${depth}rem` }}
        onClick={toggle}
        // DR-0008 addendum: marks the session's own workspace/worktree dir
        // when the tree root has been widened to the repo container — a
        // hint distinct from tree-selected (which tracks the open file).
        title={isOwnWs ? "このセッションのワークスペース" : undefined}
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
              ownWsPath={ownWsPath}
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
  ownWsPath,
}: {
  sid: string;
  parentPath: string;
  entries: FsEntry[];
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
  ownWsPath: string | null;
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
              ownWsPath={ownWsPath}
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

export function FileTree({
  sid,
  tree,
  peer,
}: {
  sid: string;
  tree: SessionTreeState;
  /** Peer record for `sid`, as seen in state.peers — carries repo_root/cwd
   * for the DR-0008-addendum root label + own-workspace auto-expand below.
   * Undefined for a sid that hasn't shown up in a peers/loaded response yet
   * (same fallback posture as SessionView's hasTranscript lookup). */
  peer: PeerInfo | undefined;
}) {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store).connStatus;
  const rootEntries = tree.dirs.get("");
  const rootError = tree.dirErrors.get("");
  const rootLabel = peer ? repoRootLabel(peer) : null;
  const ownWsPath = peer ? ownWorkspaceSegment(peer) : null;

  // Root listing loads eagerly on mount / session switch — everything below
  // it is lazy, click-driven (see DirNode.toggle above). Gated on connStatus
  // so a direct `#s<sid>` link opened before the WS handshake completes
  // doesn't race ws.send() (which synchronously rejects while the socket
  // isn't open, see ws.ts): the effect just waits, and re-evaluates once
  // connStatus flips to "connected" since it's in the dep list. Still
  // per-tree idle-gated (rootEntries/rootError both undefined) so a
  // reconnect after a successful/failed load never refetches.
  useEffect(() => {
    if (rootEntries !== undefined || rootError !== undefined) return;
    if (connStatus !== "connected") return;
    void ws
      .fsList(sid)
      .then((res) => {
        if (res.ok) store.dispatch({ type: "fs/dir-loaded", sid, path: "", entries: res.entries });
        else store.dispatch({ type: "fs/dir-loaded", sid, path: "", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "fs/dir-loaded", sid, path: "", error: errorMessage(err) });
      });
  }, [sid, rootEntries, rootError, connStatus]);

  // DR-0008 addendum: once the (now possibly repo-container-wide) root is
  // loaded, auto-expand the session's own workspace/worktree dir so the
  // tree doesn't open on an undifferentiated list of sibling workspaces.
  //
  // Idempotency can't be keyed off `tree.expanded.has(ownWsPath)`: toggling a
  // dir *removes* it from `expanded` (see the `fs/dir-toggled` reducer), so a
  // user collapsing their own workspace made this effect's dep (`tree.expanded`)
  // change and re-fire, reading `has(ownWsPath)` as false again and forcing it
  // back open — the user's collapse could never stick. Instead, remember (per
  // sid) that auto-expand has already run at all — attempted once, never again,
  // regardless of what the user does to `expanded` afterward.
  const autoExpandedForSid = useRef<string | null>(null);
  useEffect(() => {
    if (!ownWsPath || rootEntries === undefined) return;
    if (autoExpandedForSid.current === sid) return;
    const isDir = rootEntries.some((e) => e.name === ownWsPath && e.type === "dir");
    if (!isDir) return;
    autoExpandedForSid.current = sid;
    if (!tree.expanded.has(ownWsPath))
      store.dispatch({ type: "fs/dir-toggled", sid, path: ownWsPath });
    if (tree.dirs.get(ownWsPath) === undefined) loadDir(store, ws, sid, ownWsPath);
  }, [sid, ownWsPath, rootEntries]);

  return (
    <div class="file-tree">
      {rootLabel ? (
        <p class="tree-root-label" title={peer?.repo_root}>
          {rootLabel}
        </p>
      ) : null}
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
            ownWsPath={ownWsPath}
          />
        </ul>
      )}
    </div>
  );
}
