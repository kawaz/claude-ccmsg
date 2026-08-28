// markdown-view.ts unit tests (DR-0010): guards the mdast -> preact VNode
// walker Timeline.tsx uses to render assistant text segments, plus the URL
// allowlist that keeps it from ever emitting an executable `href`.
//
// Test strategy: `renderMarkdownAst` takes a hand-constructed mdast `Root` —
// not markdown source run through the parser — so the walker's behavior is
// pinned independently of the parser in use (mirrors
// transcript-model.test.ts's "pure fold, testable without DOM" split, see
// that file's doc comment). The walker returns Preact `VNode`s directly (no
// renderToString dependency is available in this repo, see markdown-view.tsx
// doc comment) — `collectByType`/`flattenText` below walk that VNode tree by
// hand via `.type`/`.props.children`, which is all Preact's `h()` output
// exposes without a DOM.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import type { Root } from "mdast";
import {
  attachmentUrlFromPath,
  collectMarkdownSectionKeys,
  extractMarkdownHeadings,
  foldMarkdownSections,
  extractTaskStates,
  isSafeUrl,
  parseMarkdownDocument,
  parseMarkdownSource,
  renderMarkdownAst,
  renderRestrictedMarkdown,
} from "../src/client/markdown-view.tsx";
import { CodeBlock } from "../src/client/components/CodeBlock.tsx";
import { parseSearchQuery, type SearchWord } from "../src/client/in-view-search.ts";

function isVNode(x: unknown): x is VNode {
  return x != null && typeof x === "object" && "type" in x && "props" in x;
}

function collect(node: unknown, predicate: (n: VNode) => boolean, acc: VNode[] = []): VNode[] {
  if (Array.isArray(node)) {
    for (const c of node) collect(c, predicate, acc);
    return acc;
  }
  if (!isVNode(node)) return acc;
  if (predicate(node)) acc.push(node);
  collect((node.props as { children?: unknown }).children, predicate, acc);
  return acc;
}

function flattenText(node: unknown): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(flattenText).join("");
  if (!isVNode(node)) return "";
  return flattenText((node.props as { children?: unknown }).children);
}

describe("isSafeUrl", () => {
  // Allowlisted schemes (DR-0010): the only schemes a link/image href is
  // ever allowed to carry.
  test("http/https/mailto are allowed", () => {
    expect(isSafeUrl("http://example.com/x")).toBe(true);
    expect(isSafeUrl("https://example.com/x")).toBe(true);
    expect(isSafeUrl("mailto:a@example.com")).toBe(true);
  });

  // Scheme-less URLs are relative paths / fragments, which CommonMark treats
  // as valid link targets and carry no execution risk.
  test("scheme-less (relative path / fragment) URLs are allowed", () => {
    expect(isSafeUrl("./foo")).toBe(true);
    expect(isSafeUrl("../foo/bar.md")).toBe(true);
    expect(isSafeUrl("#section")).toBe(true);
    expect(isSafeUrl("foo/bar")).toBe(true);
  });

  // The core XSS vector this module exists to close: javascript: (and any
  // case variant, since URL schemes are case-insensitive per RFC 3986 §3.1).
  test("javascript: is rejected, case-insensitively", () => {
    expect(isSafeUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeUrl("JavaScript:alert(1)")).toBe(false);
    expect(isSafeUrl("JAVASCRIPT:alert(1)")).toBe(false);
  });

  // Other unlisted schemes must be rejected too — this is an allowlist, not
  // a javascript:-specific blocklist.
  test("other non-allowlisted schemes are rejected", () => {
    expect(isSafeUrl("data:text/html,<script>alert(1)</script>")).toBe(false);
    expect(isSafeUrl("vbscript:alert(1)")).toBe(false);
    expect(isSafeUrl("file:///etc/passwd")).toBe(false);
  });

  // Scheme-detection evasion via embedded control characters: a naive
  // regex scanning the raw string could read "java" up to a stripped
  // character as scheme-less. isSafeUrl must strip control chars first
  // (see its doc comment).
  test("control-character-split scheme evasion is still rejected", () => {
    expect(isSafeUrl("java\tscript:alert(1)")).toBe(false);
    expect(isSafeUrl("java\nscript:alert(1)")).toBe(false);
    expect(isSafeUrl(" javascript:alert(1)")).toBe(false);
  });

  // Protocol-relative URLs ("//host/path") have no explicit scheme to
  // allowlist-check but inherit the page's scheme at render/navigation
  // time — not "scheme-less" in the safe sense a relative path is, so
  // these are rejected outright rather than defaulting to allowed.
  test("protocol-relative URLs are rejected", () => {
    expect(isSafeUrl("//evil.example.com/x")).toBe(false);
  });
});

describe("renderMarkdownAst / XSS defenses", () => {
  // Required-coverage item: "javascript: リンクが無害化される". A link whose
  // url fails isSafeUrl must never reach the DOM as an <a href>; the link's
  // own text is still shown (info isn't dropped, just disarmed).
  test("javascript: link renders with no <a> element, but keeps its text", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "javascript:alert(1)",
              children: [{ type: "text", value: "click me" }],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(flattenText(vnode)).toContain("click me");
  });

  // Same defense for images: a bad image url must never even reach an <img>
  // or an <a href> — DR-0010 also never auto-fetches image URLs at all, so
  // a safe url still renders as a link (not an <img src>), covered by the
  // next test.
  test("javascript: image url renders with no <a>/<img>, but keeps alt text", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "image", url: "javascript:alert(1)", alt: "logo" }],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "img")).toHaveLength(0);
    expect(flattenText(vnode)).toContain("logo");
  });

  // Design rationale coverage: images are never auto-fetched (no <img
  // src=...> for a *safe* url either) — shown as a clickable link instead.
  test("safe image url renders as a link, never an <img src>", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "image", url: "https://example.com/pic.png", alt: "logo" }],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "img")).toHaveLength(0);
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect((links[0]!.props as { href?: string }).href).toBe("https://example.com/pic.png");
  });

  // A safe-scheme link does get a real <a href>.
  test("http(s) link renders as <a href>", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "link", url: "https://example.com", children: [{ type: "text", value: "go" }] },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect((links[0]!.props as { href?: string }).href).toBe("https://example.com");
  });

  // Required-coverage item: "html ノードがテキスト化される". A raw-HTML mdast
  // node's source text must surface as a plain JSX text child, never through
  // dangerouslySetInnerHTML/innerHTML (which would execute it).
  test("html node is shown as escaped plain text, never executed via dangerouslySetInnerHTML", () => {
    const root: Root = {
      type: "root",
      children: [{ type: "html", value: "<script>alert(1)</script>" }],
    };
    const vnode = renderMarkdownAst(root);
    expect(flattenText(vnode)).toContain("<script>alert(1)</script>");
    // No node in the tree carries a dangerouslySetInnerHTML prop anywhere —
    // the walker never uses that escape hatch.
    const dangerous = collect(
      vnode,
      (n) => n.props != null && "dangerouslySetInnerHTML" in (n.props as object),
    );
    expect(dangerous).toHaveLength(0);
  });

  // Confirms the real-world reason isSafeUrl is required at all: the parser
  // passes a javascript: URL straight through into the mdast tree unchanged
  // (it doesn't sanitize), so the walker is the only defense layer (DR-0010).
  test("the parser passes a javascript: URL through unsanitized (regression pin for why isSafeUrl exists)", () => {
    const root = parseMarkdownSource("[click](javascript:alert(1))");
    const paragraph = root.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;
    const link = paragraph.children[0];
    expect(link?.type).toBe("link");
    if (link?.type !== "link") return;
    expect(link.url).toBe("javascript:alert(1)");
  });
});

describe("parseMarkdownSource / CommonMark intraword underscores", () => {
  function renderSource(source: string): VNode {
    return renderMarkdownAst(parseMarkdownSource(source));
  }

  // The reported message fragment has one intraword underscore. It must remain
  // literal on its own and must not become an opener when a later snake_case
  // token supplies another underscore for the dependency parser to pair with.
  test("reported Room message keeps intraword underscores literal across the full sentence", () => {
    const sources = [
      "type:help_catepory を作るか",
      "type:help_catepory を作るか?内部的には string_value で...",
    ];
    for (const source of sources) {
      const vnode = renderSource(source);
      expect(collect(vnode, (n) => n.type === "em")).toHaveLength(0);
      expect(flattenText(vnode)).toBe(source);
    }
  });

  // CommonMark forbids underscore emphasis inside words. Single and double
  // runs in identifiers are literal, so no middle segment may become styled.
  test("snake_case and snake__case identifiers render literally", () => {
    for (const source of ["snake_case_name", "snake__case__name"]) {
      const vnode = renderSource(source);
      expect(collect(vnode, (n) => n.type === "em")).toHaveLength(0);
      expect(collect(vnode, (n) => n.type === "strong")).toHaveLength(0);
      expect(flattenText(vnode)).toBe(source);
    }
  });

  // CommonMark character classes are Unicode-aware: Japanese letters around
  // an underscore are word content, not punctuation or whitespace.
  test("Japanese intraword underscores are literal", () => {
    const source = "日本語_項目_日本語";
    const vnode = renderSource(source);
    expect(collect(vnode, (n) => n.type === "em")).toHaveLength(0);
    expect(flattenText(vnode)).toBe(source);
  });

  // The parser workaround also sees source inside code spans and link targets.
  // Its private marker must be restored in every mdast string field, not leak
  // into displayed code or an href.
  test("protected underscores are restored in inline code and link URLs", () => {
    const vnode = renderSource("`snake_case` [link](https://example.com/a_b)");
    expect(flattenText(collect(vnode, (n) => n.type === "code")[0])).toBe("snake_case");
    const link = collect(vnode, (n) => n.type === "a")[0]!;
    expect((link.props as { href?: string }).href).toBe("https://example.com/a_b");
  });

  // Boundary-delimited underscore emphasis remains valid; only intraword runs
  // are protected from the dependency parser's non-CommonMark behavior.
  test("boundary-delimited _italic_ still renders as emphasis", () => {
    const vnode = renderSource("_italic_");
    expect(collect(vnode, (n) => n.type === "em")).toHaveLength(1);
    expect(flattenText(vnode)).toBe("italic");
  });

  // Internal underscores stay literal even inside valid outer emphasis. This
  // pins the distinction between delimiter underscores and identifier text.
  test("outer underscore emphasis may contain a literal snake_case identifier", () => {
    const vnode = renderSource("_foo_bar_baz_");
    expect(collect(vnode, (n) => n.type === "em")).toHaveLength(1);
    expect(flattenText(vnode)).toBe("foo_bar_baz");
  });

  // Asterisk emphasis is intentionally allowed intraword by CommonMark and is
  // outside this workaround, so both single and double asterisk forms persist.
  test("asterisk emphasis and strong emphasis are unchanged", () => {
    const vnode = renderSource("x*italic*y and **bold**");
    expect(collect(vnode, (n) => n.type === "em")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "strong")).toHaveLength(1);
    expect(flattenText(vnode)).toBe("xitalicy and bold");
  });
});

