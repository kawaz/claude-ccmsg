// Pure tree-merge derivations and the local-state reducer for CwdTree (DR-0018
// §2.2/§3.2). Kept out of utils.ts as a standalone module (same convention as
// rooms-filter.ts) so the nested-splice logic and the stale-answer handling are
// exercised in isolation by cwd-tree.test.ts without mounting the component or
// a fake WsHandle.
//
// The daemon's `dir_tree` response is a recursive `DirTreeEntry[]` (LN-Q3:
// bounded initial depth, `children: undefined` marks a lazy-fetch boundary).
// CwdTree keeps that same shape as its local root-entries state — merging a
// lazy child fetch means finding the boundary node by path and replacing its
// `children`, everywhere in the tree it occurs.
import type { DirTreeEntry } from "@ccmsg/protocol";

/** Collect every path in the pre-loaded tree that has a non-empty `children`
 * array. CwdTree seeds its `expanded` state with this set on each fresh fetch
 * so the depth-2 walk the daemon already paid for (repo → wt/ws layer for
 * kawaz's layout) is visible without a per-repo expand click. Boundary
 * entries (`children === undefined`) are not included — expanding them would
 * trigger a lazy fetch, which is fine on user click but not as a bulk default.
 * Real empty directories (`children: []`) are also excluded since there's
 * nothing to show. */
export function collectPathsWithPreloadedChildren(entries: readonly DirTreeEntry[]): Set<string> {
  const paths = new Set<string>();
  const walk = (list: readonly DirTreeEntry[]): void => {
    for (const entry of list) {
      if (entry.children === undefined || entry.children.length === 0) continue;
      paths.add(entry.path);
      walk(entry.children);
    }
  };
  walk(entries);
  return paths;
}

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
 * `entries` unchanged (by reference), so a listing for a directory that is no
 * longer in the tree is a no-op instead of resurrecting it. */
export function attachDirTreeChildren(
  entries: readonly DirTreeEntry[],
  path: string,
  children: readonly DirTreeEntry[],
): readonly DirTreeEntry[] {
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

/** CwdTree's whole local state: the tree the last `dir_tree` answered with,
 * plus the expand / lazy-fetch bookkeeping that only means something for that
 * tree. One reducer so the generation check (request-generation.ts) sits in
 * one place for both the whole-tree fetch and the per-directory lazy fetches. */
export interface CwdTreeState {
  /** The whole-tree request the state belongs to; 0 before the first. Lazy
   * child fetches are asked under it and dropped once a newer tree starts. */
  generation: number;
  entries: readonly DirTreeEntry[] | null;
  loading: boolean;
  error: string | null;
  expanded: ReadonlySet<string>;
  expandingPaths: ReadonlySet<string>;
  lazyErrors: ReadonlyMap<string, string>;
}

export type CwdTreeAction =
  | { type: "fetch-started"; generation: number }
  | { type: "fetched"; generation: number; entries: readonly DirTreeEntry[] }
  | { type: "fetch-failed"; generation: number; error: string }
  | { type: "toggled"; path: string }
  | { type: "children-loading"; generation: number; path: string }
  | {
      type: "children-loaded";
      generation: number;
      path: string;
      children: readonly DirTreeEntry[];
    }
  | { type: "children-failed"; generation: number; path: string; error: string };

export function initialCwdTree(): CwdTreeState {
  return {
    generation: 0,
    entries: null,
    loading: false,
    error: null,
    expanded: new Set(),
    expandingPaths: new Set(),
    lazyErrors: new Map(),
  };
}

function setWithout(from: ReadonlySet<string>, path: string): ReadonlySet<string> {
  if (!from.has(path)) return from;
  const next = new Set(from);
  next.delete(path);
  return next;
}

function mapWithout(from: ReadonlyMap<string, string>, path: string): ReadonlyMap<string, string> {
  if (!from.has(path)) return from;
  const next = new Map(from);
  next.delete(path);
  return next;
}

export function cwdTreeReducer(state: CwdTreeState, action: CwdTreeAction): CwdTreeState {
  switch (action.type) {
    case "fetch-started":
      // The previous tree stays on screen until the new one answers (only the
      // very first fetch shows "loading…"), but from here on every answer
      // asked under it is stale.
      return { ...state, generation: action.generation, loading: true, error: null };
    case "toggled": {
      const expanded = new Set(state.expanded);
      if (!expanded.delete(action.path)) expanded.add(action.path);
      return { ...state, expanded };
    }
  }
  if (action.generation !== state.generation) return state;
  switch (action.type) {
    case "fetched":
      // A fresh tree replaces the whole expand / lazy state: a filter change
      // can shuffle which nodes exist at all. Directories whose children came
      // pre-loaded open by themselves (collectPathsWithPreloadedChildren).
      return {
        ...state,
        entries: action.entries,
        loading: false,
        expanded: collectPathsWithPreloadedChildren(action.entries),
        expandingPaths: new Set(),
        lazyErrors: new Map(),
      };
    case "fetch-failed":
      return { ...state, loading: false, error: action.error };
    case "children-loading":
      return { ...state, expandingPaths: new Set(state.expandingPaths).add(action.path) };
    case "children-loaded":
      return {
        ...state,
        entries:
          state.entries && attachDirTreeChildren(state.entries, action.path, action.children),
        expandingPaths: setWithout(state.expandingPaths, action.path),
        lazyErrors: mapWithout(state.lazyErrors, action.path),
      };
    case "children-failed":
      return {
        ...state,
        expandingPaths: setWithout(state.expandingPaths, action.path),
        lazyErrors: new Map(state.lazyErrors).set(action.path, action.error),
      };
  }
}
