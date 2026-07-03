// Room storage: one append-only JSONL per room, held fully in memory.
//
// Design rationale: the daemon keeps every event of every room in memory
// (room.events). For personal scale this is bounded and makes read (arbitrary mid
// range) and subscribe since-replay (positional delta) trivial and exact. The file
// remains the durable source of truth; memory is a faithful mirror. retention /
// compaction is explicitly out of MVP scope (DR-0001 open questions), so unbounded
// growth is acceptable for now.
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  MemberEvent,
  MsgEvent,
  StorageEvent,
} from "@ccmsg/protocol";
import type { Logger } from "./log.ts";

const FSYNC_DEBOUNCE_MS = 100;

export interface Room {
  id: string;
  file: string;
  events: StorageEvent[];
  lastMid: number;
  /** creation time (ms) = earliest member joined_at, for dedup window checks. */
  createdAt: number;
  /** rooms spawned via next_room carry a prev link and are dedup-exempt (DR-0003 §4/§5). */
  dedupEligible: boolean;
  /** sorted, unique original member sids — the dedup key. */
  dedupKey: string;
  title?: string;
  next: string[];
  prev: string[];
  // append fd, lazily opened on first write and kept open to hold the fsync target.
  fd: number | null;
  fsyncTimer: ReturnType<typeof setTimeout> | null;
}

export interface PresentMember extends MemberEvent {}

/** Derive the currently-present members (member minus leave), in uid order. */
export function presentMembers(room: Room): PresentMember[] {
  const byUid = new Map<number, MemberEvent>();
  for (const ev of room.events) {
    if (ev.type === "member") byUid.set(ev.uid, ev);
    else if (ev.type === "leave") byUid.delete(ev.uid);
  }
  return [...byUid.values()].sort((a, b) => a.uid - b.uid);
}

/** Map present member sid -> uid. */
export function memberUidBySid(room: Room): Map<string, number> {
  const m = new Map<string, number>();
  for (const mem of presentMembers(room)) m.set(mem.sid, mem.uid);
  return m;
}

/** ts of the last event, or null for an empty room. */
export function lastTs(room: Room): string | null {
  for (let i = room.events.length - 1; i >= 0; i--) {
    const ev = room.events[i]!;
    const ts =
      ev.type === "member"
        ? ev.joined_at
        : "ts" in ev
          ? ev.ts
          : null;
    if (ts) return ts;
  }
  return null;
}

function computeDerived(room: Room): void {
  let lastMid = 0;
  let earliestJoin = Number.POSITIVE_INFINITY;
  const sids = new Set<string>();
  let title: string | undefined;
  const next: string[] = [];
  const prev: string[] = [];
  for (const ev of room.events) {
    switch (ev.type) {
      case "msg":
        if (ev.mid > lastMid) lastMid = ev.mid;
        break;
      case "member": {
        sids.add(ev.sid);
        const t = Date.parse(ev.joined_at);
        if (!Number.isNaN(t) && t < earliestJoin) earliestJoin = t;
        break;
      }
      case "title":
        title = ev.title;
        break;
      case "next":
        next.push(ev.room);
        break;
      case "prev":
        prev.push(ev.room);
        break;
    }
  }
  room.lastMid = lastMid;
  room.createdAt = Number.isFinite(earliestJoin) ? earliestJoin : Date.now();
  room.title = title;
  room.next = next;
  room.prev = prev;
  room.dedupEligible = prev.length === 0;
  room.dedupKey = [...sids].sort().join(",");
}

/**
 * Load a room from its JSONL file, recovering a torn tail (DR-0002 §6).
 * A trailing partial line (no newline, unparseable) is moved to
 * <file>.torn-<ts> and truncated off. A trailing complete-but-unterminated
 * line (valid JSON, no newline) is normalized by appending a newline so the
 * next append doesn't concatenate onto it.
 */