describe("parseMarkdownSource / angle-bracket tag-like text", () => {
  function renderSource(source: string): VNode {
    return renderMarkdownAst(parseMarkdownSource(source));
  }

  // Angle-bracket tokens used as placeholders or tag examples are prose, not
  // links. The parser must preserve both brackets and must not invent hrefs.
  test("placeholder and HTML tag-like tokens remain literal text", () => {
    for (const source of ["before <FILE> after", "before <div> after", "before <script> after"]) {
      const vnode = renderSource(source);
      expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
      expect(flattenText(vnode)).toBe(source);
    }
  });

  // Opening/closing tags and attributes belong to the same literal-text input
  // class; preserving only bare <NAME> would leave realistic examples broken.
  test("paired tags and attributes remain literal text", () => {
    const source = '<div class="example"><FILE></div>';
    const vnode = renderSource(source);
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(flattenText(vnode)).toBe(source);
  });

  // Explicit Markdown code syntax already owns its contents. Angle-bracket
  // protection must restore the exact code value rather than leaking markers.
  test("inline and fenced code preserve tag-like text as code", () => {
    const inline = renderSource("`<FILE>`");
    expect(flattenText(collect(inline, (n) => n.type === "code")[0])).toBe("<FILE>");

    const fenced = renderSource("```txt\n<script>\n```");
    const blocks = collect(fenced, (n) => n.type === CodeBlock);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.props).toMatchObject({ lang: "txt", code: "<script>" });
  });

  // CommonMark URL/email autolinks are not tag-like prose and remain links;
  // disabling all angle-bracket parsing would regress these valid constructs.
  test("URL and email autolinks remain links", () => {
    const vnode = renderSource("<https://example.com> <user@example.com>");
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(2);
    expect(links.map((link) => (link.props as { href?: string }).href)).toEqual([
      "https://example.com",
      "mailto:user@example.com",
    ]);
  });

  // kawaz r55m83: プレースホルダ風の `<確認項目>` が autolink 化してブラケット
  // ごと消えていた。ASCII タグ名形状 (`<div>`) だけを守っていた旧実装の穴で、
  // 非 ASCII やバージョン番号のように「scheme でも email でもない」中身は
  // すべてテキストのまま出す。
  test("non-autolink angle brackets stay literal text", () => {
    for (const src of ["<確認項目>", "<v0.73.31>", "<TODO>", "<日本語 タグ>"]) {
      const vnode = renderSource(src);
      expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
      expect(flattenText(vnode)).toContain(src);
    }
  });
});

// A `#` run that isn't a valid ATX heading opener made the dependency parser
// drop the whole block, so an assistant turn opening with `#1 …` rendered as an
// empty bubble (kawaz r99m7: 「からっぽの紫色のバルーン」). CommonMark treats
// those lines as paragraph text, which is what these pin.
describe("parseMarkdownSource / non-heading hash runs", () => {
  function renderSource(source: string): VNode {
    return renderMarkdownAst(parseMarkdownSource(source));
  }

  // The two bubbles from the report, verbatim: `#N` issue references opening a
  // sentence. Both must survive as paragraph text.
  test("a turn opening with an issue reference keeps its whole text", () => {
    for (const source of [
      "#1 を commit しました (high 4 件中 2 件が land 済み: #1 増分スキャン化、#4 添付 upload)。",
      "#2 の報告も良好 (旧実装は yield 0 回の完全停止を実測で証明)。diff を確認して commit します。",
    ]) {
      const vnode = renderSource(source);
      expect(collect(vnode, (n) => n.type === "h1")).toHaveLength(0);
      expect(flattenText(vnode)).toBe(source);
    }
  });

  // Only the offending block used to be dropped, so a later paragraph survived
  // while the opening one vanished — the silent-truncation half of the bug.
  test("a later paragraph no longer outlives the dropped opening one", () => {
    expect(flattenText(renderSource("#1 x\n\n次の段落"))).toBe("#1 x次の段落");
  });

  // 7+ hashes exceeds CommonMark's h1-h6 range, so the line is paragraph text.
  test("more than six hashes is paragraph text, not a heading", () => {
    const vnode = renderSource("####### seven");
    expect(collect(vnode, (n) => n.type.toString().startsWith("h"))).toHaveLength(0);
    expect(flattenText(vnode)).toBe("####### seven");
  });

  // The parser looks for a heading after container prefixes too, and dropped
  // the line there as well.
  test("non-heading hashes survive inside a blockquote and a list item", () => {
    expect(flattenText(renderSource("> #1 x"))).toBe("#1 x");
    expect(flattenText(renderSource("- #1 x"))).toBe("#1 x");
  });

  // Real headings, including the bare `#` and the h6 boundary, keep working.
  test("valid ATX headings still parse as headings", () => {
    expect(collect(renderSource("# heading"), (n) => n.type === "h1")).toHaveLength(1);
    expect(collect(renderSource("###### h6"), (n) => n.type === "h6")).toHaveLength(1);
    expect(collect(renderSource("#"), (n) => n.type === "h1")).toHaveLength(1);
  });

  // Code text is verbatim: a `#` run inside it is inert and must reach the
  // renderer byte-for-byte.
  test("hash runs inside fenced and indented code are verbatim", () => {
    const codeValues = (source: string) =>
      parseMarkdownSource(source).children.map((n) => (n as { value?: string }).value);
    expect(codeValues("```\n#1 code\n```")).toEqual(["#1 code"]);
    expect(codeValues("    #1 indented")).toEqual(["#1 indented"]);
  });
});

describe("extractMarkdownHeadings", () => {
  test("extracts h1-h6 in document order with visible inline text", () => {
    const root = parseMarkdownSource(
      ["# Overview *now*", "", "> ## Quoted `code`", "", "###### Final"].join("\n"),
    );

    expect(extractMarkdownHeadings(root)).toEqual([
      { depth: 1, text: "Overview now", number: "1", id: "md-section-1" },
      { depth: 2, text: "Quoted code", number: "1.1", id: "md-section-1-1" },
      { depth: 6, text: "Final", number: "1.1.0.0.0.1", id: "md-section-1-1-0-0-0-1" },
    ]);
  });

  test("matches CSS-counter resets, including skipped levels", () => {
    const root = parseMarkdownSource(["# A", "## B", "## C", "### D", "# E", "### F"].join("\n"));

    expect(extractMarkdownHeadings(root).map((heading) => heading.number)).toEqual([
      "1",
      "1.1",
      "1.2",
      "1.2.1",
      "2",
      "2.0.1",
    ]);
  });

  test("assigns unique anchors to duplicate and empty heading labels", () => {
    const root = parseMarkdownSource(["# Same", "## Same", "###"].join("\n"));

    expect(extractMarkdownHeadings(root).map(({ text, id }) => ({ text, id }))).toEqual([
      { text: "Same", id: "md-section-1" },
      { text: "Same", id: "md-section-1-1" },
      { text: "（無題）", id: "md-section-1-1-1" },
    ]);
  });

  test("renderMarkdownAst applies extracted anchors to the matching headings", () => {
    const root = parseMarkdownSource("# First\n\n## Second");
    const headings = extractMarkdownHeadings(root);
    const vnode = renderMarkdownAst(root, undefined, headings);
    const renderedHeadings = collect(vnode, (node) => /^h[1-6]$/.test(String(node.type)));

    expect(renderedHeadings.map((node) => (node.props as { id?: string }).id)).toEqual([
      "md-section-1",
      "md-section-1-1",
    ]);
  });
});

