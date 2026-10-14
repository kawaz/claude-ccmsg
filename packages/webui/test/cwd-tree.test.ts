// DR-0018 §2.2/§3.2: pure DirTreeEntry merge helpers for CwdTree.tsx —
// boundary detection and the lazy-fetch splice, exercised against
// hand-built `dir_tree`-shaped responses (no daemon/ws round trip).
import { describe, expect, test } from "bun:test";
import type { DirTreeEntry } from "@ccmsg/protocol";
import {
  attachDirTreeChildren,
  collectPathsWithPreloadedChildren,
  cwdTreeReducer,
  initialCwdTree,
  isDirTreeBoundary,
  type CwdTreeAction,
  type CwdTreeState,
} from "../src/client/cwd-tree.ts";

describe("isDirTreeBoundary", () => {
  test("true when children is absent (depth-boundary marker)", () => {
    expect(isDirTreeBoundary({ path: "/a", is_dir: true })).toBe(true);
  });

  test("false for a real, fully-explored empty directory (children: [])", () => {
    expect(isDirTreeBoundary({ path: "/a", is_dir: true, children: [] })).toBe(false);
  });

  test("false once children have been attached", () => {
    expect(
      isDirTreeBoundary({
        path: "/a",
        is_dir: true,
        children: [{ path: "/a/b", is_dir: true }],
      }),
    ).toBe(false);
  });
});

describe("collectPathsWithPreloadedChildren", () => {
  test("includes every node that has a non-empty children array (recursive)", () => {
    // Shape mirrors kawaz's layout under `~/.local/share/repos/github.com/<owner>/`
    // after a depth=2 fetch: owner → repo → (wt|ws). The wt/ws layer is leaf,
    // so only the repo layer has preloaded children to auto-expand.
    const entries: DirTreeEntry[] = [
      {
        path: "/root/repo-a",
        is_dir: true,
        children: [
          { path: "/root/repo-a/main", is_dir: true },
          { path: "/root/repo-a/wip-x", is_dir: true },
        ],
      },
      {
        path: "/root/repo-b",
        is_dir: true,
        children: [{ path: "/root/repo-b/main", is_dir: true }],
      },
    ];
    expect(collectPathsWithPreloadedChildren(entries)).toEqual(
      new Set(["/root/repo-a", "/root/repo-b"]),
    );
  });

  test("excludes boundary entries (children undefined) — auto-expanding those would fire lazy fetches behind the user's back", () => {
    const entries: DirTreeEntry[] = [{ path: "/root/repo-a", is_dir: true }];
    expect(collectPathsWithPreloadedChildren(entries)).toEqual(new Set());
  });

  test("excludes real empty directories (children: []) — nothing to reveal", () => {
    const entries: DirTreeEntry[] = [{ path: "/root/repo-a", is_dir: true, children: [] }];
    expect(collectPathsWithPreloadedChildren(entries)).toEqual(new Set());
  });

  test("walks arbitrarily deep so a lazy re-fetch that pulls a bigger subtree also unfolds", () => {
    const entries: DirTreeEntry[] = [
      {
        path: "/a",
        is_dir: true,
        children: [
          {
            path: "/a/b",
            is_dir: true,
            children: [{ path: "/a/b/c", is_dir: true }],
          },
        ],
      },
    ];
    expect(collectPathsWithPreloadedChildren(entries)).toEqual(new Set(["/a", "/a/b"]));
  });
});

describe("attachDirTreeChildren", () => {
  test("attaches children to a matching top-level boundary entry", () => {
    const entries: DirTreeEntry[] = [{ path: "/root/alpha", is_dir: true }];
    const children: DirTreeEntry[] = [{ path: "/root/alpha/beta", is_dir: true }];
    const next = attachDirTreeChildren(entries, "/root/alpha", children);
    expect(next).toEqual([{ path: "/root/alpha", is_dir: true, children }]);
  });

  test("attaches children to a matching entry nested several levels deep", () => {
    const entries: DirTreeEntry[] = [
      {
        path: "/root/alpha",
        is_dir: true,
        children: [
          {
            path: "/root/alpha/beta",
            is_dir: true,
            children: [{ path: "/root/alpha/beta/gamma", is_dir: true }],
          },
        ],
      },
    ];
    const children: DirTreeEntry[] = [{ path: "/root/alpha/beta/gamma/delta", is_dir: true }];
    const next = attachDirTreeChildren(entries, "/root/alpha/beta/gamma", children);
    expect(next).toEqual([
      {
        path: "/root/alpha",
        is_dir: true,
        children: [
          {
            path: "/root/alpha/beta",
            is_dir: true,
            children: [{ path: "/root/alpha/beta/gamma", is_dir: true, children }],
          },
        ],
      },
    ]);
  });

  test("leaves siblings of the matched path untouched by reference", () => {
    const untouchedSibling: DirTreeEntry = { path: "/root/zeta", is_dir: true };
    const entries: DirTreeEntry[] = [{ path: "/root/alpha", is_dir: true }, untouchedSibling];
    const next = attachDirTreeChildren(entries, "/root/alpha", []);
    expect(next[1]).toBe(untouchedSibling);
  });

  test("no match anywhere returns the original array unchanged, by reference", () => {
    const entries: DirTreeEntry[] = [{ path: "/root/alpha", is_dir: true }];
    const next = attachDirTreeChildren(entries, "/root/does-not-exist", []);
    expect(next).toBe(entries);
  });

  test("replaces an already-attached (non-boundary) entry's children too — a re-expand after collapse re-fetches and this still splices cleanly", () => {
    const entries: DirTreeEntry[] = [
      { path: "/root/alpha", is_dir: true, children: [{ path: "/root/alpha/old", is_dir: true }] },
    ];
    const next = attachDirTreeChildren(entries, "/root/alpha", [
      { path: "/root/alpha/new", is_dir: true },
    ]);
    expect(next).toEqual([
      { path: "/root/alpha", is_dir: true, children: [{ path: "/root/alpha/new", is_dir: true }] },
    ]);
  });
});

