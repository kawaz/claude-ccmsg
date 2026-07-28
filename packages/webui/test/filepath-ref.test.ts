// Parser + resolver contract for `filepath[:LINE[:COL]]` / `filepath[:L1-L2]`
// tokens (kawaz r46 mid=55). Two independent responsibilities are covered
// separately:
//   - parseFilePathRef: token -> {path, line?, end?} or null (shape rules)
//   - refToAbsolutePath / hrefFromStatEntry: (ref, sender ctx) -> fileHref URL
//     (relative paths normalize against the sender's cwd)
import { describe, expect, test } from "bun:test";
import {
  looksLikePath,
  looksLikeFile,
  parseFilePathRef,
  refToAbsolutePath,
  hrefFromStatEntry,
  extractInlineCodeTokens,
  previewFilePathCtx,
  alternateLinkReading,
  refLinkTarget,
  viewerPathForAbsolute,
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
  test("bare relative anchors at cwd, same as `./`", () => {
    // kawaz r55 m93: bare paths used to anchor at repo_root, on the premise
    // that senders cite monorepo-root-relative paths. They don't — a process
    // citing a file it is working on writes it cwd-relative. Under the jj
    // worktree layout (cwd `<repo>/<ws>`, repo_root `<repo>`) the old rule
    // resolved `docs/QUESTIONS.md` to `<repo>/docs/QUESTIONS.md`, which the
    // daemon's stat probe rejected, so the token never linkified.
    expect(refToAbsolutePath({ path: "packages/foo.ts" }, CTX)).toBe("/repo/pkg/packages/foo.ts");
    expect(refToAbsolutePath({ path: "x.ts" }, { sid: "s2", cwd: "/w" })).toBe("/w/x.ts");
  });
  test("worktree layout: bare path resolves under the workspace, not the container", () => {
    // The real shape from the bug report: jj names the workspace dir one
    // level under the repo container, and repo_root is that container.
    const wt = {
      sid: "s4",
      cwd: "/Users/k/repos/claude-ccmsg/main",
      repoRoot: "/Users/k/repos/claude-ccmsg",
    };
    expect(refToAbsolutePath({ path: "docs/QUESTIONS.md" }, wt)).toBe(
      "/Users/k/repos/claude-ccmsg/main/docs/QUESTIONS.md",
    );
  });
  test("repo_root is the fallback anchor only when the sender announced no cwd", () => {
    expect(refToAbsolutePath({ path: "x.ts" }, { sid: "s5", repoRoot: "/repo" })).toBe(
      "/repo/x.ts",
    );
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

// Preview-side resolve anchor (kawaz r55 m116/m117). A relative markdown link
// inside a previewed file anchors at *that file's* directory, not the session
// cwd — the markdown convention, so the same link text resolves the same way
// here as it does on GitHub or in an editor. Message bodies keep the cwd
// anchor (`refToAbsolutePath` above); these two are deliberately different and
// the difference is what these tests hold in place.
describe("previewFilePathCtx", () => {
  const ROOT = "/repo/main";

  test("a contained path anchors at the previewed file's own directory", () => {
    expect(previewFilePathCtx("S1", "docs/design/QUESTIONS.md", ROOT)).toEqual({
      sid: "S1",
      cwd: "/repo/main/docs/design",
      docPath: "docs/design/QUESTIONS.md",
      containmentRoot: "/repo/main",
    });
  });

  test("a sibling link resolves next to the file, not next to the repo root", () => {
    const ctx = previewFilePathCtx("S1", "docs/design/QUESTIONS.md", ROOT)!;
    expect(refToAbsolutePath({ path: "notes.md" }, ctx)).toBe("/repo/main/docs/design/notes.md");
    expect(refToAbsolutePath({ path: "../spec.md" }, ctx)).toBe("/repo/main/docs/spec.md");
  });

  // An absolute link means the same thing under either anchor, so it must not
  // be rebased onto the file's directory.
  test("an absolute link target ignores the anchor", () => {
    const ctx = previewFilePathCtx("S1", "docs/QUESTIONS.md", ROOT)!;
    expect(refToAbsolutePath({ path: "/etc/hosts" }, ctx)).toBe("/etc/hosts");
  });

  test("a file at the root anchors at the root itself", () => {
    expect(previewFilePathCtx("S1", "README.md", ROOT)).toEqual({
      sid: "S1",
      cwd: "/repo/main",
      docPath: "README.md",
      containmentRoot: "/repo/main",
    });
  });

  // The document's own viewer path rides along so a 404 downstream can re-read
  // a failed link against the other convention (kawaz r55 m152).
  test("the ctx carries the previewed document's own path", () => {
    expect(previewFilePathCtx("S1", "docs/QUESTIONS.md", ROOT)?.docPath).toBe("docs/QUESTIONS.md");
  });

  // External / workspace files reach the viewer as absolute paths, where the
  // session root plays no part.
  test("an absolute viewer path anchors without needing the session root", () => {
    expect(previewFilePathCtx("S1", "/other/place/doc.md", undefined)).toEqual({
      sid: "S1",
      cwd: "/other/place",
      docPath: "/other/place/doc.md",
    });
  });

  test("a file directly under / anchors at /", () => {
    expect(previewFilePathCtx("S1", "/doc.md", undefined)).toEqual({
      sid: "S1",
      cwd: "/",
      docPath: "/doc.md",
    });
  });

  // Fail closed: with no way to form an absolute anchor the caller gets
  // `undefined`, which disables linking rather than guessing a base.
  test("a relative viewer path with no session root yields no ctx", () => {
    expect(previewFilePathCtx("S1", "docs/a.md", undefined)).toBeUndefined();
  });
});

// The worktree layout, where the daemon serves from a container (`repo_root`)
// holding sibling workspaces, so viewer paths are relative to it while the
// document itself lives a level down. The anchor is derived from the document's
// own location either way, so nothing here depends on which of the two roots
// the session announced.
describe("previewFilePathCtx (worktree layout: document below the containment root)", () => {
  const CONTAINER = "/repo";

  test("the anchor is the document's directory, the containment root the container", () => {
    expect(previewFilePathCtx("S1", "main/docs/QUESTIONS.md", CONTAINER)).toEqual({
      sid: "S1",
      cwd: "/repo/main/docs",
      docPath: "main/docs/QUESTIONS.md",
      containmentRoot: "/repo",
    });
  });

  test("a resolved target is addressed relative to what the daemon serves from", () => {
    const ctx = previewFilePathCtx("S1", "main/docs/QUESTIONS.md", CONTAINER)!;
    expect(refLinkTarget({ path: "decisions/DR-0008.md" }, ctx)).toBe(
      "/repo/main/docs/decisions/DR-0008.md",
    );
    expect(viewerPathForAbsolute("/repo/main/docs/decisions/DR-0008.md", ctx.containmentRoot)).toBe(
      "main/docs/decisions/DR-0008.md",
    );
  });
});

// The reading of a leading `/` (kawaz r76 m11). The viewer reaches files
// outside the session's tree (DR-0008), so an absolute target has to name the
// file it literally spells — that reading is unambiguously correct, whereas the
// root-relative one is a convention the author only might have meant. A
// root-relative intent 404s and is recovered by `alternateLinkReading` below.
describe("refLinkTarget", () => {
  const ctx = previewFilePathCtx("S1", "docs/design/QUESTIONS.md", "/repo/main")!;

  test("a relative target anchors at the document's own directory", () => {
    expect(refLinkTarget({ path: "notes.md" }, ctx)).toBe("/repo/main/docs/design/notes.md");
    expect(refLinkTarget({ path: "../spec.md" }, ctx)).toBe("/repo/main/docs/spec.md");
  });

  // The whole point of the change: a genuine absolute path — including one
  // outside the session's tree, which the external read path serves — resolves
  // to itself instead of being rebased into the document's tree and dying.
  test("a leading / is the filesystem path, never rebased onto the document tree", () => {
    expect(refLinkTarget({ path: "/Users/x/notes.md" }, ctx)).toBe("/Users/x/notes.md");
    expect(refLinkTarget({ path: "/etc/hosts" }, ctx)).toBe("/etc/hosts");
  });

  // A target written with root-relative intent gets the same treatment — it
  // resolves outside the repo and 404s, which is what earns the "did you mean".
  test("a root-relative intent is not honored, it resolves literally", () => {
    expect(refLinkTarget({ path: "/fixtures/a.json" }, ctx)).toBe("/fixtures/a.json");
  });

  // Message bodies carry no document ctx and always took this reading.
  test("the reading does not depend on having a document ctx", () => {
    expect(refLinkTarget({ path: "/etc/hosts" }, { sid: "S1", cwd: "/repo/main" })).toBe(
      "/etc/hosts",
    );
  });

  test("no anchor at all yields null — nothing to link to", () => {
    expect(refLinkTarget({ path: "notes.md" }, { sid: "S1" })).toBeNull();
  });
});

// The FileViewer addresses contained files root-relatively and everything else
// absolutely. `fs_stat_batch` used to report which; the client now derives it.
describe("viewerPathForAbsolute", () => {
  test("a file under the root becomes root-relative", () => {
    expect(viewerPathForAbsolute("/repo/main/docs/spec.md", "/repo/main")).toBe("docs/spec.md");
  });

  test("a file outside the root stays absolute", () => {
    expect(viewerPathForAbsolute("/etc/hosts", "/repo/main")).toBe("/etc/hosts");
  });

  // Prefix collision: `/repo/mainline` is not inside `/repo/main`.
  test("a sibling sharing a name prefix is not treated as contained", () => {
    expect(viewerPathForAbsolute("/repo/mainline/x.ts", "/repo/main")).toBe("/repo/mainline/x.ts");
  });

  test("the root itself, and an absent root, stay absolute", () => {
    expect(viewerPathForAbsolute("/repo/main", "/repo/main")).toBe("/repo/main");
    expect(viewerPathForAbsolute("/repo/main/x.ts", undefined)).toBe("/repo/main/x.ts");
  });

  test("a trailing slash on the root does not leak into the result", () => {
    expect(viewerPathForAbsolute("/repo/main/x.ts", "/repo/main/")).toBe("x.ts");
  });
});

// The 404's "did you mean" (kawaz r55 m152/m153). This runs only after a link
// has already failed, and that ordering is the whole point: the failed path is
// by construction the document's directory plus what the author typed, so
// stripping that directory reverse-engineers the original text. One candidate,
// derived — not a search of the tree for something similarly named.
describe("alternateLinkReading", () => {
  // The observed case: a link written from the repo root, resolved against the
  // document, so the document's directory got prepended.
  test("recovers what the author wrote by stripping the document's directory", () => {
    expect(alternateLinkReading("docs/packages/webui/x.ts", "docs")).toBe("packages/webui/x.ts");
    expect(alternateLinkReading("docs/docs/spec.md", "docs")).toBe("docs/spec.md");
  });

  test("nested document directories are stripped whole, not per-segment", () => {
    expect(alternateLinkReading("docs/design/notes.md", "docs/design")).toBe("notes.md");
  });

  // A document at the repo root has nothing prepended, so the link already
  // meant exactly what it said and there is no second reading.
  test("a document at the root yields nothing to recover", () => {
    expect(alternateLinkReading("spec.md", "")).toBeNull();
    expect(alternateLinkReading("docs/spec.md", "")).toBeNull();
  });

  // `refLinkTarget` always keeps the filesystem reading of a leading `/`, so
  // every absolute target that 404s reaches here. The documentation reading is
  // the recoverable other one — but only when there is a cwd to read it
  // against.
  test("an absolute target has only one reading without a cwd", () => {
    expect(alternateLinkReading("/etc/hosts", "docs")).toBeNull();
  });

  test("an absolute target recovers its documentation reading against the cwd", () => {
    expect(alternateLinkReading("/docs/spec.md", "", "/repo/main")).toBe("/repo/main/docs/spec.md");
    expect(alternateLinkReading("/docs/spec.md", "", "/repo/main/")).toBe(
      "/repo/main/docs/spec.md",
    );
  });

  // A target naming the cwd itself (or `/`) rebases onto a directory, and one
  // that rebases back onto itself has no second reading at all.
  test("an absolute target with no distinct second reading yields nothing", () => {
    expect(alternateLinkReading("/", "", "/repo/main")).toBeNull();
    expect(alternateLinkReading("/etc/hosts", "", "/")).toBeNull();
  });

  // Only paths the document's directory actually prefixes are derivable; this
  // is what keeps a same-named file elsewhere in the tree from being offered.
  test("a failed path outside the document's directory yields nothing", () => {
    expect(alternateLinkReading("other/spec.md", "docs")).toBeNull();
    expect(alternateLinkReading("docs-archive/spec.md", "docs")).toBeNull();
  });

  test("the candidate never escapes the root or repeats the failed path", () => {
    expect(alternateLinkReading("docs/", "docs")).toBeNull();
    expect(alternateLinkReading("docs/../outside.md", "docs")).toBeNull();
  });

  test("a trailing or leading slash on the document directory is tolerated", () => {
    expect(alternateLinkReading("docs/spec.md", "/docs/")).toBe("spec.md");
  });
});
