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
  touchedFileGroups,
} from "../src/client/files-sections.ts";

// A jj-style layout: the containment root is the repo container, the session
// works in `main`, and the workspace file names `main` itself plus a library.
const PEER = { cwd: "/repo/main", repo_root: "/repo" };
const MAIN = { name: "main", path: "/repo/main", is_cwd: true as const };
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

  // The daemon realpaths both sides; the peer row keeps the spelling the
  // session announced. A cwd reached through a symlink is still its folder.
  test("a cwd announced through a symlink still matches the folder the daemon marked", () => {
    const layout = filesLayout({ cwd: "/link/main", repo_root: "/link" }, [
      { name: "main", path: "/real/main", is_cwd: true },
    ]);
    expect(layout.folders).toEqual([
      { name: "main", path: "/link/main", key: "main", isCwd: true },
    ]);
    expect(layout.routed).toEqual([]);
  });

  test("a folder spelled like the cwd but not marked is not the cwd's", () => {
    expect(
      filesLayout(PEER, [{ name: "main", path: "/repo/main" }]).folders.map((f) => f.name),
    ).toEqual([PROJECT_ROOT_NAME, "main"]);
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

  test("the cwd group comes first, then folders in section order, then others", () => {
    const groups = groupByFolder(
      ["/elsewhere/z.md", "/repo/lib/b.md", "/repo/main/docs/a.md", "/repo/main/README.md"],
      layout,
    );
    expect(groups).toEqual([
      {
        name: "main",
        isCwd: true,
        rows: [
          { full: "/repo/main/docs/a.md", key: "main/docs/a.md", label: "docs/a.md" },
          { full: "/repo/main/README.md", key: "main/README.md", label: "README.md" },
        ],
      },
      {
        name: "lib",
        isCwd: false,
        rows: [{ full: "/repo/lib/b.md", key: "/repo/lib/b.md", label: "b.md" }],
      },
      {
        name: OTHERS_GROUP_NAME,
        isCwd: false,
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
        isCwd: false,
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
        isCwd: false,
        rows: [{ full: "/repo/feature/x.md", key: "feature/x.md", label: "/repo/feature/x.md" }],
      },
    ]);
  });

  test("a favorited folder root is labelled `.` and keyed like its DirNode", () => {
    expect(groupByFolder(["/repo/main", "/repo/lib"], layout)).toEqual([
      { name: "main", isCwd: true, rows: [{ full: "/repo/main", key: "main", label: "." }] },
      { name: "lib", isCwd: false, rows: [{ full: "/repo/lib", key: "/repo/lib", label: "." }] },
    ]);
  });

  test("prefix collision is not containment", () => {
    expect(groupByFolder(["/repo/library/x.md"], layout)[0]?.name).toBe(OTHERS_GROUP_NAME);
  });

  // The tree lists directories before files at each level, then by name.
  test("rows of one level are directories first, then files, as the tree lists them", () => {
    const dirs = new Set(["main/docs/decisions", "main/docs/issue"]);
    const labels = (
      groupByFolder(
        [
          "/repo/main/docs/decisions",
          "/repo/main/docs/DESIGN-ja.md",
          "/repo/main/docs/issue",
          "/repo/main/docs/QUESTIONS.md",
          "/repo/main/docs/ROADMAP.md",
          "/repo/main/docs/STRUCTURE.md",
        ],
        layout,
        (key) => dirs.has(key),
      )[0]?.rows ?? []
    ).map((r) => r.label);
    expect(labels).toEqual([
      "docs/decisions",
      "docs/issue",
      "docs/DESIGN-ja.md",
      "docs/QUESTIONS.md",
      "docs/ROADMAP.md",
      "docs/STRUCTURE.md",
    ]);
  });

  test("paths of different depth follow the tree's depth-first order", () => {
    const dirs = new Set(["main/a/d"]);
    const labels = (
      groupByFolder(["/repo/main/a.md", "/repo/main/a/d", "/repo/main/a/b/c.md"], layout, (key) =>
        dirs.has(key),
      )[0]?.rows ?? []
    ).map((r) => r.label);
    expect(labels).toEqual(["a/b/c.md", "a/d", "a.md"]);
  });
});

describe("touchedFileGroups (DR-0024)", () => {
  const layout = filesLayout(PEER, [MAIN, LIB]);
  const rows = (groups: ReturnType<typeof touchedFileGroups>) =>
    groups.map((g) => [g.name, g.rows.map((r) => r.label)]);

  test("the cwd group comes first, then workspace folders, then others", () => {
    const groups = touchedFileGroups(
      [
        { path: "/elsewhere/z.md", origin: "read" },
        { path: "/repo/lib/b.md", origin: "edit" },
        { path: "main/src/a.ts", origin: "edit" },
      ],
      layout,
    );
    expect(groups).toEqual([
      {
        name: "main",
        isCwd: true,
        rows: [{ full: "/repo/main/src/a.ts", key: "main/src/a.ts", label: "src/a.ts" }],
      },
      {
        name: "lib",
        isCwd: false,
        rows: [{ full: "/repo/lib/b.md", key: "/repo/lib/b.md", label: "b.md" }],
      },
      {
        name: OTHERS_GROUP_NAME,
        isCwd: false,
        rows: [{ full: "/elsewhere/z.md", key: "/elsewhere/z.md", label: "/elsewhere/z.md" }],
      },
    ]);
  });

  test("the cwd group leaves out reads; edits and attachments stay", () => {
    const groups = touchedFileGroups(
      [
        { path: "main/read.ts", origin: "read" },
        { path: "main/edited.ts", origin: "edit" },
        { path: "main/attached.md", origin: "attachment" },
      ],
      layout,
    );
    expect(rows(groups)).toEqual([["main", ["attached.md", "edited.ts"]]]);
  });

  test("the other groups keep their reads", () => {
    const groups = touchedFileGroups(
      [
        { path: "/repo/lib/read.ts", origin: "read" },
        { path: "/elsewhere/read.md", origin: "read" },
      ],
      layout,
    );
    expect(rows(groups)).toEqual([
      ["lib", ["read.ts"]],
      [OTHERS_GROUP_NAME, ["/elsewhere/read.md"]],
    ]);
  });

  test("a cwd group of reads only is not shown at all", () => {
    expect(touchedFileGroups([{ path: "main/read.ts", origin: "read" }], layout)).toEqual([]);
  });

  test("one file under two spellings is one row, kept when any entry for it is not a read", () => {
    const groups = touchedFileGroups(
      [
        { path: "main/a.ts", origin: "read" },
        { path: "/repo/main/a.ts", origin: "edit" },
      ],
      layout,
    );
    expect(rows(groups)).toEqual([["main", ["a.ts"]]]);
  });

  test("root-relative entries wait for the containment root; absolute ones show at once", () => {
    const before = filesLayout(undefined, []);
    expect(
      rows(
        touchedFileGroups(
          [
            { path: "main/a.ts", origin: "edit" },
            { path: "/elsewhere/z.md", origin: "read" },
          ],
          before,
        ),
      ),
    ).toEqual([[OTHERS_GROUP_NAME, ["/elsewhere/z.md"]]]);
  });
});
