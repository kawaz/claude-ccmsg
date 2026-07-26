// Files pane name search: the client-side pure parts. The matching itself
// lives on the daemon (fs_find), so what's covered here is which roots a
// search fans out to, how several roots' replies are summarized, and the one
// path set the client matches itself (DR-0024 external files).
import { describe, expect, test } from "bun:test";
import {
  fileSearchHitCount,
  fileSearchIncomplete,
  fileSearchTargets,
  filterExternalFiles,
  type FileSearchGroup,
} from "../src/client/file-search.ts";

function group(over: Partial<FileSearchGroup> = {}): FileSearchGroup {
  return { label: null, hits: [], truncated: false, error: null, ...over };
}

describe("fileSearchTargets", () => {
  test("searches the tree's own root as the unlabeled group", () => {
    expect(fileSearchTargets([], "")).toEqual([{ kind: "contained", root: "", label: null }]);
  });

  // kawaz r55 m97: the tree browses from cwd, which under a worktree layout
  // sits below the daemon's containment root. The search must walk that same
  // subtree — a containment-rooted walk would return hits from sibling
  // worktrees that the tree itself never shows.
  test("scopes the contained walk to the tree root rather than the containment root", () => {
    expect(fileSearchTargets([], "main")).toEqual([
      { kind: "contained", root: "main", label: null },
    ]);
  });

  test("adds one workspace target per folder, labeled by folder name", () => {
    // The tree renders a ワークスペース section for these, so a search that
    // skipped them would cover less than the tree the user is looking at.
    expect(
      fileSearchTargets(
        [
          { name: "sibling", path: "/repo/sibling" },
          { name: "other", path: "/repo/other" },
        ],
        "main",
      ),
    ).toEqual([
      { kind: "contained", root: "main", label: null },
      { kind: "workspace", root: "/repo/sibling", label: "sibling" },
      { kind: "workspace", root: "/repo/other", label: "other" },
    ]);
  });
});

describe("fileSearchIncomplete", () => {
  test("false when every group answered in full", () => {
    expect(fileSearchIncomplete([group(), group({ label: "ws" })])).toBe(false);
  });

  test("true when any group hit a cap", () => {
    expect(fileSearchIncomplete([group(), group({ truncated: true })])).toBe(true);
  });

  test("true when any group failed — its hits are unknown, not empty", () => {
    expect(fileSearchIncomplete([group(), group({ error: "path not allowed" })])).toBe(true);
  });
});

describe("fileSearchHitCount", () => {
  test("sums hits across groups", () => {
    expect(
      fileSearchHitCount([
        group({ hits: [{ path: "a.ts", type: "file" }] }),
        group({
          hits: [
            { path: "b.ts", type: "file" },
            { path: "c", type: "dir" },
          ],
        }),
      ]),
    ).toBe(3);
  });

  test("zero for no groups and for empty groups", () => {
    expect(fileSearchHitCount([])).toBe(0);
    expect(fileSearchHitCount([group(), group()])).toBe(0);
  });
});

describe("filterExternalFiles", () => {
  const files = ["/other/repo/src/main.ts", "/other/repo/docs/README.md", "/elsewhere/notes.txt"];

  test("matches a substring anywhere in the absolute path", () => {
    expect(filterExternalFiles(files, "notes")).toEqual(["/elsewhere/notes.txt"]);
  });

  test("ANDs whitespace-separated words, order-independently", () => {
    expect(filterExternalFiles(files, "repo md")).toEqual(["/other/repo/docs/README.md"]);
    expect(filterExternalFiles(files, "md repo")).toEqual(["/other/repo/docs/README.md"]);
    expect(filterExternalFiles(files, "repo nomatch")).toEqual([]);
  });

  test("is case-insensitive, matching the daemon's fs_find contract", () => {
    expect(filterExternalFiles(files, "README")).toEqual(["/other/repo/docs/README.md"]);
    expect(filterExternalFiles(files, "readme")).toEqual(["/other/repo/docs/README.md"]);
  });

  test("empty / whitespace-only query matches nothing, not everything", () => {
    // Same contract as the daemon side: an empty box shows no results rather
    // than dumping every known path.
    expect(filterExternalFiles(files, "")).toEqual([]);
    expect(filterExternalFiles(files, "   ")).toEqual([]);
  });

  test("collapses whitespace runs and a full-width space", () => {
    expect(filterExternalFiles(files, "repo   md")).toEqual(["/other/repo/docs/README.md"]);
    expect(filterExternalFiles(files, "repo　md")).toEqual(["/other/repo/docs/README.md"]);
  });
});
