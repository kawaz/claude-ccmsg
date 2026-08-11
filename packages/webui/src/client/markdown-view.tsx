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
import { classifyMarkdownLinkUrl, isSafeUrl } from "./markdown-link.ts";
import type { ParsedFilePathRef } from "./filepath-ref.ts";

// `isSafeUrl` moved to markdown-link.ts (scheme policy and path policy are two
// answers to the same question); re-exported here so existing importers and
// DR-0010's named coverage target keep resolving through this module.
export { isSafeUrl };
/** A callback that MarkdownView invokes on every inline-code token to decide
 * whether it should render as a FileViewer link. Returns the href when the
 * token names a real, daemon-confirmed file for the sender's session, or
 * `null` otherwise (plain `<code>`). Kept as a function rather than a
 * pre-built Map so the caller — which owns the sender-scoped `ctx`, the
 * fs_stat_batch cache, and the ability to enqueue new probes — can express
 * "we just asked, waiting for the answer" and "declined" identically from
 * the renderer's viewpoint (both produce plain code). */
export type FilePathLinker = (token: string) => string | null;

/** A callback that MarkdownView invokes on every markdown *link* whose target
 * is a filesystem path rather than an off-app URL (kawaz r55 m116/m117).
 * Returns the FileViewer href naming that path.
 *
 * Whether the file exists is deliberately not consulted (kawaz r55 m129): the
 * viewer reports a missing file itself, and resolving synchronously is what
 * makes a link clickable the instant the document renders. `null` means no
 * absolute path could be formed at all — the link then renders **without an
 * `href`**, never as a plain `<a>`, since a path-shaped target that navigates
 * the webui origin strands a standalone PWA user with no way back. */
export type MarkdownPathLinker = (ref: ParsedFilePathRef) => string | null;

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

/** Checked state of every GFM task item in the tree, in the order the render
 * walk visits them (= the order that assigns ordinals). Paired with
 * `scanTaskStates` by `taskStatesAlign` to decide whether ordinals are a
 * trustworthy coordinate for writing back to the source. */
export function extractTaskStates(root: Root): boolean[] {
  const states: boolean[] = [];
  function visit(nodes: AnyNode[] | undefined): void {
    if (!nodes) return;
    for (const node of nodes) {
      if (node.type === "listItem" && typeof (node as ListItem).checked === "boolean") {
        states.push((node as ListItem).checked as boolean);
      }
      const parent = node as AnyNode & { children?: AnyNode[] };
      visit(parent.children);
    }
  }
  visit(root.children);
  return states;
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
  /** kawaz r55 m116/m117: resolver for markdown links whose target is a
   * filesystem path (`[x](fixtures/a.json)`, `[x](/docs/spec.md)`). When
   * absent, such links render as inert text — never as an `<a href>` to the
   * webui origin, which is the dead end this whole path exists to prevent. */
  pathLinker?: MarkdownPathLinker;
  /** Interactive GFM task lists. When set, every task item renders as a real
   * `<input type="checkbox">` whose click reports the item's document-order
   * ordinal back to the caller, which owns the file write. Absent (every
   * viewer that isn't showing a writable file) the items render exactly as
   * they always have. */
  taskList?: MarkdownTaskListCtx;
  /** Running count of task items visited so far — the ordinal assigned to the
   * next one. Mutated during the walk, mirroring `headingIndex`. */
  taskIndex: number;
}

/** A failed write, reported against the item it happened to.
 *
 * `seq` increments on every fresh occurrence, including a repeat failure of an
 * item that is already showing this same message. It is the element key of the
 * rendered message, so a repeat remounts it and its one-shot flash animation
 * plays again — otherwise a second click on an already-errored item would
 * change nothing on screen and read as "the click did nothing". */
export interface MarkdownTaskError {
  message: string;
  seq: number;
}

