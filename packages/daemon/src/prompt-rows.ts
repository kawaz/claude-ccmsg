// The rows of a session's transcript that may be the person's prompts, for
// the webui's 👤 filter (prompt_rows, DR-0058 §11): the ones outside its
// loaded window. Which of them are prompts the webui tells by the Timeline's
// own classifying of rows; this hands every `type:"user"` row with a uuid
// whose message carries no tool result, so the rule of what a prompt is lives
// in one place.
//
// What was read is kept in memory, per session, with the byte offset the
// read reached: the next request reads only the lines added since (a
// transcript is only appended to). Kept against the transcript file it was
// read from (its path and inode): a session whose transcript is another file
// now, or one shorter than what was read (rewritten), is read again from its
// start, so no row of the old file is answered. The kept rows are bounded by
// their total size: past it the least recently asked sessions are dropped,
// to be read again from the start when asked next (the way session-status.ts
// bounds its canonical pins by the session).
import * as v from "valibot";
import { jsonText, parseWith, type BookmarkRow } from "@ccmsg/protocol";

/** The total size of the lines kept for every session (32 MiB). */
export const PROMPT_ROWS_MAX_BYTES = 32 * 1024 * 1024;

/** What one session's transcript was read into. */
interface SessionPromptRows {
  file: string;
  dev: number;
  ino: number;
  /** The byte offset the read reached: the end of its last whole line. */
  end: number;
  rows: BookmarkRow[];
  /** The UTF-8 size of `rows`' lines. */
  bytes: number;
}

export interface PromptRowsStore {
  /** sid → what was read, the least recently asked first. */
  sessions: Map<string, SessionPromptRows>;
  /** The sum of the sessions' `bytes`. */
  bytes: number;
  maxBytes: number;
  /** sid → the read in flight: a session's reads go one after another, so
   * two requests do not both take the same lines. */
  reading: Map<string, Promise<unknown>>;
}

export function createPromptRowsStore(maxBytes = PROMPT_ROWS_MAX_BYTES): PromptRowsStore {
  return { sessions: new Map(), bytes: 0, maxBytes, reading: new Map() };
}

/** The transcript file as it is now. */
export interface TranscriptFile {
  path: string;
  dev: number;
  ino: number;
  size: number;
}

/** Reads the transcript's complete lines from byte `start` into `take`. */
export type TranscriptScanFrom = (start: number, take: (line: string) => void) => Promise<void>;

/** A user row that may be a prompt: its uuid and what its message holds. */
const UserRowSchema = jsonText(
  v.object({
    type: v.literal("user"),
    uuid: v.pipe(v.string(), v.nonEmpty()),
    message: v.object({
      content: v.union([v.string(), v.array(v.object({ type: v.string() }))]),
    }),
  }),
);

/** The uuid of `line` when it may be the person's prompt, else null. */
function candidateUuid(line: string): string | null {
  if (!line.includes('"user"')) return null;
  const row = parseWith(UserRowSchema, line);
  if (!row.ok) return null;
  const { content } = row.value.message;
  if (typeof content !== "string" && content.some((block) => block.type === "tool_result")) {
    return null;
  }
  return row.value.uuid;
}

function utf8Size(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The rows of `sid`'s transcript (`file`) that may be the person's prompts,
 * in file order (prompt_rows). Reads what was not read before, from the
 * start when what was kept is of another file. */
export function promptRows(
  store: PromptRowsStore,
  sid: string,
  file: TranscriptFile,
  scan: TranscriptScanFrom,
): Promise<BookmarkRow[]> {
  const before = store.reading.get(sid) ?? Promise.resolve();
  const read = before.catch(() => {}).then(() => readNew(store, sid, file, scan));
  store.reading.set(sid, read);
  return read.finally(() => {
    if (store.reading.get(sid) === read) store.reading.delete(sid);
  });
}

async function readNew(
  store: PromptRowsStore,
  sid: string,
  file: TranscriptFile,
  scan: TranscriptScanFrom,
): Promise<BookmarkRow[]> {
  const held = store.sessions.get(sid);
  const same =
    held !== undefined &&
    held.file === file.path &&
    held.dev === file.dev &&
    held.ino === file.ino &&
    held.end <= file.size;
  const base = same
    ? held
    : { file: file.path, dev: file.dev, ino: file.ino, end: 0, rows: [], bytes: 0 };
  const rows = [...base.rows];
  let end = base.end;
  let bytes = base.bytes;
  await scan(base.end, (line) => {
    end += utf8Size(line) + 1;
    const uuid = candidateUuid(line);
    if (uuid === null) return;
    rows.push({ uuid, lines: [line] });
    bytes += utf8Size(line);
  });
  if (held !== undefined) {
    store.sessions.delete(sid);
    store.bytes -= held.bytes;
  }
  store.sessions.set(sid, { ...base, end, rows, bytes });
  store.bytes += bytes;
  for (const [oldest, kept] of store.sessions) {
    if (store.bytes <= store.maxBytes || oldest === sid) break;
    store.sessions.delete(oldest);
    store.bytes -= kept.bytes;
  }
  return rows.map((row) => ({ uuid: row.uuid, lines: [...row.lines] }));
}