describe("renderMarkdownAst / structural coverage", () => {
  // Required-coverage item: "コードフェンスが lang 付きで CodeBlock に渡る".
  test("code node is delegated to CodeBlock with its lang and value", () => {
    const root: Root = {
      type: "root",
      children: [{ type: "code", lang: "ts", value: "const x = 1;" }],
    };
    const vnode = renderMarkdownAst(root);
    const blocks = collect(vnode, (n) => n.type === CodeBlock);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.props).toMatchObject({ lang: "ts", code: "const x = 1;" });
  });

  // A fence with no info-string still renders through CodeBlock, with a
  // null lang (plain-text fallback is CodeBlock's own concern, exercised in
  // its own component — not re-tested here).
  test("code node with no lang passes lang: null to CodeBlock", () => {
    const root: Root = { type: "root", children: [{ type: "code", value: "plain text" }] };
    const vnode = renderMarkdownAst(root);
    const blocks = collect(vnode, (n) => n.type === CodeBlock);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.props).toMatchObject({ lang: null, code: "plain text" });
  });

  // inlineCode is a separate mdast node type from a fenced code block and
  // must not be routed through CodeBlock (no async highlighting for a
  // single inline token).
  test("inlineCode renders as <code>, not through CodeBlock", () => {
    const root: Root = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "inlineCode", value: "x = 1" }] }],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === CodeBlock)).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "code")).toHaveLength(1);
    expect(flattenText(vnode)).toBe("x = 1");
  });

  // kawaz r119 m15: a bold run naming a real file linkifies exactly like an
  // inline-code path — same linker, so the same "shape + daemon-confirmed"
  // gate. The <strong> stays inside the <a> so the text still reads as
  // emphasis when the link is declined or the reader ignores it.
  describeStrongLinkTests();

  // Headings 1-6 map to their own <hN> tag (depth is clamped defensively,
  // though mdast's Heading.depth type is already 1|2|...|6).
  test("heading depth maps to the matching h1..h6 tag", () => {
    for (const depth of [1, 2, 3, 4, 5, 6] as const) {
      const root: Root = {
        type: "root",
        children: [{ type: "heading", depth, children: [{ type: "text", value: `h${depth}` }] }],
      };
      const vnode = renderMarkdownAst(root);
      expect(collect(vnode, (n) => n.type === `h${depth}`)).toHaveLength(1);
    }
  });

  // strong/emphasis/delete/inlineCode/break/thematicBreak: each maps to its
  // dedicated inline/block tag.
  test("strong/emphasis/delete/break/thematicBreak map to their tags", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            { type: "strong", children: [{ type: "text", value: "b" }] },
            { type: "emphasis", children: [{ type: "text", value: "i" }] },
            { type: "delete", children: [{ type: "text", value: "s" }] },
            { type: "break" },
          ],
        },
        { type: "thematicBreak" },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "strong")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "em")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "del")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "br")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "hr")).toHaveLength(1);
  });

  // list/listItem: ordered vs. unordered map to <ol>/<ul>, each item to <li>.
  test("unordered and ordered lists map to <ul>/<ol> with <li> items", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "list",
          ordered: false,
          children: [
            {
              type: "listItem",
              children: [{ type: "paragraph", children: [{ type: "text", value: "a" }] }],
            },
            {
              type: "listItem",
              children: [{ type: "paragraph", children: [{ type: "text", value: "b" }] }],
            },
          ],
        },
        {
          type: "list",
          ordered: true,
          start: 1,
          children: [
            {
              type: "listItem",
              children: [{ type: "paragraph", children: [{ type: "text", value: "1" }] }],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "ul")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "ol")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "li")).toHaveLength(3);
  });

  // blockquote maps to <blockquote>, preserving nested content.
  test("blockquote wraps its children in <blockquote>", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "blockquote",
          children: [{ type: "paragraph", children: [{ type: "text", value: "quoted" }] }],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "blockquote")).toHaveLength(1);
    expect(flattenText(vnode)).toContain("quoted");
  });

  // Required-coverage item: "未知 node フォールバック" — a node type this
  // walker has never seen (a future CommonMark/GFM/mdast-extension addition)
  // must still surface its text content by recursing into `children`.
  test("unknown node type with children recurses into them (safe fallback)", () => {
    const root = {
      type: "root",
      children: [
        {
          // Not a real mdast type — simulates a future/unrecognized extension.
          type: "someFutureExtension",
          children: [{ type: "text", value: "future content" }],
        },
      ],
    } as unknown as Root;
    const vnode = renderMarkdownAst(root);
    expect(flattenText(vnode)).toContain("future content");
  });

  // An unknown node type with no `children` at all must not throw and must
  // render nothing (rather than e.g. JSON.stringify-ing arbitrary fields).
  test("unknown node type with no children renders nothing, without throwing", () => {
    const root = {
      type: "root",
      children: [{ type: "someOpaqueNode", value: "opaque" }],
    } as unknown as Root;
    expect(() => renderMarkdownAst(root)).not.toThrow();
    expect(flattenText(renderMarkdownAst(root))).toBe("");
  });

  // Required-coverage item: "GFM テーブル" — table/tableRow/tableCell fold
  // into <table><tbody><tr><th|td>, first row as headers, align reflected as
  // inline text-align style.
  test("GFM table renders as <table> with first row as <th>, rest as <td>, honoring align", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "table",
          align: ["left", "right"],
          children: [
            {
              type: "tableRow",
              children: [
                { type: "tableCell", children: [{ type: "text", value: "H1" }] },
                { type: "tableCell", children: [{ type: "text", value: "H2" }] },
              ],
            },
            {
              type: "tableRow",
              children: [
                { type: "tableCell", children: [{ type: "text", value: "A" }] },
                { type: "tableCell", children: [{ type: "text", value: "B" }] },
              ],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "table")).toHaveLength(1);
    const headers = collect(vnode, (n) => n.type === "th");
    const cells = collect(vnode, (n) => n.type === "td");
    expect(headers).toHaveLength(2);
    expect(cells).toHaveLength(2);
    expect(flattenText(headers[0])).toBe("H1");
    expect(flattenText(cells[0])).toBe("A");
    expect((headers[1]!.props as { style?: { textAlign?: string } }).style?.textAlign).toBe(
      "right",
    );
  });

  // A table with many columns must not be squeezed into the container's
  // width (see app.css's `.md-table-scroll` doc comment for why) — the
  // renderer wraps <table> in a `.md-table-scroll` div so app.css can scroll
  // that div horizontally while the table itself keeps its natural width.
  test("GFM table is wrapped in a .md-table-scroll div", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "table",
          children: [
            {
              type: "tableRow",
              children: [{ type: "tableCell", children: [{ type: "text", value: "H1" }] }],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    const wrappers = collect(
      vnode,
      (n) => n.type === "div" && (n.props as { class?: string }).class === "md-table-scroll",
    );
    expect(wrappers).toHaveLength(1);
    expect(collect(wrappers[0], (n) => n.type === "table")).toHaveLength(1);
  });

  // Plain text and a paragraph wrapper are the baseline case everything else
  // builds on.
  test("plain text inside a paragraph round-trips", () => {
    const root: Root = {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value: "hello world" }] }],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "p")).toHaveLength(1);
    expect(flattenText(vnode)).toBe("hello world");
  });
});

// DR-0015 §2.6 attachment path recognition + rendering. Composer sends
// message bodies with `[FILE<N>:<name>](<abs path to TMPDIR>)` links; the
// receiving webui rewrites those absolute paths to the daemon's HTTP endpoint
// (`/attachment/<basename>`) and, when the extension is an image MIME,
// upgrades the anchor to an inline <img>. All non-attachment URLs must go
// through the existing safe-URL / disarming path unchanged — the attachment
// short-circuit is additive.
describe("attachmentUrlFromPath (DR-0015 §2.6)", () => {
  // 何を保証する: TMPDIR path を daemon の GET URL に変換 + 画像拡張子判定。
  test("matches TMPDIR attachment path, extracts basename, and flags image mime by extension", () => {
    const got = attachmentUrlFromPath("/tmp/claude-ccmsg-501/attachment/abc-uuid.png");
    expect(got).not.toBeNull();
    expect(got!.url).toBe("/attachment/abc-uuid.png");
    expect(got!.isImage).toBe(true);
  });

  // 非画像拡張子は isImage=false — link のまま daemon URL に投げる (webui は
  // 通常の <a href> で表示、click で inline 表示 or download)。
  test("non-image extension gets isImage=false but still rewrites the URL", () => {
    const got = attachmentUrlFromPath("/private/tmp/claude-ccmsg-501/attachment/xyz.pdf");
    expect(got).not.toBeNull();
    expect(got!.url).toBe("/attachment/xyz.pdf");
    expect(got!.isImage).toBe(false);
  });

  // 拡張子なしの basename (Makefile 等) も daemon URL に変換される。isImage=false
  // — MIME sniff は daemon 側の職務。
  test("extension-less basename is still rewritten (isImage=false)", () => {
    const got = attachmentUrlFromPath("/tmp/claude-ccmsg-501/attachment/bareuuid");
    expect(got).not.toBeNull();
    expect(got!.url).toBe("/attachment/bareuuid");
    expect(got!.isImage).toBe(false);
  });

  // 別 uid も TMPDIR path prefix にマッチする (macOS `/private/tmp/claude-ccmsg-1000/...`
  // 等、Linux/macOS 差分に依存しない挙動を凍結)。
  test("matches regardless of prefix path segments before /claude-ccmsg-<uid>/", () => {
    expect(
      attachmentUrlFromPath("/var/folders/xx/claude-ccmsg-1000/attachment/f.png"),
    ).not.toBeNull();
    expect(attachmentUrlFromPath("/claude-ccmsg-501/attachment/f.png")).not.toBeNull();
  });

  // 非マッチ: 通常の TMPDIR 外 URL、hostile shape、http URL 等はすべて null。
  test("returns null for non-attachment URLs (http URL / random path / traversal-shaped)", () => {
    expect(attachmentUrlFromPath("https://example.com/pic.png")).toBeNull();
    expect(attachmentUrlFromPath("/etc/passwd")).toBeNull();
    // `attachment/` を含んでも `/claude-ccmsg-` prefix が無ければ非マッチ。
    expect(attachmentUrlFromPath("/tmp/random/attachment/x.png")).toBeNull();
    // basename に `/` があれば regex の `[^/]+` に落ちて非マッチ (traversal 防御)。
    expect(attachmentUrlFromPath("/tmp/claude-ccmsg-501/attachment/../etc")).toBeNull();
  });

  // 拡張子は大小文字非依存で判定される (PNG 等の upload に対応)。
  test("image extension check is case-insensitive", () => {
    const got = attachmentUrlFromPath("/tmp/claude-ccmsg-501/attachment/uuid.PNG");
    expect(got!.isImage).toBe(true);
  });
});

describe("renderMarkdownAst: attachment links (DR-0015 §2.6)", () => {
  // 何を保証する: link node の URL が TMPDIR attachment path + image 拡張子なら
  // <img> にアップグレードする。Composer が送る `[FILE1:diagram.png](/tmp/...)`
  // の受信 rendering ケース。
  test("image-mime attachment link renders as inline <img> wrapped in <a>", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "/tmp/claude-ccmsg-501/attachment/abc.png",
              children: [{ type: "text", value: "FILE1:diagram.png" }],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    const imgs = collect(vnode, (n) => n.type === "img");
    expect(imgs).toHaveLength(1);
    // src は daemon の GET endpoint。生の TMPDIR path は browser sandbox 越えで
    // fetch できないので、そのまま出したら壊れる → GET URL に変換が必須。
    expect((imgs[0]!.props as { src?: string }).src).toBe("/attachment/abc.png");
    // alt は link text から抽出 (`FILE1:diagram.png` 表記のまま)。
    expect((imgs[0]!.props as { alt?: string }).alt).toBe("FILE1:diagram.png");
    // 親 <a> の href も同じ GET URL — click で開くルートを維持。
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect((links[0]!.props as { href?: string }).href).toBe("/attachment/abc.png");
  });

  // 非画像添付 (pdf 等): <img> にはならず、link のまま daemon URL を href に持つ。
  test("non-image attachment link renders as plain <a href> to daemon URL, no <img>", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "/tmp/claude-ccmsg-501/attachment/uuid.pdf",
              children: [{ type: "text", value: "FILE1:notes.pdf" }],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "img")).toHaveLength(0);
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect((links[0]!.props as { href?: string }).href).toBe("/attachment/uuid.pdf");
    expect(flattenText(links[0])).toBe("FILE1:notes.pdf");
  });

  // 非 attachment link は既存 (disarming / <a href> 経路) を通る。
  // attachment 分岐が既存挙動を壊していないことの regression pin。
  test("non-attachment https link still renders as plain <a> (regression pin for the existing safe-url path)", () => {
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "link",
              url: "https://example.com/",
              children: [{ type: "text", value: "outside" }],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root);
    expect(collect(vnode, (n) => n.type === "img")).toHaveLength(0);
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect((links[0]!.props as { href?: string }).href).toBe("https://example.com/");
  });
});

