// Which says the person has not read (DR-0045 §7). A say is a `say` tool
// call on the main thread of a live session, known by its tool_use's id; the
// relay hands the session's lines to the fold here (the catch-up's and every
// push's read), so a say is seen with its row's time. What is read is a set
// of those ids, kept in `<stateDir>/say-read.json` with `since`, the time
// before which every say counts as read: the first start, and a file that
// does not read, would otherwise make every say in every live transcript
// unread at once.
//
// Design rationale: this is the one state the daemon keeps on disk for the
// webui alone (DR-0036 §3 keeps v1 from growing such state). The says are
// drawn from the transcripts, which outlive the daemon; with the read ids in
// memory only, every restart would bring back every say as unread.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  ccmsgSayText,
  isKnownContentBlock,
  isKnownTranscriptRow,
  jsonText,
  parseWith,
  TranscriptRowLineSchema,
  type UnreadSay,
} from "@ccmsg/protocol";
import type { LineFold } from "./transcript-relay.ts";

/** say-read.json: the read ids, and the time before which every say is
 * read. */
const SayReadFileSchema = jsonText(
  v.object({
    since: v.pipe(v.string(), v.isoTimestamp()),
    read: v.array(v.string()),
  }),
);

/** The says of one live session, by tool_use id, to their row's time. */
type SessionSays = Map<string, string>;

export interface SayUnreadStore {
  /** The settled says of each live session. */
  says: Map<string, SessionSays>;
  read: Set<string>;
  since: string;
  file: string;
  /** The last write of the file: the writes go one after another, so an
   * older set never lands over a newer one. */
  written: Promise<void>;
}

export interface SayReadLog {
  warn(msg: string): void;
}

/** The store as `file` holds it. A file that is missing or does not read
 * starts over from now (said in the log when it was there). */
export function loadSayUnreadStore(file: string, log: SayReadLog, now: () => Date): SayUnreadStore {
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      log.warn(
        `say-read: ${file}: ${e instanceof Error ? e.message : "unreadable"} — starting over`,
      );
    }
  }
  const read = text === undefined ? undefined : parseWith(SayReadFileSchema, text);
  if (read !== undefined && !read.ok) {
    log.warn(`say-read: ${file}: ${read.failure.summary} — starting over`);
  }
  if (read?.ok === true) {
    const { since } = read.value;
    return {
      says: new Map(),
      read: new Set(read.value.read),
      since,
      file,
      written: Promise.resolve(),
    };
  }
  const since = now().toISOString();
  return { says: new Map(), read: new Set(), since, file, written: Promise.resolve() };
}

function isUnread(store: SayUnreadStore, id: string, ts: string): boolean {
  return !store.read.has(id) && Date.parse(ts) >= Date.parse(store.since);
}

/** Every unread say, oldest first. */
export function unreadSays(store: SayUnreadStore): UnreadSay[] {
  const unread: UnreadSay[] = [];
  for (const [sid, says] of store.says) {
    for (const [id, ts] of says) {
      if (isUnread(store, id, ts)) unread.push({ session_id: sid, tool_use_id: id, ts });
    }
  }
  return unread.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** What `markSaysRead` did. `unknown` lists the ids that are neither unread
 * nor read; when any is, nothing is marked. */
export type MarkSaysReadResult =
  | { kind: "read" }
  | { kind: "unchanged" }
  | { kind: "unknown"; ids: readonly string[] };

/** Mark `ids` read, all of them or none, and write the file before saying
 * so. An id is known when a live session's say has it, or it was read
 * before. */
export async function markSaysRead(
  store: SayUnreadStore,
  ids: readonly string[],
): Promise<MarkSaysReadResult> {
  const unread = new Set(unreadSays(store).map((s) => s.tool_use_id));
  const known = (id: string): boolean =>
    store.read.has(id) || [...store.says.values()].some((says) => says.has(id));
  const unknown = ids.filter((id) => !known(id));
  if (unknown.length > 0) return { kind: "unknown", ids: unknown };
  const fresh = ids.filter((id) => unread.has(id));
  if (fresh.length === 0) return { kind: "unchanged" };
  for (const id of fresh) store.read.add(id);
  await writeSayRead(store);
  return { kind: "read" };
}

/** Write the file whole: to a temporary file beside it, then renamed over
 * it, so a crash leaves the old file or the new one. */
function writeSayRead(store: SayUnreadStore): Promise<void> {
  const text = `${JSON.stringify({ since: store.since, read: [...store.read] })}\n`;
  const tmp = path.join(path.dirname(store.file), `.say-read.${String(process.pid)}.tmp`);
  const write = async (): Promise<void> => {
    await fs.promises.mkdir(path.dirname(store.file), { recursive: true });
    await fs.promises.writeFile(tmp, text, { mode: 0o600 });
    await fs.promises.rename(tmp, store.file);
  };
  const written = store.written.then(write, write);
  store.written = written.catch(() => {});
  return written;
}

/** The say a line makes, if it is one: a main-thread assistant row with a
 * `say` tool call whose input is the tool's. */
function saysOfLine(line: string): { id: string; ts: string }[] {
  if (!line.includes('"mcp__ccmsg-v1__say"')) return [];
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok) return [];
  const row = read.value;
  if (!isKnownTranscriptRow(row) || row.type !== "assistant" || row.isSidechain) return [];
  return row.message.content.flatMap((block) =>
    isKnownContentBlock(block) &&
    block.type === "tool_use" &&
    ccmsgSayText(block.name, block.input) !== null
      ? [{ id: block.id, ts: row.timestamp }]
      : [],
  );
}

/** `sid`'s says, for the transcript relay. A catch-up folds into a detached
 * set that replaces the settled one only when it lands. `onChange` is told
 * when the unread says may have moved. */
export function sayUnreadFold(store: SayUnreadStore, sid: string, onChange: () => void): LineFold {
  let settled: SessionSays | undefined;
  let next: SessionSays | undefined;
  let moved = false;
  return {
    restart() {
      next = new Map();
    },
    take(line) {
      const says = next ?? settled;
      if (says === undefined) return;
      for (const say of saysOfLine(line)) {
        if (says.has(say.id)) continue;
        says.set(say.id, say.ts);
        if (says === settled) moved = true;
      }
    },
    settle() {
      if (next !== undefined) {
        moved ||= next.size > 0 || (settled?.size ?? 0) > 0;
        settled = next;
        next = undefined;
        store.says.set(sid, settled);
      }
      if (!moved) return;
      moved = false;
      onChange();
    },
    close() {
      if (store.says.get(sid) === settled) store.says.delete(sid);
      if ((settled?.size ?? 0) > 0) onChange();
      settled = undefined;
      next = undefined;
    },
  };
}
