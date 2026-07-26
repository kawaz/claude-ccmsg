// .gitignore pattern compilation for the fs_find walk. The cases here are the
// gitignore(5) grammar this repo commits to supporting (see gitignore.ts's
// header for what is deliberately out of scope) — each one is a pattern shape
// that appears in real .gitignore files, not an exhaustive fuzz of the syntax.
import { describe, expect, test } from "bun:test";
import { compileIgnoreLayer, isIgnored } from "../src/gitignore.ts";

/** Convenience: one layer at `/repo`, asked about a repo-relative path. */
function ignored(patterns: string, relPath: string, isDir = false): boolean {
  const layer = compileIgnoreLayer("/repo", patterns);
  return isIgnored(`/repo/${relPath}`, isDir, [layer]);
}

describe("basic patterns", () => {
  test("a bare name matches at any depth, as a file or a directory", () => {
    expect(ignored("node_modules", "node_modules", true)).toBe(true);
    expect(ignored("node_modules", "packages/webui/node_modules", true)).toBe(true);
    expect(ignored("node_modules", "src/node_modules.txt")).toBe(false);
  });

  test("matching a directory hides everything under it", () => {
    // The walk prunes ignored directories so it rarely asks, but a rule from a
    // parent .gitignore is still evaluated against deep paths.
    expect(ignored("node_modules", "node_modules/preact/dist/index.js")).toBe(true);
  });

  test("blank lines and # comments contribute no rules", () => {
    expect(ignored("\n\n# node_modules\n", "node_modules", true)).toBe(false);
  });

  test("a \\# escape makes a leading hash literal", () => {
    expect(ignored("\\#tmp", "#tmp")).toBe(true);
  });

  test("trailing spaces are stripped unless escaped", () => {
    expect(ignored("dist   ", "dist", true)).toBe(true);
    expect(ignored("dist\\ ", "dist ", true)).toBe(true);
  });
});

describe("anchoring", () => {
  test("a leading / anchors to the .gitignore's own directory", () => {
    expect(ignored("/dist", "dist", true)).toBe(true);
    expect(ignored("/dist", "packages/webui/dist", true)).toBe(false);
  });

  test("an embedded / anchors too, even without a leading one", () => {
    expect(ignored("docs/build", "docs/build", true)).toBe(true);
    expect(ignored("docs/build", "packages/docs/build", true)).toBe(false);
  });

  test("a trailing / alone does not anchor — it restricts to directories", () => {
    expect(ignored("build/", "packages/x/build", true)).toBe(true);
  });
});

describe("directory-only patterns", () => {
  test("a trailing / matches directories but not same-named files", () => {
    expect(ignored("logs/", "logs", true)).toBe(true);
    expect(ignored("logs/", "logs")).toBe(false);
  });

  test("without a trailing / both a file and a directory match", () => {
    expect(ignored("logs", "logs", true)).toBe(true);
    expect(ignored("logs", "logs")).toBe(true);
  });
});

describe("wildcards", () => {
  test("* matches within one path segment only", () => {
    expect(ignored("*.log", "debug.log")).toBe(true);
    expect(ignored("*.log", "var/debug.log")).toBe(true);
    expect(ignored("logs/*.log", "logs/debug.log")).toBe(true);
    // The point of * stopping at "/": this must NOT match, or logs/*.log
    // would be indistinguishable from logs/**/*.log.
    expect(ignored("logs/*.log", "logs/nested/debug.log")).toBe(false);
  });

  test("? matches exactly one non-separator character", () => {
    expect(ignored("file?.ts", "file1.ts")).toBe(true);
    expect(ignored("file?.ts", "file12.ts")).toBe(false);
    expect(ignored("file?.ts", "file/.ts")).toBe(false);
  });

  test("[...] matches one character from the set, and [!...] negates it", () => {
    expect(ignored("file[0-9].ts", "file7.ts")).toBe(true);
    expect(ignored("file[0-9].ts", "filex.ts")).toBe(false);
    expect(ignored("file[!0-9].ts", "filex.ts")).toBe(true);
    expect(ignored("file[!0-9].ts", "file7.ts")).toBe(false);
  });

  test("a trailing /** matches everything below, and only below", () => {
    expect(ignored("vendor/**", "vendor/a/b.txt")).toBe(true);
    expect(ignored("vendor/**", "vendored.txt")).toBe(false);
  });

  test("an interior /**/ matches zero or more directories", () => {
    expect(ignored("a/**/b", "a/b", true)).toBe(true);
    expect(ignored("a/**/b", "a/x/b", true)).toBe(true);
    expect(ignored("a/**/b", "a/x/y/b", true)).toBe(true);
    expect(ignored("a/**/b", "x/a/b", true)).toBe(false);
  });

  test("a leading **/ matches at any depth", () => {
    expect(ignored("**/tmp", "tmp", true)).toBe(true);
    expect(ignored("**/tmp", "a/b/tmp", true)).toBe(true);
  });

  test("a malformed pattern is dropped rather than failing the whole file", () => {
    // Losing one rule costs some filtering; rejecting the file would flood the
    // results with the trees its other, valid lines were hiding.
    const layer = compileIgnoreLayer("/repo", "[unterminated\nnode_modules");
    expect(isIgnored("/repo/node_modules", true, [layer])).toBe(true);
  });
});

describe("negation", () => {
  test("a later ! re-includes what an earlier rule excluded", () => {
    expect(ignored("*.log\n!keep.log", "debug.log")).toBe(true);
    expect(ignored("*.log\n!keep.log", "keep.log")).toBe(false);
  });

  test("last match wins, so order within the file decides", () => {
    expect(ignored("!keep.log\n*.log", "keep.log")).toBe(true);
  });

  test("a \\! escape makes a leading bang literal", () => {
    expect(ignored("\\!important", "!important")).toBe(true);
  });
});

describe("layer precedence", () => {
  const outer = compileIgnoreLayer("/repo", "*.log");
  const inner = compileIgnoreLayer("/repo/pkg", "!debug.log");

  test("a nearer .gitignore overrides a conflicting rule above it", () => {
    expect(isIgnored("/repo/pkg/debug.log", false, [outer, inner])).toBe(false);
    // Outside the inner layer's subtree the outer rule still stands.
    expect(isIgnored("/repo/other/debug.log", false, [outer, inner])).toBe(true);
  });

  test("a path outside a layer's subtree is not matched by that layer", () => {
    // Guards the `path.relative` fallback: without the ".." check, a sibling
    // path would be tested as "../other/debug.log" and could match by accident.
    expect(isIgnored("/elsewhere/debug.log", false, [outer])).toBe(false);
  });

  test("no layers means nothing is ignored", () => {
    expect(isIgnored("/repo/debug.log", false, [])).toBe(false);
  });
});