export function loadRoom(file: string, id: string, log: Logger): Room {
  const room: Room = {
    id,
    file,
    events: [],
    lastMid: 0,
    createdAt: Date.now(),
    dedupEligible: true,
    dedupKey: "",
    next: [],
    prev: [],
    fd: null,
    fsyncTimer: null,
  };

  let raw: Buffer;
  try {
    raw = fs.readFileSync(file);
  } catch {
    return room; // no file yet = empty room
  }
  if (raw.length === 0) return room;

  const text = raw.toString("utf8");
  const endsWithNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (endsWithNewline) lines.pop(); // drop the trailing "" after the final newline

  // If the file doesn't end with a newline, the last element is a candidate torn line.
  let tornLine: string | null = null;
  if (!endsWithNewline && lines.length > 0) {
    const last = lines[lines.length - 1]!;
    if (tryParse(last) === null) {
      tornLine = lines.pop() ?? null;
    }
  }

  for (const line of lines) {
    if (line.trim() === "") continue;
    const ev = tryParse(line);
    if (ev === null) {
      // A non-tail corrupt line is unexpected under append-only writes. Skip it
      // (keep the rest of the log usable) and record the anomaly.
      log.error(`room ${id}: skipping unparseable line: ${line.slice(0, 120)}`);
      continue;
    }
    room.events.push(ev);
  }

  if (tornLine !== null) {
    const tornPath = `${file}.torn-${Date.now()}`;
    const lastNewline = raw.lastIndexOf(0x0a); // last '\n'
    const keepLen = lastNewline + 1; // everything through the final newline
    try {
      fs.writeFileSync(tornPath, raw.subarray(keepLen));
      fs.truncateSync(file, keepLen);
      log.warn(`room ${id}: torn tail recovered to ${path.basename(tornPath)} (${raw.length - keepLen} bytes)`);
    } catch (e) {
      log.error(`room ${id}: torn tail recovery failed: ${String(e)}`);
    }
  } else if (!endsWithNewline) {
    // Last line is valid JSON but was written without its newline. Normalize.
    try {
      fs.appendFileSync(file, "\n");
      log.warn(`room ${id}: appended missing trailing newline`);
    } catch {
      // best effort
    }
  }

  computeDerived(room);
  return room;
}

function tryParse(line: string): StorageEvent | null {
  try {
    return JSON.parse(line) as StorageEvent;
  } catch {
    return null;
  }
}

/** Append one event to the room's file (durable log) and in-memory mirror. */
export function appendEvent(room: Room, ev: StorageEvent): void {
  room.events.push(ev);
  if (ev.type === "msg" && ev.mid > room.lastMid) room.lastMid = ev.mid;
  if (ev.type === "title") room.title = ev.title;
  if (ev.type === "next") room.next.push(ev.room);
  if (ev.type === "prev") {
    room.prev.push(ev.room);
    room.dedupEligible = false;
  }
  const line = `${JSON.stringify(ev)}\n`;
  if (room.fd === null) room.fd = fs.openSync(room.file, "a");
  fs.writeSync(room.fd, line);
  scheduleFsync(room);
}

// fsync is not per-record: debounce 100ms so a burst of writes syncs once
// (DR-0002 §6). The <=100ms loss window is accepted at personal scale; the torn
// tail recovery above is the safety net for a crash inside that window.
function scheduleFsync(room: Room): void {
  if (room.fsyncTimer !== null) return;
  room.fsyncTimer = setTimeout(() => {
    room.fsyncTimer = null;
    if (room.fd !== null) {
      try {
        fs.fsyncSync(room.fd);
      } catch {
        // ignore
      }
    }
  }, FSYNC_DEBOUNCE_MS);
}

/** Force a synchronous flush (used on graceful shutdown). */
export function flushRoom(room: Room): void {
  if (room.fsyncTimer !== null) {
    clearTimeout(room.fsyncTimer);
    room.fsyncTimer = null;
  }
  if (room.fd !== null) {
    try {
      fs.fsyncSync(room.fd);
    } catch {
      // ignore
    }
  }
}

export function closeRoom(room: Room): void {
  flushRoom(room);
  if (room.fd !== null) {
    try {
      fs.closeSync(room.fd);
    } catch {
      // ignore
    }
    room.fd = null;
  }
}

/** Return msg events whose mid is in the requested set, sorted ascending. */
export function readMsgs(room: Room, mids: Set<number>): MsgEvent[] {
  const out: MsgEvent[] = [];
  for (const ev of room.events) {
    if (ev.type === "msg" && mids.has(ev.mid)) out.push(ev);
  }
  out.sort((a, b) => a.mid - b.mid);
  return out;
}

/** Parse a mids selector ("10-15,18" or [10,11]) into a concrete set. */
export function parseMidSelector(sel: string | number[]): Set<number> {
  const out = new Set<number>();
  if (Array.isArray(sel)) {
    for (const n of sel) if (Number.isInteger(n)) out.add(n);
    return out;
  }
  for (const part of sel.split(",")) {
    const t = part.trim();
    if (t === "") continue;
    const dash = t.indexOf("-");
    if (dash > 0) {
      const lo = Number(t.slice(0, dash));
      const hi = Number(t.slice(dash + 1));
      if (Number.isInteger(lo) && Number.isInteger(hi) && lo <= hi) {
        for (let i = lo; i <= hi; i++) out.add(i);
      }
    } else {
      const n = Number(t);
      if (Number.isInteger(n)) out.add(n);
    }
  }
  return out;
}

export function scanRooms(roomsDir: string, log: Logger): Map<string, Room> {
  const rooms = new Map<string, Room>();
  let entries: string[];
  try {
    entries = fs.readdirSync(roomsDir);
  } catch {
    return rooms; // dir doesn't exist yet
  }
  for (const name of entries) {
    if (!name.endsWith(".jsonl")) continue;
    const id = name.slice(0, -".jsonl".length);
    const room = loadRoom(path.join(roomsDir, name), id, log);
    rooms.set(id, room);
  }
  return rooms;
}
