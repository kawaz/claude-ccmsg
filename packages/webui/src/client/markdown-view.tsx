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

type AnyNode = RootContent | PhrasingContent;

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

// @mizchi/markdown treats bare `<NAME>` as an autolink and drops its brackets.
// Protect HTML-name-shaped tokens only; `<https://…>` and `<user@example.com>`
// remain available to the parser as valid CommonMark autolinks.
function protectTagLikeAngleBrackets(source: string): {
  source: string;
  openMarker?: string;
  closeMarker?: string;
} {
  const tagLike = /<(\/?[A-Za-z][A-Za-z0-9-]*(?:[ \t]+[^<>\n]*?)?\/?)>/g;
  if (!tagLike.test(source)) return { source };
  tagLike.lastIndex = 0;
  const openMarker = unusedPrivateUseMarker(source);
  const closeMarker = unusedPrivateUseMarker(source + openMarker);
  return {
    source: source.replace(tagLike, (_match, content: string) => {
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
    const root = parseMarkdownSource(source);
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