// In-view search highlighting (DR-0022 §3): renderMarkdownAst's optional
// `search` context must reach into `text` nodes and wrap matches in
// <mark class="search-hl">, without touching output at all when omitted
// (the common no-active-search render path).
describe("renderMarkdownAst / DR-0022 search highlighting", () => {
  function textRoot(value: string): Root {
    return {
      type: "root",
      children: [{ type: "paragraph", children: [{ type: "text", value }] }],
    };
  }

  // Baseline: no `search` arg at all -> plain string text node, exactly the
  // pre-DR-0022 shape (no wrapping <span>, no <mark>).
  test("omitting search leaves text nodes as plain strings", () => {
    const vnode = renderMarkdownAst(textRoot("hello world"));
    expect(collect(vnode, (n) => n.type === "mark")).toHaveLength(0);
    expect(flattenText(vnode)).toBe("hello world");
  });

  test("tag-like rendered text matches the visible FILE text", () => {
    const words = parseSearchQuery("FILE", { caseSensitive: false, regex: false }).words;
    const vnode = renderMarkdownAst(parseMarkdownSource("before <FILE> after"), {
      words,
      onMatchClick: () => {},
    });
    const marks = collect(vnode, (n) => n.type === "mark");
    expect(marks).toHaveLength(1);
    expect(flattenText(marks[0])).toBe("FILE");
    expect(flattenText(vnode)).toBe("before <FILE> after");
  });

  test("a matching word is wrapped in <mark class=search-hl> with its colorIndex as --hl-color", () => {
    const words: SearchWord[] = parseSearchQuery("world", {
      caseSensitive: false,
      regex: false,
    }).words;
    const vnode = renderMarkdownAst(textRoot("hello world"), { words, onMatchClick: () => {} });
    const marks = collect(vnode, (n) => n.type === "mark");
    expect(marks).toHaveLength(1);
    expect((marks[0]!.props as { class?: string }).class).toBe("search-hl");
    expect((marks[0]!.props as { style?: Record<string, string> }).style).toEqual({
      "--hl-color": "var(--search-color-1)",
    });
    expect(flattenText(vnode)).toBe("hello world"); // content itself is unchanged, only wrapped
  });

  test("clicking a highlighted span invokes the passed onMatchClick", () => {
    const words: SearchWord[] = parseSearchQuery("world", {
      caseSensitive: false,
      regex: false,
    }).words;
    let clicked = 0;
    const vnode = renderMarkdownAst(textRoot("hello world"), {
      words,
      onMatchClick: () => {
        clicked += 1;
      },
    });
    const mark = collect(vnode, (n) => n.type === "mark")[0]!;
    (mark.props as unknown as { onClick: () => void }).onClick();
    expect(clicked).toBe(1);
  });

  test("no match -> text node stays a plain string even with a non-empty query", () => {
    const words: SearchWord[] = parseSearchQuery("zzz", {
      caseSensitive: false,
      regex: false,
    }).words;
    const vnode = renderMarkdownAst(textRoot("hello world"), { words, onMatchClick: () => {} });
    expect(collect(vnode, (n) => n.type === "mark")).toHaveLength(0);
    expect(flattenText(vnode)).toBe("hello world");
  });
});

// kawaz r55 m12: user-authored messages are rendered through a restricted
// pipeline where only inline code / fenced code blocks / blockquotes are
// interpreted as markdown, so the composer's `#123` text or `<R G B>` don't
// disappear into an H1 or an autolink.
describe("renderRestrictedMarkdown", () => {
  test("leading #NNNN is NOT a heading — the `#` and the rest survive verbatim", () => {
    const src = "別件でルール系の作業として追加。\n\n#NNNN でPRやIssue番号を書く際は...";
    const vnode = renderRestrictedMarkdown(src);
    // No heading tag, and the whole source text is present in the output.
    expect(collect(vnode, (n) => /^h[1-6]$/.test(String(n.type)))).toHaveLength(0);
    expect(flattenText(vnode)).toBe(src);
  });

  test("<R G B> is NOT an autolink / HTML tag — angle brackets survive", () => {
    const src = "色は <R G B> の順で並ぶ";
    const vnode = renderRestrictedMarkdown(src);
    expect(flattenText(vnode)).toBe(src);
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
  });

  test("emphasis / strong / list / hr / table markers are shown verbatim", () => {
    const src = "**bold** *em* _u_\n- item1\n- item2\n\n---\n\n| a | b |\n|---|---|\n| 1 | 2 |";
    const vnode = renderRestrictedMarkdown(src);
    expect(flattenText(vnode)).toBe(src);
    expect(collect(vnode, (n) => n.type === "strong")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "em")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "ul" || n.type === "ol")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "hr")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "table")).toHaveLength(0);
  });

  test("inline `code` renders as <code>", () => {
    const vnode = renderRestrictedMarkdown("run `foo bar` please");
    const codes = collect(vnode, (n) => n.type === "code");
    expect(codes).toHaveLength(1);
    expect(flattenText(codes[0])).toBe("foo bar");
    expect(flattenText(vnode)).toContain("run ");
    expect(flattenText(vnode)).toContain(" please");
  });

  test("fenced ``` code block renders as CodeBlock (lang preserved)", () => {
    const src = "before\n```ts\nconst x = 1\n```\nafter";
    const vnode = renderRestrictedMarkdown(src);
    const blocks = collect(vnode, (n) => n.type === CodeBlock);
    expect(blocks).toHaveLength(1);
    const props = blocks[0]!.props as unknown as { code: string; lang: string | null };
    expect(props.code).toBe("const x = 1");
    expect(props.lang).toBe("ts");
    // The `#`-heading disaster does not happen inside fences either — the
    // fence body is opaque to the tokenizer.
    const src2 = "```\n# not a heading\n```";
    const vnode2 = renderRestrictedMarkdown(src2);
    expect(collect(vnode2, (n) => /^h[1-6]$/.test(String(n.type)))).toHaveLength(0);
  });

  test("> quoted lines render as <blockquote>, adjacent runs coalesce", () => {
    const src = "> line1\n> line2\nafter";
    const vnode = renderRestrictedMarkdown(src);
    const quotes = collect(vnode, (n) => n.type === "blockquote");
    expect(quotes).toHaveLength(1);
    expect(flattenText(quotes[0])).toBe("line1\nline2");
  });

  test("bare newlines survive (rendered via pre-wrap span)", () => {
    // The output span carries `md-restricted-text` so CSS `pre-wrap` reveals
    // the `\n`; we assert the character actually reaches the DOM text.
    const vnode = renderRestrictedMarkdown("line1\nline2\nline3");
    expect(flattenText(vnode)).toBe("line1\nline2\nline3");
  });

  test("unclosed backtick is left as literal text (no swallowing)", () => {
    const src = "here is a ` stray backtick";
    const vnode = renderRestrictedMarkdown(src);
    expect(flattenText(vnode)).toBe(src);
    expect(collect(vnode, (n) => n.type === "code")).toHaveLength(0);
  });

  // kawaz r55 m16: user msgs carry composer attachments as
  // `[FILE<N>:name](path)` markdown links; the restricted tokenizer must
  // keep them live so a sent u1 bubble still shows the attachment.
  test("[FILE:name](attachment path) renders inline <img> for image mimes", () => {
    const src = "見て `[FILE1:screenshot.png](/tmp/claude-ccmsg-501/attachment/abcd.png)";
    // (leading backtick above is a distractor to verify the code/link race —
    // unclosed backtick stays verbatim, the link still tokenizes)
    const cleanSrc = "見て [FILE1:screenshot.png](/tmp/claude-ccmsg-501/attachment/abcd.png)";
    const vnode = renderRestrictedMarkdown(cleanSrc);
    const imgs = collect(vnode, (n) => n.type === "img");
    expect(imgs).toHaveLength(1);
    const props = imgs[0]!.props as unknown as { src: string; alt: string };
    // Rewritten to daemon HTTP endpoint (DR-0015 §2.6), not the raw fs path.
    expect(props.src).toBe("/attachment/abcd.png");
    expect(props.alt).toBe("FILE1:screenshot.png");
    // Ensure the raw fs path did not leak into visible text.
    expect(flattenText(vnode)).not.toContain("/tmp/claude-ccmsg-501");
    // Silence the eslint-unused warning for the distractor probe.
    expect(src).toContain("`");
  });

  test("[FILE:name](attachment path) renders <a class=md-attachment-link> for non-image mimes", () => {
    const src = "log は [FILE2:trace.txt](/private/tmp/claude-ccmsg-501/attachment/xyz.txt) を参照";
    const vnode = renderRestrictedMarkdown(src);
    const anchors = collect(vnode, (n) => n.type === "a");
    expect(anchors).toHaveLength(1);
    const props = anchors[0]!.props as unknown as { href: string; class?: string };
    expect(props.href).toBe("/attachment/xyz.txt");
    expect(props.class).toBe("md-attachment-link");
    expect(flattenText(anchors[0])).toBe("FILE2:trace.txt");
  });

  test("plain http link renders as <a>, javascript: is disarmed to text", () => {
    const vnode = renderRestrictedMarkdown(
      "見て [ここ](https://example.com/x) と [悪](javascript:alert(1))",
    );
    const anchors = collect(vnode, (n) => n.type === "a");
    // Only the https link produces an <a>; javascript: becomes a bare <span>.
    expect(anchors).toHaveLength(1);
    const props = anchors[0]!.props as unknown as { href: string };
    expect(props.href).toBe("https://example.com/x");
    // The disarmed link's label is still visible.
    expect(flattenText(vnode)).toContain("悪");
    // And no href ever carried the javascript: scheme.
    for (const a of anchors) {
      const p = a.props as unknown as { href: string };
      expect(p.href.toLowerCase()).not.toContain("javascript:");
    }
  });

  test("image markdown ![alt](url) stays verbatim (composer does not emit it)", () => {
    const src = "![alt](https://example.com/pic.png)";
    const vnode = renderRestrictedMarkdown(src);
    expect(collect(vnode, (n) => n.type === "img")).toHaveLength(0);
    expect(flattenText(vnode)).toBe(src);
  });
});

