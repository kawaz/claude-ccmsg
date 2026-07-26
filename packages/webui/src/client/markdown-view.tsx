/** @jsxImportSource preact */
// mdast -> preact JSX renderer for assistant text segments in Timeline.tsx
// (DR-0010). `@mizchi/markdown`'s `parse()` returns a standard mdast tree;
// this module walks it into JSX by hand rather than through the library's
// `toHtml()`/`toHtmlLiteral()` (both proven to pass a `javascript:` link URL
// straight into the HTML string unescaped — see the DR) and never uses
// `innerHTML`/`dangerouslySetInnerHTML` — every renderable value reaches the
// DOM as a JSX text node, so Preact's own escaping is what protects against
// markdown content containing `<`/`&`/quotes.
import { h, type VNode } from "preact";
import { useMemo } from "preact/hooks";
import { parse } from "@mizchi/markdown";
import type {
  Blockquote,
  Code,
  Delete,
  Emphasis,
  Heading,
  Html,
  Image,
  InlineCode,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
  Strong,
  Table,
  Text,
} from "mdast";
import { CodeBlock } from "./components/CodeBlock.tsx";
import { openImageLightbox } from "./components/ImageLightbox.tsx";
import { splitTextForHighlight, type SearchWord } from "./in-view-search.ts";
/** A callback that MarkdownView invokes on every inline-code token to decide
 * whether it should render as a FileViewer link. Returns the href when the
 * token names a real, daemon-confirmed file for the sender's session, or
 * `null` otherwise (plain `<code>`). Kept as a function rather than a
 * pre-built Map so the caller — which owns the sender-scoped `ctx`, the
 * fs_stat_batch cache, and the ability to enqueue new probes — can express
 * "we just asked, waiting for the answer" and "declined" identically from
 * the renderer's viewpoint (both produce plain code). */
export type FilePathLinker = (token: string) => string | null;

// URL scheme allowlist for link/image targets (DR-0010): http/https/mailto,
// plus scheme-less URLs (relative paths, `#fragment`s) which CommonMark
// treats as valid link targets and carry no execution risk. Everything else
// (`javascript:`, `data:`, `vbscript:`, ...) is rejected — the caller must
// render the link's text without an `href` rather than trust the URL.
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

// DR-0015 §2.6 attachment image extensions. Kept as a set (not re-derived
// from the daemon's MIME table) so this file stays browser-only and doesn't
// pull the daemon's node-only helpers via cross-package imports. The daemon
// upload path stores files with the extensions this set filters on, so a
// mismatch would surface immediately as a broken `<img>` — the failure mode
// is loud, not silent.
const ATTACHMENT_IMAGE_EXTENSIONS = new Set([
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".avif",
  ".bmp",
  ".ico",
]);

/**
 * DR-0015 §2.6 attachment path recognizer. Given a Markdown link's `url` from
 * a message body, returns `{url, isImage}` when it points at the daemon's
 * TMPDIR attachment area (`/…/claude-ccmsg-<uid>/attachment/<basename>`), or
 * `null` otherwise. The returned `url` is rewritten to the daemon's HTTP
 * endpoint (`/attachment/<basename>`) — the raw filesystem path a browser
 * cannot fetch (`file://` is sandbox-blocked) becomes a fetchable
 * same-origin URL, which the caller renders as either `<img>` (image mime)
 * or a normal `<a>`.
 *
 * The pattern intentionally matches only trailing basenames — one segment,
 * no slashes — under the `attachment/` directory. Anchoring at the end + the
 * `[^/]+` guard means a path like `/foo/claude-ccmsg-501/attachment/../etc`
 * would not match at all (`..` fails the character class), so a hostile
 * message body can't rewrite arbitrary daemon URLs. The daemon's own GET
 * route does its own uuid/ext re-validation regardless.
 */
export function attachmentUrlFromPath(url: string): { url: string; isImage: boolean } | null {
  const m = /\/claude-ccmsg-[^/]+\/attachment\/([^/]+)$/.exec(url);
  if (!m) return null;
  const basename = m[1]!;
  const dot = basename.lastIndexOf(".");
  const ext = dot >= 0 ? basename.slice(dot).toLowerCase() : "";
  return {
    url: `/attachment/${basename}`,
    isImage: ATTACHMENT_IMAGE_EXTENSIONS.has(ext),
  };
}

/**
 * True if `url` is safe to place in an `href`/`src`. Exported for unit
 * testing (DR-0010's required-coverage list: "javascript: リンクが無害化される").
 *
 * Strips ASCII control characters (incl. space/tab/newline) before scanning
 * for a scheme, matching how browsers' URL parsers skip them when
 * determining a URL's scheme — a naive regex that didn't strip them first
 * could be fooled by a scheme split across a stripped character (e.g.
 * `"java\tscript:alert(1)"`) into misreading it as scheme-less (= trusted).
 * A leading `//` (protocol-relative) is rejected outright: it has no
 * explicit scheme to allowlist-check, but inherits the *page's* scheme at
 * render time, so it isn't "scheme-less" in the safe sense a relative path is.
 */
export function isSafeUrl(url: string): boolean {
  // Intentional control-character match: stripping them is the
  // scheme-split evasion defense described above, not an accidental match.
  // oxlint-disable-next-line no-control-regex
  const stripped = url.replace(/[\u0000-\u0020]+/g, "");
  if (stripped.startsWith("//")) return false;
  const m = /^([a-zA-Z][a-zA-Z0-9+.-]*):/.exec(stripped);
  if (!m) return true; // no scheme = relative path / fragment, safe
  return ALLOWED_URL_SCHEMES.has(m[1]!.toLowerCase() + ":");
}

