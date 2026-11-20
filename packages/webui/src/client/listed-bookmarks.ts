// The ⭐ filter's bookmarked items outside the loaded window (DR-0058 §5):
// each from the lines the daemon read for it (bookmark_rows: the row, its next
// line, and its tool calls' results), drawn as the window draws that row. The
// row goes through the same parse and the same cross-line passes as the
// window's rows (a request for permission is one only with its result, a
// `! <command>` takes its output from the next row), so it is the same item.
//
// Pure, per DR-0005 §1.
import type { BookmarkRow } from "@ccmsg/protocol";
import { crossLineIncrementally, emptyCrossLineCache } from "./incremental-cross-line.ts";
import {
  classifyBoundaryLine,
  parseTranscriptLine,
  utf8ByteLength,
  type BoundaryKind,
  type TurnLine,
} from "./transcript-model.ts";

/** A bookmarked item outside the window: its row's uuid and time, the row as
 * the window would hold it, and what it draws as. */
export interface ListedBookmark {
  uuid: string;
  /** The row's time (empty when it has none, which places it at the end). */
  ts: string;
  line: TurnLine;
  boundary: BoundaryKind;
}

/** The item `row` draws as, or null when its row draws as no item of its own
 * (a row the window folds away; a bookmark is set only on an item that has
 * a position, so this is a row that changed kind, which does not happen). */
export function listedBookmarkOf(row: BookmarkRow): ListedBookmark | null {
  const raws = row.lines;
  const { groups } = crossLineIncrementally(emptyCrossLineCache(), {
    start: 0,
    raws,
    perLine: raws.map(parseTranscriptLine),
    byteLengths: raws.map(utf8ByteLength),
  });
  for (const group of groups) {
    if (group.kind !== "entry" || group.line.kind !== "turn") continue;
    if (group.line.uuid !== row.uuid) continue;
    const boundary = classifyBoundaryLine(group.line);
    if (boundary === null) return null;
    return { uuid: row.uuid, ts: group.line.ts ?? "", line: group.line, boundary };
  }
  return null;
}

/** The rows of the session's bookmarks that are bookmarked still and not in
 * the window (`inWindow`, the uuids of the window's rows), as items. */
export function listedBookmarks(
  rows: readonly BookmarkRow[],
  marked: ReadonlySet<string>,
  inWindow: ReadonlySet<string>,
): ListedBookmark[] {
  return rows.flatMap((row) => {
    if (!marked.has(row.uuid) || inWindow.has(row.uuid)) return [];
    const item = listedBookmarkOf(row);
    return item === null ? [] : [item];
  });
}
