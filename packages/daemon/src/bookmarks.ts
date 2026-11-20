// The person's bookmarks of Timeline items (DR-0058): the uuids of transcript
// rows, under the session whose transcript has each, kept in
// `<stateDir>/bookmarks.json` as each session's list in the order they were
// set. The webui sets them (bookmark_set) and is told every session's
// (ev:"bookmarks"); its ⭐ filter asks for the rows of the ones outside its
// loaded window (bookmark_rows), which this reads off the session's
// transcript and keeps: a row of a transcript never changes.
//
// Design rationale: this is the third state the daemon keeps on disk for the
// webui alone, after say-read.json and permit-state.json (DR-0036 §3 keeps v1
// from growing such state), for the same reason: a bookmark is of a
// transcript, which outlives the daemon, and with the bookmarks in memory only
// every restart would take them all away. Unlike the other two, the state of
// a session that is not running is kept (pruneNotificationState does not drop
// it): a bookmark is a mark to come back to, which a session ending does not
// make moot.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  isKnownContentBlock,
  isKnownTranscriptRow,
  jsonText,
  parseWith,
  TranscriptRowLineSchema,
  type BookmarkRow,
  type BookmarksStreamEvent,
} from "@ccmsg/protocol";

/** bookmarks.json: each session's bookmarked uuids, in the order set. */
const BookmarksFileSchema = jsonText(v.record(v.string(), v.array(v.string())));

export interface BookmarksLog {
  warn(msg: string): void;
}

export interface BookmarkStore {
  /** sid → the uuids bookmarked, in the order set. A session with none is
   * not held. */
  sessions: Map<string, string[]>;
  /** sid → uuid → the row, for the rows read whole (their next line and
   * every result found). */
  rows: Map<string, Map<string, KeptRow>>;
  file: string;
  log: BookmarksLog;
  /** The last write of the file: the writes go one after another, so an
   * older state never lands over a newer one. */
  written: Promise<void>;
}

/** The store as `file` holds it. A file that is missing or does not read
 * starts empty (said in the log when it was there). */
export function loadBookmarkStore(file: string, log: BookmarksLog): BookmarkStore {
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      log.warn(
        `bookmarks: ${file}: ${e instanceof Error ? e.message : "unreadable"} — starting empty`,
      );
    }
  }
  const read = text === undefined ? undefined : parseWith(BookmarksFileSchema, text);
  if (read !== undefined && !read.ok) {
    log.warn(`bookmarks: ${file}: ${read.failure.summary} — starting empty`);
  }
  const sessions = new Map<string, string[]>();
  if (read?.ok === true) {
    for (const [sid, uuids] of Object.entries(read.value)) {
      const unique = [...new Set(uuids)];
      if (unique.length > 0) sessions.set(sid, unique);
    }
  }
  return { sessions, rows: new Map(), file, log, written: Promise.resolve() };
}

/** The ev:"bookmarks" of now. */
export function bookmarksEvent(store: BookmarkStore): BookmarksStreamEvent {
  return {
    ev: "bookmarks",
    sessions: [...store.sessions].map(([sid, uuids]) => ({ session_id: sid, uuids: [...uuids] })),
  };
}

/** Bookmark `uuid` of session `sid` (`on`) or take it off, and write the
 * file before saying so. False when nothing changed (set already, or off
 * already). */
export async function setBookmark(
  store: BookmarkStore,
  sid: string,
  uuid: string,
  on: boolean,
): Promise<boolean> {
  const held = store.sessions.get(sid) ?? [];
  if (held.includes(uuid) === on) return false;
  const next = on ? [...held, uuid] : held.filter((u) => u !== uuid);
  if (next.length === 0) store.sessions.delete(sid);
  else store.sessions.set(sid, next);
  await writeBookmarks(store);
  return true;
}

/** Write the file whole: to a temporary file beside it, then renamed over
 * it, so a crash leaves the old file or the new one. A write that fails is
 * said in the log; the bookmarks stay held in memory. */