// `<details>` folding (kawaz r55 m77). The renderer maps exactly two HTML tags
// onto real elements; everything else stays literal text, so these tests
// pin both halves — the shapes that must fold, and the near-misses that must
// not. Sources go through `parseMarkdownDocument` (parse + fold) because the
// fold's whole job is reassembling what the parser split apart, and a
// hand-built tree would not exercise that.
describe("parseMarkdownDocument / <details> folding", () => {
  function render(source: string): VNode {
    return renderMarkdownAst(parseMarkdownDocument(source));
  }
  const details = (vnode: VNode) => collect(vnode, (n) => n.type === "details");
  const summaries = (vnode: VNode) => collect(vnode, (n) => n.type === "summary");

  test("the canonical blank-line-separated form becomes a real <details>", () => {
    const vnode = render("<details>\n<summary>title</summary>\n\ncontent\n\n</details>");
    const found = details(vnode);
    expect(found).toHaveLength(1);
    expect(flattenText(summaries(vnode)[0])).toBe("title");
    expect(flattenText(found[0])).toContain("content");
    // The tag text itself never survives into the output as prose.
    expect(flattenText(vnode)).not.toContain("<details>");
    expect(flattenText(vnode)).not.toContain("</summary>");
  });

  // Without blank lines the parser keeps the entire block as ONE paragraph,
  // so the fold has to split paragraphs into source lines rather than rely on
  // node boundaries. Same visible result as the form above.
  test("the compact form with no blank lines folds identically", () => {
    const vnode = render("<details>\n<summary>t</summary>\ncontent\n</details>");
    expect(details(vnode)).toHaveLength(1);
    expect(flattenText(summaries(vnode)[0])).toBe("t");
    expect(flattenText(details(vnode)[0])).toContain("content");
  });

  test("`<details open>` renders expanded, a bare `<details>` collapsed", () => {
    const openProps = details(render("<details open>\n<summary>t</summary>\n\nx\n\n</details>"))[0]!
      .props as unknown as { open: boolean };
    expect(openProps.open).toBe(true);
    const shutProps = details(render("<details>\n<summary>t</summary>\n\nx\n\n</details>"))[0]!
      .props as unknown as { open: boolean };
    expect(shutProps.open).toBe(false);
  });

  // The label is prose in every real use, so it keeps its inline markdown
  // rather than being flattened to the raw characters the author typed.
  test("summary keeps inline markdown", () => {
    const vnode = render(
      "<details>\n<summary>**bold** and [d](https://e.com)</summary>\n\nx\n\n</details>",
    );
    const summary = summaries(vnode)[0]!;
    expect(collect(summary, (n) => n.type === "strong")).toHaveLength(1);
    expect(collect(summary, (n) => n.type === "a")).toHaveLength(1);
    expect(flattenText(summary)).toContain("bold");
  });

  test("block markdown inside the body still renders as markdown", () => {
    const vnode = render(
      "<details>\n<summary>t</summary>\n\n- a\n- b\n\n```js\nvar a=1\n```\n\n</details>",
    );
    expect(collect(vnode, (n) => n.type === "ul")).toHaveLength(1);
    expect(collect(vnode, (n) => n.type === "li")).toHaveLength(2);
    expect(collect(vnode, (n) => n.type === CodeBlock)).toHaveLength(1);
  });

  test("a body with no <summary> still folds (browser supplies the label)", () => {
    const vnode = render("<details>\n\nx\n\n</details>");
    expect(details(vnode)).toHaveLength(1);
    expect(summaries(vnode)).toHaveLength(1);
    expect(flattenText(details(vnode)[0])).toContain("x");
  });

  test("surrounding prose is preserved on both sides", () => {
    const vnode = render("before\n\n<details>\n<summary>t</summary>\n\nx\n\n</details>\n\nafter");
    expect(details(vnode)).toHaveLength(1);
    const text = flattenText(vnode);
    expect(text).toContain("before");
    expect(text).toContain("after");
  });

  test("nesting produces nested elements without hanging or dropping content", () => {
    const src =
      "<details>\n<summary>outer</summary>\n\n<details>\n<summary>inner</summary>\n\ndeep\n\n</details>\n\n</details>";
    const vnode = render(src);
    const found = details(vnode);
    expect(found).toHaveLength(2);
    // The inner one is a descendant of the outer, not a sibling.
    expect(collect(found[0]!, (n) => n.type === "details")).toHaveLength(2);
    expect(flattenText(vnode)).toContain("deep");
    expect(summaries(vnode).map(flattenText)).toEqual(["outer", "inner"]);
  });

  test("blockquotes and other containers fold their own <details>", () => {
    const vnode = render("> <details>\n> <summary>t</summary>\n>\n> x\n>\n> </details>");
    expect(collect(vnode, (n) => n.type === "blockquote")).toHaveLength(1);
    expect(details(vnode)).toHaveLength(1);
  });

  // --- near-misses: everything below must stay literal text ---

  test("an opener with no closer stays literal text", () => {
    const src = "<details>\n<summary>t</summary>\n\ncontent";
    const vnode = render(src);
    expect(details(vnode)).toHaveLength(0);
    expect(flattenText(vnode)).toContain("<details>");
    expect(flattenText(vnode)).toContain("<summary>t</summary>");
    expect(flattenText(vnode)).toContain("content");
  });

  test("a stray closer alone stays literal text", () => {
    const vnode = render("x\n\n</details>\n\ny");
    expect(details(vnode)).toHaveLength(0);
    expect(flattenText(vnode)).toContain("</details>");
  });

  test("<detailsfoo> does not match the tag name", () => {
    const vnode = render("<detailsfoo>\n<summary>t</summary>\n\nx\n\n</detailsfoo>");
    expect(details(vnode)).toHaveLength(0);
    expect(flattenText(vnode)).toContain("<detailsfoo>");
  });

  // Security: the tag is recognized by exact shape, and `open` is the ONLY
  // attribute accepted. An attribute-carrying tag fails to match entirely,
  // so its text is escaped prose — no handler, no attribute, no element.
  test("attribute-carrying tags are refused and shown as text", () => {
    for (const tag of [
      '<details onclick="alert(1)">',
      '<details open="true">',
      '<details class="x">',
    ]) {
      const vnode = render(`${tag}\n<summary>t</summary>\n\nx\n\n</details>`);
      expect(details(vnode)).toHaveLength(0);
      expect(flattenText(vnode)).toContain(tag);
    }
  });

  test("no attribute other than `open` ever reaches the rendered element", () => {
    const vnode = render("<details open>\n<summary>t</summary>\n\nx\n\n</details>");
    const props = details(vnode)[0]!.props as unknown as Record<string, unknown>;
    expect(Object.keys(props).sort()).toEqual(["children", "class", "open"]);
    expect(props.class).toBe("md-details");
  });

  test("tags inside a fenced code block are code, not markup", () => {
    const vnode = render("```html\n<details>\n<summary>t</summary>\n</details>\n```");
    expect(details(vnode)).toHaveLength(0);
    const blocks = collect(vnode, (n) => n.type === CodeBlock);
    expect(blocks).toHaveLength(1);
    expect((blocks[0]!.props as unknown as { code: string }).code).toContain("<details>");
  });

  test("a tag mentioned mid-sentence is prose, not a fold", () => {
    const src = "Use <details> for folding.";
    const vnode = render(src);
    expect(details(vnode)).toHaveLength(0);
    expect(flattenText(vnode)).toBe(src);
  });

  test("restricted mode (user-authored messages) keeps the source verbatim", () => {
    const src = "<details>\n<summary>title</summary>\n\ncontent\n\n</details>";
    const vnode = renderRestrictedMarkdown(src);
    expect(collect(vnode, (n) => n.type === "details")).toHaveLength(0);
    expect(flattenText(vnode)).toBe(src);
  });

  // A deeply unbalanced document must terminate rather than recurse forever.
  test("pathological unbalanced input terminates and drops nothing", () => {
    const src = `${"<details>\n".repeat(50)}body\n${"</details>\n".repeat(3)}`;
    expect(() => render(src)).not.toThrow();
    expect(flattenText(render(src))).toContain("body");
  });
});

// GFM task lists (kawaz r55: QUESTIONS.md arbitration UX). The parser
// consumes the `[ ]` characters, so a task item that rendered as a bare <li>
// would lose them from the display entirely — the checkbox is the rendering
// of those characters, and is merely disabled where it can't be clicked.
describe("renderMarkdownAst / task lists", () => {
  const source = "- [ ] a\n- [x] b\n  - [ ] nested\n- plain\n";
  const checkboxes = (vnode: unknown) =>
    collect(vnode, (n) => n.type === "input") as (VNode & {
      props: { checked?: boolean; disabled?: boolean; onClick?: () => void };
    })[];

  test("task items render a checkbox reflecting `checked`; plain items do not", () => {
    const vnode = renderMarkdownAst(parseMarkdownDocument(source));
    const boxes = checkboxes(vnode);
    expect(boxes.map((b) => b.props.checked)).toEqual([false, true, false]);
    expect(collect(vnode, (n) => n.type === "li")).toHaveLength(4);
  });

  test("without a taskList ctx every checkbox is disabled and inert", () => {
    const boxes = checkboxes(renderMarkdownAst(parseMarkdownDocument(source)));
    expect(boxes.every((b) => b.props.disabled === true)).toBe(true);
    expect(boxes.every((b) => b.props.onClick === undefined)).toBe(true);
  });

  // Ordinals are the coordinate the write uses (see markdown-task-list.ts), so
  // the click must report document order — a parent numbers before the items
  // nested inside it.
  test("clicking reports the item's document-order ordinal and its states", () => {
    const seen: [number, boolean, boolean][] = [];
    const vnode = renderMarkdownAst(parseMarkdownDocument(source), undefined, undefined, {
      taskList: { onToggle: (ordinal, from, to) => seen.push([ordinal, from, to]) },
    });
    const boxes = checkboxes(vnode);
    expect(boxes).toHaveLength(3);
    for (const box of boxes) box.props.onClick?.();
    expect(seen).toEqual([
      [0, false, true],
      [1, true, false],
      [2, false, true],
    ]);
  });

  // Writes are applied optimistically and serialized by the caller, so a run
  // of quick clicks must all be accepted rather than blocked while one lands.
  test("checkboxes stay enabled so consecutive clicks all register", () => {
    const seen: number[] = [];
    const vnode = renderMarkdownAst(parseMarkdownDocument(source), undefined, undefined, {
      taskList: { onToggle: (ordinal) => seen.push(ordinal) },
    });
    const boxes = checkboxes(vnode);
    expect(boxes.every((b) => b.props.disabled === false)).toBe(true);
    boxes[0]!.props.onClick?.();
    boxes[0]!.props.onClick?.();
    expect(seen).toEqual([0, 0]);
  });

  test("extractTaskStates walks the same items in the same order", () => {
    expect(extractTaskStates(parseMarkdownDocument(source))).toEqual([false, true, false]);
  });

  // A write that fails has to be visible where the user is looking: at the
  // checkbox that just sprang back, not in a banner at the top of a document
  // they have scrolled down (kawaz r55 m125).
  describe("per-item write failures", () => {
    const withErrors = (
      errors: Map<number, { message: string; seq: number }>,
      onDismissError?: (ordinal: number) => void,
    ) =>
      renderMarkdownAst(parseMarkdownDocument(source), undefined, undefined, {
        taskList: { onToggle: () => {}, errors, onDismissError },
      });
    const items = (vnode: unknown) =>
      collect(vnode, (n) => n.type === "li") as (VNode & { props: { class?: string } })[];
    const errorNodes = (vnode: unknown) =>
      collect(vnode, (n) => (n.props as { class?: string }).class === "md-task-error");

    test("the message renders inside the failing item, not at the document top", () => {
      const vnode = withErrors(new Map([[1, { message: "競合しました", seq: 1 }]]));
      const errored = items(vnode).filter((li) => li.props.class?.includes("md-task-item-error"));
      expect(errored).toHaveLength(1);
      // Ordinal 1 is the second task item ("b"), so the message must live in
      // that item's subtree alongside its own text.
      expect(flattenText(errored[0])).toContain("b");
      expect(flattenText(errored[0])).toContain("競合しました");
      expect(errorNodes(vnode)).toHaveLength(1);
    });

    test("items without an error are untouched", () => {
      const vnode = withErrors(new Map([[1, { message: "競合しました", seq: 1 }]]));
      const clean = items(vnode).filter((li) => !li.props.class?.includes("md-task-item-error"));
      expect(clean).toHaveLength(3);
      for (const li of clean) expect(flattenText(li)).not.toContain("競合しました");
    });

    // Writes are queued per click, each resolved against its own fresh read,
    // so two items can fail independently — one banner could only show one.
    test("several items can report failures at once", () => {
      const vnode = withErrors(
        new Map([
          [0, { message: "削除されています", seq: 1 }],
          [2, { message: "競合しました", seq: 2 }],
        ]),
      );
      expect(errorNodes(vnode)).toHaveLength(2);
      expect(
        items(vnode).filter((li) => li.props.class?.includes("md-task-item-error")),
      ).toHaveLength(2);
    });

    // The flash that marks a rollback is a one-shot CSS animation, so a repeat
    // failure of an already-errored item must remount the row to replay it.
    test("a new seq changes the item's key so its flash replays", () => {
      const first = items(withErrors(new Map([[1, { message: "競合", seq: 1 }]])));
      const again = items(withErrors(new Map([[1, { message: "競合", seq: 2 }]])));
      const keyOf = (li: VNode) => (li as unknown as { key?: unknown }).key;
      const erroredKey = (list: VNode[]) =>
        keyOf(list.find((li) => (li.props as { class?: string }).class?.includes("error"))!);
      expect(erroredKey(first)).not.toBe(erroredKey(again));
    });

    test("dismissing reports the item's own ordinal; absent handler renders no button", () => {
      const dismissed: number[] = [];
      const withButton = withErrors(new Map([[2, { message: "競合", seq: 1 }]]), (o) =>
        dismissed.push(o),
      );
      const buttons = collect(
        withButton,
        (n) => (n.props as { class?: string }).class === "md-task-error-dismiss",
      ) as (VNode & { props: { onClick?: () => void } })[];
      expect(buttons).toHaveLength(1);
      buttons[0]!.props.onClick?.();
      expect(dismissed).toEqual([2]);

      const noHandler = collect(
        withErrors(new Map([[2, { message: "競合", seq: 1 }]])),
        (n) => (n.props as { class?: string }).class === "md-task-error-dismiss",
      );
      expect(noHandler).toHaveLength(0);
    });

    test("a read-only render (no taskList ctx) shows no error decoration", () => {
      const vnode = renderMarkdownAst(parseMarkdownDocument(source));
      expect(errorNodes(vnode)).toHaveLength(0);
      expect(items(vnode).some((li) => li.props.class?.includes("md-task-item-error"))).toBe(false);
    });
  });
});

