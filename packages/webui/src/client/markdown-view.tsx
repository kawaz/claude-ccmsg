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

function renderChildren(
  nodes: AnyNode[] | undefined,
  keyPrefix: string,
  search: MarkdownSearchCtx | undefined,
): (VNode | string)[] {
  if (!nodes) return [];
  return nodes.map((n, i) => renderNode(n, `${keyPrefix}.${i}`, search));
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
function renderNode(
  node: AnyNode,
  key: string,
  search: MarkdownSearchCtx | undefined,
): VNode | string {
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
      return <p key={key}>{renderChildren((node as Paragraph).children, key, search)}</p>;

    case "heading": {
      const heading = node as Heading;
      const tag = `h${Math.min(6, Math.max(1, heading.depth))}` as
        | "h1"
        | "h2"
        | "h3"
        | "h4"
        | "h5"
        | "h6";
      return h(tag, { key }, renderChildren(heading.children, key, search)) as VNode;
    }

    case "strong":
      return <strong key={key}>{renderChildren((node as Strong).children, key, search)}</strong>;

    case "emphasis":
      return <em key={key}>{renderChildren((node as Emphasis).children, key, search)}</em>;

    case "delete":
      return <del key={key}>{renderChildren((node as Delete).children, key, search)}</del>;

    case "inlineCode":
      return (
        <code class="md-inline-code" key={key}>
          {(node as InlineCode).value}
        </code>
      );

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
        const label = renderChildren(link.children, key, search);
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
        return <span key={key}>{renderChildren(link.children, key, search)}</span>;
      }
      return (
        <a
          key={key}
          href={link.url}
          title={link.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {renderChildren(link.children, key, search)}
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
        renderChildren(list.children, key, search),
      ) as VNode;
    }

    case "listItem":
      return <li key={key}>{renderChildren((node as ListItem).children, key, search)}</li>;

    case "blockquote":
      return (
        <blockquote key={key}>
          {renderChildren((node as Blockquote).children, key, search)}
        </blockquote>
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
                    renderChildren(cell.children, `${key}.${ri}.${ci}`, search),
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
        return (
          <span key={key}>{renderChildren(maybeParent.children as AnyNode[], key, search)}</span>
        );
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

function restoreProtectedUnderscores(value: unknown, marker: string): void {
  if (Array.isArray(value)) {
    for (const item of value) restoreProtectedUnderscores(item, marker);
    return;
  }
  if (value === null || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (typeof child === "string") {
      if (child.includes(marker)) {
        (value as Record<string, unknown>)[key] = child.replaceAll(marker, "_");
      }
    } else {
      restoreProtectedUnderscores(child, marker);
    }
  }
}

/** Parse the markdown source used by MarkdownView. Kept as a pure seam so
 * parser-level compatibility fixes are exercised without a DOM. */
export function parseMarkdownSource(source: string): Root {
  const protectedSource = protectIntrawordUnderscores(source);
  const root = parse(protectedSource.source);
  if (protectedSource.marker) restoreProtectedUnderscores(root, protectedSource.marker);
  return root;
}

/** Pure mdast-AST -> VNode transform, split out from `MarkdownView` so tests
 * can hand-construct mdast fragments (DR-0010) without going through
 * `parse()`. */
export function renderMarkdownAst(root: Root, search?: MarkdownSearchCtx): VNode {
  return <div class="md">{renderChildren(root.children, "md", search)}</div>;
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
}: {
  source: string;
  highlightWords?: readonly SearchWord[];
  onMatchClick?: () => void;
}) {
  const search =
    highlightWords && onMatchClick ? { words: highlightWords, onMatchClick } : undefined;
  return useMemo(
    () => renderMarkdownAst(parseMarkdownSource(source), search),
    [source, highlightWords, onMatchClick],
  );
}
