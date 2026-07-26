// Lazy-loading directory tree for SessionView (DR-0008). Directories fetch
// their listing (fs_list) the first time they're expanded and the result is
// cached in state.sessionTrees[sid].dirs, so re-collapsing/re-expanding never
// re-fetches. DR-0024 adds transcript-observed external files using the client
// convention `path.startsWith("/")`: existing tree keys are root-relative and
// never start with `/`, so external favorites/selections cannot collide. This
// file owns the fs_list round trip; the reducer only stores what it's told
// (DR-0005 §1: effects in components, not the reducer).
import type { FsEntry, PeerInfo, WorkspaceFolder } from "@ccmsg/protocol";
import { useEffect, useRef, useState } from "preact/hooks";
import { fileIconKind, FileTypeIcon } from "./FileIcon.tsx";
import { FileSearchPanel } from "./FileSearchPanel.tsx";
import type { Store } from "../useStore.ts";
import type { SessionTreeState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { fileHref } from "../locator.ts";
import type { WsHandle } from "../ws.ts";
import {
  errorMessage,
  favoritesStorageKey,
  isWorkspaceFilePath,
  parseFavorites,
  sortExternalFiles,
  sortFavorites,
  toggleFavorite,
  treeRootPath,
} from "../utils.ts";
import { readStorage, writeStorage } from "../storage.ts";

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
  return parseFavorites(readStorage(favoritesStorageKey(root)));
}

function saveFavorites(root: string, favorites: string[]): void {
  writeStorage(favoritesStorageKey(root), JSON.stringify(favorites));
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
export function FavoriteToggle({
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
export interface FavContext {
  favorites: Set<string>;
  onToggle: (path: string) => void;
}

/** Threaded down every DirNode so it can render its own "+ 新規" affordance
 * and, when this DirNode is the target of an active create, the inline input
 * row. Only one directory hosts a live input at a time; `activePath` is that
 * directory's key (matches DirNode.path exactly — root-relative for contained,
 * absolute for workspace/favorited dirs).
 *
 * The kind passed through determines which authorization surface fs_create
 * uses on the daemon side — mirrors loadDir's own workspace/contained branch
 * (isWorkspaceFilePath). External favorites are files not directories, so no
 * DirNode ever receives kind="external"; the union stays two-valued here. */
interface CreateContext {
  activePath: string | null;
  errorMsg: string | null;
  submitting: boolean;
  onStart: (dirPath: string, kind: "contained" | "workspace") => void;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}

/** Threaded down to every FileNode so it can render its own delete button
 * (visible only when the row is selected — the affordance is meant to be
 * discoverable but not always-on, mirroring the "select then act" pattern
 * kawaz asked for at r46 m25). External files (transcript-observed absolute
 * paths outside the containment surfaces fs_delete supports) get a null
 * context and no button. Confirmation lives in the callback (window.confirm
 * with the target path), never in the daemon — the daemon has no
 * confirmation channel. */
interface DeleteContext {
  onDelete: (filePath: string) => void;
}

/** fs_list round trip for one directory, shared by DirNode's click-to-expand,
 * FileTree's own root/auto-expand effects, and FilesPanes' post-memo-create
 * ancestor reload (webui simplify componentization, issue 2026-07-17) — all
 * just need "dispatch the loaded entries or error", differing only in when
 * they call it and whether they await the round trip. Kept out of the
 * reducer per DR-0005 §1 (effects live in components); FileTree stays the
 * owner of the fs_list round trip, other callers import this rather than
 * re-implement it.
 *
 * DR-0026: when `path` is an absolute path under one of the session's
 * workspace_folders, use fs_list_workspace instead of fs_list — the daemon's
 * relative-only fs_list wire contract would reject the absolute path outright.
 * Callers that don't have workspace_folders yet (initial root load before
 * session_status arrives) pass `[]` and get the pre-DR-0026 fs_list behavior. */
export function loadDir(
  store: Store,
  ws: WsHandle,
  sid: string,
  path: string,
  workspaceFolders: readonly WorkspaceFolder[] = [],
): Promise<void> {
  const call = isWorkspaceFilePath(path, workspaceFolders)
    ? ws.fsListWorkspace(sid, path)
    : ws.fsList(sid, path);
  return (
    call
      .then((res) => {
        if (res.ok) store.dispatch({ type: "fs/dir-loaded", sid, path, entries: res.entries });
        else store.dispatch({ type: "fs/dir-loaded", sid, path, error: res.error.msg });
      })
      // A rejection here (e.g. the socket dropped/hasn't opened yet, see
      // ws.ts send()) must still resolve the "loading…" placeholder above
      // into something the user can act on, same as an ok:false reply.
      .catch((err) => {
        store.dispatch({ type: "fs/dir-loaded", sid, path, error: errorMessage(err) });
      })
  );
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
  workspaceFolders,
  fav,
  create,
  del,
}: {
  sid: string;
  path: string;
  name: string;
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
  workspaceFolders: readonly WorkspaceFolder[];
  fav: FavContext | null;
  create: CreateContext | null;
  del: DeleteContext | null;
}) {
  const { store, ws } = useApp();
  const expanded = tree.expanded.has(path);
  const entries = tree.dirs.get(path);
  const error = tree.dirErrors.get(path);
  const creatingHere = create !== null && create.activePath === path;

  function toggle() {
    store.dispatch({ type: "fs/dir-toggled", sid, path });
    if (!expanded && entries === undefined) void loadDir(store, ws, sid, path, workspaceFolders);
  }

  function onNewFile(e: MouseEvent) {
    e.stopPropagation();
    if (!create) return;
    // Auto-expand + eager-load so the newly-created file lands in an already
    // visible listing (mirrors DirNode.toggle's own lazy-load path).
    if (!expanded) store.dispatch({ type: "fs/dir-toggled", sid, path });
    if (entries === undefined) void loadDir(store, ws, sid, path, workspaceFolders);
    create.onStart(path, isWorkspaceFilePath(path, workspaceFolders) ? "workspace" : "contained");
  }

  return (
    <li>
      <div class="tree-row-line">
        <button
          type="button"
          class="tree-row tree-dir"
          style={{ paddingLeft: `${depth}rem` }}
          onClick={toggle}
        >
          <span class="tree-caret">{expanded ? "▾" : "▸"}</span>
          <FileTypeIcon kind={fileIconKind(name, "dir", expanded)} />
          {name}
        </button>
        {create ? (
          <button
            type="button"
            class="tree-new-file-toggle"
            onClick={onNewFile}
            aria-label={`${path} に新規ファイルを作成`}
            title="このディレクトリに新規ファイル"
          >
            +
          </button>
        ) : null}
        {fav ? (
          <FavoriteToggle path={path} favorited={fav.favorites.has(path)} onToggle={fav.onToggle} />
        ) : null}
      </div>
      {expanded ? (
        <ul class="tree-children">
          {creatingHere && create ? (
            <NewFileInputRow
              depth={depth + 1}
              errorMsg={create.errorMsg}
              submitting={create.submitting}
              onCancel={create.onCancel}
              onSubmit={create.onSubmit}
            />
          ) : null}
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
              workspaceFolders={workspaceFolders}
              fav={fav}
              create={create}
              del={del}
            />
          )}
        </ul>
      ) : null}
    </li>
  );
}