// Renderer half of the link classification (kawaz r55 m116/m117). The pure
// URL decisions live in markdown-link.test.ts; what is pinned here is the
// *output shape* each decision produces — specifically that a path target
// never becomes an `<a href>` unless a resolver confirmed it, since an
// origin-relative href is the dead end this work exists to remove.
describe("renderMarkdownAst / markdown links to files", () => {
  function linkRoot(url: string, text = "click"): Root {
    return {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [{ type: "link", url, children: [{ type: "text", value: text }] }],
        },
      ],
    };
  }

  const anchors = (v: VNode): VNode[] => collect(v, (n) => n.type === "a");
  const hrefOf = (n: VNode): string | undefined => (n.props as { href?: string }).href;

  test("a relative path with no resolver renders inert — no href at all", () => {
    const vnode = renderMarkdownAst(linkRoot("fixtures/seq-parse/literal.json"));
    expect(anchors(vnode)).toHaveLength(0);
    expect(flattenText(vnode)).toContain("click");
  });

  test("an absolute path with no resolver renders inert too", () => {
    const vnode = renderMarkdownAst(linkRoot("/fixtures/seq-parse/literal.json"));
    expect(anchors(vnode)).toHaveLength(0);
  });

  // A resolver reports null when it cannot form an absolute path at all (no
  // anchor in its ctx). Existence is no longer consulted (kawaz r55 m129), so
  // this is the only remaining null — and it must still fail closed rather
  // than fall through to an origin-relative <a>.
  test("a resolver returning null renders inert rather than an origin-relative link", () => {
    const vnode = renderMarkdownAst(linkRoot("docs/spec.md"), undefined, undefined, {
      pathLinker: () => null,
    });
    expect(anchors(vnode)).toHaveLength(0);
  });

  test("a confirmed path links to the resolver's href and stays in-app", () => {
    const vnode = renderMarkdownAst(linkRoot("docs/spec.md"), undefined, undefined, {
      pathLinker: () => "#sSID:docs%2Fspec.md",
    });
    const a = anchors(vnode);
    expect(a).toHaveLength(1);
    expect(hrefOf(a[0]!)).toBe("#sSID:docs%2Fspec.md");
    // target="_blank" would leave a standalone PWA with no way back, and the
    // destination is this same app anyway.
    expect((a[0]!.props as { target?: string }).target).toBeUndefined();
  });

  test("the parsed ref reaches the resolver, line fragment included", () => {
    const seen: unknown[] = [];
    renderMarkdownAst(linkRoot("src/a.ts#L10-L20"), undefined, undefined, {
      pathLinker: (ref) => {
        seen.push(ref);
        return null;
      },
    });
    expect(seen).toEqual([{ path: "src/a.ts", line: 10, end: 20 }]);
  });

  test("external URLs are untouched — still a new-tab link", () => {
    const vnode = renderMarkdownAst(linkRoot("https://example.com/x"));
    const a = anchors(vnode);
    expect(a).toHaveLength(1);
    expect(hrefOf(a[0]!)).toBe("https://example.com/x");
    expect((a[0]!.props as { target?: string }).target).toBe("_blank");
    expect((a[0]!.props as { rel?: string }).rel).toBe("noopener noreferrer");
  });

  // Self-referential ccmsg links (a session sharing its own webui URL) must
  // not get the new-tab treatment: same reasoning as the path/anchor cases
  // above (a standalone PWA has no way back). `location` does not exist in
  // this bun:test environment (no DOM), matching the guard in
  // `currentOrigin()` — these tests shim it in and restore it after.
  describe("with a same-origin absolute URL (location shimmed in)", () => {
    const origin = "https://ccmsg.example.com";
    const previousLocation = (globalThis as { location?: unknown }).location;

    beforeEach(() => {
      Object.defineProperty(globalThis, "location", {
        value: new URL(`${origin}/s/current`),
        configurable: true,
      });
    });

    afterEach(() => {
      if (previousLocation === undefined) {
        delete (globalThis as { location?: unknown }).location;
      } else {
        Object.defineProperty(globalThis, "location", {
          value: previousLocation,
          configurable: true,
        });
      }
    });

    test("a link back to this webui's own origin opens same-tab", () => {
      const vnode = renderMarkdownAst(linkRoot(`${origin}/s/abc/timeline/head`));
      const a = anchors(vnode);
      expect(a).toHaveLength(1);
      expect(hrefOf(a[0]!)).toBe(`${origin}/s/abc/timeline/head`);
      expect((a[0]!.props as { target?: string }).target).toBeUndefined();
      expect((a[0]!.props as { rel?: string }).rel).toBeUndefined();
    });

    test("a link to a different origin still opens a new tab", () => {
      const vnode = renderMarkdownAst(linkRoot("https://example.com/x"));
      const a = anchors(vnode);
      expect(a).toHaveLength(1);
      expect((a[0]!.props as { target?: string }).target).toBe("_blank");
      expect((a[0]!.props as { rel?: string }).rel).toBe("noopener noreferrer");
    });

    // A relative link's routing (the FileViewer `path` kind) must stay
    // completely untouched by the `currentOrigin` addition.
    test("a relative path link is still routed as a path target, unaffected", () => {
      const vnode = renderMarkdownAst(linkRoot("docs/spec.md"), undefined, undefined, {
        pathLinker: () => "#sSID:docs%2Fspec.md",
      });
      const a = anchors(vnode);
      expect(a).toHaveLength(1);
      expect(hrefOf(a[0]!)).toBe("#sSID:docs%2Fspec.md");
      expect((a[0]!.props as { target?: string }).target).toBeUndefined();
    });
  });

  test("in-page anchors stay same-window links", () => {
    const vnode = renderMarkdownAst(linkRoot("#md-section-2"));
    const a = anchors(vnode);
    expect(a).toHaveLength(1);
    expect(hrefOf(a[0]!)).toBe("#md-section-2");
    expect((a[0]!.props as { target?: string }).target).toBeUndefined();
  });

  test("a resolver is never consulted for a hostile scheme", () => {
    let called = false;
    const vnode = renderMarkdownAst(linkRoot("javascript:alert(1)"), undefined, undefined, {
      pathLinker: () => {
        called = true;
        return "#anything";
      },
    });
    expect(called).toBe(false);
    expect(anchors(vnode)).toHaveLength(0);
  });

  // Images take the same four-way decision; DR-0010's "never auto-fetch"
  // rule still holds, so a resolved image is a link, never an <img src>.
  test("an image with a path target renders as a link, not an auto-fetched <img>", () => {
    const root: Root = {
      type: "root",
      children: [
        { type: "paragraph", children: [{ type: "image", url: "assets/d.png", alt: "diagram" }] },
      ],
    };
    const unresolved = renderMarkdownAst(root);
    expect(anchors(unresolved)).toHaveLength(0);
    expect(collect(unresolved, (n) => n.type === "img")).toHaveLength(0);

    const resolved = renderMarkdownAst(root, undefined, undefined, {
      pathLinker: () => "#sSID:assets%2Fd.png",
    });
    const a = anchors(resolved);
    expect(a).toHaveLength(1);
    expect(hrefOf(a[0]!)).toBe("#sSID:assets%2Fd.png");
    expect(collect(resolved, (n) => n.type === "img")).toHaveLength(0);
  });

  // Attachment links (DR-0015 §2.6) are rewritten to a daemon HTTP endpoint
  // before classification runs, so they must not be swept into the path case.
  test("attachment links keep their daemon endpoint rewrite", () => {
    const vnode = renderMarkdownAst(linkRoot("/tmp/claude-ccmsg-501/attachment/x.pdf", "FILE1:x"));
    const a = anchors(vnode);
    expect(a).toHaveLength(1);
    expect(hrefOf(a[0]!)).toBe("/attachment/x.pdf");
  });
});

// Restricted mode (user-authored messages) has no session-scoped resolver, so
// every path target is inert there. Pinned separately because restricted mode
// runs its own tokenizer, not the mdast walk.
describe("renderRestrictedMarkdown / link targets", () => {
  test("a path-shaped target does not become an origin-relative link", () => {
    const vnode = renderRestrictedMarkdown("see [notes](docs/notes.md)");
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(flattenText(vnode)).toContain("notes");
  });

  test("an external URL still links", () => {
    const vnode = renderRestrictedMarkdown("see [site](https://example.com)");
    const a = collect(vnode, (n) => n.type === "a");
    expect(a).toHaveLength(1);
    expect((a[0]!.props as { href?: string }).href).toBe("https://example.com");
  });
});

