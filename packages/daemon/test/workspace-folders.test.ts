// DR-0026 workspace folder detection + JSONC parse + folders[] resolution.
// Every test constructs a real filesystem fixture (not mocks) so JSONC quirks,
// symlink escape rejection, and cwd-relative `path` resolution are exercised
// end-to-end.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverWorkspaceFolders, parseJsonc } from "../src/workspace-folders.ts";

function mkfixture(): string {
  return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-ws-")));
}

let cleanup: string[] = [];
beforeEach(() => {
  cleanup = [];
});
afterEach(() => {
  for (const dir of cleanup) fs.rmSync(dir, { recursive: true, force: true });
});

describe("parseJsonc", () => {
  test("plain JSON parses to a record", () => {
    // Baseline: nothing to strip — the parser must not garble a valid input.
    expect(parseJsonc('{"folders": [{"path": "."}]}')).toEqual({
      folders: [{ path: "." }],
    });
  });

  test("line comments (`// ...`) are stripped", () => {
    // VS Code's `.code-workspace` files can carry line comments; the parser
    // must not fall over on them.
    const src = `{
      // this comment must not become part of the JSON
      "folders": [{"path": "."}] // trailing comment on a value line
    }`;
    expect(parseJsonc(src)).toEqual({ folders: [{ path: "." }] });
  });

  test("block comments (`/* ... */`) are stripped", () => {
    const src = `{
      /* a
         multi-line
         block */
      "folders": [/* inline */ {"path": "."}]
    }`;
    expect(parseJsonc(src)).toEqual({ folders: [{ path: "." }] });
  });

  test("trailing commas in objects and arrays are stripped", () => {
    // JSONC allows trailing commas; JSON.parse does not — the strip must
    // handle both `, }` and `, ]` (with whitespace between).
    const src = `{
      "folders": [
        {"path": "a"},
        {"path": "b"},
      ],
    }`;
    expect(parseJsonc(src)).toEqual({ folders: [{ path: "a" }, { path: "b" }] });
  });

  test("string literals are not mangled by the comment / comma strippers", () => {
    // A `//` inside a string is legitimate content, not a comment: the parser
    // tracks in-string state so URL-like values pass through intact.
    // A `,` immediately before `}` inside a string is also legitimate.
    const src = `{
      "folders": [{"path": "a", "name": "has // slashes"}]
    }`;
    const parsed = parseJsonc(src) as { folders: { path: string; name: string }[] };
    expect(parsed.folders[0]!.name).toBe("has // slashes");
  });

  test("a literal `, }` / `, ]` inside a string value is preserved", () => {
    // The trailing-comma stripper must be string-aware: a folder path or name
    // legitimately containing `, }` is content, not JSONC syntax. A naive
    // whole-text regex would delete the comma and corrupt the path — which
    // then resolves (or fails to resolve) to the wrong directory.
    const src = '{"folders": [{"path": "dir with , }", "name": "n, ]"}]}';
    expect(parseJsonc(src)).toEqual({
      folders: [{ path: "dir with , }", name: "n, ]" }],
    });
  });

  test("malformed JSON returns undefined instead of throwing", () => {
    // Callers rely on undefined-on-failure to skip the file silently; a thrown
    // exception would abort the whole workspace-folders discovery pass.
    expect(parseJsonc('{ "folders": [')).toBeUndefined();
    expect(parseJsonc("not json at all")).toBeUndefined();
  });
});

