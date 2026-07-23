// Parser + resolver contract for `filepath[:LINE[:COL]]` / `filepath[:L1-L2]`
// tokens (kawaz r46 mid=55). Two independent responsibilities are covered
// separately:
//   - parseFilePathRef: token -> {path, line?, end?} or null (shape rules)
//   - resolveFilePathRef: (ref, sender ctx) -> fileHref URL or null
//     (relative/absolute normalization against cwd/repo_root)
import { describe, expect, test } from "bun:test";
import {
  looksLikePath,
  looksLikeFile,
  parseFilePathRef,
  resolveFilePathRef,
  inlineCodeToFileHref,
  refToAbsolutePath,
  hrefFromStatEntry,
  extractInlineCodeTokens,
} from "../src/client/filepath-ref.ts";
import { fileHref } from "../src/client/locator.ts";

describe("looksLikePath", () => {
  test("accepts absolute / relative / repo-relative shapes", () => {
    expect(looksLikePath("/etc/hosts")).toBe(true);
    expect(looksLikePath("./foo.ts")).toBe(true);
    expect(looksLikePath("../bar")).toBe(true);
    expect(looksLikePath("packages/webui/foo.ts")).toBe(true);
  });
  test("rejects bare words and prose-like colonised tokens", () => {
    expect(looksLikePath("foo")).toBe(false);
    expect(looksLikePath("Cargo.toml")).toBe(false); // bare basename, no /
    expect(looksLikePath("Foo::bar")).toBe(false);
  });
  test("rejects whitespace / NUL / urls", () => {
    expect(looksLikePath("foo bar/baz")).toBe(false);
    expect(looksLikePath("https://example.com/x")).toBe(false);
    expect(looksLikePath("")).toBe(false);
  });
});

describe("looksLikeFile — file vs directory heuristic (kawaz r46 m56)", () => {
  test("accepts common extensions", () => {
    expect(looksLikeFile("docs/x.md")).toBe(true);
    expect(looksLikeFile("index.ejs")).toBe(true);
    expect(looksLikeFile("Cargo.toml")).toBe(true);
    expect(looksLikeFile("foo/bar/index.html")).toBe(true);
  });
  test("rejects directory-shaped tokens", () => {
    // The exact m56 example: dated worktree dir with dashes, no extension.
    expect(
      looksLikeFile(
        "/Users/kawaz/.local/share/repos/github.com/emeradaco/antenna/2632-2631-fix-remove-cc-institutions-back-button",
      ),
    ).toBe(false);
    expect(looksLikeFile("packages/webui")).toBe(false);
    expect(looksLikeFile("some/dir/")).toBe(false);
    expect(looksLikeFile(".env")).toBe(false); // dotfile, no extension segment
    expect(looksLikeFile("foo.")).toBe(false); // trailing dot
  });
  test("rejects too-long / non-alphanumeric ext", () => {
    // `fix/2631-remove-cc-institutions-back-button` — the dashy suffix isn't
    // an extension. `.back-button` fails the [A-Za-z0-9] restriction.
    expect(looksLikeFile("fix/2631-remove-cc-institutions-back-button")).toBe(false);
  });
});

