// DR-0018 §2.2/§3.2: pure DirTreeEntry merge helpers for CwdTree.tsx —
// boundary detection and the lazy-fetch splice, exercised against
// hand-built `dir_tree`-shaped responses (no daemon/ws round trip).
import { describe, expect, test } from "bun:test";
import type { DirTreeEntry } from "@ccmsg/protocol";
import { attachDirTreeChildren, isDirTreeBoundary } from "../src/client/cwd-tree.ts";

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
