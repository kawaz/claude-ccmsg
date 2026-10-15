// The room logs left on disk, read on request (DR-0036 §2).
//
// Rooms are read-only: nothing appends to `<data dir>/rooms/r<N>.jsonl` any
// more, and what remains is read for the webui's room view (`rooms`,
// `room_history`), for the Timeline's full text of a room message a past
// transcript shows (`read`), and for a session dump's rooms. All of them read
// through one reader, which parses a log the first time it is asked for and
// reuses the parse while the file's stat stays the same (mtime-cache.ts).
//
// A line that does not read is left out of what is returned — a torn last
// line from a crash mid-append included — and the file is never written back.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  errorText,
  jsonText,
  parseWith,
  StorageEventSchema,
  type MemberEvent,
  type MsgEvent,
  type RoomKind,
  type RoomSummary,
  type StorageEvent,
} from "@ccmsg/protocol";
import { createMtimeCache } from "./mtime-cache.ts";

/** One room's log: its id and every event it holds, in file order. */
export interface RoomLog {
  readonly id: string;
  readonly events: readonly StorageEvent[];
}

export interface RoomReader {
  /** Every room log, in room number order. */
  list(): Promise<RoomLog[]>;
  /** The log of room `id`, or undefined when there is no such room (an id
   * not of the `r<N>` shape included, so a request cannot name a file
   * outside the rooms dir). */
  room(id: string): Promise<RoomLog | undefined>;
}

/** How many parsed logs the reader keeps. Above the number of logs there are,
 * so a `rooms` request (which reads every log) hits the cache from the second
 * time on; the logs no longer grow in number, since nothing creates a room. */
const CACHED_LOGS = 4096;

/** `r<N>` as the daemon numbered rooms: no leading zero, so one number names
 * one file. */
const ROOM_ID_RE = /^r[1-9]\d*$/;
const ROOM_FILE_RE = /^(r[1-9]\d*)\.jsonl$/;

/** One line of a room's file. */
const StorageEventLineSchema = jsonText(StorageEventSchema);

/** Read the logs under `roomsDir`. `warn` hears of a line that does not read
 * (once per change of the file, since a parse is reused until then), and of
 * a log that cannot be read at all (a directory, no permission), which is
 * left out as if absent rather than failing every other room with it. */
export function createRoomReader(
  roomsDir: string,
  warn: (line: string) => void = () => {},
): RoomReader {
  const cache = createMtimeCache<readonly StorageEvent[]>(CACHED_LOGS);
  const load = async (id: string): Promise<RoomLog | undefined> => {
    const file = path.join(roomsDir, `${id}.jsonl`);
    try {
      const events = await cache.get(file, async () =>
        parseLog(id, await fs.promises.readFile(file, "utf8"), warn),
      );
      return events === undefined ? undefined : { id, events };
    } catch (e) {
      warn(`room ${id}: log unreadable, left out (${errorText(e)})`);
      return undefined;
    }
  };
  return {
    async list() {
      let names: string[];
      try {
        names = await fs.promises.readdir(roomsDir);
      } catch {
        return [];
      }
      const ids = names
        .flatMap((name) => ROOM_FILE_RE.exec(name)?.[1] ?? [])
        .sort((a, b) => roomNumber(a) - roomNumber(b));
      const logs = await Promise.all(ids.map(load));
      return logs.filter((log): log is RoomLog => log !== undefined);
    },
    async room(id) {
      return ROOM_ID_RE.test(id) ? await load(id) : undefined;
    },
  };
}

function roomNumber(id: string): number {
  return Number(id.slice(1));
}

function parseLog(id: string, text: string, warn: (line: string) => void): StorageEvent[] {
  const events: StorageEvent[] = [];
  const lines = text.split("\n");
  for (const [i, line] of lines.entries()) {
    if (line.trim() === "") continue;
    const read = parseWith(StorageEventLineSchema, line);
    if (read.ok) {
      events.push(read.value);
      continue;
    }
    // The last line without its newline is a write a crash cut short; anything
    // else is unexpected in an append-only log and worth a line in the log.
    if (i !== lines.length - 1) {
      warn(`room ${id}: skipping unreadable line (${read.failure.summary}): ${line.slice(0, 120)}`);
    }
  }
  return events;
}

/** The members present in `events` (member minus leave), in id order (`u`
 * before `a`, then by number). */
export function presentMembers(events: readonly StorageEvent[]): MemberEvent[] {
  const byId = new Map<string, MemberEvent>();
  for (const ev of events) {
    if (ev.type === "member") byId.set(ev.id, ev);
    else if (ev.type === "leave") byId.delete(ev.id);
  }
  return [...byId.values()].sort((a, b) => compareMemberIds(a.id, b.id));
}

function memberIdKey(id: string): [number, number] {
  const m = /^([ua])(\d+)$/.exec(id);
  if (!m) return [2, 0];
  return [m[1] === "u" ? 0 : 1, Number(m[2])];
}

function compareMemberIds(a: string, b: string): number {
  const [ap, an] = memberIdKey(a);
  const [bp, bn] = memberIdKey(b);
  return ap === bp ? an - bn : ap - bp;
}

/** What the room list shows of one log. */
export function roomSummary(log: RoomLog): RoomSummary {
  let title: string | undefined;
  let archived = false;
  let kind: RoomKind = "normal";
  let lastMid = 0;
  let lastTs: string | null = null;
  for (const ev of log.events) {
    if (ev.type === "title") title = ev.title;
    else if (ev.type === "archive") archived = ev.archived;
    else if (ev.type === "kind") kind = ev.kind;
    else if (ev.type === "msg" && ev.mid > lastMid) lastMid = ev.mid;
    lastTs = (ev.type === "member" ? ev.joined_at : ev.ts) || lastTs;
  }
  return {
    id: log.id,
    ...(title ? { title } : {}),
    members: presentMembers(log.events),
    last_mid: lastMid,
    last_ts: lastTs,
    ...(archived ? { archived: true } : {}),
    ...(kind !== "normal" ? { kind } : {}),
  };
}

/** The msgs of `log` whose mid `selector` names, by mid. */
export function readMsgs(log: RoomLog, selector: string | readonly number[]): MsgEvent[] {
  const ranges = midRanges(selector);
  return log.events
    .filter(
      (ev): ev is MsgEvent =>
        ev.type === "msg" && ranges.some(([lo, hi]) => lo <= ev.mid && ev.mid <= hi),
    )
    .sort((a, b) => a.mid - b.mid);
}

/** A mids selector ("10-15,18" or [10,11]) as inclusive ranges. Kept as
 * ranges rather than spelled out, so a wide range costs no more than a
 * narrow one. A part that is not an integer or an ascending range names
 * nothing. */
export function midRanges(selector: string | readonly number[]): [number, number][] {
  if (typeof selector !== "string") {
    return selector.filter((n) => Number.isInteger(n)).map((n): [number, number] => [n, n]);
  }
  return selector.split(",").flatMap((part): [number, number][] => {
    const t = part.trim();
    const dash = t.indexOf("-");
    const lo = Number(dash > 0 ? t.slice(0, dash) : t);
    const hi = Number(dash > 0 ? t.slice(dash + 1) : t);
    return t !== "" && Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi ? [[lo, hi]] : [];
  });
}
