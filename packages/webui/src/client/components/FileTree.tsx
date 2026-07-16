// Lazy-loading directory tree for SessionView (DR-0008). Directories fetch
// their listing (fs_list) the first time they're expanded and the result is
// cached in state.sessionTrees[sid].dirs, so re-collapsing/re-expanding never
// re-fetches. This file owns the fs_list round trip; the reducer only stores
// what it's told (DR-0005 §1: effects in components, not the reducer).
import type { FsEntry, PeerInfo } from "@ccmsg/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { fileIconKind, FileTypeIcon } from "./FileIcon.tsx";
import type { Store } from "../useStore.ts";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { fileHref } from "../locator.ts";
import type { WsHandle } from "../ws.ts";
import {
  errorMessage,
  favoritesStorageKey,
  ownWorkspaceSegment,
  parseFavorites,
  repoRootLabel,
  sortFavorites,
  toggleFavorite,
  workspaceRootEntries,
} from "../utils.ts";

function joinPath(parent: string, name: string): string {
  return parent ? `${parent}/${name}` : name;
}

/** Favorites persistence I/O (localStorage read/write) — kept here as the
 * component-side counterpart to the pure logic in utils.ts (parseFavorites/
 * toggleFavorite/sortFavorites), same split FilesPanes.tsx uses for its pane
 * ratio (loadPaneRatio/savePaneRatio there vs clampPaneRatio in utils.ts):
 * localStorage access is an effect, not something a pure function should do,
 * per DR-0005 §1. */
function loadFavorites(root: string): string[] {
  try {
    return parseFavorites(localStorage.getItem(favoritesStorageKey(root)));
  } catch {
    // storage unavailable (private mode) — behave as if nothing's favorited
    return [];
  }
}

function saveFavorites(root: string, favorites: string[]): void {
  try {
    localStorage.setItem(favoritesStorageKey(root), JSON.stringify(favorites));
  } catch {
    // storage unavailable — favoriting still works for the session, just
    // doesn't persist across reload
  }
}

/** Star toggle button shared by DirNode/FileNode rows and the favorites
 * section (same rows, so a favorited path shows as ★ in both places at
 * once — they share the same `favorites` Set from FileTree). Rendered as a
 * sibling of the row's own button/link (not nested inside it — a `<button>`
 * inside a `<button>`, or inside an `<a>`, is invalid HTML and would also
 * complicate click-target separation) so its own onClick never needs to
 * fight the row's toggle/navigate handler; stopPropagation is still added
 * defensively per the task's explicit ask. `null` `onToggle` (rather than
 * omitting the button) is intentionally never used — FileTree simply doesn't
 * render the tree at all when favorites are disabled (see its `favorites ===
 * null` check), so every row that mounts always has a real handler. */
function FavoriteToggle({
  path,
  favorited,
  onToggle,
}: {
  path: string;
  favorited: boolean;
  onToggle: (path: string) => void;
}) {
  return (
    <button
      type="button"
      class="tree-fav-toggle"
      // 32px-ish hit target on touch (padding, not visual size — the glyph
      // itself stays small per the task's "視覚は小さく" ask) via CSS.
      onClick={(e) => {
        e.stopPropagation();
        onToggle(path);
      }}
      aria-label={favorited ? `${path} をお気に入りから外す` : `${path} をお気に入りに追加`}
      title={favorited ? "お気に入りから外す" : "お気に入りに追加"}
    >
      {favorited ? "★" : "☆"}
    </button>
  );
}

/** Threaded down every tree row so it can render its own FavoriteToggle;
 * `null` end-to-end (from FileTree) means favorites are disabled for this
 * session (see FileTree's doc comment on why) and no row renders the
 * button at all. */