describe("discoverWorkspaceFolders", () => {
  test("returns [] when cwd has no `.code-workspace` file", () => {
    // Absence must be silent (no error, empty allowlist) — the daemon uses this
    // exact shape to suppress the workspace_folders field on the wire.
    const cwd = mkfixture();
    cleanup.push(cwd);
    fs.writeFileSync(path.join(cwd, "README.md"), "hi");
    expect(discoverWorkspaceFolders(cwd)).toEqual([]);
  });

  test("resolves `folders[].path` relative to the workspace file, not cwd", () => {
    // A `.code-workspace` at cwd's top level with `path: "."` resolves to cwd
    // itself; a subdir-authored one would resolve differently. Kawaz's kuu
    // workspace uses `..` to reach sibling repos, so this must not silently
    // treat paths as cwd-relative.
    const parent = mkfixture();
    cleanup.push(parent);
    const cwd = path.join(parent, "main");
    const sibling = path.join(parent, "sibling", "main");
    fs.mkdirSync(cwd);
    fs.mkdirSync(sibling, { recursive: true });
    fs.writeFileSync(
      path.join(cwd, "example.code-workspace"),
      JSON.stringify({
        folders: [
          { name: "self", path: "." },
          { name: "sib", path: "../sibling/main" },
        ],
      }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result.map((f) => [f.name, f.path])).toEqual([
      ["self", cwd],
      ["sib", sibling],
    ]);
  });

  test("realpath-normalizes folders reached through symlinks", () => {
    // If the workspace lists a symlinked path, the resolved entry should be
    // the target's realpath — otherwise the daemon's later realpath check
    // would treat any client-side reference through the symlink as an escape.
    const parent = mkfixture();
    cleanup.push(parent);
    const cwd = path.join(parent, "cwd");
    const target = path.join(parent, "real-target");
    fs.mkdirSync(cwd);
    fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(parent, "link"));
    fs.writeFileSync(
      path.join(cwd, "s.code-workspace"),
      JSON.stringify({ folders: [{ path: "../link" }] }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result).toHaveLength(1);
    expect(result[0]!.path).toBe(fs.realpathSync(target));
  });

  test("silently skips folders whose path doesn't exist", () => {
    // A stale workspace entry (e.g. removed worktree) must not become an
    // allowlist grant for a directory that could later be recreated with
    // different contents.
    const cwd = mkfixture();
    cleanup.push(cwd);
    fs.writeFileSync(
      path.join(cwd, "x.code-workspace"),
      JSON.stringify({
        folders: [{ path: "." }, { path: "./does-not-exist" }],
      }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result.map((f) => f.path)).toEqual([cwd]);
  });

  test("skips folder entries that point at a non-directory", () => {
    // The allowlist is about directories the client can browse; a file listed
    // in `folders[]` must be dropped rather than admitted as a browsable root.
    const cwd = mkfixture();
    cleanup.push(cwd);
    fs.writeFileSync(path.join(cwd, "not-a-dir"), "hi");
    fs.writeFileSync(
      path.join(cwd, "y.code-workspace"),
      JSON.stringify({ folders: [{ path: "not-a-dir" }, { path: "." }] }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result.map((f) => f.path)).toEqual([cwd]);
  });

  test("deduplicates folders that resolve to the same realpath", () => {
    // Two workspace files (or two folders in one workspace file) referring to
    // the same directory should show once — the DR promises no duplicates.
    const parent = mkfixture();
    cleanup.push(parent);
    const cwd = path.join(parent, "cwd");
    fs.mkdirSync(cwd);
    fs.writeFileSync(
      path.join(cwd, "a.code-workspace"),
      JSON.stringify({ folders: [{ path: "." }] }),
    );
    fs.writeFileSync(
      path.join(cwd, "b.code-workspace"),
      JSON.stringify({ folders: [{ name: "dup", path: "." }] }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result).toHaveLength(1);
    // First occurrence wins (a.code-workspace sorts before b.code-workspace) —
    // no name from the duplicate leaks through.
    expect(result[0]!.name).toBe(path.basename(cwd));
  });

  test("falls back to the folder basename when `name` is absent", () => {
    // Matches VS Code's own default (folder root's basename in the sidebar) —
    // an empty `name` field must not surface as an empty display name.
    const cwd = mkfixture();
    cleanup.push(cwd);
    fs.writeFileSync(
      path.join(cwd, "n.code-workspace"),
      JSON.stringify({ folders: [{ path: "." }] }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result[0]!.name).toBe(path.basename(cwd));
  });

  test("does not recurse into subdirectories looking for `.code-workspace`", () => {
    // DR-0026 §2 says "cwd 直下" — a workspace file nested under `sub/` must
    // not contribute folders. Otherwise a rogue workspace file deep in a
    // dependency tree could widen the allowlist.
    const cwd = mkfixture();
    cleanup.push(cwd);
    const nested = path.join(cwd, "sub");
    fs.mkdirSync(nested);
    fs.writeFileSync(
      path.join(nested, "hidden.code-workspace"),
      JSON.stringify({ folders: [{ path: ".." }] }),
    );
    expect(discoverWorkspaceFolders(cwd)).toEqual([]);
  });

  test("malformed workspace file yields no folders (does not throw)", () => {
    // Broken JSON must not take out the whole discovery pass — later files
    // in the same cwd still get their chance.
    const cwd = mkfixture();
    cleanup.push(cwd);
    fs.writeFileSync(path.join(cwd, "bad.code-workspace"), "{ this is not json");
    fs.writeFileSync(
      path.join(cwd, "good.code-workspace"),
      JSON.stringify({ folders: [{ path: "." }] }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result.map((f) => f.path)).toEqual([cwd]);
  });

  test("rejects the shape `{}` (no folders array) without throwing", () => {
    // A workspace file that doesn't declare `folders[]` at all contributes
    // nothing, same as an entirely missing file.
    const cwd = mkfixture();
    cleanup.push(cwd);
    fs.writeFileSync(
      path.join(cwd, "empty.code-workspace"),
      JSON.stringify({ settings: { foo: "bar" } }),
    );
    expect(discoverWorkspaceFolders(cwd)).toEqual([]);
  });

  test("security: overbroad folder roots (`/`, `$HOME`, ancestors of `$HOME`) are dropped", () => {
    // A malicious (or careless) workspace file listing `/` or the user's home
    // as a folder would turn the DR-0026 directory-prefix allowlist into an
    // unbounded read grant for the webui. Same guard policy as
    // validateRepoRoot's repo_root widening: reject `/`, `$HOME` itself, and
    // any ancestor of `$HOME`; normal repo checkouts (descendants of `$HOME`)
    // are unaffected — this very fixture (under tmpdir) must survive.
    const cwd = mkfixture();
    cleanup.push(cwd);
    fs.writeFileSync(
      path.join(cwd, "evil.code-workspace"),
      JSON.stringify({
        folders: [
          { name: "root", path: "/" },
          { name: "home", path: os.homedir() },
          { name: "self", path: "." },
        ],
      }),
    );
    const result = discoverWorkspaceFolders(cwd);
    expect(result.map((f) => f.path)).toEqual([cwd]);
  });

  test("returns [] for a non-absolute or missing cwd", () => {
    // Defensive: caller sanitizes, but discover* is the last line — a bogus
    // cwd must not throw or leak an unbounded scan.
    expect(discoverWorkspaceFolders("relative/cwd")).toEqual([]);
    expect(discoverWorkspaceFolders("/nonexistent-ccmsg-test")).toEqual([]);
  });
});