function writeBookmarks(store: BookmarkStore): Promise<void> {
  const text = `${JSON.stringify(Object.fromEntries(store.sessions))}\n`;
  const tmp = path.join(path.dirname(store.file), `.bookmarks.${String(process.pid)}.tmp`);
  const write = async (): Promise<void> => {
    try {
      await fs.promises.mkdir(path.dirname(store.file), { recursive: true });
      await fs.promises.writeFile(tmp, text, { mode: 0o600 });
      await fs.promises.rename(tmp, store.file);
    } catch (e) {
      store.log.warn(`bookmarks: ${store.file}: ${e instanceof Error ? e.message : "not written"}`);
    }
  };
  const written = store.written.then(write);
  store.written = written;
  return written;
}

/** Reads a transcript's lines in order into `take`. */
export type TranscriptScan = (take: (line: string) => void) => Promise<void>;

/** A row read whole: its line's place among the transcript's lines (0 for
 * the first) and BookmarkRow's `lines`. */
interface KeptRow {
  index: number;
  lines: readonly string[];
}

/** A row being completed: its lines so far, and what it still waits for. */
interface OpenRow {
  index: number;
  lines: string[];
  /** The line after the row has been taken. */
  next: boolean;
  /** The tool calls of the row whose result's line has not come. */
  results: Set<string>;
}

/** The uuid of a transcript row line, and the ids of the tool calls it
 * makes; null for a line that is no row. */
function rowOf(line: string): { uuid: string; toolUses: string[] } | null {
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok || !isKnownTranscriptRow(read.value)) return null;
  const row = read.value;
  if (row.type !== "assistant" && row.type !== "user") return null;
  const content = row.message.content;
  const toolUses =
    row.type === "assistant" && typeof content !== "string"
      ? content.flatMap((block) =>
          isKnownContentBlock(block) && block.type === "tool_use" ? [block.id] : [],
        )
      : [];
  return { uuid: row.uuid, toolUses };
}

/** The tool_use ids whose results a line carries, among `waiting`. */
function resultsIn(line: string, waiting: ReadonlySet<string>): string[] {
  if (!line.includes('"tool_result"')) return [];
  return [...waiting].filter((id) => line.includes(id));
}

/** The rows of `sid`'s bookmarks, in file order (bookmark_rows). The rows
 * read whole before are not read again; when any bookmark has none yet,
 * `scan` reads the session's transcript once for all of them. A row is kept
 * once its next line and every result of its tool calls have been read; one
 * still waiting at the end of the file (the session's current turn) is
 * answered as far as it goes and read again next time. A bookmark whose row
 * the transcript does not have is left out. */
export async function bookmarkRows(
  store: BookmarkStore,
  sid: string,
  scan: TranscriptScan,
): Promise<BookmarkRow[]> {
  const wanted = store.sessions.get(sid) ?? [];
  const kept = store.rows.get(sid) ?? new Map<string, KeptRow>();
  const missing = new Set(wanted.filter((uuid) => !kept.has(uuid)));
  const partial = new Map<string, KeptRow>();
  if (missing.size > 0) {
    const open = new Map<string, OpenRow>();
    let index = 0;
    await scan((line) => {
      const at = index;
      index += 1;
      for (const [uuid, row] of open) {
        if (!row.next) {
          row.next = true;
          row.lines.push(line);
        } else {
          const ids = resultsIn(line, row.results);
          if (ids.length === 0) continue;
          for (const id of ids) row.results.delete(id);
          row.lines.push(line);
        }
        if (row.results.size === 0) {
          open.delete(uuid);
          kept.set(uuid, { index: row.index, lines: row.lines });
        }
      }
      for (const uuid of missing) {
        if (!line.includes(uuid)) continue;
        const row = rowOf(line);
        if (row === null || row.uuid !== uuid) continue;
        missing.delete(uuid);
        open.set(uuid, { index: at, lines: [line], next: false, results: new Set(row.toolUses) });
      }
    });
    for (const [uuid, row] of open) partial.set(uuid, { index: row.index, lines: row.lines });
    if (kept.size > 0) store.rows.set(sid, kept);
  }
  return wanted
    .flatMap((uuid) => {
      const row = kept.get(uuid) ?? partial.get(uuid);
      return row === undefined ? [] : [{ uuid, ...row }];
    })
    .sort((a, b) => a.index - b.index)
    .map(({ uuid, lines }) => ({ uuid, lines: [...lines] }));
}
