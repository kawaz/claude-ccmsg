/** @jsxImportSource preact */
import type { JSX } from "preact";

// Per-node icons for FileTree (kawaz 2026-07-16 ask): inline SVG, stroke/fill
// currentColor so they follow the row's own text color (and therefore the
// light/dark theme + .tree-selected accent color) without any icon-specific
// theming. No emoji, no external icon library/CDN — every glyph here is
// hand-drawn feather-style line art (viewBox 0 0 24 24, stroke width 2,
// round caps/joins), matching the "16px 級のシンプルな線画" ask.

/** The full icon vocabulary a tree row can render. `dir-closed`/`dir-open`
 * track DirNode's own expand state (same source of truth as its ▸/▾ caret);
 * everything else is a leaf classification. */
export type FileIconKind =
  | "dir-closed"
  | "dir-open"
  | "symlink"
  | "markdown"
  | "image"
  | "code"
  | "file";

const IMAGE_EXTENSIONS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"]);
const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".json",
  ".css",
  ".html",
  ".sh",
  ".rs",
  ".go",
  ".py",
  ".mbt",
]);

/** name + entry type (+ expand state, dirs only) -> icon kind. Pure/testable
 * on purpose (packages/webui/test/file-icon.test.ts) — no DOM, no store.
 *
 * Extension matching mirrors utils.ts's isMarkdownPath: case-insensitive,
 * and the extension must be the real last segment past the final dot, so
 * `foo.tar.gz` classifies on `.gz` (falls through to generic "file", not
 * matched by any list here) rather than `.tar.gz` as a whole.
 *
 * Dotfiles (`.gitignore`) intentionally fall to the generic "file" icon: the
 * only "." in the name is the leading one, so `dot <= 0` treats it as
 * extension-less rather than reading the whole name as its own extension. A
 * name like `.bashrc.sh` still gets the code icon — the leading dot doesn't
 * suppress a *real* extension further down the name, only a leading-dot-only
 * name (dot index 0 with nothing after) does. */
export function fileIconKind(
  name: string,
  type: "dir" | "file" | "symlink",
  expanded = false,
): FileIconKind {
  if (type === "dir") return expanded ? "dir-open" : "dir-closed";
  if (type === "symlink") return "symlink";
  const dot = name.lastIndexOf(".");
  if (dot <= 0) return "file";
  const ext = name.slice(dot).toLowerCase();
  if (ext === ".md" || ext === ".markdown") return "markdown";
  if (IMAGE_EXTENSIONS.has(ext)) return "image";
  if (CODE_EXTENSIONS.has(ext)) return "code";
  return "file";
}

const SVG_PROPS: JSX.SVGAttributes<SVGSVGElement> = {
  viewBox: "0 0 24 24",
  width: 14,
  height: 14,
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 2,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": "true",
};

function FolderClosedGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4.379a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 12.12 7H19.5A1.5 1.5 0 0 1 21 8.5v9A1.5 1.5 0 0 1 19.5 19h-15A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

function FolderOpenGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M3 6.5a1.5 1.5 0 0 1 1.5-1.5h4.379a1.5 1.5 0 0 1 1.06.44l1.122 1.12A1.5 1.5 0 0 0 12.12 7H19.5A1.5 1.5 0 0 1 21 8.5v.5H6.83a1.5 1.5 0 0 0-1.45 1.11L3 17.5z" />
      <path d="M3 17.5l2.38-8.4A1.5 1.5 0 0 1 6.83 8H21.5a1 1 0 0 1 .96 1.27l-1.98 7A1.5 1.5 0 0 1 19.03 17.4L19 17.5a1.5 1.5 0 0 1-1.5 1.5h-13A1.5 1.5 0 0 1 3 17.5z" />
    </svg>
  );
}

/** External-link-shaped arrow — a symlink points somewhere else, same idiom
 * as "opens elsewhere" affordances. */
function SymlinkGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
      <polyline points="15 3 21 3 21 9" />
      <line x1="10" y1="14" x2="21" y2="3" />
    </svg>
  );
}

function MarkdownGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="8" y1="13" x2="16" y2="13" />
      <line x1="8" y1="17" x2="13" y2="17" />
    </svg>
  );
}

function ImageGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  );
}

function CodeGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <polyline points="16 18 22 12 16 6" />
      <polyline points="8 6 2 12 8 18" />
    </svg>
  );
}

function GenericFileGlyph() {
  return (
    <svg {...SVG_PROPS}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
    </svg>
  );
}

const GLYPHS: Record<FileIconKind, () => JSX.Element> = {
  "dir-closed": FolderClosedGlyph,
  "dir-open": FolderOpenGlyph,
  symlink: SymlinkGlyph,
  markdown: MarkdownGlyph,
  image: ImageGlyph,
  code: CodeGlyph,
  file: GenericFileGlyph,
};

/** Rendered by DirNode/FileNode ahead of the row's name (see FileTree.tsx),
 * inside the same button/link so it inherits the row's currentColor (theme +
 * .tree-selected accent) automatically — no icon-specific color CSS needed. */
export function FileTypeIcon({ kind }: { kind: FileIconKind }) {
  const Glyph = GLYPHS[kind];
  return (
    <span class={`tree-icon tree-icon-${kind}`}>
      <Glyph />
    </span>
  );
}
