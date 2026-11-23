// A comment on a quote in a file the Files tab shows (DR-0062 §2, §7, P20,
// P26): where in the file the text chosen is (its lines, the column it
// starts at, the line it starts on as it reads), found again in what the file
// holds now, and the path a comment names the file by.
//
// The source's text is the file's content as the viewer draws it, one line a
// line; a preview's is the joined text of what the markdown draws (as a
// Timeline bubble's, comment-quote.ts), each piece of it in a block of the
// markdown whose lines in the source are known (`PreviewPiece`).
//
// Pure, per DR-0005 §1, as comment-quote.ts beside it.
import type { FileAnchor } from "@ccmsg/protocol";
import { choiceIn, findQuote } from "./comment-quote.ts";
import { normalizePosix } from "./filepath-ref.ts";

/** What a quote in a file is, but its path and view. */
export type FileQuote = Omit<FileAnchor, "kind" | "path" | "view">;

function withoutTrailingSlashes(dir: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed === "" ? "/" : trimmed;
}

/** `abs` as a path under `dir`, or null when it is not under it. */
function under(abs: string, dir: string): string | null {
  const base = withoutTrailingSlashes(dir);
  if (base === "/") return abs.slice(1);
  return abs.startsWith(`${base}/`) ? abs.slice(base.length + 1) : null;
}

/** The absolute path of the Files tab's `treePath` (relative to the
 * session's root, `repo_root ?? cwd`, or absolute). Null without a root. */
function absoluteOf(treePath: string, root: string | undefined): string | null {
  if (treePath.startsWith("/")) return normalizePosix(treePath);
  return root === undefined ? null : normalizePosix(`${withoutTrailingSlashes(root)}/${treePath}`);
}

/** The path a comment on the Files tab's `treePath` names the file by
 * (DR-0062 §4, §7): relative to the session's cwd when inside it, else
 * absolute. Null when the session's root or cwd is not known. */
export function fileAnchorPathOf(
  treePath: string,
  root: string | undefined,
  cwd: string | undefined,
): string | null {
  const abs = absoluteOf(treePath, root);
  if (abs === null || cwd === undefined) return null;
  return under(abs, cwd) ?? abs;
}

/** The Files tab's path of the file a comment names `anchorPath` (relative
 * to the session's root when inside it, else absolute). Null when the
 * session's cwd is not known. */
export function fileTreePathOf(
  anchorPath: string,
  root: string | undefined,
  cwd: string | undefined,
): string | null {
  const abs = absoluteOf(anchorPath, cwd);
  if (abs === null) return null;
  return root === undefined ? abs : (under(abs, root) ?? abs);
}

/** Where each line of `content` starts (lines are split at `\n`). */
export function lineStartsOf(content: string): number[] {
  const starts = [0];
  for (let at = content.indexOf("\n"); at >= 0; at = content.indexOf("\n", at + 1)) {
    starts.push(at + 1);
  }
  return starts;
}

/** The index of the line `offset` is in. */
function lineIndexAt(starts: readonly number[], offset: number): number {
  let index = 0;
  while (index + 1 < starts.length && (starts[index + 1] ?? Infinity) <= offset) index += 1;
  return index;
}

/** Line `index` of `content`, its line break (and a `\r` before it) left
 * out. */
function lineAt(content: string, starts: readonly number[], index: number): string {
  const from = starts[index] ?? content.length;
  const next = starts[index + 1];
  return content.slice(from, next === undefined ? content.length : next - 1).replace(/\r$/, "");
}

/** How many characters (code points) `text` holds. */
function codePoints(text: string): number {
  return Array.from(text).length;
}

/** The choice of `start`..`end` in a file's `content` (DR-0062 §7): the text,
 * the characters around it, the line and column (from 1, in characters) it
 * starts at, the line its last character is on (none when it is the start's),
 * and the start's line as it reads. Null when nothing but spaces is chosen. */