describe("parseFilePathRef — suffix shapes", () => {
  test("no suffix, file-shaped extension -> qualifies", () => {
    expect(parseFilePathRef("packages/foo/bar.ts")).toEqual({ path: "packages/foo/bar.ts" });
  });
  test("no suffix, no extension -> null (kawaz r46 m56: dir path stays plain)", () => {
    // Even though this passes looksLikePath (absolute), it lacks both an
    // extension and line info, so parseFilePathRef refuses it.
    expect(
      parseFilePathRef(
        "/Users/kawaz/.local/share/repos/github.com/emeradaco/antenna/2632-2631-fix-remove-cc-institutions-back-button",
      ),
    ).toBeNull();
    expect(parseFilePathRef("docs/decision-records/2632")).toBeNull();
  });
  test("branch-name shape -> null (kawaz r46 m56: `fix/…-back-button`)", () => {
    // Branch names look path-shaped (`/` present) but aren't files. The
    // trailing segment has no file-shaped extension (dashy word), so the
    // "extension OR line info" gate rejects it.
    expect(parseFilePathRef("fix/2631-remove-cc-institutions-back-button")).toBeNull();
  });
  test("line info alone qualifies extension-less paths", () => {
    // Some real files have no extension (`Makefile`, `LICENSE`); if the
    // author bothered to write `:10`, that's evidence enough on its own.
    expect(parseFilePathRef("scripts/Makefile:10")).toEqual({
      path: "scripts/Makefile",
      line: 10,
    });
  });
  test("`:L<n>` single line", () => {
    expect(parseFilePathRef("src/a.ts:L42")).toEqual({ path: "src/a.ts", line: 42 });
  });
  test("`:L<n>-<m>` range", () => {
    expect(parseFilePathRef("src/a.ts:L10-20")).toEqual({
      path: "src/a.ts",
      line: 10,
      end: 20,
    });
  });
  test("`:<n>` compiler style", () => {
    expect(parseFilePathRef("src/a.ts:42")).toEqual({ path: "src/a.ts", line: 42 });
  });
  test("`:<n>:<col>` — column dropped, single-line highlight", () => {
    // FileViewer only supports whole-line highlight, so col drops out of the
    // resolved range (line === end path in the resolver).
    expect(parseFilePathRef("src/a.ts:42:7")).toEqual({ path: "src/a.ts", line: 42 });
  });
  test("absolute path with `:L`", () => {
    expect(parseFilePathRef("/tmp/x.md:L3-4")).toEqual({
      path: "/tmp/x.md",
      line: 3,
      end: 4,
    });
  });
  test("inverted range keeps path but drops the bad end", () => {
    expect(parseFilePathRef("a/b.ts:L10-5")).toEqual({ path: "a/b.ts", line: 10 });
  });
  test("returns null for non-path tokens", () => {
    expect(parseFilePathRef("foo")).toBeNull();
    expect(parseFilePathRef("Foo::bar")).toBeNull();
    expect(parseFilePathRef("2:3")).toBeNull();
  });
  test("trims surrounding backticks (defensive; mdast inlineCode.value has none)", () => {
    expect(parseFilePathRef("`src/a.ts:5`")).toEqual({ path: "src/a.ts", line: 5 });
  });
});

describe("resolveFilePathRef", () => {
  const CTX = {
    sid: "s1",
    cwd: "/repo/pkg",
    repoRoot: "/repo",
  };

  test("`./` prefix anchors at cwd then rebases to repoRoot", () => {
    // `./x.ts` under cwd `/repo/pkg` -> abs `/repo/pkg/x.ts` -> repo-relative
    // `pkg/x.ts`, no line info -> no `:L…` suffix on the href.
    expect(resolveFilePathRef({ path: "./x.ts" }, CTX)).toBe(fileHref("s1", "pkg/x.ts"));
  });

  test("bare relative without ./ is treated as repo-root-relative (matches Claude Code output style)", () => {
    // Claude Code cites files as `packages/foo/bar.ts` — repo-root-relative,
    // not cwd-relative. Interpreting bare tokens against base directly avoids
    // silently double-nesting when the writer meant repo root.
    expect(resolveFilePathRef({ path: "packages/foo.ts" }, CTX)).toBe(
      fileHref("s1", "packages/foo.ts"),
    );
  });

  test("absolute inside repoRoot -> stripped to repo-relative", () => {
    expect(resolveFilePathRef({ path: "/repo/packages/webui/foo.ts", line: 5 }, CTX)).toBe(
      fileHref("s1", "packages/webui/foo.ts", { start: 5, end: 5 }),
    );
  });

  test("range preserved end-to-end", () => {
    expect(resolveFilePathRef({ path: "/repo/a.md", line: 3, end: 10 }, CTX)).toBe(
      fileHref("s1", "a.md", { start: 3, end: 10 }),
    );
  });

  test("absolute path outside repo_root/cwd -> null (no external allowlist)", () => {
    expect(resolveFilePathRef({ path: "/etc/hosts" }, CTX)).toBeNull();
  });

  test("`..` escapes into repo_root correctly", () => {
    // From cwd `/repo/pkg`, `../a.ts` -> `/repo/a.ts` -> repo-relative `a.ts`.
    expect(resolveFilePathRef({ path: "../a.ts" }, CTX)).toBe(fileHref("s1", "a.ts"));
  });

  test("no repo_root -> cwd is the base", () => {
    const c = { sid: "s2", cwd: "/w" };
    expect(resolveFilePathRef({ path: "./x.ts", line: 1 }, c)).toBe(
      fileHref("s2", "x.ts", { start: 1, end: 1 }),
    );
  });

  test("neither cwd nor repo_root and a relative path -> null", () => {
    expect(resolveFilePathRef({ path: "x.ts" }, { sid: "s3" })).toBeNull();
  });

  test("path that normalises to the base directory itself -> null", () => {
    // `/repo` is the base; a ref pointing at it isn't a file link.
    expect(resolveFilePathRef({ path: "/repo" }, CTX)).toBeNull();
  });
});

