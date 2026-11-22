// The ⭐ filter's bookmarked items it draws apart from the window's rows
// (DR-0058 §5): the ones outside the loaded window, each from the lines the
// daemon read for it (bookmark_rows: the row, its next line, and its tool
// calls' results), and a fold's rows inside it (a fold hides its rows, and the
// filter shows only the Timeline's own items), drawn as the window draws that
// row. The
// row goes through the same parse and the same cross-line passes as the
// window's rows (a request for permission is one only with its result, a
// `! <command>` takes its output from the next row), so it is the same item.
//
// Pure, per DR-0005 §1.
import {
  isKnownContentBlock,
  isKnownTranscriptRow,
  parseWith,
  queuedPersonPrompt,
  TranscriptRowLineSchema,
  type BookmarkRow,
  type TimedText,
} from "@ccmsg/protocol";
import { crossLineIncrementally, emptyCrossLineCache } from "./incremental-cross-line.ts";
import {
  classifyBoundaryLine,
  parseTranscriptLine,
  utf8ByteLength,
  type BoundaryKind,
  type ParsedLine,
  type TimelineGroup,
} from "./transcript-model.ts";

/** A bookmarked item outside the window: its row's uuid and time, the row as
 * the window would hold it, and what it draws as. */
export interface ListedBookmark {
  uuid: string;
  /** The row's time (empty when it has none, which places it at the end). */
  ts: string;
  line: ParsedLine;
  /** What it draws as when it is a boundary bubble; null for a fold's row. */
  boundary: BoundaryKind | null;
  /** The row's byte offset (in the window), or its place among the daemon's
   * lines for one outside it: the key of its fold row's search units. */
  offset: number;
}

/** The uuid and time of a row the Timeline draws as an item. */
function rowOf(line: ParsedLine): { uuid: string; ts: string } | null {
  if (line.kind === "broken" || line.uuid === undefined) return null;
  return { uuid: line.uuid, ts: line.ts ?? "" };
}

/** The item `row` draws as: a boundary bubble, or a fold's row. Null when the
 * row draws as no item of its own (a tool's result, drawn with its call). */
export function listedBookmarkOf(row: BookmarkRow): ListedBookmark | null {
  const raws = row.lines;
  const { groups } = crossLineIncrementally(emptyCrossLineCache(), {
    start: 0,
    raws,
    perLine: raws.map(parseTranscriptLine),
    byteLengths: raws.map(utf8ByteLength),
  });
  for (const group of groups) {
    const entries = group.kind === "fold" ? group.entries : [group];
    for (const { line, offset } of entries) {
      const found = rowOf(line);
      if (found === null || found.uuid !== row.uuid) continue;
      const boundary = group.kind === "entry" ? classifyBoundaryLine(line) : null;
      return { ...found, line, boundary, offset };
    }
  }
  return null;
}

/** The window's fold rows that are bookmarked, in the window's order: the
 * ⭐ filter draws them apart, a fold hiding them. */
export function bookmarkedFoldRows(
  groups: readonly TimelineGroup[],
  marked: ReadonlySet<string>,
): ListedBookmark[] {
  if (marked.size === 0) return [];
  return groups.flatMap((group) =>
    group.kind !== "fold"
      ? []
      : group.entries.flatMap(({ line, offset }): ListedBookmark[] => {
          const found = rowOf(line);
          return found !== null && marked.has(found.uuid)
            ? [{ ...found, line, boundary: null, offset }]
            : [];
        }),
  );
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

/** The person's prompts outside the window (`inWindow`, the uuids of the
 * window's rows), as items (the 👤 filter, DR-0058 §11): the rows the daemon
 * read as possible prompts (prompt_rows) that the Timeline draws as a
 * prompt, by the window's own classifying of rows. */
export function listedPrompts(
  rows: readonly BookmarkRow[],
  inWindow: ReadonlySet<string>,
): ListedBookmark[] {
  return rows.flatMap((row) => {
    if (inWindow.has(row.uuid)) return [];
    const item = listedBookmarkOf(row);
    return item !== null && item.boundary?.kind === "user-prompt" ? [item] : [];
  });
}

/** The person's prompt `line` holds, as written, with its time: a user row
 * the Timeline draws as a prompt (its content, or the text blocks of a content
 * that is a list, a prompt with an image, one per line), or a `queued_command`
 * attachment row of the person's (a prompt entered while a tool ran, which
 * gets no user row of its own). Null for any other row, and for a row without
 * a time. */
function landedPromptOf(row: BookmarkRow): TimedText | null {
  const line = row.lines[0] ?? "";
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok || !isKnownTranscriptRow(read.value)) return null;
  const parsed = read.value;
  if (parsed.type === "attachment") {
    const text = queuedPersonPrompt(parsed);
    return text === null || parsed.timestamp === "" ? null : { text, at: parsed.timestamp };
  }
  if (parsed.type !== "user") return null;
  const item = listedBookmarkOf(row);
  if (item === null || item.boundary?.kind !== "user-prompt" || item.ts === "") return null;
  const { content } = parsed.message;
  const text =
    typeof content === "string"
      ? content
      : content
          .flatMap((block) =>
            isKnownContentBlock(block) && block.type === "text" ? [block.text] : [],
          )
          .join("\n");
  return { text, at: item.ts };
}

/** The person's prompts among `rows` (prompt_rows), with their text as
 * written and the time they were written: what the composer looks through
 * for what it sent (DR-0035 §5). A user row is a prompt when the Timeline
 * draws it as one, as for the 👤 filter (listedPrompts). */
export function landedPromptsOf(rows: readonly BookmarkRow[]): TimedText[] {
  return rows.flatMap((row) => {
    const prompt = landedPromptOf(row);
    return prompt === null ? [] : [prompt];
  });
}

/** The window's fold rows at `offsets` (the rows the in-view search matched),
 * in the window's order: the 🔍 filter draws them apart, a fold hiding them
 * (DR-0022 §3), as the ⭐ filter draws a bookmarked fold row. */
export function matchedFoldRows(
  groups: readonly TimelineGroup[],
  offsets: ReadonlySet<number>,
): ListedBookmark[] {
  if (offsets.size === 0) return [];
  return groups.flatMap((group) =>
    group.kind !== "fold"
      ? []
      : group.entries.flatMap(({ line, offset }): ListedBookmark[] => {
          const found = rowOf(line);
          return found !== null && offsets.has(offset)
            ? [{ ...found, line, boundary: null, offset }]
            : [];
        }),
  );
}
