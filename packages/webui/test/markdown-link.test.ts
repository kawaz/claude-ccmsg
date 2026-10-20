// Link-target classification for markdown bodies and file previews.
//
// The bug this pins: a markdown link written as `[x](fixtures/a.json)` used to
// render as an `<a href="fixtures/a.json">`, so clicking it navigated the
// **webui origin** to a URL the daemon has no route for. In a standalone
// (home-screen) PWA there is neither an address bar nor a back button, so that
// navigation is unrecoverable without killing the app.
//
// The contract these tests hold in place is therefore asymmetric: an
// unresolved *external* URL is fine to link, an unresolved *path* is not. Any
// change that lets a path-shaped target reach an `href` without daemon
// confirmation reintroduces the trap, so the "fails closed" cases below are
// the load-bearing ones — the resolution cases only describe what happens once
// the answer is known.
import { describe, expect, test } from "bun:test";
import {
  classifyMarkdownLinkUrl,
  codeSpanLinkTarget,
  extractMarkdownLinkUrls,
  isSafeUrl,
  literalAutolinkText,
  markdownLinkPathRef,
} from "../src/client/markdown-link.ts";

describe("classifyMarkdownLinkUrl", () => {
  test("scheme'd URLs on the allowlist are external (unchanged behavior)", () => {
    expect(classifyMarkdownLinkUrl("https://example.com/x")).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
    expect(classifyMarkdownLinkUrl("http://example.com")).toMatchObject({ kind: "external" });
    expect(classifyMarkdownLinkUrl("mailto:a@example.com")).toMatchObject({ kind: "external" });
  });

  test("hostile schemes disarm rather than classify as anything linkable", () => {
    for (const url of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:alert(1)",
      "file:///etc/passwd",
      // Scheme split across a stripped control character — must not be read
      // as scheme-less (= a relative path), which would make it a `path`.
      "java\tscript:alert(1)",
      // Protocol-relative: no scheme to check, inherits the page's at render
      // time, so it is not "relative" in the safe sense.
      "//evil.example.com/x",
    ]) {
      expect(classifyMarkdownLinkUrl(url)).toEqual({ kind: "disarm" });
    }
  });

  test("bare fragments stay in-page anchors", () => {
    expect(classifyMarkdownLinkUrl("#md-section-2")).toEqual({
      kind: "anchor",
      url: "#md-section-2",
    });
  });

  // The reported case: a relative link inside a previewed QUESTIONS.md.
  test("relative and absolute paths classify as path targets", () => {
    expect(classifyMarkdownLinkUrl("fixtures/seq-parse/literal.json")).toEqual({
      kind: "path",
      ref: { path: "fixtures/seq-parse/literal.json" },
    });
    expect(classifyMarkdownLinkUrl("/docs/spec.md")).toEqual({
      kind: "path",
      ref: { path: "/docs/spec.md" },
    });
    expect(classifyMarkdownLinkUrl("./notes.md")).toMatchObject({ kind: "path" });
    expect(classifyMarkdownLinkUrl("../sibling/notes.md")).toMatchObject({ kind: "path" });
  });

  // Unlike `parseFilePathRef` (which must guess whether a bare inline-code
  // token was even meant as a path), link syntax declares the intent, so no
  // extension/slash heuristic applies.
  test("a bare filename with no slash or extension is still a path target", () => {
    expect(classifyMarkdownLinkUrl("notes")).toEqual({ kind: "path", ref: { path: "notes" } });
    expect(classifyMarkdownLinkUrl("Makefile")).toMatchObject({ kind: "path" });
  });

  test("directory targets disarm — the viewer opens files, not directories", () => {
    expect(classifyMarkdownLinkUrl("docs/")).toEqual({ kind: "disarm" });
    expect(classifyMarkdownLinkUrl("/")).toEqual({ kind: "disarm" });
  });

  test("an empty target disarms rather than resolving to the anchor directory", () => {
    expect(classifyMarkdownLinkUrl("")).toEqual({ kind: "disarm" });
  });

  // A markdown body can carry a self-referential link — e.g. a ccmsg session
  // sharing its own webui URL. Rendered with the default new-tab treatment,
  // that link strands a standalone PWA user on a duplicate tab of the same
  // app. Only an *absolute* URL matching `currentOrigin` gets this treatment;
  // it must not interact with the scheme-less relative-link (`path`) routing
  // tested above, which is unconditional.
  describe("with a currentOrigin supplied", () => {
    const origin = "https://ccmsg.example.com";

    test("an absolute URL matching currentOrigin is internal, not external", () => {
      expect(classifyMarkdownLinkUrl(`${origin}/s/abc/timeline/head`, origin)).toEqual({
        kind: "internal",
        url: `${origin}/s/abc/timeline/head`,
      });
    });

    test("an absolute URL on a different origin stays external", () => {
      expect(classifyMarkdownLinkUrl("https://example.com/x", origin)).toEqual({
        kind: "external",
        url: "https://example.com/x",
      });
    });

    test("mailto: never becomes internal even if it were textually similar", () => {
      expect(classifyMarkdownLinkUrl("mailto:a@example.com", origin)).toEqual({
        kind: "external",
        url: "mailto:a@example.com",
      });
    });

    test("relative paths are unaffected — still path targets, not internal", () => {
      expect(classifyMarkdownLinkUrl("docs/spec.md", origin)).toEqual({
        kind: "path",
        ref: { path: "docs/spec.md" },
      });
    });

    test("a protocol-relative URL still disarms rather than becoming internal", () => {
      expect(classifyMarkdownLinkUrl(`//${new URL(origin).host}/x`, origin)).toEqual({
        kind: "disarm",
      });
    });
  });

  test("with no currentOrigin, a same-looking absolute URL stays external (unchanged default)", () => {
    expect(classifyMarkdownLinkUrl("https://ccmsg.example.com/s/abc")).toEqual({
      kind: "external",
      url: "https://ccmsg.example.com/s/abc",
    });
  });
});