/** Synthetic node the `<details>` fold (see `foldDetailsBlocks`) inserts into
 * the mdast tree. Not an mdast type — `type` is namespaced so it can never
 * collide with a future CommonMark/GFM node, and `renderNode` is the only
 * place that knows how to render it. */
export interface MarkdownDetails {
  type: "ccmsgDetails";
  /** `<details open>`; any other attribute disqualifies the tag entirely. */
  open: boolean;
  /** Inline children of the `<summary>` line, already parsed as markdown.
   * Absent when the block had no recognizable `<summary>` line (the browser
   * then supplies its own default disclosure label). */
  summary?: PhrasingContent[];
  children: AnyNode[];
}

type AnyNode = RootContent | PhrasingContent | MarkdownDetails;

export interface MarkdownHeading {
  depth: Heading["depth"];
  id: string;
  number: string;
  text: string;
}

function headingPlainText(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
    case "html":
      return node.value;
    case "image":
      return node.alt ?? "";
    case "break":
      return " ";
    default: {
      const parent = node as PhrasingContent & { children?: PhrasingContent[] };
      return parent.children?.map(headingPlainText).join("") ?? "";
    }
  }
}

/** Extract the numbered document outline used by both heading anchors and the
 * file preview's TOC. The counter transition mirrors app.css exactly: entering
 * depth N increments that level and resets every deeper level. */
export function extractMarkdownHeadings(root: Root): MarkdownHeading[] {
  const counters = [0, 0, 0, 0, 0, 0];
  const headings: MarkdownHeading[] = [];

  function visit(nodes: AnyNode[] | undefined): void {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.type === "heading") {
        const heading = node as Heading;
        const index = heading.depth - 1;
        counters[index] += 1;
        counters.fill(0, index + 1);
        const number = counters.slice(0, heading.depth).join(".");
        headings.push({
          depth: heading.depth,
          id: `md-section-${number.replaceAll(".", "-")}`,
          number,
          text:
            heading.children.map(headingPlainText).join("").replace(/\s+/g, " ").trim() ||
            "（無題）",
        });
        continue;
      }
      const parent = node as AnyNode & { children?: AnyNode[] };
      visit(parent.children);
    }
  }

  visit(root.children);
  return headings;
}

/** In-view search context threaded through the mdast walk (DR-0022 §3: TL
 * highlighting must reach into markdown-rendered assistant text, not just
 * plain segments) — `undefined` (the common case, no active search) skips
 * every extra allocation below and reproduces the pre-DR-0022 output
 * byte-for-byte. Only `text` nodes consult it; `code`/`inlineCode` are
 * deliberately left out of scope (they render through CodeBlock's own Shiki
 * pipeline, which would need the same "bypass tokens while searching"
 * treatment FileViewer.tsx applies to its own Shiki spans — a follow-up, not
 * this pass). */
interface MarkdownSearchCtx {
  words: readonly SearchWord[];
  /** Called when any highlighted span in this markdown tree is clicked —
   * the caller (Timeline.tsx) already knows which "unit" (segment) this
   * whole render belongs to, so a single no-arg callback per MarkdownView
   * instance is enough (DR-0022 §2.2: click only updates the index, all
   * hits within one unit resolve to that unit's position). */
  onMatchClick: () => void;
}

interface MarkdownRenderCtx {
  search?: MarkdownSearchCtx;
  headings?: readonly MarkdownHeading[];
  headingIndex: number;
  /** kawaz r46 m55-m58: per-token linker that renders inline code as a
   * FileViewer link when the sender's session has a real file matching that
   * token (daemon-confirmed via fs_stat_batch, cached by
   * filepath-existence-cache). `undefined` = plain rendering, matching the
   * pre-DR baseline byte-for-byte. */
  filePathLinker?: FilePathLinker;
}

function renderChildren(
  nodes: AnyNode[] | undefined,
  keyPrefix: string,
  ctx: MarkdownRenderCtx,
): (VNode | string)[] {
  if (!nodes) return [];
  return nodes.map((n, i) => renderNode(n, `${keyPrefix}.${i}`, ctx));
}

