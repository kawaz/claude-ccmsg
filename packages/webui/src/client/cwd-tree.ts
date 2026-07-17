// Pure tree-merge derivations for CwdTree (DR-0018 §2.2/§3.2). Kept out of
// utils.ts as a standalone module (same convention as rooms-filter.ts) so the
// nested-splice logic is exercised in isolation by cwd-tree.test.ts without
// mounting the component or a fake WsHandle.
//
// The daemon's `dir_tree` response is a recursive `DirTreeEntry[]` (LN-Q3:
// bounded initial depth, `children: undefined` marks a lazy-fetch boundary).
// CwdTree keeps that same shape as its local root-entries state — merging a
// lazy child fetch means finding the boundary node by path and replacing its
// `children`, everywhere in the tree it occurs.
import type { DirTreeEntry } from "@ccmsg/protocol";

/** True when `entry` is a lazy-fetch boundary (LN-Q3): the initial bounded
 * fetch stopped here, and expanding it in the UI should trigger a depth-1
 * `dir_tree` request for `entry.path`. An entry with `children: []` (a real,
 * fully-explored empty directory) is NOT a boundary — only `undefined` is. */
export function isDirTreeBoundary(entry: DirTreeEntry): boolean {
  return entry.children === undefined;
}

/** Recursively replaces the `children` of the entry at `path` with
 * `children`, returning a new tree (copy-on-write down the path to `path`,
 * every sibling subtree reused by reference — same shallow-copy discipline
 * store.ts's reducer helpers use). No match anywhere in `entries` returns
 * `entries` unchanged (by reference), so a stale lazy-fetch response that
 * raced a filter-driven root reload becomes a no-op instead of resurrecting
 * a path that's no longer in the tree. */
export function attachDirTreeChildren(
  entries: DirTreeEntry[],
  path: string,
  children: DirTreeEntry[],
): DirTreeEntry[] {
  let changed = false;
  const next = entries.map((entry) => {
    if (entry.path === path) {
      changed = true;
      return { ...entry, children };
    }
    if (entry.children === undefined) return entry;
    const nextChildren = attachDirTreeChildren(entry.children, path, children);
    if (nextChildren === entry.children) return entry;
    changed = true;
    return { ...entry, children: nextChildren };
  });
  return changed ? next : entries;
}