// A code span is a link when what it holds is a link destination of the same
// kind a markdown link names: a URL with an allowed scheme, judged by
// classifyMarkdownLinkUrl. A span without a scheme stays code — `rows` or
// `docs/x.md` is not a destination the author wrote as one.
describe("codeSpanLinkTarget", () => {
  test("a URL with an allowed scheme is external", () => {
    expect(codeSpanLinkTarget("https://example.com/x")).toEqual({
      kind: "external",
      url: "https://example.com/x",
    });
    expect(codeSpanLinkTarget("mailto:a@example.com")).toMatchObject({ kind: "external" });
  });

  test("a URL naming this webui's origin is internal", () => {
    expect(
      codeSpanLinkTarget("https://ccmsg.example.com/s/abc", "https://ccmsg.example.com"),
    ).toEqual({ kind: "internal", url: "https://ccmsg.example.com/s/abc" });
  });

  // No exception for template characters: the URL rule is the one rule.
  test("template characters do not keep a URL from linking", () => {
    expect(codeSpanLinkTarget("https://example.com/{id}/x")).toMatchObject({ kind: "external" });
  });

  test("a span without a scheme stays code", () => {
    expect(codeSpanLinkTarget("rows")).toBeNull();
    expect(codeSpanLinkTarget("docs/x.md")).toBeNull();
    expect(codeSpanLinkTarget("#section")).toBeNull();
  });

  test("a disallowed scheme stays code", () => {
    expect(codeSpanLinkTarget("javascript:alert(1)")).toBeNull();
  });

  // A destination holds no whitespace, so a span with any is not one
  // destination but a command or prose that mentions a URL.
  test("a span with whitespace stays code", () => {
    expect(codeSpanLinkTarget("https://example.com/x y")).toBeNull();
    expect(codeSpanLinkTarget("curl https://example.com/x")).toBeNull();
  });
});

describe("markdownLinkPathRef", () => {
  test("GitHub-style line fragments become a FileViewer line range", () => {
    expect(markdownLinkPathRef("src/a.ts#L10")).toEqual({ path: "src/a.ts", line: 10 });
    expect(markdownLinkPathRef("src/a.ts#L10-L20")).toEqual({
      path: "src/a.ts",
      line: 10,
      end: 20,
    });
    expect(markdownLinkPathRef("src/a.ts#L10-20")).toEqual({ path: "src/a.ts", line: 10, end: 20 });
  });

  test("an inverted range keeps the anchor line and drops the range", () => {
    expect(markdownLinkPathRef("src/a.ts#L20-L10")).toEqual({ path: "src/a.ts", line: 20 });
  });

  // A heading fragment names a location *inside* the target file that the
  // FileViewer cannot jump to. Dropping it still opens the right file, which
  // is strictly better than refusing the link.
  test("a non-line fragment is dropped but the file still resolves", () => {
    expect(markdownLinkPathRef("docs/spec.md#installation")).toEqual({ path: "docs/spec.md" });
  });

  test("percent-encoding is decoded so a spaced filename resolves", () => {
    expect(markdownLinkPathRef("docs/my%20notes.md")).toEqual({ path: "docs/my notes.md" });
  });

  test("malformed percent-encoding falls back to the raw text instead of throwing", () => {
    expect(() => markdownLinkPathRef("docs/%zz.md")).not.toThrow();
    expect(markdownLinkPathRef("docs/%zz.md")).toEqual({ path: "docs/%zz.md" });
  });

  test("a query string is stripped (GitHub's ?plain=1 idiom)", () => {
    expect(markdownLinkPathRef("docs/spec.md?plain=1")).toEqual({ path: "docs/spec.md" });
  });
});