interface FavContext {
  favorites: Set<string>;
  onToggle: (path: string) => void;
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
  fav,
}: {
  sid: string;
  path: string;
  name: string;
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
  ownWsPath: string | null;
  fav: FavContext | null;
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
      <div class="tree-row-line">
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
          <span class="tree-caret">{expanded ? "▾" : "▸"}</span>
          <FileTypeIcon kind={fileIconKind(name, "dir", expanded)} />
          {name}
        </button>
        {fav ? (
          <FavoriteToggle path={path} favorited={fav.favorites.has(path)} onToggle={fav.onToggle} />
        ) : null}
      </div>
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
              fav={fav}
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
  fav,
}: {
  sid: string;
  path: string;
  name: string;
  depth: number;
  selected: boolean;
  symlink: boolean;
  fav: FavContext | null;
}) {
  // Judgment call (DR-0008): fs_list reports type "symlink" for the link
  // itself and never resolves whether the target is a file or a directory
  // (see FsEntry doc comment in @ccmsg/protocol). Rather than guess with a
  // second op, every symlink is treated as file-navigable here; if it
  // actually points at a directory, fs_read's error response surfaces in
  // FileViewer same as any other read failure.
  return (
    <li>
      <div class="tree-row-line">
        <a
          class={
            "tree-row tree-file" +
            (selected ? " tree-selected" : "") +
            (symlink ? " tree-symlink" : "")
          }
          style={{ paddingLeft: `${depth}rem` }}
          href={fileHref(sid, path)}
        >
          {/* Empty same-width spacer so file names line up with dir names,
           * which have a real ▸/▾ caret occupying this space (kawaz ask:
           * "caret 幅と整合させる"). */}
          <span class="tree-caret" aria-hidden="true" />
          <FileTypeIcon kind={fileIconKind(name, symlink ? "symlink" : "file")} />
          {name}
        </a>
        {fav ? (
          <FavoriteToggle path={path} favorited={fav.favorites.has(path)} onToggle={fav.onToggle} />
        ) : null}
      </div>
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
  fav,
  sorted = false,
}: {
  sid: string;
  parentPath: string;
  entries: FsEntry[];
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
  ownWsPath: string | null;
  fav: FavContext | null;
  /** Skips the directories-first/alphabetical sortEntries pass — set by
   * FileTree's repo-container-root ws list, which has already ordered
   * `entries` itself (own workspace pinned first, see workspaceRootEntries)
   * and would otherwise have that ordering undone by sortEntries' plain
   * alphabetical pass. Every recursive Nodes call from inside DirNode omits
   * this (defaults false), so every level below the root still sorts the
   * conventional way. */
  sorted?: boolean;
}) {
  const ordered = sorted ? entries : sortEntries(entries);
  return (
    <>
      {ordered.map((entry) => {
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
              fav={fav}
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
            fav={fav}
          />
        );
      })}
    </>
  );
}

/** Best-effort dir-vs-file classification for a favorited path, used only by
 * the favorites section (rows *inside* the normal tree already know their
 * own type from the fs_list entry that produced them). Favorites persist as
 * plain path strings (see utils.ts's favoritesStorageKey doc comment), not
 * `{path, type}` pairs, so the type has to be re-derived from whatever the
 * tree already knows:
 * 1. If `path` itself has cached dir-listing state (tree.dirs/dirErrors/
 *    expanded all key on directory paths), it's definitely a directory.
 * 2. Else, look it up by name in its parent's cached listing — the common
 *    case, since favoriting a row happens while that row's parent is
 *    expanded (i.e. cached) at that moment.
 * 3. Otherwise unknown (e.g. right after a page reload, before the user has
 *    re-browsed to it this session) — default to "file". This mirrors
 *    FileNode's existing symlink-ambiguity fallback above: a wrongly-guessed
 *    file just shows FileViewer's normal fs_read-error state instead of
 *    opening, no crash either way. */
