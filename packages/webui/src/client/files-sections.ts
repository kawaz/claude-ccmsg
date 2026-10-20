// What the Files tree's sections are made of: the folders of the ワークスペース
// section, and how a set of full paths (favorites, files outside the project)
// is grouped under them. Pure functions of the peer row and the session's
// published workspace folders, so the grouping is testable without a DOM.
//
// Two path spaces meet here. A path is *identified* by its normalized full
// path — that is what favorites store and compare, so one file is one favorite
// however it was reached. A row is *addressed* by its tree key, the spelling
// the Files panes route by (`canonicalViewerPath`): containment-relative for
// the session's own folder, absolute for any other workspace folder and for
// files outside every folder the containment root holds.
import type { WorkspaceFolder } from "@ccmsg/protocol";
import { normalizePosix, viewerPathForAbsolute } from "./filepath-ref.ts";
import { treeRootPath } from "./utils.ts";

/** Name of the folder that stands for the session's cwd when no workspace
 * folder is the cwd (or no workspace file exists at all). */
export const PROJECT_ROOT_NAME = "PROJECT_ROOT";

/** Heading of the group holding paths that lie in no folder. */
export const OTHERS_GROUP_NAME = "others";

/** One folder of the ワークスペース section. */
export interface FilesFolder {
  name: string;
  /** Absolute folder path. */
  path: string;
  /** The tree key the folder's DirNode is addressed by. */
  key: string;
  /** The session's own cwd: listed through the containment root (`fs_list`)
   * rather than as a workspace folder, so its files keep the spelling links,
   * creation, deletion and search already use for them. */
  isCwd: boolean;
}

export interface FilesLayout {
  /** The ワークスペース section, in display order. Always holds the cwd. */
  folders: FilesFolder[];
  /** Workspace folders addressed through `fs_*_workspace`: every published
   * folder except the cwd's own. This is the list the panes route by. */
  routed: WorkspaceFolder[];
  /** `repo_root ?? cwd` — what relative tree keys are relative to. `undefined`
   * until the peer row is known. */
  containmentRoot: string | undefined;
}

function trimSlash(p: string): string {
  return p.length > 1 ? p.replace(/\/+$/, "") : p;
}

/** The ワークスペース section for a session.
 *
 * The cwd is always one of the folders. A workspace folder at the cwd (`"."`
 * in the workspace file) is that folder, under its own name; with none, a
 * `PROJECT_ROOT` folder for the cwd is put first. Either way the cwd is listed
 * through the containment root, so the tree shows it under the key its files
 * are already addressed by.
 *
 * Before the peer row arrives the cwd is unknown; the containment root's own
 * listing (key `""`) stands in for it, as the tree did before the row came. */
export function filesLayout(
  peer: { cwd: string; repo_root?: string } | undefined,
  workspaceFolders: readonly WorkspaceFolder[],
): FilesLayout {
  if (!peer) {
    return {
      folders: [{ name: PROJECT_ROOT_NAME, path: "", key: "", isCwd: true }],
      routed: [...workspaceFolders],
      containmentRoot: undefined,
    };
  }
  const cwd = trimSlash(peer.cwd);
  const rootKey = treeRootPath(peer);
  // The daemon marks the cwd's folder (it can realpath both sides; a cwd
  // announced through a symlink is spelled differently from the folder).
  const cwdFolder = workspaceFolders.find((f) => f.is_cwd === true);
  const folders: FilesFolder[] = workspaceFolders.map((f) =>
    f === cwdFolder
      ? { name: f.name, path: cwd, key: rootKey, isCwd: true }
      : { name: f.name, path: trimSlash(f.path), key: f.path, isCwd: false },
  );
  if (!cwdFolder)
    folders.unshift({ name: PROJECT_ROOT_NAME, path: cwd, key: rootKey, isCwd: true });
  return {
    folders,
    routed: workspaceFolders.filter((f) => f !== cwdFolder),
    containmentRoot: trimSlash(peer.repo_root ?? peer.cwd),
  };
}

/** The full path a tree key or stored favorite names: absolute ones
 * normalized, relative ones read against the containment root (the space tree
 * keys and older favorites were written in). `null` when a relative path
 * cannot be placed yet. */
export function fullPathOf(p: string, containmentRoot: string | undefined): string | null {
  if (p.startsWith("/")) return normalizePosix(p);
  if (containmentRoot === undefined) return null;
  return normalizePosix(`${containmentRoot}/${p}`);
}

/** Stored favorites as full paths, each file once, in stored order. Entries
 * that cannot be placed (relative ones before the root is known) are left out
 * of what is shown; nothing is written back by reading. */
export function favoriteFullPaths(
  stored: readonly string[],
  containmentRoot: string | undefined,
): string[] {
  const out = new Set<string>();
  for (const p of stored) {
    const full = fullPathOf(p, containmentRoot);
    if (full !== null) out.add(full);
  }
  return [...out];
}

/** One row of a grouped section. */
export interface FilesGroupRow {
  /** Normalized full path — the row's identity. */
  full: string;
  /** Tree key — what the row links to and expands by. */
  key: string;
  /** What the row shows: the path inside its folder, the full path in
   * `others`, `.` for the folder itself. */
  label: string;
}

/** A group of rows under one folder. `name` is `null` for the cwd's group,
 * which is shown without a heading; `OTHERS_GROUP_NAME` collects paths in no
 * folder. */
export interface FilesGroup {
  name: string | null;
  rows: FilesGroupRow[];
}

function folderOf(full: string, folders: readonly FilesFolder[]): FilesFolder | undefined {
  let best: FilesFolder | undefined;
  for (const folder of folders) {
    if (folder.path === "") continue;
    const inside = full === folder.path || full.startsWith(`${folder.path}/`);
    if (inside && (!best || folder.path.length > best.path.length)) best = folder;
  }
  return best;
}

/** Group full paths by the folder holding them — the deepest one when folders
 * nest. The cwd's group comes first, then the other folders in section order,
 * then `others`; a folder with no path in it gets no group. Rows sort by
 * label within a group. */
export function groupByFolder(fulls: readonly string[], layout: FilesLayout): FilesGroup[] {
  const byFolder = new Map<FilesFolder, FilesGroupRow[]>();
  const others: FilesGroupRow[] = [];
  for (const full of fulls) {
    const folder = folderOf(full, layout.folders);
    if (!folder) {
      others.push({ full, key: viewerPathForAbsolute(full, layout.containmentRoot), label: full });
      continue;
    }
    const label = full === folder.path ? "." : full.slice(folder.path.length + 1);
    const key = !folder.isCwd
      ? full
      : full === folder.path
        ? folder.key
        : viewerPathForAbsolute(full, layout.containmentRoot);
    const rows = byFolder.get(folder) ?? [];
    rows.push({ full, key, label });
    byFolder.set(folder, rows);
  }
  const sortRows = (rows: FilesGroupRow[]) => rows.sort((a, b) => a.label.localeCompare(b.label));
  const ordered = [...layout.folders].sort((a, b) => Number(b.isCwd) - Number(a.isCwd));
  const groups: FilesGroup[] = [];
  for (const folder of ordered) {
    const rows = byFolder.get(folder);
    if (rows) groups.push({ name: folder.isCwd ? null : folder.name, rows: sortRows(rows) });
  }
  if (others.length > 0) groups.push({ name: OTHERS_GROUP_NAME, rows: sortRows(others) });
  return groups;
}
