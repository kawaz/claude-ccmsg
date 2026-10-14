// Session-launcher cwd picker (DR-0018 §2.2/§3.2): directory-only tree over
// the configured root_dirs, with LN-Q3's "initial bounded fetch + lazy
// expansion past the boundary" split and a substring search filter. Modeled
// after FileTree.tsx's DirNode/Nodes split (same expand/collapse row shape),
// but simpler — no favorites, no file leaves, and selection is a distinct
// action from expand/collapse (a directory the user is only browsing through
// on the way to a deeper one must stay expandable without becoming `cwd`).
//
// issue 2026-07-17-session-creator-cwd-picker-unify: the filter input used to
// live inside this component (a second text box next to SessionCreator's own
// cwd field). It's now unified into a single input owned by SessionCreator —
// `filterInput` arrives as a prop instead of local state, and this component
// no longer renders its own `<input>`. The debounce stays here since it's
// this component's dir_tree request that the debounce protects.
import { useEffect, useReducer, useState } from "preact/hooks";
import type { DirTreeEntry } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { useKeyedValue } from "../useKeyedState.ts";
import { errorMessage, lastPathSegment } from "../utils.ts";
import { nextRequestGeneration } from "../request-generation.ts";
import { cwdTreeReducer, initialCwdTree, isDirTreeBoundary } from "../cwd-tree.ts";

/** Debounce for the filter input (DR-0018 §2.2's search box): each keystroke
 * would otherwise fire a full server-side re-walk (dir-tree.ts's synchronous
 * fs.readdirSync recursion, see its own MAX_DIR_TREE_DEPTH doc comment on why
 * that walk is bounded but still real I/O per request). */
const FILTER_DEBOUNCE_MS = 300;

interface NodeProps {
  entry: DirTreeEntry;
  depth: number;
  selected: string;
  expanded: ReadonlySet<string>;
  expandingPaths: ReadonlySet<string>;
  lazyErrors: ReadonlyMap<string, string>;
  onToggle: (entry: DirTreeEntry) => void;
  onSelect: (path: string) => void;
}

