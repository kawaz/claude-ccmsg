// markdown-view.ts unit tests (DR-0010): guards the mdast -> preact VNode
// walker Timeline.tsx uses to render assistant text segments, plus the URL
// allowlist that keeps it from ever emitting an executable `href`.
//
// Test strategy: `renderMarkdownAst` takes a hand-constructed mdast `Root` —
// not markdown source run through `parse()` — so the walker's behavior is
// pinned independently of `@mizchi/markdown`'s parsing quirks (mirrors
// transcript-model.test.ts's "pure fold, testable without DOM" split, see
// that file's doc comment). The walker returns Preact `VNode`s directly (no
// renderToString dependency is available in this repo, see markdown-view.tsx
// doc comment) — `collectByType`/`flattenText` below walk that VNode tree by
// hand via `.type`/`.props.children`, which is all Preact's `h()` output
// exposes without a DOM.
import { describe, expect, test } from "bun:test";
import type { VNode } from "preact";
import type { Root } from "mdast";
import { parse } from "@mizchi/markdown";
import {
  attachmentUrlFromPath,
  isSafeUrl,
  renderMarkdownAst,
} from "../src/client/markdown-view.tsx";
import { CodeBlock } from "../src/client/components/CodeBlock.tsx";

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

  // Confirms the real-world reason isSafeUrl is required at all: the
  // library's own parse() passes a javascript: URL straight through into
  // the mdast tree unchanged (it doesn't sanitize), so the walker is the
  // only defense layer (DR-0010).
  test("parse() itself passes a javascript: URL through unsanitized (regression pin for why isSafeUrl exists)", () => {
    const root = parse("[click](javascript:alert(1))");
    const paragraph = root.children[0];
    expect(paragraph?.type).toBe("paragraph");
    if (paragraph?.type !== "paragraph") return;
    const link = paragraph.children[0];
    expect(link?.type).toBe("link");
    if (link?.type !== "link") return;
    expect(link.url).toBe("javascript:alert(1)");
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