// The tree and the lazily fetched child listings below it are requests of one
// generation (request-generation.ts): a filter change starts a new tree, and
// any answer — whole tree or one directory's children — that was asked for the
// previous tree is dropped instead of mixing old rows into the new one.
// Source: docs/findings/2026-10-14-webui-hooks-review-react-guidance.md (high 6).
describe("cwdTreeReducer", () => {
  const boundary = (path: string): DirTreeEntry => ({ path, is_dir: true });
  const run = (...actions: CwdTreeAction[]): CwdTreeState =>
    actions.reduce(cwdTreeReducer, initialCwdTree());

  test("a child listing asked under the previous filter does not attach to the refetched tree", () => {
    const state = run(
      { type: "fetch-started", generation: 1 },
      { type: "fetched", generation: 1, entries: [boundary("/r/a")] },
      { type: "toggled", path: "/r/a" },
      { type: "children-loading", generation: 1, path: "/r/a" },
      { type: "fetch-started", generation: 2 },
      { type: "fetched", generation: 2, entries: [boundary("/r/a")] },
      {
        type: "children-loaded",
        generation: 1,
        path: "/r/a",
        children: [boundary("/r/a/unfiltered")],
      },
    );
    expect(state.entries).toEqual([boundary("/r/a")]);
    expect(state.expandingPaths.size).toBe(0);
  });

  test("a child listing failure asked under the previous filter is not shown on the new tree", () => {
    const state = run(
      { type: "fetch-started", generation: 1 },
      { type: "fetched", generation: 1, entries: [boundary("/r/a")] },
      { type: "children-loading", generation: 1, path: "/r/a" },
      { type: "fetch-started", generation: 2 },
      { type: "fetched", generation: 2, entries: [boundary("/r/a")] },
      { type: "children-failed", generation: 1, path: "/r/a", error: "denied" },
    );
    expect(state.lazyErrors.size).toBe(0);
  });

  test("a whole-tree answer for the previous filter does not replace the current one", () => {
    const state = run(
      { type: "fetch-started", generation: 1 },
      { type: "fetch-started", generation: 2 },
      { type: "fetched", generation: 2, entries: [boundary("/r/new")] },
      { type: "fetched", generation: 1, entries: [boundary("/r/old")] },
    );
    expect(state.entries).toEqual([boundary("/r/new")]);
    expect(state.loading).toBe(false);
  });

  test("a child listing for the current tree attaches under its directory", () => {
    const state = run(
      { type: "fetch-started", generation: 1 },
      { type: "fetched", generation: 1, entries: [boundary("/r/a")] },
      { type: "toggled", path: "/r/a" },
      { type: "children-loading", generation: 1, path: "/r/a" },
      { type: "children-loaded", generation: 1, path: "/r/a", children: [boundary("/r/a/b")] },
    );
    expect(state.entries).toEqual([{ path: "/r/a", is_dir: true, children: [boundary("/r/a/b")] }]);
    expect(state.expanded.has("/r/a")).toBe(true);
    expect(state.expandingPaths.size).toBe(0);
  });

  test("a fresh tree opens the directories whose children came with it", () => {
    const state = run(
      { type: "fetch-started", generation: 1 },
      {
        type: "fetched",
        generation: 1,
        entries: [{ path: "/r/a", is_dir: true, children: [boundary("/r/a/b")] }],
      },
    );
    expect(state.expanded).toEqual(new Set(["/r/a"]));
  });
});