function Node({
  entry,
  depth,
  selected,
  expanded,
  expandingPaths,
  lazyErrors,
  onToggle,
  onSelect,
}: NodeProps) {
  const isExpanded = expanded.has(entry.path);
  const isExpanding = expandingPaths.has(entry.path);
  const lazyError = lazyErrors.get(entry.path);
  const isSelected = selected === entry.path;

  return (
    <li>
      <div class="cwd-tree-row-line">
        <button
          type="button"
          class="cwd-tree-row"
          style={{ paddingLeft: `${depth}rem` }}
          onClick={() => onToggle(entry)}
        >
          <span class="cwd-tree-caret">{isExpanded ? "▾" : "▸"}</span>
          {lastPathSegment(entry.path)}
        </button>
        <button
          type="button"
          class={"cwd-tree-select" + (isSelected ? " cwd-tree-selected" : "")}
          onClick={() => onSelect(entry.path)}
          title={entry.path}
        >
          {isSelected ? "✓ 選択中" : "選択"}
        </button>
      </div>
      {isExpanded ? (
        <ul class="cwd-tree-children">
          {isExpanding ? (
            <li class="cwd-tree-loading" style={{ paddingLeft: `${depth + 1}rem` }}>
              loading…
            </li>
          ) : lazyError ? (
            <li class="cwd-tree-error" style={{ paddingLeft: `${depth + 1}rem` }}>
              {lazyError}
            </li>
          ) : entry.children === undefined ? null : entry.children.length > 0 ? (
            entry.children.map((child) => (
              <Node
                key={child.path}
                entry={child}
                depth={depth + 1}
                selected={selected}
                expanded={expanded}
                expandingPaths={expandingPaths}
                lazyErrors={lazyErrors}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          ) : (
            <li class="cwd-tree-empty" style={{ paddingLeft: `${depth + 1}rem` }}>
              (空)
            </li>
          )}
        </ul>
      ) : null}
    </li>
  );
}

export function CwdTree({
  roots,
  selected,
  filterInput,
  onSelect,
}: {
  /** session_launcher_config's root_dirs — the daemon containment-checks
   * every dir_tree request (initial and lazy) against these. */
  roots: readonly string[];
  /** the form's current cwd value, so the matching row shows "✓ 選択中". */
  selected: string;
  /** Raw (undebounced) filter text — SessionCreator's unified cwd input,
   * owned by the parent so the same value can also drive direct-entry commit
   * (issue 2026-07-17-session-creator-cwd-picker-unify). */
  filterInput: string;
  onSelect: (path: string) => void;
}) {
  const { ws } = useApp();
  const [tree, dispatch] = useReducer(cwdTreeReducer, undefined, initialCwdTree);
  const { entries, loading, error, expanded, expandingPaths, lazyErrors } = tree;
  const [filter, setFilter] = useState("");

  useEffect(() => {
    const id = setTimeout(() => setFilter(filterInput.trim()), FILTER_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [filterInput]);

  // Initial bounded fetch (LN-Q3): re-runs whenever `roots` or the debounced
  // `filter` changes. A fresh fetch always replaces the whole tree — a
  // filter change can shuffle which nodes exist at all, so partial reuse of
  // the previous expand/lazy state would show stale rows next to fresh ones
  // (cwdTreeReducer's "fetched"). Each fetch is a new request generation, and
  // the lazy child fetches below are asked under it: the reducer drops any
  // answer — whole tree or one directory — asked for an earlier tree.
  // Held per content: a fresh array reference from the parent's config load
  // must not re-trigger this fetch, only an actual content change (or filter)
  // should.
  const rootList = useKeyedValue([roots.join("\n")], () => roots);
  useEffect(() => {
    if (rootList.length === 0) return;
    const generation = nextRequestGeneration();
    dispatch({ type: "fetch-started", generation });
    void ws
      .dirTree(rootList, filter ? { filter } : {})
      .then((res) => {
        // Auto-expand every node whose children came pre-loaded in this
        // initial bounded fetch (kawaz r38 m8): configured
        // `dir_tree_depth: 2` over a root like
        // `~/.local/share/repos/github.com/<owner>/` returns
        // repo → wt/ws in one round trip, so seeding `expanded` with those
        // paths surfaces the wt/ws layer without a per-repo click. Boundary
        // entries are excluded (see collectPathsWithPreloadedChildren) so
        // this doesn't fan out into lazy-fetch requests behind the user's
        // back.
        if (res.ok) dispatch({ type: "fetched", generation, entries: res.entries });
        else dispatch({ type: "fetch-failed", generation, error: res.error.msg });
      })
      .catch((err) => {
        dispatch({ type: "fetch-failed", generation, error: errorMessage(err) });
      });
  }, [rootList, filter, ws]);

  function toggle(entry: DirTreeEntry): void {
    const willExpand = !expanded.has(entry.path);
    dispatch({ type: "toggled", path: entry.path });
    if (!willExpand || !isDirTreeBoundary(entry)) return;

    const { generation } = tree;
    dispatch({ type: "children-loading", generation, path: entry.path });
    void ws
      .dirTree([entry.path], { depth: 1 })
      .then((res) => {
        if (res.ok) {
          dispatch({
            type: "children-loaded",
            generation,
            path: entry.path,
            children: res.entries,
          });
        } else {
          dispatch({ type: "children-failed", generation, path: entry.path, error: res.error.msg });
        }
      })
      .catch((err) => {
        dispatch({
          type: "children-failed",
          generation,
          path: entry.path,
          error: errorMessage(err),
        });
      });
  }

  return (
    <div class="cwd-tree">
      {error ? (
        <p class="cwd-tree-error">{error}</p>
      ) : loading && entries === null ? (
        <p class="cwd-tree-loading">loading…</p>
      ) : entries && entries.length > 0 ? (
        <ul class="cwd-tree-root">
          {entries.map((entry) => (
            <Node
              key={entry.path}
              entry={entry}
              depth={0}
              selected={selected}
              expanded={expanded}
              expandingPaths={expandingPaths}
              lazyErrors={lazyErrors}
              onToggle={toggle}
              onSelect={onSelect}
            />
          ))}
        </ul>
      ) : (
        <p class="cwd-tree-empty">該当なし</p>
      )}
    </div>
  );
}