export function sourceQuoteOf(content: string, start: number, end: number): FileQuote | null {
  const choice = choiceIn(content, start, end);
  if (choice === null) return null;
  const starts = lineStartsOf(content);
  const first = lineIndexAt(starts, choice.start);
  const last = lineIndexAt(starts, choice.end - 1);
  return {
    text: choice.text,
    before: choice.before,
    after: choice.after,
    line: first + 1,
    ...(last !== first ? { end_line: last + 1 } : {}),
    col: codePoints(content.slice(starts[first] ?? 0, choice.start)) + 1,
    line_text: lineAt(content, starts, first),
  };
}

/** Where line `line` (from 1) and column `col` (from 1, in characters) are
 * in `content`, kept inside it. */
function offsetOf(content: string, line: number, col: number): number {
  const starts = lineStartsOf(content);
  const index = Math.min(Math.max(line - 1, 0), starts.length - 1);
  const from = starts[index] ?? 0;
  const text = lineAt(content, starts, index);
  const before = Array.from(text)
    .slice(0, Math.max(col - 1, 0))
    .join("");
  return from + before.length;
}

/** Where `quote` is in the file's `content` now (P20): its text between the
 * characters it stood between, or its text alone when that is in one place
 * only; of several places, the nearest to the line and column it was at.
 * Null when it is nowhere. */
export function findSourceQuote(
  content: string,
  quote: Pick<FileAnchor, "text" | "before" | "after" | "line" | "col">,
): { start: number; end: number } | null {
  return findQuote(content, {
    text: quote.text,
    before: quote.before,
    after: quote.after,
    start: offsetOf(content, quote.line, quote.col ?? 1),
  });
}

/** A piece of a preview's drawn text: where it starts in it, and the lines in
 * the source of the markdown block it is in (P26). Pieces are in the order of
 * the drawn text. */
export interface PreviewPiece {
  start: number;
  line: number;
  endLine: number;
}

/** The piece `offset` is in: the last starting at or before it. */
function pieceAt(pieces: readonly PreviewPiece[], offset: number): PreviewPiece | undefined {
  return pieces.findLast((piece) => piece.start <= offset);
}

/** The choice of `start`..`end` in a preview's `drawn` text (DR-0062 §7,
 * P26): the text drawn, the characters around it, the first line in the
 * source of the block its start is in, the last line of the block its end is
 * in (none when it is the start's), and the start's line in `source` as it
 * reads. No column: a preview draws no columns of the source. Null when
 * nothing but spaces is chosen, or it is in no block. */
export function previewQuoteOf(
  drawn: string,
  start: number,
  end: number,
  pieces: readonly PreviewPiece[],
  source: string,
): FileQuote | null {
  const choice = choiceIn(drawn, start, end);
  if (choice === null) return null;
  const first = pieceAt(pieces, choice.start);
  const last = pieceAt(pieces, choice.end - 1);
  if (first === undefined || last === undefined) return null;
  const starts = lineStartsOf(source);
  const endLine = Math.max(last.endLine, first.line);
  return {
    text: choice.text,
    before: choice.before,
    after: choice.after,
    line: first.line,
    ...(endLine !== first.line ? { end_line: endLine } : {}),
    line_text: lineAt(source, starts, first.line - 1),
  };
}

/** Where `quote` is in a preview's `drawn` text now (P20): as in the source,
 * the nearest of several places to the first block at or after the line it
 * was on. Null when it is nowhere. */
export function findPreviewQuote(
  drawn: string,
  pieces: readonly PreviewPiece[],
  quote: Pick<FileAnchor, "text" | "before" | "after" | "line">,
): { start: number; end: number } | null {
  const near = pieces.find((piece) => piece.line >= quote.line) ?? pieces.at(-1);
  return findQuote(drawn, {
    text: quote.text,
    before: quote.before,
    after: quote.after,
    start: near?.start,
  });
}
