// dir_tree (DR-0018 Phase 1): containment-checked, bounded directory-only
// traversal used by the session launcher cwd picker.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { DirTreeEntry, SessionLauncherConfig } from "@ccmsg/protocol";
import { dirTree } from "../src/dir-tree.ts";

function config(root: string, depth = 2): SessionLauncherConfig {
  return {
    root_dirs: [root],
    default_prompt: "",
    shell: "bash",
    command: "run",
    timeout_seconds: 10,
    dir_tree_depth: depth,
  };
}

function names(entries: DirTreeEntry[]): string[] {
  return entries.map((entry) => path.basename(entry.path));
}

describe("dirTree", () => {
  let base: string;
  let root: string;
  let outside: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-dir-tree-"));
    root = path.join(base, "root");
    outside = path.join(base, "outside");
    fs.mkdirSync(root);
    fs.mkdirSync(outside);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // depth=2 means two directory levels below each requested root. Boundary
  // nodes omit children, which is the UI's marker that lazy fetch is available.
  test("default depth returns two levels and leaves the third unexplored", () => {
    fs.mkdirSync(path.join(root, "alpha", "beta", "gamma"), { recursive: true });
    const result = dirTree(config(root), [root], undefined, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(names(result.data.entries)).toEqual(["alpha"]);
    const alpha = result.data.entries[0]!;
    expect(names(alpha.children!)).toEqual(["beta"]);
    expect(alpha.children![0]!.children).toBeUndefined();
  });

  // Lazy expansion requests a contained node as a new root with depth=1. The
  // response is that node's immediate children, not a duplicate wrapper node.
  test("a contained subdirectory can be fetched lazily at depth one", () => {
    fs.mkdirSync(path.join(root, "repo", "workspace", "nested"), { recursive: true });
    const lazyRoot = path.join(root, "repo");
    const result = dirTree(config(root), [lazyRoot], 1, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(names(result.data.entries)).toEqual(["workspace"]);
    expect(result.data.entries[0]!.children).toBeUndefined();
  });

  // A lexical absolute path outside every configured root is never traversed;
  // this is the primary arbitrary-filesystem-read boundary of the op.
  test("a requested root outside configured roots is path_forbidden", () => {
    const result = dirTree(config(root), [outside], 1, undefined);
    expect(result).toMatchObject({ ok: false, code: "path_forbidden" });
  });

  // Lexically the link lives below root, but realpath points outside. Realpath
  // containment must win so a symlink cannot expand the launcher's universe.
  test("a requested root that escapes through a symlink is path_forbidden", () => {
    const link = path.join(root, "outside-link");
    fs.symlinkSync(outside, link);
    const result = dirTree(config(root), [link], 1, undefined);
    expect(result).toMatchObject({ ok: false, code: "path_forbidden" });
  });

  // Dot directories contain implementation/private state (.git, .jj, etc.) and
  // DR-0018 explicitly excludes them from the cwd picker at every depth.
  test("dot directories are excluded at every level", () => {
    fs.mkdirSync(path.join(root, ".git"));
    fs.mkdirSync(path.join(root, "visible", ".jj"), { recursive: true });
    fs.mkdirSync(path.join(root, "visible", "child"));
    const result = dirTree(config(root), [root], 2, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(names(result.data.entries)).toEqual(["visible"]);
    expect(names(result.data.entries[0]!.children!)).toEqual(["child"]);
  });

  // The picker selects directories only; ordinary files must not appear even
  // when they share the same names or sort positions as valid directories.
  test("ordinary files are excluded", () => {
    fs.writeFileSync(path.join(root, "a-file"), "x");
    fs.mkdirSync(path.join(root, "b-dir"));
    const result = dirTree(config(root), [root], 1, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(names(result.data.entries)).toEqual(["b-dir"]);
  });

  // A symlink to an in-root directory is a legitimate cwd alias. It is shown as
  // a directory and remains traversable, unlike the escaping-link case above.
  test("an in-root directory symlink is included and traversed", () => {
    fs.mkdirSync(path.join(root, "target", "child"), { recursive: true });
    fs.symlinkSync(path.join(root, "target"), path.join(root, "alias"));
    const result = dirTree(config(root), [root], 2, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const alias = result.data.entries.find((entry) => path.basename(entry.path) === "alias")!;
    expect(alias.is_dir).toBe(true);
    expect(names(alias.children!)).toEqual(["child"]);
  });

  // Filtering matches the root-relative path and retains ancestors required to
  // reach a matching node, while unrelated branches disappear.
  test("filter keeps matching paths and their ancestors only", () => {
    fs.mkdirSync(path.join(root, "group", "foo-project"), { recursive: true });
    fs.mkdirSync(path.join(root, "group", "bar-project"), { recursive: true });
    fs.mkdirSync(path.join(root, "unrelated"));
    const result = dirTree(config(root), [root], 2, "foo");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(names(result.data.entries)).toEqual(["group"]);
    expect(names(result.data.entries[0]!.children!)).toEqual(["foo-project"]);
  });

  // A missing requested root is distinguishable from a forbidden existing path
  // so the UI can report a stale/deleted directory accurately.
  test("a missing requested root returns not_found", () => {
    const result = dirTree(config(root), [path.join(root, "gone")], 1, undefined);
    expect(result).toMatchObject({ ok: false, code: "not_found" });
  });

  // No valid launcher config means there is no administrator-defined boundary;
  // the op fails closed instead of treating client roots as authoritative.
  test("an unconfigured launcher returns launcher_not_configured", () => {
    const result = dirTree(undefined, [root], 1, undefined);
    expect(result).toMatchObject({ ok: false, code: "launcher_not_configured" });
  });

  // depth expresses "how many levels to return" and lazy expansion always asks
  // for at least 1; zero and negative values have no meaning in that contract,
  // so they are rejected as invalid_args instead of being clamped to something
  // the client did not ask for.
  test("zero and negative requested depth are invalid_args", () => {
    for (const depth of [0, -1]) {
      const result = dirTree(config(root), [root], depth, undefined);
      expect(result).toMatchObject({ ok: false, code: "invalid_args" });
    }
  });

  // Client-supplied depth is bounded independently of config so one request
  // cannot trigger an arbitrarily deep synchronous filesystem walk.
  test("excessive requested depth is clamped to a finite walk", () => {
    let cursor = root;
    for (let i = 1; i <= 7; i++) {
      cursor = path.join(cursor, `d${i}`);
      fs.mkdirSync(cursor);
    }
    const result = dirTree(config(root), [root], 100, undefined);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    let entry = result.data.entries[0]!;
    let returnedLevels = 1;
    while (entry.children) {
      entry = entry.children[0]!;
      returnedLevels++;
    }
    expect(returnedLevels).toBe(5);
    expect(path.basename(entry.path)).toBe("d5");
  });
});
