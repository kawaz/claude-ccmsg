// The rows of a session's transcript that may be the person's prompts, for
// the webui's 👤 filter (prompt_rows, DR-0058 §11): the ones outside its
// loaded window. Which of them are prompts the webui tells by the Timeline's
// own classifying of rows; this hands every `type:"user"` row with a uuid
// whose message carries no tool result, and every `queued_command`
// attachment row with a uuid (a prompt entered while a tool ran, DR-0035 §5),
// so the rule of what a prompt is lives in one place.
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

/** A kept row, with the time it was written (its `timestamp`, as ms since
 * the epoch; null when it has none or it does not read). */
interface KeptRow extends BookmarkRow {
  at: number | null;
}

/** What one session's transcript was read into. */
interface SessionPromptRows {
  file: string;
  dev: number;
  ino: number;
  /** The byte offset the read reached: the end of its last whole line. */
  end: number;
  rows: KeptRow[];
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

/** When a row was written: a time that does not read leaves the row a
 * candidate, without a time. */
const RowTimeSchema = v.fallback(v.optional(v.string()), undefined);

/** A row that may be a prompt: a user row (its uuid, when it was written and
 * what its message holds), or a `queued_command` attachment row (a prompt
 * entered while a tool ran, which gets no user row of its own). */
const CandidateRowSchema = jsonText(
  v.variant("type", [
    v.object({
      type: v.literal("user"),
      uuid: v.pipe(v.string(), v.nonEmpty()),
      timestamp: RowTimeSchema,
      message: v.object({
        content: v.union([v.string(), v.array(v.object({ type: v.string() }))]),
      }),
    }),
    v.object({
      type: v.literal("attachment"),
      uuid: v.pipe(v.string(), v.nonEmpty()),
      timestamp: RowTimeSchema,
      attachment: v.object({ type: v.literal("queued_command") }),
    }),
  ]),
);

/** The uuid and time of `line` when it may be the person's prompt, else
 * null. */
function candidate(line: string): { uuid: string; at: number | null } | null {
  if (!line.includes('"user"') && !line.includes('"queued_command"')) return null;
  const row = parseWith(CandidateRowSchema, line);
  if (!row.ok) return null;
  const read = row.value;
  if (
    read.type === "user" &&
    typeof read.message.content !== "string" &&
    read.message.content.some((block) => block.type === "tool_result")
  ) {
    return null;
  }
  const at = read.timestamp === undefined ? Number.NaN : Date.parse(read.timestamp);
  return { uuid: read.uuid, at: Number.isFinite(at) ? at : null };
}

function utf8Size(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The rows of `sid`'s transcript (`file`) that may be the person's prompts,
 * in file order (prompt_rows); with `since` (ms since the epoch), only the
 * ones written at or after it. Reads what was not read before, from the
 * start when what was kept is of another file. */
export function promptRows(
  store: PromptRowsStore,
  sid: string,
  file: TranscriptFile,
  scan: TranscriptScanFrom,
  since?: number,
): Promise<BookmarkRow[]> {
  const before = store.reading.get(sid) ?? Promise.resolve();
  const read = before.catch(() => {}).then(() => readNew(store, sid, file, scan, since));
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
  since: number | undefined,
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
    const found = candidate(line);
    if (found === null) return;
    rows.push({ ...found, lines: [line] });
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
  return rows.flatMap((row) =>
    since === undefined || (row.at !== null && row.at >= since)
      ? [{ uuid: row.uuid, lines: [...row.lines] }]
      : [],
  );
}