describe("parseMarkdownSource / empty table header cells", () => {
  function tableNodes(source: string): { align: unknown; rows: string[][] }[] {
    const out: { align: unknown; rows: string[][] }[] = [];
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        for (const child of node) walk(child);
        return;
      }
      if (node === null || typeof node !== "object") return;
      const typed = node as { type?: string; align?: unknown; children?: unknown };
      if (typed.type === "table") {
        out.push({
          align: typed.align,
          rows: (typed.children as { children: unknown[] }[]).map((row) =>
            row.children.map((cell) =>
              flattenText(
                renderMarkdownAst({
                  type: "root",
                  children: [{ type: "paragraph", children: (cell as { children: [] }).children }],
                } as unknown as Root),
              ),
            ),
          ),
        });
        return;
      }
      walk(typed.children);
    };
    walk(parseMarkdownSource(source).children);
    return out;
  }

  // kawaz r99m41: a comparison table whose first column holds row labels starts
  // with an empty header cell, and the whole block rendered as raw pipe text.
  test("comparison table with an empty leading header cell parses as a table", () => {
    const [table, ...rest] = tableNodes(
      [
        "## 比較",
        "",
        "| | Anthropic Messages API | OpenAI Responses API |",
        "|---|---|---|",
        "| 名前 | messages | responses |",
      ].join("\n"),
    );
    expect(rest).toHaveLength(0);
    expect(table?.rows).toEqual([
      ["", "Anthropic Messages API", "OpenAI Responses API"],
      ["名前", "messages", "responses"],
    ]);
  });

  // GFM allows an empty or whitespace-only header cell at any column index,
  // with or without padding spaces, and inside a blockquote — the usual shape
  // of a comparison table whose first column holds row labels (kawaz r99m41).
  test("every measured empty-header-cell shape parses as a table with the cell empty", () => {
    const cases: [string, string, string[][]][] = [
      [
        "col 0",
        "| | A | B |",
        [
          ["", "A", "B"],
          ["x", "1", "2"],
        ],
      ],
      [
        "col 1",
        "| h | | B |",
        [
          ["h", "", "B"],
          ["x", "1", "2"],
        ],
      ],
      [
        "col 2",
        "| h | A | |",
        [
          ["h", "A", ""],
          ["x", "1", "2"],
        ],
      ],
      [
        "no padding spaces",
        "|| A | B |",
        [
          ["", "A", "B"],
          ["x", "1", "2"],
        ],
      ],
      [
        "tab-only cell",
        "|\t| A | B |",
        [
          ["", "A", "B"],
          ["x", "1", "2"],
        ],
      ],
      [
        "all cells empty",
        "| | | |",
        [
          ["", "", ""],
          ["x", "1", "2"],
        ],
      ],
    ];
    for (const [name, header, expected] of cases) {
      const tables = tableNodes(`${header}\n|---|---|---|\n| x | 1 | 2 |`);
      expect(tables, name).toHaveLength(1);
      expect(tables[0]?.rows, name).toEqual(expected);
    }
  });

  test("empty header cells parse inside a blockquote and with no body row", () => {
    expect(tableNodes("> | | A |\n> |---|---|\n> | x | 1 |")[0]?.rows).toEqual([
      ["", "A"],
      ["x", "1"],
    ]);
    expect(tableNodes("| | A |\n|---|---|")[0]?.rows).toEqual([["", "A"]]);
  });

  test("empty body cells and alignment markers keep working", () => {
    const [table] = tableNodes("| | A | B |\n|:--|:-:|--:|\n| | 1 | |");
    expect(table?.rows).toEqual([
      ["", "A", "B"],
      ["", "1", ""],
    ]);
    expect(table?.align).toEqual(["left", "center", "right"]);
  });

  // Pipe lines that are not tables must survive byte-for-byte.
  test("pipes inside fenced code and non-table prose are untouched", () => {
    const fenced = ["```", "| | A | B |", "|---|---|---|", "| x | 1 | 2 |", "```"].join("\n");
    expect(tableNodes(fenced)).toHaveLength(0);
    const code = parseMarkdownSource(fenced).children[0] as { type: string; value: string };
    expect(code.type).toBe("code");
    expect(code.value).toBe("| | A | B |\n|---|---|---|\n| x | 1 | 2 |");

    const prose = "a | b | c\nnot a delimiter row";
    expect(tableNodes(prose)).toHaveLength(0);
    expect(flattenText(renderMarkdownAst(parseMarkdownSource(prose)))).toBe(
      "a | b | c\nnot a delimiter row",
    );
  });

  test("escaped pipes in a header row do not shift cell boundaries", () => {
    const [table] = tableNodes("| a\\|b | | B |\n|---|---|---|\n| x | 1 | 2 |");
    expect(table?.rows[0]).toEqual(["a|b", "", "B"]);
  });
});

// CommonMark conformance pins (see
// docs/findings/2026-08-13-markdown-parser-comparison.md).
//
// Each case below is a construct a previous parser got wrong in a way a reader
// would notice — a continuation line escaping its bullet, emphasis swallowing
// its neighbours, a tab eating the characters after it. They are pinned as AST
// shape rather than rendered output because the shape is what the walker
// consumes, and because a wrong shape is what made the rendered output wrong.
describe("parseMarkdownSource / CommonMark conformance", () => {
  const skeleton = (node: unknown): string => {
    const n = node as { type: string; children?: unknown[] };
    return n.children ? `${n.type}(${n.children.map(skeleton).join(",")})` : n.type;
  };
  const shape = (source: string) => parseMarkdownSource(source).children.map(skeleton).join(",");

  // A continuation line indented under a bullet belongs to that item; it must
  // not break out into a sibling paragraph.
  test("an indented continuation line stays inside its list item", () => {
    expect(shape("- a\n  more\n- b\n")).toBe(
      "list(listItem(paragraph(text)),listItem(paragraph(text)))",
    );
    const list = parseMarkdownSource("- a\n  more\n- b\n").children[0];
    expect(list?.type).toBe("list");
    if (list?.type !== "list") return;
    const paragraph = list.children[0]?.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;
    const text = paragraph.children[0];
    expect(text?.type).toBe("text");
    if (text?.type !== "text") return;
    expect(text.value).toBe("a\nmore");
  });

  // Inline code inside strong emphasis must appear once, as one inlineCode
  // child — not duplicated around the span.
  test("inline code inside strong emphasis is not duplicated", () => {
    expect(shape("**x `c` y**\n")).toBe("paragraph(strong(text,inlineCode,text))");
  });

  // A blank line before the continuation makes the item loose (two paragraphs
  // in one item). The whole run must stay one list: splitting it at the
  // continuation leaves the later bullets in a second list, which restarts
  // numbering and breaks the spacing between them.
  test("a loose continuation keeps the list in one piece", () => {
    expect(shape("- a\n\n  cont\n- b\n")).toBe(
      "list(listItem(paragraph(text),paragraph(text)),listItem(paragraph(text)))",
    );
  });

  // An empty leading bullet is a list item with no children, not a paragraph
  // of the bullet character followed by a separate list.
  test("an empty leading bullet stays part of its list", () => {
    expect(shape("-\n- b\n")).toBe("list(listItem(),listItem(paragraph(text)))");
  });

  // Link reference definitions: the reference resolves and the definition is
  // its own node rather than being flattened into the paragraph's text.
  test("link reference definitions parse as linkReference + definition", () => {
    expect(shape('See [foo].\n\n[foo]: https://example.com "T"\n')).toBe(
      "paragraph(text,linkReference(text),text),definition",
    );
    // All three reference forms, because the definition node carries the URL:
    // losing it strips the destination out of the tree entirely, and the
    // shortcut form is the one a parser is most likely to not recognize.
    for (const source of [
      "[a][r]\n\n[r]: https://ex.com\n",
      "[r][]\n\n[r]: https://ex.com\n",
      "[r]\n\n[r]: https://ex.com\n",
    ]) {
      expect(shape(source)).toBe("paragraph(linkReference(text)),definition");
    }
  });

  // Inline HTML is literal text here (protectTagLikeAngleBrackets, DR-0010) —
  // the point of this pin is that it is never a `link`, which is what would
  // put an unintended anchor in the middle of a sentence.
  test("inline HTML is literal text, never a link", () => {
    expect(shape("a <b>bold</b> c\n")).toBe("paragraph(text)");
    const vnode = renderMarkdownAst(parseMarkdownSource("a <b>bold</b> c\n"));
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(flattenText(vnode)).toBe("a <b>bold</b> c");
  });

  // `**` nested inside `*` nests as strong-within-emphasis, with the
  // surrounding text kept as siblings.
  test("emphasis nests in both directions and keeps its surrounding text", () => {
    expect(shape("*outer **inner** rest*\n")).toBe("paragraph(emphasis(text,strong(text),text))");
    expect(shape("**x *e* y**\n")).toBe("paragraph(strong(text,emphasis(text),text))");
  });

  // Tabs are expanded to CommonMark's tab stops: a tab-indented continuation
  // line stays in the item, and two tabs after the bullet is indented code.
  test("tab indentation follows CommonMark tab stops", () => {
    expect(shape("- foo\n\tbar\n")).toBe("list(listItem(paragraph(text)))");
    expect(shape("-\t\tfoo\n")).toBe("list(listItem(code))");
    // A tab-indented code block keeps every character after the tab: a tab
    // stop is a width, not a count of characters to drop.
    const code = parseMarkdownSource("\tcode\n").children[0];
    expect(code?.type).toBe("code");
    if (code?.type !== "code") return;
    expect(code.value).toBe("code");
  });

  // Constructs that must keep rendering exactly as they always have. These are
  // the other half of a parser swap: the conformance pins above prove the
  // breakage is gone, these prove nothing else moved with it.
  test("everyday constructs are unchanged", () => {
    expect(shape("- a\n- b\n")).toBe("list(listItem(paragraph(text)),listItem(paragraph(text)))");
    expect(shape("1. a\n2. b\n")).toBe("list(listItem(paragraph(text)),listItem(paragraph(text)))");
    expect(shape("- a\n  - b\n")).toBe(
      "list(listItem(paragraph(text),list(listItem(paragraph(text)))))",
    );
    expect(shape("- [x] done\n- [ ] todo\n")).toBe(
      "list(listItem(paragraph(text)),listItem(paragraph(text)))",
    );
    expect(shape("| a | b |\n| - | - |\n| 1 | 2 |\n")).toBe(
      "table(tableRow(tableCell(text),tableCell(text)),tableRow(tableCell(text),tableCell(text)))",
    );
    expect(shape("~~x~~\n")).toBe("paragraph(delete(text))");
    expect(shape("a  \nb\n")).toBe("paragraph(text,break,text)");
    expect(shape("a\n===\n")).toBe("heading(text)");
    expect(shape("> a\n> b\n")).toBe("blockquote(paragraph(text))");
  });

  // A bare URL in prose stays prose. GFM's autolink-literal extension would
  // turn it into a link, which is a behavior change for message bodies full of
  // pasted URLs — so this app registers table/strikethrough/task-list only.
  // If this starts failing, the GFM extension set grew.
  test("a bare URL in prose is not autolinked", () => {
    expect(shape("see https://ex.com x\n")).toBe("paragraph(text)");
    const vnode = renderMarkdownAst(parseMarkdownSource("see https://ex.com x\n"));
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
  });

  // `position.start.offset` is a document-absolute UTF-16 index. Both halves
  // matter: astral characters (QUESTIONS.md marks every arbitration heading
  // with 👺) must not shift it, and a list item inside a blockquote must not
  // report an offset relative to its container.
  test("position offsets are document-absolute UTF-16 indices", () => {
    const itemOffsets = (source: string): number[] => {
      const out: number[] = [];
      const walk = (node: unknown): void => {
        const n = node as {
          type?: string;
          position?: { start?: { offset?: number } };
          children?: unknown[];
        };
        if (n.type === "listItem" && n.position?.start?.offset !== undefined) {
          out.push(n.position.start.offset);
        }
        for (const child of n.children ?? []) walk(child);
      };
      walk(parseMarkdownSource(source));
      return out;
    };
    const astral = "👺👺 X\n\n- [ ] a\n- [x] b\n";
    expect(itemOffsets(astral)).toEqual([8, 16]);
    expect(astral.slice(8, 13)).toBe("- [ ]");

    const quoted = "> - [ ] g\n> - [x] h\n";
    expect(itemOffsets(quoted)).toEqual([2, 12]);
    expect(quoted.slice(2, 7)).toBe("- [ ]");
  });
});

