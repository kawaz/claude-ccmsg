// The Files tree's sections: which folders the ワークスペース section lists,
// how favorites are identified, and how full paths group under the folders.
import { describe, expect, test } from "bun:test";
import {
  favoriteFullPaths,
  filesLayout,
  fullPathOf,
  groupByFolder,
  OTHERS_GROUP_NAME,
  PROJECT_ROOT_NAME,
} from "../src/client/files-sections.ts";

// A jj-style layout: the containment root is the repo container, the session
// works in `main`, and the workspace file names `main` itself plus a library.
const PEER = { cwd: "/repo/main", repo_root: "/repo" };
const MAIN = { name: "main", path: "/repo/main" };
const LIB = { name: "lib", path: "/repo/lib" };

describe("filesLayout", () => {
  test("without a workspace file the cwd is PROJECT_ROOT, listed through the containment root", () => {
    expect(filesLayout(PEER, [])).toEqual({
      folders: [{ name: PROJECT_ROOT_NAME, path: "/repo/main", key: "main", isCwd: true }],
      routed: [],
      containmentRoot: "/repo",
    });
  });

  test("a workspace folder at the cwd is the cwd's folder, under its own name and not routed", () => {
    const layout = filesLayout(PEER, [LIB, MAIN]);
    expect(layout.folders).toEqual([
      { name: "lib", path: "/repo/lib", key: "/repo/lib", isCwd: false },
      { name: "main", path: "/repo/main", key: "main", isCwd: true },
    ]);
    expect(layout.routed).toEqual([LIB]);
  });

  test("with workspace folders but none at the cwd, PROJECT_ROOT comes first", () => {
    const layout = filesLayout(PEER, [LIB]);
    expect(layout.folders.map((f) => f.name)).toEqual([PROJECT_ROOT_NAME, "lib"]);
    expect(layout.routed).toEqual([LIB]);
  });

  test("a session with no repo_root keys its cwd folder as the containment root itself", () => {
    expect(filesLayout({ cwd: "/repo/main" }, []).folders[0]?.key).toBe("");
  });

  test("before the peer row arrives the containment root stands in for the cwd", () => {
    const layout = filesLayout(undefined, [LIB]);
    expect(layout.folders).toEqual([{ name: PROJECT_ROOT_NAME, path: "", key: "", isCwd: true }]);
    expect(layout.routed).toEqual([LIB]);
    expect(layout.containmentRoot).toBeUndefined();
  });
});

describe("favorite identity", () => {
  // The complaint this fixes: `docs/QUESTIONS.md` and its full path were two
  // favorites. Both name one file, so both read as one full path.
  test("a relative and an absolute spelling of one file are one favorite", () => {
    expect(
      favoriteFullPaths(["main/docs/QUESTIONS.md", "/repo/main/docs/QUESTIONS.md"], "/repo"),
    ).toEqual(["/repo/main/docs/QUESTIONS.md"]);
  });

  test("full paths are normalized before comparing", () => {
    expect(
      favoriteFullPaths(["/repo/main/./docs/../docs/a.md", "/repo/main/docs/a.md"], "/repo"),
    ).toEqual(["/repo/main/docs/a.md"]);
  });

  test("a relative entry cannot be placed before the containment root is known", () => {
    expect(fullPathOf("docs/a.md", undefined)).toBeNull();
    expect(favoriteFullPaths(["docs/a.md", "/x/b.md"], undefined)).toEqual(["/x/b.md"]);
  });
});

describe("groupByFolder", () => {
  const layout = filesLayout(PEER, [MAIN, LIB, { name: "nested", path: "/repo/lib/nested" }]);

  test("the cwd group comes first without a heading, then folders in section order, then others", () => {
    const groups = groupByFolder(
      ["/elsewhere/z.md", "/repo/lib/b.md", "/repo/main/docs/a.md", "/repo/main/README.md"],
      layout,
    );
    expect(groups).toEqual([
      {
        name: null,
        rows: [
          { full: "/repo/main/docs/a.md", key: "main/docs/a.md", label: "docs/a.md" },
          { full: "/repo/main/README.md", key: "main/README.md", label: "README.md" },
        ],
      },
      { name: "lib", rows: [{ full: "/repo/lib/b.md", key: "/repo/lib/b.md", label: "b.md" }] },
      {
        name: OTHERS_GROUP_NAME,
        rows: [{ full: "/elsewhere/z.md", key: "/elsewhere/z.md", label: "/elsewhere/z.md" }],
      },
    ]);
  });

  test("a folder with nothing in it gets no group", () => {
    expect(groupByFolder(["/repo/lib/b.md"], layout).map((g) => g.name)).toEqual(["lib"]);
  });

  test("nested folders take the deepest one", () => {
    expect(groupByFolder(["/repo/lib/nested/c.md"], layout)).toEqual([
      {
        name: "nested",
        rows: [{ full: "/repo/lib/nested/c.md", key: "/repo/lib/nested/c.md", label: "c.md" }],
      },
    ]);
  });

  // A sibling worktree inside the container but in no folder is still
  // contained, so its row routes root-relative like any link to it.
  test("an others path inside the containment root keeps its contained key", () => {
    expect(groupByFolder(["/repo/feature/x.md"], layout)).toEqual([
      {
        name: OTHERS_GROUP_NAME,
        rows: [{ full: "/repo/feature/x.md", key: "feature/x.md", label: "/repo/feature/x.md" }],
      },
    ]);
  });

  test("a favorited folder root is labelled `.` and keyed like its DirNode", () => {
    expect(groupByFolder(["/repo/main", "/repo/lib"], layout)).toEqual([
      { name: null, rows: [{ full: "/repo/main", key: "main", label: "." }] },
      { name: "lib", rows: [{ full: "/repo/lib", key: "/repo/lib", label: "." }] },
    ]);
  });

  test("prefix collision is not containment", () => {
    expect(groupByFolder(["/repo/library/x.md"], layout)[0]?.name).toBe(OTHERS_GROUP_NAME);
  });
});