// Every mdast node type this renderer has an opinion on is listed in
// DR-0010's required-coverage set (heading/paragraph/list/listItem/code/
// inlineCode/blockquote/table family/link/image/strong/emphasis/del/break/
// thematicBreak/html/text). Anything else — a future CommonMark/GFM addition,
// or an mdast extension this app never opted into (e.g. wikiLink, which
// `@mizchi/markdown` only emits when `MarkdownOptions.wikilinks` is passed,
// and this app never passes it) — falls through to the `default` case below,
// which recurses into `children` if present so text content isn't silently
// dropped, or renders nothing if the node has none.
function renderNode(node: AnyNode, key: string, ctx: MarkdownRenderCtx): VNode | string {
  const search = ctx.search;
  switch (node.type) {
    case "text": {
      const value = (node as Text).value;
      if (!search || search.words.length === 0) return value;
      const pieces = splitTextForHighlight(value, search.words);
      if (pieces.length === 1 && pieces[0]!.colorIndex === null) return value;
      // Wrapped in a <span> only on this (active-search) path — the common
      // no-search path above still returns the bare string Preact expects,
      // unchanged from pre-DR-0022 behavior.
      return (
        <span key={key}>
          {pieces.map((p, i) =>
            p.colorIndex !== null ? (
              <mark
                key={`${key}.${i}`}
                class="search-hl"
                style={{ "--hl-color": `var(--search-color-${p.colorIndex + 1})` }}
                onClick={search.onMatchClick}
              >
                {p.text}
              </mark>
            ) : (
              p.text
            ),
          )}
        </span>
      );
    }

    case "paragraph":
      return <p key={key}>{renderChildren((node as Paragraph).children, key, ctx)}</p>;

    case "heading": {
      const heading = node as Heading;
      const tag = `h${Math.min(6, Math.max(1, heading.depth))}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      const outlineHeading = ctx.headings?.[ctx.headingIndex];
      ctx.headingIndex += 1;
      return h(
        tag,
        { key, id: outlineHeading?.id },
        renderChildren(heading.children, key, ctx),
      ) as VNode;
    }

    case "strong":
      return <strong key={key}>{renderChildren((node as Strong).children, key, ctx)}</strong>;

    case "emphasis":
      return <em key={key}>{renderChildren((node as Emphasis).children, key, ctx)}</em>;

    case "delete":
      return <del key={key}>{renderChildren((node as Delete).children, key, ctx)}</del>;

    case "inlineCode": {
      const value = (node as InlineCode).value;
      // kawaz r46 m55-m58: linkify inline-code tokens shaped like
      // `packages/foo.ts:L10-12` / `foo.ts:42` when the sender's session has
      // a real file matching that token. The link's *text* keeps the exact
      // inline `<code>` rendering so a false-positive (or a click-averse
      // reader) still sees the original token visually. Any token the linker
      // declines — non-path shape, unknown to the daemon, still pending its
      // batch answer — falls through to plain `<code>`, matching pre-DR
      // output byte-for-byte.
      const href = ctx.filePathLinker ? ctx.filePathLinker(value) : null;
      if (!href) {
        return (
          <code class="md-inline-code" key={key}>
            {value}
          </code>
        );
      }
      return (
        <a key={key} class="md-inline-code-file-link" href={href}>
          <code class="md-inline-code">{value}</code>
        </a>
      );
    }

    case "code": {
      const code = node as Code;
      return <CodeBlock key={key} code={code.value} lang={code.lang ?? null} />;
    }

    case "link": {
      const link = node as Link;
      // DR-0015 §2.6: attachment paths (`.../claude-ccmsg-<uid>/attachment/…`)
      // are rewritten to the daemon's HTTP endpoint (`/attachment/<basename>`)
      // and image mimes are rendered inline as <img>. Same-origin (the webui
      // backend), so the auto-fetch privacy concern in the `image` case
      // below does not apply — the target is this daemon's own file, served
      // by this same origin.
      const attachment = attachmentUrlFromPath(link.url);
      if (attachment) {
        const label = renderChildren(link.children, key, ctx);
        // Extract text-only alt for the <img>; falls back to link text as-is
        // when children include non-text (rare for `[FILE1:name](path)` shape
        // which is a single text run, but be defensive).
        const alt = link.children.map((c) => (c.type === "text" ? (c as Text).value : "")).join("");
        if (attachment.isImage) {
          // kawaz r26 mid=49: target="_blank" は standalone PWA で脱出不能に
          // なる (戻る UI が無い) ため in-app lightbox で開く。
          return (
            <a
              key={key}
              class="md-attachment-image-link"
              href={attachment.url}
              onClick={(e) => {
                e.preventDefault();
                openImageLightbox(attachment.url, alt || attachment.url);
              }}
            >
              <img class="md-attachment-image" src={attachment.url} alt={alt || attachment.url} />
            </a>
          );
        }
        return (
          <a
            key={key}
            class="md-attachment-link"
            href={attachment.url}
            target="_blank"
            rel="noopener noreferrer"
          >
            {label}
          </a>
        );
      }
      if (!isSafeUrl(link.url)) {
        // Disarmed: render the link's own text with no <a>/href at all so a
        // hostile URL scheme can never reach the DOM, while the human-visible
        // content (the link text) is still shown rather than dropped.
        return <span key={key}>{renderChildren(link.children, key, ctx)}</span>;
      }
      return (
        <a
          key={key}
          href={link.url}
          title={link.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderChildren(link.children, key, ctx)}
        </a>
      );
    }

    case "image": {
      // Design rationale: never auto-fetch the image URL (no <img src=...>).
      // A remote image load is an information-leak vector outside this app's
      // CSP-controlled surface (viewer IP/UA reaches an arbitrary third
      // party the moment the markdown renders, no click required) — shown
      // instead as alt text plus a clickable link the user opts into.
      const image = node as Image;
      const label = image.alt || image.url;
      if (!isSafeUrl(image.url)) {
        return <span key={key}>🖼 {label}</span>;
      }
      return (
        <a
          key={key}
          class="md-image-link"
          href={image.url}
          target="_blank"
          rel="noopener noreferrer"
        >
          🖼 {label}
        </a>
      );
    }

    case "list": {
      const list = node as List;
      const tag = list.ordered ? "ol" : "ul";
      return h(
        tag,
        { key, start: list.start ?? undefined },
        renderChildren(list.children, key, ctx),
      ) as VNode;
    }

    case "listItem":
      return <li key={key}>{renderChildren((node as ListItem).children, key, ctx)}</li>;

    case "blockquote":
      return (
        <blockquote key={key}>{renderChildren((node as Blockquote).children, key, ctx)}</blockquote>
      );

    case "thematicBreak":
      return <hr key={key} />;

    case "break":
      return <br key={key} />;

    case "ccmsgDetails": {
      // The sole structural HTML mapping (kawaz r55 m77, see foldDetailsBlocks).
      // Only `open` crosses from source into the DOM, and only as a boolean —
      // the tag's own text never becomes markup, so this stays inside the
      // "no raw HTML" guarantee the module doc comment describes.
      const details = node as MarkdownDetails;
      return (
        <details key={key} class="md-details" open={details.open}>
          {details.summary && details.summary.length > 0 ? (
            <summary>{renderChildren(details.summary, `${key}.s`, ctx)}</summary>
          ) : (
            <summary>詳細</summary>
          )}
          {renderChildren(details.children, key, ctx)}
        </details>
      );
    }

    case "html":
      // Never executed: the raw source text of an HTML block/inline node is
      // shown as a plain JSX text child (Preact-escaped), not parsed or
      // injected via innerHTML — see module doc comment.
      return (
        <span class="md-raw-html" key={key}>
          {(node as Html).value}
        </span>
      );

    case "table": {
      const table = node as Table;
      const align = table.align ?? [];
      return (
        <table key={key}>
          <tbody>
            {table.children.map((row, ri) => (
              <tr key={`${key}.${ri}`}>
                {row.children.map((cell, ci) => {
                  const cellTag = ri === 0 ? "th" : "td";
                  const cellAlign = align[ci];
                  return h(
                    cellTag,
                    {
                      key: `${key}.${ri}.${ci}`,
                      style: cellAlign ? { textAlign: cellAlign } : undefined,
                    },
                    renderChildren(cell.children, `${key}.${ri}.${ci}`, ctx),
                  ) as VNode;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      );
    }

    default: {
      // Safe fallback for both "known-but-unhandled" and "never-seen-before"
      // node shapes: recurse into `children` (duck-typed — see module doc
      // comment) so text content still surfaces, otherwise render nothing.
      const maybeParent = node as unknown as { children?: unknown };
      if (Array.isArray(maybeParent.children)) {
        return <span key={key}>{renderChildren(maybeParent.children as AnyNode[], key, ctx)}</span>;
      }
      return "";
    }
  }
}

// CommonMark 0.31.2 defines whitespace as Unicode Zs plus tab/LF/FF/CR,
// and punctuation as Unicode P or S. An underscore run surrounded by
// characters in neither class is intraword and cannot open or close `_`/`__`
// emphasis. @mizchi/markdown does not implement that restriction.
const COMMONMARK_WHITESPACE_RE = /^(?:\p{Zs}|[\t\n\f\r])$/u;
const COMMONMARK_PUNCTUATION_RE = /^[\p{P}\p{S}]$/u;

function isCommonMarkWordContent(char: string | undefined): boolean {
  return (
    char !== undefined &&
    !COMMONMARK_WHITESPACE_RE.test(char) &&
    !COMMONMARK_PUNCTUATION_RE.test(char)
  );
}

function unusedPrivateUseMarker(source: string): string {
  const used = new Set(source);
  const ranges: readonly [number, number][] = [
    [0xe000, 0xf8ff],
    [0xf0000, 0xffffd],
    [0x100000, 0x10fffd],
  ];
  for (const [start, end] of ranges) {
    for (let codePoint = start; codePoint <= end; codePoint += 1) {
      const candidate = String.fromCodePoint(codePoint);
      if (!used.has(candidate)) return candidate;
    }
  }
  let fallback = "\uE000\uE000";
  while (source.includes(fallback)) fallback += "\uE000";
  return fallback;
}

function protectIntrawordUnderscores(source: string): { source: string; marker?: string } {
  if (!source.includes("_")) return { source };
  const chars = Array.from(source);
  let marker: string | undefined;
  for (let start = 0; start < chars.length; start += 1) {
    if (chars[start] !== "_") continue;
    let end = start + 1;
    while (chars[end] === "_") end += 1;
    if (isCommonMarkWordContent(chars[start - 1]) && isCommonMarkWordContent(chars[end])) {
      marker ??= unusedPrivateUseMarker(source);
      chars.fill(marker, start, end);
    }
    start = end - 1;
  }
  return marker ? { source: chars.join(""), marker } : { source };
}

// The parser turns a bare `<WORD>` into an autolink and drops its brackets, so
// prose like `<確認項目>` or `<v0.73.31>` silently became a link (kawaz r55m83).
// Protect every `<…>` that is NOT a valid CommonMark autolink — those are only
// `<scheme:rest>` (scheme = letter + [A-Za-z0-9+.-]{1,31}) and `<user@host>`,
// both of which stay available to the parser. Everything else, including the
// HTML-name shapes this function originally guarded (`<div>`, `<FILE>`), is
// stashed behind private-use markers and restored as plain text afterwards.
function protectTagLikeAngleBrackets(source: string): {
  source: string;
  openMarker?: string;
  closeMarker?: string;
} {
  const AUTOLINK_URI = /^[A-Za-z][A-Za-z0-9+.-]{1,31}:[^\s<>]*$/;
  // CommonMark's email autolink production, trimmed to what it actually needs.
  const AUTOLINK_EMAIL =
    /^[A-Za-z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*$/;
  const tagLike = /<([^<>\n]*)>/g;
  const isAutolink = (content: string): boolean =>
    AUTOLINK_URI.test(content) || AUTOLINK_EMAIL.test(content);
  if (!tagLike.test(source)) return { source };
  tagLike.lastIndex = 0;
  const openMarker = unusedPrivateUseMarker(source);
  const closeMarker = unusedPrivateUseMarker(source + openMarker);
  return {
    source: source.replace(tagLike, (match, content: string) => {
      if (isAutolink(content)) return match;
      return `${openMarker}${content}${closeMarker}`;
    }),
    openMarker,
    closeMarker,
  };
}

function restoreProtectedText(value: unknown, marker: string, replacement: string): void {
  if (Array.isArray(value)) {
    for (const item of value) restoreProtectedText(item, marker, replacement);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (child.includes(marker)) {
        (value as Record<string, unknown>)[key] = child.replaceAll(marker, replacement);
      }
    } else {
      restoreProtectedText(child, marker, replacement);
    }
  }
}

// ---------------------------------------------------------------------------
// `<details>` folding (kawaz r55 m77)
//
// The one HTML construct this renderer understands structurally. Everything
// else stays literal text — see the module doc comment; enabling arbitrary
// HTML would reintroduce the injection surface DR-0010 closed. The tags below
// are recognized by *shape* and mapped onto Preact's own `<details>`/
// `<summary>` elements, so no attacker-controlled string ever becomes markup:
// the only thing a matched tag can influence is the boolean `open`.
//
// The matching runs on the mdast tree rather than the raw source because
// `protectTagLikeAngleBrackets` (above) rewrites every tag-shaped token before
// `parse()` sees it, so `<details>` never arrives as an mdast `html` node —
// it lands as literal `text`. Working post-parse also means fenced code and
// inline code are already claimed by their own nodes, so a `<details>` inside
// a ```html fence is a `code` node and can't be mistaken for a real tag.
//
// After parsing, a `<details>` block appears as text lines split across
// `paragraph` children: the opening tag and the `<summary>` line are separate
// `text` children of one paragraph (joined by a `"\n"` text node or a `break`
// when the line ended in two spaces), the body is whatever sibling nodes
// follow, and `</details>` is a paragraph of its own. The fold below
// reassembles that.

/** `<details>` / `<details open>` — nothing else. The name is anchored on both
 * sides so `<detailsfoo>` cannot match, and the only accepted attribute is a
 * bare `open`; anything else (`onclick=…`, `class=…`, `open="x"`) fails to
 * match and the tag stays literal text. */
const DETAILS_OPEN_TAG_RE = /^<details(\s+open)?\s*>$/i;
const DETAILS_CLOSE_TAG_RE = /^<\/details\s*>$/i;
const SUMMARY_OPEN_RE = /^<summary\s*>([\s\S]*)$/i;
const SUMMARY_CLOSE_RE = /^([\s\S]*)<\/summary\s*>$/i;

/** One source line's worth of inline nodes, tagged with the paragraph it came
 * from so the rebuild can tell "two lines of one paragraph" from "two
 * paragraphs". `block` items are every other node kind, passed through whole. */
type FoldItem =
  | { kind: "line"; line: PhrasingContent[]; group: number }
  | { kind: "block"; node: AnyNode };

/** Flatten a sibling list into the line stream the fold scans. Paragraphs
 * explode into their source lines — mdast encodes a soft break inside a
 * paragraph as a `"\n"` text child and a hard break as a `break` node — so a
 * `<details>` block written without blank lines (which the parser keeps as a
 * *single* paragraph) is matched by exactly the same code path as the
 * blank-line-separated form. */
function toFoldItems(nodes: AnyNode[]): FoldItem[] {
  const items: FoldItem[] = [];
  nodes.forEach((node, group) => {
    if (node.type !== "paragraph") {
      items.push({ kind: "block", node });
      return;
    }
    let line: PhrasingContent[] = [];
    const endLine = () => {
      items.push({ kind: "line", line, group });
      line = [];
    };
    for (const child of node.children) {
      if (child.type === "break") {
        endLine();
        continue;
      }
      if (child.type === "text" && child.value.includes("\n")) {
        const parts = child.value.split("\n");
        parts.forEach((part, i) => {
          if (i > 0) endLine();
          if (part !== "") line.push({ type: "text", value: part });
        });
        continue;
      }
      line.push(child);
    }
    endLine();
  });
  return items;
}

/** Turn a run of line items back into paragraphs, one per source paragraph
 * (`group`), restoring the `"\n"` separators `toFoldItems` consumed. Blocks
 * pass through untouched, and all-whitespace remnants are dropped rather than
 * emitted as empty paragraphs. */
function fromFoldItems(items: FoldItem[]): AnyNode[] {
  const out: AnyNode[] = [];
  let pending: PhrasingContent[][] = [];
  let pendingGroup = -1;
  const flush = () => {
    if (pending.length === 0) return;
    const children: PhrasingContent[] = [];
    pending.forEach((line, i) => {
      if (i > 0) children.push({ type: "text", value: "\n" });
      children.push(...line);
    });
    pending = [];
    if (children.some((c) => c.type !== "text" || c.value.trim() !== "")) {
      out.push({ type: "paragraph", children } satisfies Paragraph);
    }
  };
  for (const item of items) {
    if (item.kind === "block") {
      flush();
      out.push(item.node);
      continue;
    }
    if (item.group !== pendingGroup) {
      flush();
      pendingGroup = item.group;
    }
    pending.push(item.line);
  }
  flush();
  return out;
}

/** The line's text when it is pure text, else `null`. A tag line is by
 * definition pure text, so a line holding emphasis or a link is not one. */
function lineAsPlainText(line: PhrasingContent[]): string | null {
  let out = "";
  for (const node of line) {
    if (node.type !== "text") return null;
    out += node.value;
  }
  return out.trim();
}

/** `<summary>…</summary>` occupying a whole line, returning the label's inline
 * nodes. Matching on the parsed children (rather than re-parsing a flattened
 * string) is what lets `<summary>**bold** t</summary>` keep its `strong` node:
 * the parser already turned the label into inline markdown, and only the
 * literal tag text at the two ends needs stripping. */
function matchSummaryLine(line: PhrasingContent[]): PhrasingContent[] | null {
  const first = line[0];
  const last = line[line.length - 1];
  if (!first || !last || first.type !== "text" || last.type !== "text") return null;
  if (line.length === 1) {
    const m = /^<summary\s*>([\s\S]*)<\/summary\s*>$/i.exec(first.value.trim());
    if (!m) return null;
    const inner = m[1]!.trim();
    return inner === "" ? [] : [{ type: "text", value: inner }];
  }
  const openMatch = SUMMARY_OPEN_RE.exec(first.value.trimStart());
  const closeMatch = SUMMARY_CLOSE_RE.exec(last.value.trimEnd());
  if (!openMatch || !closeMatch) return null;
  const head = openMatch[1]!;
  const tail = closeMatch[1]!;
  const middle = line.slice(1, -1);
  const label: PhrasingContent[] = [];
  if (head !== "") label.push({ type: "text", value: head });
  label.push(...middle);
  if (tail !== "") label.push({ type: "text", value: tail });
  return label;
}

/** Collapse balanced `<details>`…`</details>` runs into `ccmsgDetails` nodes,
 * recursing into the folded body and into every other container so a block
 * inside a blockquote or list item folds the same way.
 *
 * An opener with no matching closer is left exactly as parsed (literal tag
 * text) — a half-written block should look unfinished rather than silently
 * swallow the rest of the document. Nesting is handled by depth counting: the
 * closer that ends a block is the one bringing depth back to zero.
 *
 * Termination: the outer scan advances past the closer it consumed each time,
 * and the recursive call receives the strictly shorter body slice (both tag
 * lines excluded), so depth is bounded by the input length. */
function foldDetailsBlocks(nodes: AnyNode[]): AnyNode[] {
  const items = toFoldItems(nodes);
  const out: FoldItem[] = [];
  let i = 0;
  while (i < items.length) {
    const item = items[i]!;
    const tag = item.kind === "line" ? lineAsPlainText(item.line) : null;
    const openMatch = tag === null ? null : DETAILS_OPEN_TAG_RE.exec(tag);
    if (!openMatch) {
      out.push(
        item.kind === "block" ? { kind: "block", node: foldInsideContainer(item.node) } : item,
      );
      i += 1;
      continue;
    }
    let depth = 1;
    let closeAt = -1;
    for (let j = i + 1; j < items.length; j += 1) {
      const candidate = items[j]!;
      if (candidate.kind !== "line") continue;
      const text = lineAsPlainText(candidate.line);
      if (text === null) continue;
      if (DETAILS_CLOSE_TAG_RE.test(text)) {
        depth -= 1;
        if (depth === 0) {
          closeAt = j;
          break;
        }
        continue;
      }
      if (DETAILS_OPEN_TAG_RE.test(text)) depth += 1;
    }
    if (closeAt < 0) {
      out.push(item);
      i += 1;
      continue;
    }
    // A `<summary>` counts only as the block's very first line.
    const next = items[i + 1];
    const summary = next && next.kind === "line" ? matchSummaryLine(next.line) : null;
    const bodyStart = summary ? i + 2 : i + 1;
    out.push({
      kind: "block",
      node: {
        type: "ccmsgDetails",
        open: openMatch[1] !== undefined,
        ...(summary ? { summary } : {}),
        children: foldDetailsBlocks(fromFoldItems(items.slice(bodyStart, closeAt))),
      },
    });
    i = closeAt + 1;
  }
  return fromFoldItems(out);
}

/** Recurse the fold into a non-`<details>` container's children (blockquote,
 * list, listItem, …) without disturbing leaf nodes. */
function foldInsideContainer(node: AnyNode): AnyNode {
  if (node.type === "heading" || node.type === "code") return node;
  const parent = node as AnyNode & { children?: AnyNode[] };
  if (!Array.isArray(parent.children)) return node;
  return { ...node, children: foldDetailsBlocks(parent.children) } as AnyNode;
}

/** Parse the markdown source used by MarkdownView. Kept as a pure seam so
 * parser-level compatibility fixes are exercised without a DOM. */
export function parseMarkdownSource(source: string): Root {
  const protectedUnderscores = protectIntrawordUnderscores(source);
  const protectedAngles = protectTagLikeAngleBrackets(protectedUnderscores.source);
  const root = parse(protectedAngles.source);
  if (protectedAngles.openMarker) restoreProtectedText(root, protectedAngles.openMarker, "<");
  if (protectedAngles.closeMarker) restoreProtectedText(root, protectedAngles.closeMarker, ">");
  if (protectedUnderscores.marker) restoreProtectedText(root, protectedUnderscores.marker, "_");
  return root;
}

/** `parseMarkdownSource` plus the `<details>` fold. Separate from the parse
 * seam so the fold can be unit-tested against hand-built trees, and so the
 * `<summary>` re-parse above can call the unfolded parse without recursing
 * into itself. */
export function parseMarkdownDocument(source: string): Root {
  const root = parseMarkdownSource(source);
  return { ...root, children: foldDetailsBlocks(root.children) as RootContent[] };
}

/** Restricted-mode renderer for user-authored messages (kawaz r55 m12).
 *
 * When a human types a message into the composer, they almost never intend
 * `#foo` to be an H1 heading, `**word**` to be bold, or `<R G B>` to be an
 * HTML tag / autolink — the CommonMark syntax collides with everyday prose
 * and looks broken (heading swallowing the rest of the message, autolink
 * dropping the angle brackets and linkifying `R G B`). What users *do* use
 * on purpose is: inline code (`` `foo` ``), fenced code blocks (```` ``` ````),
 * and blockquote lines (`> ...`). This renderer keeps exactly those three
 * markdown constructs live and shows everything else verbatim as plain text.
 *
 * Deliberately tokenizes source directly (no `parse()` involvement) instead
 * of walking the mdast tree and flattening disallowed nodes back to text —
 * the mdast round trip loses positional details (`#NNNN` where the parser
 * ate the `#`, exact whitespace inside `_foo_` etc.), so reconstructing the
 * user's original characters from the tree is fragile. A three-token lexer
 * is small enough to test exhaustively and can't accidentally drop input.
 *
 * The output is wrapped in `<div class="md md-restricted">`; `.md-restricted`
 * applies `white-space: pre-wrap` so bare newlines in the user's message
 * render as line breaks (matching how the composer showed them). */
export function renderRestrictedMarkdown(source: string): VNode {
  const lines = source.split("\n");
  const blocks: (VNode | string)[] = [];
  let key = 0;
  let i = 0;
  let pending: string[] = [];
  const flushText = () => {
    if (pending.length === 0) return;
    const text = pending.join("\n");
    pending = [];
    blocks.push(
      <span class="md-restricted-text" key={`b${key++}`}>
        {renderRestrictedInline(text, `b${key}`)}
      </span>,
    );
  };
  while (i < lines.length) {
    const line = lines[i]!;
    const fence = /^(`{3,})(\S*)\s*$/.exec(line);
    if (fence) {
      flushText();
      const marker = fence[1]!;
      const lang = fence[2] ? fence[2] : null;
      const body: string[] = [];
      i += 1;
      const closer = new RegExp(`^${marker}\\s*$`);
      while (i < lines.length && !closer.test(lines[i]!)) {
        body.push(lines[i]!);
        i += 1;
      }
      if (i < lines.length) i += 1; // consume closing fence
      blocks.push(<CodeBlock key={`b${key++}`} code={body.join("\n")} lang={lang} />);
      continue;
    }
    if (/^>\s?/.test(line)) {
      flushText();
      const quoted: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i]!)) {
        quoted.push(lines[i]!.replace(/^>\s?/, ""));
        i += 1;
      }
      const text = quoted.join("\n");
      blocks.push(
        <blockquote key={`b${key++}`}>
          <span class="md-restricted-text">{renderRestrictedInline(text, `b${key}`)}</span>
        </blockquote>,
      );
      continue;
    }
    pending.push(line);
    i += 1;
  }
  flushText();
  return <div class="md md-restricted">{blocks}</div>;
}

/** Inline pass for restricted rendering: only these two constructs are
 * markdown-styled — everything else is untouched text.
 *
 *   1. Inline code `` `foo` `` → `<code>`
 *   2. Inline link `[text](url)` → `<a>` (with DR-0015 §2.6 attachment
 *      rewrite: the composer emits `[FILE<N>:name](/…/claude-ccmsg-<uid>/
 *      attachment/<uuid.ext>)` and both image + non-image mimes need to
 *      round-trip identically to how the full MarkdownView renders them
 *      today, otherwise sent-message attachments vanish from u1 bubbles).
 *      URL scheme is filtered by `isSafeUrl` — a hostile `javascript:` is
 *      disarmed to the link's own text with no `<a>`, matching the full
 *      renderer's link handling.
 *
 * Image markdown `![alt](url)` is NOT tokenized here — the composer does
 * not emit it (attachments always ship as `[FILE<N>:...](...)` links, and
 * an image mime is detected from the target path, not the `!` prefix), so
 * a literal `![alt](url)` a user typed stays verbatim as prose the same
 * way heading/list markers do.
 *
 * A backtick or `[` with no matching pair on the same string is left
 * verbatim (no swallowing). Scanning is left-to-right with `lastIndex`
 * tracked manually so each character is claimed by at most one token. */
function renderRestrictedInline(text: string, keyPrefix: string): (VNode | string)[] {
  // Match either `code` OR [text](url). Alternation is left-to-right so a
  // literal `[foo](bar)` inside `code` stays inside the code span (the
  // backtick match wins first at that position).
  // The negative lookbehind `(?<!!)` guards image markdown `![alt](url)`:
  // the composer never emits it, so it should stay verbatim as prose, but a
  // bare `[alt](url)` at the same position would otherwise tokenize and
  // swallow the trailing `alt`/`url` (see test).
  const re = /`([^`\n]+)`|(?<!!)\[([^\]\n]*)\]\(([^)\n\s]+)\)/g;
  const out: (VNode | string)[] = [];
  let last = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] !== undefined) {
      out.push(
        <code class="md-inline-code" key={`${keyPrefix}c${n++}`}>
          {m[1]}
        </code>,
      );
    } else {
      const label = m[2] ?? "";
      const url = m[3] ?? "";
      out.push(renderRestrictedLink(label, url, `${keyPrefix}l${n++}`));
    }
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out.length > 0 ? out : [text];
}

/** Render one `[label](url)` link under restricted mode. Mirrors the safe
 * subset of MarkdownView's `link` case (DR-0015 §2.6 attachment rewrite +
 * DR-0010 URL scheme allowlist), minus the mdast child recursion (a
 * restricted link's label is always plain text as tokenized above). */
function renderRestrictedLink(label: string, url: string, key: string): VNode {
  const attachment = attachmentUrlFromPath(url);
  if (attachment) {
    if (attachment.isImage) {
      const alt = label || attachment.url;
      return (
        <a
          key={key}
          class="md-attachment-image-link"
          href={attachment.url}
          onClick={(e) => {
            e.preventDefault();
            openImageLightbox(attachment.url, alt);
          }}
        >
          <img class="md-attachment-image" src={attachment.url} alt={alt} />
        </a>
      );
    }
    return (
      <a
        key={key}
        class="md-attachment-link"
        href={attachment.url}
        target="_blank"
        rel="noopener noreferrer"
      >
        {label || attachment.url}
      </a>
    );
  }
  if (!isSafeUrl(url)) {
    // Same disarm as the full renderer: drop the `<a>` entirely but keep
    // the label visible so the reader isn't silently robbed of the text.
    return <span key={key}>{label}</span>;
  }
  return (
    <a key={key} href={url} target="_blank" rel="noopener noreferrer">
      {label || url}
    </a>
  );
}

/** Pure mdast-AST -> VNode transform, split out from `MarkdownView` so tests
 * can hand-construct mdast fragments (DR-0010) without going through
 * `parse()`. */
export function renderMarkdownAst(
  root: Root,
  search?: MarkdownSearchCtx,
  headings?: readonly MarkdownHeading[],
  filePathLinker?: FilePathLinker,
): VNode {
  const ctx: MarkdownRenderCtx = { search, headings, headingIndex: 0, filePathLinker };
  return <div class="md">{renderChildren(root.children, "md", ctx)}</div>;
}

// `useMemo` keyed on `source`: parse+render は Timeline のような親が高頻度
// (接続状態変化等) で re-render される文脈で使われるため、source が変わって
// いなければ再パースしない。`<details>` (thinking の折り畳み等) は collapsed
// でも Preact が中身を描画し続けるので、折り畳み自体はコスト削減にならない
// — この memo がそれを補う。
//
// `highlightWords`/`onMatchClick` (DR-0022 §3) additionally key the memo: a
// new words array (query edited, or a color-order shuffle — neither actually
// happens today, but identity is the correctness-relevant signal) forces a
// re-render with fresh <mark> spans. When omitted (no active search, the
// common case) the memo key is unchanged from before this DR and the cached
// render is reused exactly as previously.
export function MarkdownView({
  source,
  highlightWords,
  onMatchClick,
  tableOfContents = false,
  filePathLinker,
  restricted = false,
}: {
  source: string;
  highlightWords?: readonly SearchWord[];
  onMatchClick?: () => void;
  tableOfContents?: boolean;
  /** kawaz r46 m55-m58: per-token linker used to turn inline-code file
   * references into FileViewer links (see `FilePathLinker` doc). Omit for
   * viewers that don't have a sender to attribute paths to (e.g.
   * InlineFileViewer reads a file rendered inline — the file being viewed
   * *is* the target, there's no separate author to link out from). */
  filePathLinker?: FilePathLinker;
  /** kawaz r55 m12: user-authored message rendering. In restricted mode,
   * only inline code / fenced code blocks / blockquotes render as markdown;
   * everything else (headings, lists, tables, emphasis, links, HTML) is
   * shown verbatim so a user typing `#123 の件` doesn't lose the line to an
   * H1 heading and `<R G B>` isn't consumed as an HTML tag / autolink.
   * `tableOfContents`, `filePathLinker`, and `highlightWords` do not apply
   * in this mode (user messages don't need TOC or session-scoped file
   * linkification; in-view search on user text is handled by the caller's
   * plain-text path already). */
  restricted?: boolean;
}) {
  const search =
    highlightWords && onMatchClick ? { words: highlightWords, onMatchClick } : undefined;
  return useMemo(() => {
    if (restricted) return renderRestrictedMarkdown(source);
    const root = parseMarkdownDocument(source);
    const headings = tableOfContents ? extractMarkdownHeadings(root) : [];
    const markdown = renderMarkdownAst(
      root,
      search,
      tableOfContents ? headings : undefined,
      filePathLinker,
    );
    if (headings.length <= 1) return markdown;

    return (
      <div class="md-document">
        <details class="md-toc" open={headings.length <= 6}>
          <summary>目次</summary>
          <nav aria-label="目次">
            <ol>
              {headings.map((heading) => (
                <li
                  key={heading.id}
                  class={`md-toc-depth-${heading.depth}`}
                  style={{ "--md-toc-depth": heading.depth - 1 }}
                >
                  <a
                    href={`#${heading.id}`}
                    onClick={(event) => {
                      // The app hash owns session/file routing, so keep the anchor
                      // URL for semantics but scroll without replacing that hash.
                      event.preventDefault();
                      document
                        .getElementById(heading.id)
                        ?.scrollIntoView({ behavior: "smooth", block: "start" });
                    }}
                  >
                    <span class="md-toc-number">{heading.number}</span>
                    <span>{heading.text}</span>
                  </a>
                </li>
              ))}
            </ol>
          </nav>
        </details>
        {markdown}
      </div>
    );
  }, [source, highlightWords, onMatchClick, tableOfContents, filePathLinker, restricted]);
}