function favoriteEntryKind(
  path: string,
  tree: SessionTreeState,
): { kind: "dir" | "file"; symlink: boolean } {
  if (tree.dirs.has(path) || tree.dirErrors.has(path) || tree.expanded.has(path)) {
    return { kind: "dir", symlink: false };
  }
  const slash = path.lastIndexOf("/");
  const parentPath = slash < 0 ? "" : path.slice(0, slash);
  const baseName = slash < 0 ? path : path.slice(slash + 1);
  const entry = tree.dirs.get(parentPath)?.find((e) => e.name === baseName);
  if (entry)
    return { kind: entry.type === "dir" ? "dir" : "file", symlink: entry.type === "symlink" };
  return { kind: "file", symlink: false };
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

  // Favorites (U-fav): keyed on peer.repo_root ?? peer.cwd (kawaz), so every
  // session/tab open on the same project shares one favorites list. `peer`
  // undefined means the daemon hasn't told us this sid's cwd yet at all — the
  // key would be undefined too, so favorites stay off (`favRoot === null`)
  // rather than briefly keying on nothing and losing/overwriting the real
  // list once `peer` arrives. State lives here (useState + localStorage
  // effect), not the reducer, per DR-0005 §1 — same split as FilesPanes'
  // pane-ratio persistence, which this mirrors deliberately.
  const favRoot = peer ? (peer.repo_root ?? peer.cwd) : null;
  const [favorites, setFavorites] = useState<string[]>([]);

  useEffect(() => {
    setFavorites(favRoot ? loadFavorites(favRoot) : []);
  }, [favRoot]);

  useEffect(() => {
    if (favRoot) saveFavorites(favRoot, favorites);
  }, [favRoot, favorites]);

  const onToggleFavorite = (path: string) => setFavorites((prev) => toggleFavorite(prev, path));
  const fav: FavContext | null = favRoot
    ? { favorites: new Set(favorites), onToggle: onToggleFavorite }
    : null;
  const sortedFavorites = sortFavorites(favorites);

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
      {/* Favorites section (U-fav): only shown once ≥1 path is favorited —
       * an empty section would just be two separator lines with nothing
       * between them. Each favorite renders through the same DirNode/
       * FileNode components the main tree uses, at depth 0 with its full
       * relative path as the display name (rather than just the basename),
       * so expand state / lazy-load / selection-highlight / the ★ toggle
       * itself all come for free — `path` doubles as both `tree.dirs`/
       * `tree.expanded` key and displayed name here. A favorited directory
       * therefore shares expand/collapse state with the *same* directory
       * reachable via the normal tree below (both key off the identical
       * path) — collapsing it in one place collapses it in the other too.
       * This is an accepted, documented behavior, not a bug: keeping two
       * independent expand states for the same path would need a second
       * `SessionTreeState` namespace for no real benefit. */}
      {sortedFavorites.length > 0 ? (
        <>
          <p class="tree-section-label">お気に入り</p>
          <ul class="tree-root tree-favorites">
            {sortedFavorites.map((path) => {
              const { kind, symlink } = favoriteEntryKind(path, tree);
              return kind === "dir" ? (
                <DirNode
                  key={path}
                  sid={sid}
                  path={path}
                  name={path}
                  depth={0}
                  tree={tree}
                  selectedPath={tree.selectedPath}
                  ownWsPath={ownWsPath}
                  fav={fav}
                />
              ) : (
                <FileNode
                  key={path}
                  sid={sid}
                  path={path}
                  name={path}
                  depth={0}
                  selected={tree.selectedPath === path}
                  symlink={symlink}
                  fav={fav}
                />
              );
            })}
          </ul>
          <p class="tree-section-label">プロジェクト</p>
        </>
      ) : null}
      {rootError ? (
        <p class="tree-error">{rootError}</p>
      ) : rootEntries === undefined ? (
        <p class="tree-loading">loading…</p>
      ) : (
        <ul class="tree-root">
          {/* DR-0008 addendum session (rootLabel !== null, tree root widened
           * to the repo container): show only the ws/wt directories at this
           * level (kawaz 2026-07-12), own workspace pinned first — the raw
           * container listing (.git/.jj/dotfiles/other ws) doesn't appear
           * here once `peer` (state.peers) has arrived, only inside an
           * opened ws's own subtree. Filtering keys off `peer`, not the
           * fs_list result itself: a direct `#s<sid>` link can have the
           * fs_list("") response land before the (separately-driven, see
           * ws.ts's peers request in onOpen) peers/loaded dispatch, in which
           * case `rootLabel` is still null here and this one paint shows the
           * unfiltered listing — self-corrects on the next render once
           * `peer` arrives (adversarial review minor: known, accepted as
           * cosmetic — fixing the race would mean gating the root fs_list
           * effect on peers too, which delays every session's tree for a
           * property only repo_root sessions use). A session with no
           * repo_root (rootLabel === null) keeps the unfiltered cwd listing
           * permanently, unchanged from before this task. */}
          <Nodes
            sid={sid}
            parentPath=""
            entries={
              rootLabel !== null ? workspaceRootEntries(rootEntries, ownWsPath) : rootEntries
            }
            depth={0}
            tree={tree}
            selectedPath={tree.selectedPath}
            ownWsPath={ownWsPath}
            fav={fav}
            sorted={rootLabel !== null}
          />
        </ul>
      )}
    </div>
  );
}