/** Inline file-name editor rendered as the first child of the directory being
 * created into. Enter submits, Esc cancels, blur without submit cancels.
 * Kept local (uncontrolled input value) since the FileTree-level context only
 * owns the "which dir is active" bit, not per-keystroke draft state — the
 * name is only observed at submit time. */
function NewFileInputRow({
  depth,
  errorMsg,
  submitting,
  onCancel,
  onSubmit,
}: {
  depth: number;
  errorMsg: string | null;
  submitting: boolean;
  onCancel: () => void;
  onSubmit: (name: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  function onKeyDown(e: KeyboardEvent) {
    if (e.key === "Enter") {
      e.preventDefault();
      const value = inputRef.current?.value.trim() ?? "";
      if (value === "") return;
      onSubmit(value);
    } else if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  }
  return (
    <li class="tree-new-file-row" style={{ paddingLeft: `${depth}rem` }}>
      <input
        ref={inputRef}
        type="text"
        class="tree-new-file-input"
        placeholder="ファイル名"
        disabled={submitting}
        onKeyDown={onKeyDown}
        // A pointerdown outside the input in the same tree exits the mode;
        // rely on blur since input focus doesn't survive the outer click.
        onBlur={() => {
          // Defer: if user clicked a "submit"-adjacent element there wouldn't
          // be any here (Enter is the submit path), so blur == cancel.
          if (!submitting) onCancel();
        }}
      />
      {errorMsg ? <span class="tree-new-file-error">{errorMsg}</span> : null}
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
  del,
}: {
  sid: string;
  path: string;
  name: string;
  depth: number;
  selected: boolean;
  symlink: boolean;
  fav: FavContext | null;
  del: DeleteContext | null;
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
        {del && selected ? (
          <button
            type="button"
            class="tree-delete-toggle"
            onClick={(e) => {
              e.stopPropagation();
              e.preventDefault();
              del.onDelete(path);
            }}
            aria-label={`${path} を削除`}
            title="このファイルを削除"
          >
            ×
          </button>
        ) : null}
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
  workspaceFolders,
  fav,
  create,
  del,
}: {
  sid: string;
  parentPath: string;
  entries: FsEntry[];
  depth: number;
  tree: SessionTreeState;
  selectedPath: string | null;
  workspaceFolders: readonly WorkspaceFolder[];
  fav: FavContext | null;
  create: CreateContext | null;
  del: DeleteContext | null;
}) {
  const ordered = sortEntries(entries);
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
              workspaceFolders={workspaceFolders}
              fav={fav}
              create={create}
              del={del}
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
            del={del}
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
 * 3. Otherwise unknown (including every `/`-prefixed external favorite, which
 *    deliberately has no fs_list directory entry) — default to "file". This mirrors
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
  externalFiles,
  workspaceFolders,
  onNewMemo,
}: {
  sid: string;
  tree: SessionTreeState;
  /** DR-0024 allowlisted absolute paths from the live session_status fold. */
  externalFiles: readonly string[];
  /** DR-0026 allowlisted absolute folder roots from the live session_status
   * fold. Each becomes a root-level DirNode in the ワークスペース section
   * (rendered between お気に入り and プロジェクト). Empty array = the
   * session's cwd carries no `.code-workspace` file, and the section is
   * suppressed. */
  workspaceFolders: readonly WorkspaceFolder[];
  /** Peer record for `sid`, as seen in state.peers — carries the repo_root/cwd
   * pair the tree's browsing origin is derived from (see rootPath below).
   * Undefined for a sid that hasn't shown up in a peers/loaded response yet
   * (same fallback posture as SessionView's hasTranscript lookup). */
  peer: PeerInfo | undefined;
  /** Switch the right-hand viewer pane into its new-memo editor. FilesPanes
   * owns that cross-pane display mode; FileTree only exposes the affordance. */
  onNewMemo: () => void;
}) {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store).connStatus;
  // Browsing origin is the session's own cwd (kawaz r55 m97), expressed in the
  // containment-root-relative space every fs path key uses — see treeRootPath.
  // `null` peer means the daemon hasn't told us this sid's cwd yet, in which
  // case "" (the containment root) is the only root we can name; it self-
  // corrects to the cwd root once `peer` arrives.
  const rootPath = peer ? treeRootPath(peer) : "";
  const rootEntries = tree.dirs.get(rootPath);
  const rootError = tree.dirErrors.get(rootPath);

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
  const sortedExternalFiles = sortExternalFiles(externalFiles);

  // New-file creation state (kawaz r46 mid=24): kept here so at most one
  // DirNode hosts the inline input at a time — sharing a single `activePath`
  // slot across all rows means a user starting a create somewhere else
  // implicitly exits any prior one. Pure component state (no reducer) since
  // it's ephemeral UI that dies with the session tab (same posture as
  // FilesPanes' memoEditorOpen). Kind is captured at onStart time so submit
  // doesn't have to re-derive it from the path (workspace vs contained).
  // Name search (kawaz r55 m67). The box lives in this header and its
  // emptiness is what decides between the tree body and the results panel, so
  // the query string is owned here; the request/result cycle belongs to
  // FileSearchPanel. Ephemeral like the create/memo modes — a query does not
  // survive a session switch (reset below alongside the create state).
  const [searchQuery, setSearchQuery] = useState("");
  const searching = searchQuery.trim() !== "";

  const [createActive, setCreateActive] = useState<{
    path: string;
    kind: "contained" | "workspace";
  } | null>(null);
  const [createErr, setCreateErr] = useState<string | null>(null);
  const [createSubmitting, setCreateSubmitting] = useState(false);
  // Reset the mode on sid switch (session tabs are independent) — same idea
  // as FilesPanes' setMemoEditorOpen(false) on [sid, selectedPath] change.
  useEffect(() => {
    setCreateActive(null);
    setCreateErr(null);
    setCreateSubmitting(false);
    setSearchQuery("");
  }, [sid]);
  const createCtx: CreateContext = {
    activePath: createActive?.path ?? null,
    errorMsg: createErr,
    submitting: createSubmitting,
    onStart: (dirPath, kind) => {
      setCreateActive({ path: dirPath, kind });
      setCreateErr(null);
    },
    onCancel: () => {
      if (createSubmitting) return;
      setCreateActive(null);
      setCreateErr(null);
    },
    onSubmit: (name) => {
      if (!createActive || createSubmitting) return;
      // Reject anything that would escape the selected directory: no slashes,
      // no ".." — the server enforces containment too, but a client-side
      // check gives a faster / clearer error.
      if (name.includes("/") || name === "." || name === "..") {
        setCreateErr("ファイル名にスラッシュや . / .. は使えません");
        return;
      }
      const dirPath = createActive.path;
      const kind = createActive.kind;
      const target =
        kind === "workspace"
          ? dirPath.endsWith("/")
            ? `${dirPath}${name}`
            : `${dirPath}/${name}`
          : dirPath === ""
            ? name
            : `${dirPath}/${name}`;
      setCreateSubmitting(true);
      setCreateErr(null);
      ws.fsCreate(sid, target, kind, "")
        .then(async (res) => {
          if (!res.ok) {
            setCreateErr(res.error.msg);
            setCreateSubmitting(false);
            return;
          }
          // Refresh the containing listing so the new leaf appears; use the
          // dirPath we captured (server echoes a normalized realpath which
          // may differ if an in-tree symlink resolved elsewhere — but the
          // tree keys off the lexical path the user browsed by).
          await loadDir(store, ws, sid, dirPath, workspaceFolders);
          setCreateActive(null);
          setCreateSubmitting(false);
          // Open the new file in the viewer pane — mirrors FilesPanes'
          // onMemoCreated navigation. Use the client-side target for the URL
          // (same lexical space as fs_list results).
          location.assign(fileHref(sid, target));
        })
        .catch((err) => {
          setCreateErr(errorMessage(err));
          setCreateSubmitting(false);
        });
    },
  };

  // File delete (kawaz r46 m25): confirm() gate on the client, fs_delete on
  // the daemon. Success → refresh the containing dir listing so the row
  // disappears; the currently-shown FileViewer keeps its stale content (an
  // fs_read follow-up would fail with not_found, which the viewer handles as
  // any read error). External paths (path.startsWith("/") and NOT under a
  // workspace folder) get no delete button (deleteCtx passed as null for that
  // section) since fs_delete's kind union doesn't cover them.
  const deleteCtx: DeleteContext = {
    onDelete: (filePath: string) => {
      // eslint-disable-next-line no-alert -- kawaz r46 m25 explicitly asked for confirm() gate; a modal would be nicer UI but is not in scope for this task.
      const ok = window.confirm(`このファイルを削除しますか?\n\n${filePath}`);
      if (!ok) return;
      const kind: "contained" | "workspace" = isWorkspaceFilePath(filePath, workspaceFolders)
        ? "workspace"
        : "contained";
      const slash = filePath.lastIndexOf("/");
      const parentPath = slash < 0 ? "" : filePath.slice(0, slash);
      ws.fsDelete(sid, filePath, kind)
        .then(async (res) => {
          if (!res.ok) {
            // eslint-disable-next-line no-alert -- surface daemon reject reasons to the user; a status toast would be better but out of scope here.
            window.alert(`削除に失敗しました: ${res.error.msg}`);
            return;
          }
          await loadDir(store, ws, sid, parentPath, workspaceFolders);
        })
        .catch((err) => {
          window.alert(`削除に失敗しました: ${errorMessage(err)}`);
        });
    },
  };

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
    // The root is a plain containment-relative path (cwd's, see rootPath), so
    // no workspaceFolders arg is needed here — the DR-0026 branch only fires
    // for absolute workspace-folder paths, not for the session's own root.
    void loadDir(store, ws, sid, rootPath);
  }, [sid, rootPath, rootEntries, rootError, connStatus]);

  return (
    <div class="file-tree">
      {/* docs/inbox メモ作成: FileTree owns only the launch affordance. The
       * editor itself replaces FileViewer in the right pane, coordinated by
       * FilesPanes, so creating a memo has the same full-size surface as
       * reading a file instead of inserting a form into the navigation tree. */}
      <div class="tree-header">
        <span class="tree-header-spacer" />
        <button type="button" class="tree-inbox-new-btn" onClick={onNewMemo}>
          + メモ
        </button>
      </div>
      {/* Name search (kawaz r55 m67). Sits directly under the header so it
       * reads as belonging to the whole pane rather than to any one section —
       * it searches every browsable root at once (containment root, each
       * workspace folder, plus the external-file list), which is exactly the
       * set of sections rendered below it. */}
      <div class="tree-search">
        <input
          type="search"
          class="tree-search-input"
          placeholder="Search files by name"
          aria-label="ファイル名検索 (空白区切りで AND)"
          value={searchQuery}
          onInput={(e) => setSearchQuery((e.target as HTMLInputElement).value)}
          onKeyDown={(e) => {
            // Esc clears rather than just blurring — the query is what's
            // hiding the tree, so "get me out of search" and "empty the box"
            // are the same intent here.
            if (e.key === "Escape") {
              e.preventDefault();
              setSearchQuery("");
            }
          }}
        />
      </div>
      {/* An active query replaces the tree body outright rather than filtering
       * it: the tree only holds directories the user already expanded
       * (DR-0008 lazy load), so filtering it in place could never show a match
       * in an unopened directory — which is the whole point of searching. The
       * header (root label / + メモ / the box itself) stays put so the pane
       * doesn't lose its identity while searching. */}
      {searching ? (
        <FileSearchPanel
          sid={sid}
          query={searchQuery}
          treeRoot={rootPath}
          workspaceFolders={workspaceFolders}
          externalFiles={externalFiles}
          fav={fav}
        />
      ) : (
        <>
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
                  // Favorites can hold either project-relative or /-prefixed
                  // external paths. External paths (starts with "/" and NOT a
                  // workspace folder path) can't be deleted through fs_delete
                  // (external is outside its authorization surfaces), so drop the
                  // affordance for those rows only.
                  const isExternal =
                    path.startsWith("/") && !isWorkspaceFilePath(path, workspaceFolders);
                  return kind === "dir" ? (
                    <DirNode
                      key={path}
                      sid={sid}
                      path={path}
                      name={path}
                      depth={0}
                      tree={tree}
                      selectedPath={tree.selectedPath}
                      workspaceFolders={workspaceFolders}
                      fav={fav}
                      create={createCtx}
                      del={isExternal ? null : deleteCtx}
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
                      del={isExternal ? null : deleteCtx}
                    />
                  );
                })}
              </ul>
            </>
          ) : null}
          {/* Workspace section (DR-0026): folders discovered in the session's
           * cwd `.code-workspace` file(s). Each folder renders as a root-level
           * DirNode with its absolute realpath as both key and display name —
           * expand/lazy-load/★ reuse the same components as お気に入り, and
           * fs_list_workspace routing keys off the same path via loadDir's
           * DR-0026 branch. Suppressed when no workspace folders were published
           * (either no .code-workspace file, or the session hasn't subscribed
           * to session_status yet — same posture as sortedExternalFiles). */}
          {workspaceFolders.length > 0 ? (
            <>
              <p class="tree-section-label">ワークスペース</p>
              <ul class="tree-root tree-workspace">
                {workspaceFolders.map((folder) => (
                  <DirNode
                    key={folder.path}
                    sid={sid}
                    path={folder.path}
                    name={folder.name}
                    depth={0}
                    tree={tree}
                    selectedPath={tree.selectedPath}
                    workspaceFolders={workspaceFolders}
                    fav={fav}
                    create={createCtx}
                    del={deleteCtx}
                  />
                ))}
              </ul>
            </>
          ) : null}
          {sortedFavorites.length > 0 ||
          workspaceFolders.length > 0 ||
          sortedExternalFiles.length > 0 ? (
            <p class="tree-section-label">プロジェクト</p>
          ) : null}
          {rootError ? (
            <p class="tree-error">{rootError}</p>
          ) : rootEntries === undefined ? (
            <p class="tree-loading">loading…</p>
          ) : (
            <ul class="tree-root">
              {/* Top level is the session's cwd listing, whatever the daemon's
               * containment root happens to be (kawaz r55 m97) — no filtering
               * or pinning pass, just the directory as it is on disk. */}
              <Nodes
                sid={sid}
                parentPath={rootPath}
                entries={rootEntries}
                depth={0}
                tree={tree}
                selectedPath={tree.selectedPath}
                workspaceFolders={workspaceFolders}
                fav={fav}
                create={createCtx}
                del={deleteCtx}
              />
            </ul>
          )}
          {sortedExternalFiles.length > 0 ? (
            <>
              <p class="tree-section-label">プロジェクト外</p>
              <ul class="tree-root tree-external">
                {/* DR-0024: external paths render at depth 0 with the full absolute
                 * path as both label and locator key. FavoriteToggle shares the
                 * same flat string set as project rows; `/` prefix guarantees no
                 * collision, and a starred external file therefore also appears in
                 * the favorites section through favoriteEntryKind's file fallback. */}
                {sortedExternalFiles.map((externalPath) => (
                  <FileNode
                    key={externalPath}
                    sid={sid}
                    path={externalPath}
                    name={externalPath}
                    depth={0}
                    selected={tree.selectedPath === externalPath}
                    symlink={false}
                    fav={fav}
                    // DR-0024 external files live outside fs_delete's authorization
                    // surfaces (contained | workspace) — no delete affordance.
                    del={null}
                  />
                ))}
              </ul>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