describe("isSafeUrl", () => {
  // Re-pinned here (not only through markdown-view) because the scheme policy
  // now lives in this module; the two must not drift.
  test("allowlisted schemes and scheme-less targets are safe", () => {
    expect(isSafeUrl("https://example.com")).toBe(true);
    expect(isSafeUrl("mailto:a@example.com")).toBe(true);
    expect(isSafeUrl("docs/spec.md")).toBe(true);
    expect(isSafeUrl("#anchor")).toBe(true);
  });
  test("everything else is not", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("//evil.example.com")).toBe(false);
  });
});

describe("extractMarkdownLinkUrls", () => {
  test("collects link and image targets", () => {
    expect(extractMarkdownLinkUrls("see [a](docs/a.md) and ![img](assets/b.png)")).toEqual([
      "docs/a.md",
      "assets/b.png",
    ]);
  });

  test("skips fenced code so a documented example is not probed", () => {
    const source = ["before [a](docs/a.md)", "```md", "[b](docs/b.md)", "```", "after"].join("\n");
    expect(extractMarkdownLinkUrls(source)).toEqual(["docs/a.md"]);
  });

  test("stops the target at a link title", () => {
    expect(extractMarkdownLinkUrls('[a](docs/a.md "the title")')).toEqual(["docs/a.md"]);
  });

  test("unwraps an angle-bracketed target", () => {
    expect(extractMarkdownLinkUrls("[a](<docs/my file.md>)")).toEqual(["docs/my file.md"]);
  });

  // The extractor feeds the probe queue while the renderer walks mdast, so it
  // must not *under*-collect: a link the renderer will ask the cache about,
  // but which was never probed, stays dead forever. Over-collecting only
  // costs a wasted entry in a batch nobody sees.
  test("over-collecting is tolerated — a non-path target is filtered later, not here", () => {
    expect(extractMarkdownLinkUrls("[a](https://example.com)")).toEqual(["https://example.com"]);
  });
});

// A bare URL in prose runs, by the GFM rule, until whitespace — so a Japanese
// sentence written straight after it becomes part of it.
describe("literalAutolinkText", () => {
  test("an all-ASCII URL is kept whole (GFM already trimmed it)", () => {
    expect(literalAutolinkText("https://ex.com/a?b=1#c")).toBe("https://ex.com/a?b=1#c");
    expect(literalAutolinkText("www.ex.com/a")).toBe("www.ex.com/a");
  });

  test("prose running into the URL is cut off at the first non-ASCII character", () => {
    expect(literalAutolinkText("https://ex.com/a。続き")).toBe("https://ex.com/a");
    expect(literalAutolinkText("https://ex.com/aを参照")).toBe("https://ex.com/a");
    expect(literalAutolinkText("https://ex.com/a\u3000b")).toBe("https://ex.com/a");
  });

  test("a `<` ends the URL, as GFM's literal does", () => {
    expect(literalAutolinkText("https://ex.com/a<b>")).toBe("https://ex.com/a");
  });

  // The cut can expose punctuation that GFM would have trimmed had it been at
  // the end, so the same trim runs again — parentheses stay balanced.
  test("punctuation exposed by the cut is trimmed, balanced parentheses kept", () => {
    expect(literalAutolinkText("https://ex.com/a.を")).toBe("https://ex.com/a");
    expect(literalAutolinkText("https://ex.com/a),を")).toBe("https://ex.com/a");
    expect(literalAutolinkText("https://ex.com/w/A_(b)。")).toBe("https://ex.com/w/A_(b)");
  });

  test("nothing addressable left after the cut yields an empty string", () => {
    expect(literalAutolinkText("https://日本.jp/a")).toBe("");
    expect(literalAutolinkText("https://ex日本.jp")).toBe("");
  });
});