describe("inlineCodeToFileHref (parse + resolve, integration)", () => {
  const CTX = { sid: "s1", cwd: "/repo/pkg", repoRoot: "/repo" };

  test("happy path yields href + parsed ref", () => {
    const got = inlineCodeToFileHref("packages/webui/foo.ts:L10-12", CTX);
    expect(got).toEqual({
      href: fileHref("s1", "packages/webui/foo.ts", { start: 10, end: 12 }),
      ref: { path: "packages/webui/foo.ts", line: 10, end: 12 },
    });
  });

  test("returns null when ctx is null (no sender info known)", () => {
    expect(inlineCodeToFileHref("packages/webui/foo.ts", null)).toBeNull();
  });

  test("returns null for non-path token", () => {
    expect(inlineCodeToFileHref("foo", CTX)).toBeNull();
  });

  test("returns null for absolute path outside base", () => {
    expect(inlineCodeToFileHref("/etc/hosts:1", CTX)).toBeNull();
  });
});

describe("refToAbsolutePath (Phase B/C: cache-key form for daemon probe)", () => {
  const CTX = { sid: "s1", cwd: "/repo/pkg", repoRoot: "/repo" };

  test("absolute stays absolute (normalized)", () => {
    expect(refToAbsolutePath({ path: "/etc/hosts" }, CTX)).toBe("/etc/hosts");
    expect(refToAbsolutePath({ path: "/repo//a/./b.ts" }, CTX)).toBe("/repo/a/b.ts");
  });
  test("`./`/`../` anchor at cwd", () => {
    expect(refToAbsolutePath({ path: "./x.ts" }, CTX)).toBe("/repo/pkg/x.ts");
    expect(refToAbsolutePath({ path: "../a.ts" }, CTX)).toBe("/repo/a.ts");
  });
  test("bare relative anchors at repo_root when present, cwd otherwise", () => {
    expect(refToAbsolutePath({ path: "packages/foo.ts" }, CTX)).toBe("/repo/packages/foo.ts");
    expect(refToAbsolutePath({ path: "x.ts" }, { sid: "s2", cwd: "/w" })).toBe("/w/x.ts");
  });
  test("null when there is no anchor", () => {
    expect(refToAbsolutePath({ path: "x.ts" }, { sid: "s3" })).toBeNull();
  });
});

describe("hrefFromStatEntry", () => {
  test("contained entry -> relative fileHref (with line range)", () => {
    expect(
      hrefFromStatEntry(
        "s1",
        { path: "packages/foo.ts" },
        { path: "packages/foo.ts", line: 5, end: 7 },
      ),
    ).toBe(fileHref("s1", "packages/foo.ts", { start: 5, end: 7 }));
  });
  test("external entry -> absolute fileHref (single line)", () => {
    expect(
      hrefFromStatEntry("s1", { path: "/outside/x.md" }, { path: "/outside/x.md", line: 3 }),
    ).toBe(fileHref("s1", "/outside/x.md", { start: 3, end: 3 }));
  });
});

describe("extractInlineCodeTokens", () => {
  test("collects inline code across a message", () => {
    const src = "See `packages/a.ts:1` and `docs/x.md`.\nAlso `plain` and `foo/bar.ts:L2-3`.";
    expect(extractInlineCodeTokens(src)).toEqual([
      "packages/a.ts:1",
      "docs/x.md",
      "plain",
      "foo/bar.ts:L2-3",
    ]);
  });
  test("skips fenced code block contents", () => {
    // Fenced blocks contain example code; a backtick-quoted "path" inside
    // must not be treated as a real reference.
    const src = [
      "Prose `outside.ts` ok.",
      "```",
      "let s = `not/a/real.ts`;",
      "```",
      "After `after.md`.",
    ].join("\n");
    expect(extractInlineCodeTokens(src)).toEqual(["outside.ts", "after.md"]);
  });
  test("skips tilde-fenced blocks too", () => {
    const src = ["`kept.ts`", "~~~", "`inside.ts`", "~~~", "`kept2.ts`"].join("\n");
    expect(extractInlineCodeTokens(src)).toEqual(["kept.ts", "kept2.ts"]);
  });
});