// Grouped as a function so the linkify cases sit next to the other inline-node
// tests above without splitting that describe block's flow.
function describeStrongLinkTests(): void {
  const strongRoot = (value: string): Root => ({
    type: "root",
    children: [
      { type: "paragraph", children: [{ type: "strong", children: [{ type: "text", value }] }] },
    ],
  });
  const linker = (token: string) => (token === "docs/x.md" ? "#/file/S1/docs/x.md" : null);

  test("a path-shaped strong the linker accepts renders as <a><strong>", () => {
    const vnode = renderMarkdownAst(strongRoot("docs/x.md"), undefined, undefined, {
      filePathLinker: linker,
    });
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect(links[0]!.props).toMatchObject({
      href: "#/file/S1/docs/x.md",
      class: "md-strong-file-link",
    });
    expect(collect(links[0]!, (n) => n.type === "strong")).toHaveLength(1);
    expect(flattenText(vnode)).toBe("docs/x.md");
  });

  test("ordinary emphasis stays a plain <strong>", () => {
    const vnode = renderMarkdownAst(strongRoot("重要"), undefined, undefined, {
      filePathLinker: linker,
    });
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "strong")).toHaveLength(1);
  });

  test("a path the linker declines (unknown/pending) stays a plain <strong>", () => {
    const vnode = renderMarkdownAst(strongRoot("docs/missing.md"), undefined, undefined, {
      filePathLinker: linker,
    });
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "strong")).toHaveLength(1);
  });

  test("without a linker (restricted / no sender) strong is untouched", () => {
    const vnode = renderMarkdownAst(strongRoot("docs/x.md"));
    expect(collect(vnode, (n) => n.type === "a")).toHaveLength(0);
    expect(collect(vnode, (n) => n.type === "strong")).toHaveLength(1);
  });

  test("strong with mixed children is not linkified as a whole", () => {
    // `**docs/x.md `c`**` — multiple children, so the structural guard
    // declines and the inline-code case keeps handling its own token.
    const root: Root = {
      type: "root",
      children: [
        {
          type: "paragraph",
          children: [
            {
              type: "strong",
              children: [
                { type: "text", value: "docs/x.md" },
                { type: "inlineCode", value: "docs/x.md" },
              ],
            },
          ],
        },
      ],
    };
    const vnode = renderMarkdownAst(root, undefined, undefined, { filePathLinker: linker });
    const links = collect(vnode, (n) => n.type === "a");
    expect(links).toHaveLength(1);
    expect(links[0]!.props).toMatchObject({ class: "md-inline-code-file-link" });
  });
}

// Section folding (kawaz r151 m41). `foldMarkdownSections` is the whole of
// the structural decision — what a "section" contains, how deep it nests, and
// which key identifies it — so it is pinned here against hand-built trees,
// away from the DOM the fold's open/closed state needs.
describe("foldMarkdownSections", () => {
  type TestNode = { type: string; [k: string]: unknown };

  function heading(depth: number, text: string): TestNode {
    return { type: "heading", depth, children: [{ type: "text", value: text }] };
  }
  function para(text: string): TestNode {
    return { type: "paragraph", children: [{ type: "text", value: text }] };
  }
  /** `2:1 "…"` for a section (depth:key), the node type otherwise — a shape
   * the expectations can be read as an outline. */
  function outline(nodes: readonly unknown[]): unknown[] {
    return nodes.map((n) => {
      const node = n as TestNode;
      if (node.type !== "ccmsgSection") return node.type;
      const h = node.heading as { children: { value: string }[] };
      return [
        `${String(node.depth)}:${String(node.key)} ${h.children[0]!.value}`,
        outline(node.children as unknown[]),
      ];
    });
  }
  function fold(nodes: TestNode[]): unknown[] {
    // The helpers build mdast shapes structurally; the fold only reads
    // `type`/`depth`, so the cast keeps the fixtures readable.
    return outline(foldMarkdownSections(nodes as never));
  }

  test("a heading swallows the blocks that follow it", () => {
    expect(fold([heading(2, "A"), para("a1"), para("a2")])).toEqual([
      ["2:1 A", ["paragraph", "paragraph"]],
    ]);
  });

  test("same-depth headings are siblings, deeper ones nest", () => {
    expect(
      fold([heading(2, "A"), para("a"), heading(3, "A.1"), para("b"), heading(2, "B")]),
    ).toEqual([
      ["2:1 A", ["paragraph", ["3:1.1 A.1", ["paragraph"]]]],
      ["2:2 B", []],
    ]);
  });

  test("a shallower heading closes every deeper section", () => {
    expect(fold([heading(2, "A"), heading(4, "A.x"), heading(3, "A.2"), heading(2, "B")])).toEqual([
      [
        "2:1 A",
        [
          ["4:1.1 A.x", []],
          ["3:1.2 A.2", []],
        ],
      ],
      ["2:2 B", []],
    ]);
  });

  test("a skipped level nests by relative depth (h2 -> h4)", () => {
    expect(fold([heading(2, "A"), heading(4, "deep"), para("x")])).toEqual([
      ["2:1 A", [["4:1.1 deep", ["paragraph"]]]],
    ]);
  });

  // h1 is the document's title, not a section: it never folds, and it ends
  // whatever section was open (the next h2 belongs to the new document part).
  test("h1 stays a plain heading and closes open sections", () => {
    expect(fold([heading(2, "A"), para("a"), heading(1, "Title"), heading(2, "B")])).toEqual([
      ["2:1 A", ["paragraph"]],
      "heading",
      ["2:2 B", []],
    ]);
  });

  test("blocks before the first heading stay at the top level", () => {
    expect(fold([para("intro"), heading(2, "A")])).toEqual(["paragraph", ["2:1 A", []]]);
  });

  test("a document with no headings round-trips unchanged", () => {
    const nodes = [para("a"), para("b")];
    expect(foldMarkdownSections(nodes as never)).toEqual(nodes as never);
  });

  test("a document whose only heading is h1 has no sections", () => {
    expect(fold([heading(1, "Title"), para("a")])).toEqual(["heading", "paragraph"]);
  });

  // A section that starts deeper than h2 (a fragment pasted mid-document) is
  // still a section — the outline is read relatively, not from h2 downwards.
  test("a document starting at h3 folds from there", () => {
    expect(fold([heading(3, "A"), para("a"), heading(3, "B")])).toEqual([
      ["3:1 A", ["paragraph"]],
      ["3:2 B", []],
    ]);
  });

  test("keys are document-order positions among siblings", () => {
    const folded = foldMarkdownSections([
      heading(2, "A"),
      heading(3, "A.1"),
      heading(3, "A.2"),
      heading(4, "A.2.1"),
      heading(2, "B"),
    ] as never);
    expect(collectMarkdownSectionKeys(folded)).toEqual(["1", "1.1", "1.2", "1.2.1", "2"]);
  });

  test("headings inside containers are left alone (only top level folds)", () => {
    const quoted: TestNode = { type: "blockquote", children: [heading(2, "quoted")] };
    expect(fold([quoted, heading(2, "A")])).toEqual(["blockquote", ["2:1 A", []]]);
  });
});

describe("renderMarkdownAst with sections", () => {
  const source = "# T\n\nintro\n\n## A\n\na1\n\n### A.1\n\na2\n\n## B\n\nb1\n";

  function renderFolded(): VNode {
    const parsed = parseMarkdownDocument(source);
    const headings = extractMarkdownHeadings(parsed);
    const root = { ...parsed, children: foldMarkdownSections(parsed.children as never) } as never;
    return renderMarkdownAst(root, undefined, headings, { sections: true });
  }

  /** Every VNode in document order. A section's heading and body reach its
   * shell through props rather than children (the mdast walk stays one
   * synchronous pass — see MarkdownSectionShell), so the shared `collect`
   * walker stops at the shell; this one steps through those two props too. */
  function allNodes(node: unknown, acc: VNode[] = []): VNode[] {
    if (Array.isArray(node)) {
      for (const c of node) allNodes(c, acc);
      return acc;
    }
    if (!isVNode(node)) return acc;
    acc.push(node);
    const props = node.props as { children?: unknown; heading?: unknown; body?: unknown };
    allNodes(props.children, acc);
    allNodes(props.heading, acc);
    allNodes(props.body, acc);
    return acc;
  }

  function blocks(): { tag: string; text: string; id?: string }[] {
    return allNodes(renderFolded())
      .filter((n) => typeof n.type === "string" && /^(h[1-6]|p)$/.test(n.type))
      .map((n) => ({
        tag: n.type as string,
        text: flattenText(n),
        id: (n.props as { id?: string }).id,
      }));
  }

  test("the root carries the section layout class", () => {
    expect((renderFolded().props as { class?: string }).class).toBe("md md-sections");
  });

  test("every block survives the regrouping, in document order", () => {
    expect(blocks().map((b) => `${b.tag} ${b.text}`)).toEqual([
      "h1 T",
      "p intro",
      "h2 A",
      "p a1",
      "h3 A.1",
      "p a2",
      "h2 B",
      "p b1",
    ]);
  });

  // The walk assigns anchors from a counter it advances as it goes, so the
  // heading of a section must still be visited before that section's body.
  // A renumbering here would silently break every outline link.
  test("heading anchors keep document order through the nesting", () => {
    expect(
      blocks()
        .filter((b) => b.tag !== "p")
        .map((b) => b.id),
    ).toEqual(["md-section-1", "md-section-1-1", "md-section-1-1-1", "md-section-1-2"]);
  });

  test("each section element is keyed by its structural position", () => {
    const sections = allNodes(renderFolded()).filter(
      (n) =>
        typeof n.type === "function" && (n.props as unknown as { sectionKey?: string }).sectionKey,
    );
    expect(sections.map((n) => (n.props as unknown as { sectionKey: string }).sectionKey)).toEqual([
      "1",
      "1.1",
      "2",
    ]);
    expect(
      sections.map((n) => [...(n.props as unknown as { descendantKeys: string[] }).descendantKeys]),
    ).toEqual([["1.1"], [], []]);
  });
});