/** Wiring for interactive task lists (see `MarkdownRenderCtx.taskList`). */
export interface MarkdownTaskListCtx {
  /** Invoked with the clicked item's document-order ordinal, the state it was
   * displaying, and the state the click asks for. The caller applies the
   * click to the rendered source immediately and writes behind it, so the
   * checkboxes stay live rather than disabling during a write. */
  onToggle: (ordinal: number, from: boolean, to: boolean) => void;
  /** Failures to show *at* the items they belong to, keyed by the ordinal the
   * item occupies now. A write that fails only becomes visible when the user
   * is looking at the checkbox that just sprang back, and that checkbox is
   * wherever the user last clicked — not the top of a document they have
   * scrolled away from. Several items can fail independently (writes are
   * queued, each resolved against its own fresh read), so this is a map rather
   * than one message. */
  errors?: ReadonlyMap<number, MarkdownTaskError>;
  /** Dismiss the message on one item. Absent = no dismiss affordance. */
  onDismissError?: (ordinal: number) => void;
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
      // kawaz r55 m116/m117. Four outcomes, see `classifyMarkdownLinkUrl`.
      const target = classifyMarkdownLinkUrl(link.url);
      const label = renderChildren(link.children, key, ctx);
      if (target.kind === "disarm") {
        // Render the link's own text with no <a>/href at all, so neither a
        // hostile URL scheme nor an unopenable path target can reach the DOM,
        // while the human-visible content is still shown rather than dropped.
        return <span key={key}>{label}</span>;
      }
      if (target.kind === "path") {
        // A repo-relative / absolute path the author meant as a file. The
        // resolver does not check that the file exists (kawaz r55 m129) — a
        // target that names nothing opens the viewer's not-found view, which
        // is recoverable and legible, whereas gating on a probe left every
        // link inert until it answered. `null` here means no absolute path
        // could be formed at all, so there is nothing to link to.
        const href = ctx.pathLinker ? ctx.pathLinker(target.ref) : null;
        if (!href) {
          return (
            <span key={key} title={link.url}>
              {label}
            </span>
          );
        }
        // No `target="_blank"`: FileViewer is a view of *this* app, and in a
        // standalone PWA `_blank` is not a new tab anyway — it replaces the
        // current view with no way back.
        return (
          <a key={key} class="md-path-link" href={href} title={link.url}>
            {label}
          </a>
        );
      }
      if (target.kind === "anchor") {
        return (
          <a key={key} href={target.url} title={link.title ?? undefined}>
            {label}
          </a>
        );
      }
      return (
        <a
          key={key}
          href={target.url}
          title={link.title ?? undefined}
          target="_blank"
          rel="noopener noreferrer"
        >
          {label}
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
      const target = classifyMarkdownLinkUrl(image.url);
      if (target.kind === "disarm") {
        return <span key={key}>🖼 {label}</span>;
      }
      if (target.kind === "path") {
        // `![alt](docs/diagram.png)` names a file in the tree. Same rule as
        // the link case — open it in FileViewer (which renders images) rather
        // than as an origin-relative <a> that leads nowhere.
        const href = ctx.pathLinker ? ctx.pathLinker(target.ref) : null;
        if (!href) {
          return (
            <span key={key} title={image.url}>
              🖼 {label}
            </span>
          );
        }
        return (
          <a key={key} class="md-image-link md-path-link" href={href} title={image.url}>
            🖼 {label}
          </a>
        );
      }
      if (target.kind === "anchor") {
        return (
          <a key={key} class="md-image-link" href={target.url}>
            🖼 {label}
          </a>
        );
      }
      return (
        <a
          key={key}
          class="md-image-link"
          href={target.url}
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

    case "listItem": {
      const item = node as ListItem;
      // `checked` is non-null exactly for GFM task items (confirmed against
      // the real parser). Every task item consumes an ordinal whether or not
      // interaction is enabled, so the numbering the click reports is the
      // same numbering `findTaskLines` reconstructs from the source. The
      // ordinal is taken *before* recursing so a parent item numbers ahead of
      // the nested items inside it, matching document order.
      if (typeof item.checked !== "boolean") {
        return <li key={key}>{renderChildren(item.children, key, ctx)}</li>;
      }
      const checked = item.checked;
      const ordinal = ctx.taskIndex;
      ctx.taskIndex += 1;
      const children = renderChildren(item.children, key, ctx);
      const taskList = ctx.taskList;
      const error = taskList?.errors?.get(ordinal);
      const onDismissError = taskList?.onDismissError;
      return (
        <li
          // `seq` is part of the key so a *repeat* failure remounts the row and
          // replays its one-shot flash. Without it the class is already set,
          // the animation never restarts, and a second failing click looks
          // like nothing happened.
          key={error ? `${key}!${error.seq}` : key}
          class={
            "md-task-item" +
            (checked ? " md-task-checked" : "") +
            (error ? " md-task-item-error" : "")
          }
        >
          <input
            type="checkbox"
            class="md-task-checkbox"
            checked={checked}
            // Read-only contexts (message bodies, and any preview whose
            // source can't be written back) keep the checkbox as a visual
            // marker only — the parser eats the `[ ]` characters, so
            // rendering nothing would silently drop them from the display.
            disabled={!taskList}
            onClick={taskList ? () => taskList.onToggle(ordinal, checked, !checked) : undefined}
          />
          <span class="md-task-body">
            {children}
            {error ? (
              <span class="md-task-error" role="alert">
                <span class="md-task-error-text">{error.message}</span>
                {onDismissError ? (
                  <button
                    type="button"
                    class="md-task-error-dismiss"
                    aria-label="このエラーを閉じる"
                    onClick={() => onDismissError(ordinal)}
                  >
                    {"×"}
                  </button>
                ) : null}
              </span>
            ) : null}
          </span>
        </li>
      );
    }

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
            <summary>Details</summary>
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

// A `#` run that is not a valid ATX heading opener — `#1 を commit しました`,
// `####### seven` — makes @mizchi/markdown drop the whole block instead of
// falling back to a paragraph, so an assistant turn opening with `#1 …` renders
// as an empty bubble (kawaz r99m7: 「からっぽの紫色のバルーン」). CommonMark
// requires 1-6 hashes followed by a space, a tab, or the end of the line;
// anything else is ordinary paragraph text. Stash the offending run behind a
// private-use marker so the parser sees plain text, and restore it afterwards.
//
// Runs on every line, including fenced-code and indented-code content: the
// substitution is invisible there (code text is verbatim and
// `restoreProtectedText` walks `code.value` too), so tracking block context
// would add a second, drift-prone parser for no observable difference.
function protectNonHeadingHashes(source: string): { source: string; marker?: string } {
  if (!source.includes("#")) return { source };
  // Container prefixes the parser strips before looking for a heading:
  // blockquote markers and one list-item marker. Four or more leading spaces
  // is an indented code block, where `#` is already inert — hence `{0,3}`.
  const BLOCK_START = /^((?:[ \t]{0,3}>)*[ \t]{0,3}(?:[-*+][ \t]+|\d{1,9}[.)][ \t]+)?)(#+)(.*)$/gm;
  let marker: string | undefined;
  const protectedSource = source.replace(
    BLOCK_START,
    (match, prefix: string, hashes: string, rest: string) => {
      if (hashes.length <= 6 && (rest === "" || rest.startsWith(" ") || rest.startsWith("\t"))) {
        return match;
      }
      marker ??= unusedPrivateUseMarker(source);
      return `${prefix}${marker.repeat(hashes.length)}${rest}`;
    },
  );
  return marker ? { source: protectedSource, marker } : { source };
}

// An empty header cell — `| | Anthropic Messages API | OpenAI Responses API |`,
// the usual shape of a comparison table whose first column holds row labels —
// makes @mizchi/markdown reject the whole block, so it renders as a paragraph
// of raw pipes (kawaz r99m41). Measured surface: a header cell that is empty or
// whitespace-only kills the table at any column index, with or without spaces
// around the pipes, at top level and inside a blockquote; empty cells in *body*
// rows parse fine. GFM allows all of these, so fill the offending header cells
// with a private-use marker that `restoreProtectedText` turns back into an
// empty string — the rendered cell stays empty, with no visible filler.
//
// A header line is one whose next line is a delimiter row. The detection may
// over-fire (inside fenced code, or on a pipe line the parser ultimately does
// not accept as a table): that is harmless by construction, because a marker
// that does not end up in a table cell is restored to "" and the text reads
// exactly as it did before — the same reasoning `protectNonHeadingHashes`
// above relies on.
function protectEmptyTableHeaderCells(source: string): { source: string; marker?: string } {
  if (!source.includes("|")) return { source };
  // Container prefixes the parser strips before looking at the row: blockquote
  // markers and indentation short of an indented code block.
  const PREFIX = /^((?:[ \t]{0,3}>)*[ \t]{0,3})(.*)$/;
  const DELIMITER_ROW = /^\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
  const lines = source.split("\n");
  let marker: string | undefined;
  for (let i = 0; i + 1 < lines.length; i += 1) {
    const header = PREFIX.exec(lines[i]!)!;
    const delimiter = PREFIX.exec(lines[i + 1]!)!;
    if (!header[2]!.includes("|")) continue;
    if (!DELIMITER_ROW.test(delimiter[2]!)) continue;
    marker ??= unusedPrivateUseMarker(source);
    lines[i] = header[1]! + fillEmptyHeaderCells(header[2]!, marker);
  }
  return marker ? { source: lines.join("\n"), marker } : { source };
}

/** Replace every empty (or whitespace-only) cell of one table header row with
 * `marker`. The leading/trailing fields around the row's outer pipes are row
 * delimiters rather than cells, so they are left alone. */
function fillEmptyHeaderCells(row: string, marker: string): string {
  const fields: string[] = [];
  let current = "";
  for (let i = 0; i < row.length; i += 1) {
    const char = row[i]!;
    if (char === "\\" && i + 1 < row.length) {
      current += char + row[i + 1]!;
      i += 1;
      continue;
    }
    if (char === "|") {
      fields.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  fields.push(current);
  const first = row.trimStart().startsWith("|") ? 1 : 0;
  const last = fields.length - (row.trimEnd().endsWith("|") ? 2 : 1);
  for (let i = first; i <= last; i += 1) {
    if (fields[i]!.trim() === "") fields[i] = fields[i]! + marker;
  }
  return fields.join("|");
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
  const protectedHashes = protectNonHeadingHashes(source);
  const protectedUnderscores = protectIntrawordUnderscores(protectedHashes.source);
  const protectedAngles = protectTagLikeAngleBrackets(protectedUnderscores.source);
  const protectedCells = protectEmptyTableHeaderCells(protectedAngles.source);
  const root = parse(protectedCells.source);
  if (protectedCells.marker) restoreProtectedText(root, protectedCells.marker, "");
  if (protectedAngles.openMarker) restoreProtectedText(root, protectedAngles.openMarker, "<");
  if (protectedAngles.closeMarker) restoreProtectedText(root, protectedAngles.closeMarker, ">");
  if (protectedUnderscores.marker) restoreProtectedText(root, protectedUnderscores.marker, "_");
  if (protectedHashes.marker) restoreProtectedText(root, protectedHashes.marker, "#");
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
  const target = classifyMarkdownLinkUrl(url);
  // Restricted mode has no `pathLinker` (a user-typed path isn't a
  // session-scoped reference — same reasoning that keeps `filePathLinker` off
  // this path), so a path target renders inert rather than navigating the
  // webui origin. Disarm and path collapse to the same output here.
  if (target.kind === "path") {
    return <span key={key}>{label || url}</span>;
  }
  if (target.kind === "disarm") {
    // Drop the `<a>` entirely but keep the label visible so the reader isn't
    // silently robbed of the text. The URL itself is deliberately not shown
    // as a fallback the way a path target's is — a rejected scheme is exactly
    // the string we don't want to surface.
    return <span key={key}>{label}</span>;
  }
  if (target.kind === "anchor") {
    return (
      <a key={key} href={target.url}>
        {label || url}
      </a>
    );
  }
  return (
    <a key={key} href={target.url} target="_blank" rel="noopener noreferrer">
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
  /** Everything past `headings` is named rather than positional: the tail had
   * grown to four independent optionals, so call sites needing only the last
   * one were writing `undefined, undefined, undefined` and a mis-ordered
   * argument would have type-checked between the two linkers. */
  opts?: {
    filePathLinker?: FilePathLinker;
    pathLinker?: MarkdownPathLinker;
    taskList?: MarkdownTaskListCtx;
  },
): VNode {
  const ctx: MarkdownRenderCtx = {
    search,
    headings,
    headingIndex: 0,
    filePathLinker: opts?.filePathLinker,
    pathLinker: opts?.pathLinker,
    taskList: opts?.taskList,
    taskIndex: 0,
  };
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
  pathLinker,
  restricted = false,
  taskList,
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
  /** kawaz r55 m116/m117: resolver for markdown links/images whose target is a
   * filesystem path. Omit and such links render inert — which is the safe
   * default, not a degraded one (see `MarkdownPathLinker`). */
  pathLinker?: MarkdownPathLinker;
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
  /** Interactive task lists. Only the file preview passes this — a message
   * body has no file behind it to write a toggle back to. Ignored in
   * `restricted` mode (user-typed `- [ ]` is prose, not a task list). */
  taskList?: MarkdownTaskListCtx;
}) {
  const search =
    highlightWords && onMatchClick ? { words: highlightWords, onMatchClick } : undefined;
  return useMemo(() => {
    if (restricted) return renderRestrictedMarkdown(source);
    const root = parseMarkdownDocument(source);
    const headings = tableOfContents ? extractMarkdownHeadings(root) : [];
    const markdown = renderMarkdownAst(root, search, tableOfContents ? headings : undefined, {
      filePathLinker,
      pathLinker,
      taskList,
    });
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
  }, [
    source,
    highlightWords,
    onMatchClick,
    tableOfContents,
    filePathLinker,
    pathLinker,
    restricted,
    taskList,
  ]);
}
