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
import type { MemberEvent, MsgEvent, RoomKind, StorageEvent } from "@ccmsg/protocol";
import type { Logger } from "./log.ts";

const FSYNC_DEBOUNCE_MS = 100;

export interface Room {
  id: string;
  file: string;
  events: StorageEvent[];
  lastMid: number;
  /** per-room seq high-water mark spanning ALL event types (DR-0016), maintained
   * by computeDerived (load: persisted seq / in-memory backfill for legacy rows)
   * and appendEvent (write: advanced only after a successful disk write). */
  lastSeq: number;
  /** creation time (ms) = earliest member joined_at, for dedup window checks. */
  createdAt: number;
  /** rooms spawned via next_room carry a prev link and are dedup-exempt (DR-0003 §4/§5). */
  dedupEligible: boolean;
  /** sorted, unique original member sids — the dedup key. */
  dedupKey: string;
  title?: string;
  /** last-wins archive flag (DR-0012), same rule as title. */
  archived: boolean;
  /** room kind (DR-0013). "normal" is the absence of any KindEvent in the log;
   * "broadcast" is set exactly once at creation by createRoom and recovered on
   * daemon restart by computeDerived reading the KindEvent back. */
  kind: RoomKind;
  next: string[];
  prev: string[];
  // append fd, lazily opened on first write and kept open to hold the fsync target.
  fd: number | null;
  fsyncTimer: ReturnType<typeof setTimeout> | null;
}

export interface PresentMember extends MemberEvent {}

/** Sort key for member ids: `u` namespace before `a`, then numeric suffix ascending. */
function idSortKey(id: string): [number, number] {
  const m = /^([ua])(\d+)$/.exec(id);
  if (!m) return [2, 0]; // unrecognized shape sorts last
  return [m[1] === "u" ? 0 : 1, Number(m[2])];
}

/** Member id ordering: `u` namespace before `a`, then numeric suffix ascending.
 * Exported so server.ts's reply op (DR-0017 §2.2) can emit its constructed
 * `to` list in the same canonical order regardless of how the original msg's
 * `to` was ordered at post time. */
export function compareIds(a: string, b: string): number {
  const [ap, an] = idSortKey(a);
  const [bp, bn] = idSortKey(b);
  return ap === bp ? an - bn : ap - bp;
}

/** Derive the currently-present members (member minus leave), in id order (u before a). */
export function presentMembers(room: Room): PresentMember[] {
  const byId = new Map<string, MemberEvent>();
  for (const ev of room.events) {
    if (ev.type === "member") byId.set(ev.id, ev);
    else if (ev.type === "leave") byId.delete(ev.id);
  }
  return [...byId.values()].sort((a, b) => compareIds(a.id, b.id));
}

/** Map present member sid -> id. */
export function memberIdBySid(room: Room): Map<string, string> {
  const m = new Map<string, string>();
  for (const mem of presentMembers(room)) m.set(mem.sid, mem.id);
  return m;
}

/**
 * Next free agent-namespace member id for `invite` (DR-0011 §1-4). Scans every
 * `member` event ever appended to the room (not just present members) so a
 * leave doesn't free up an id for reuse — the id already appears in earlier
 * `msg`/`member` lines in the log and reassigning it would make those lines
 * ambiguous about who they referred to. Invite targets are always connected
 * sessions (agents), never the `u`-namespace (guest) that next_room's
 * relabeling preserves, so this only ever mints `a<n>`.
 */
export function nextAgentMemberId(room: Room): string {
  let maxA = 0;
  for (const ev of room.events) {
    if (ev.type !== "member") continue;
    const m = /^a(\d+)$/.exec(ev.id);
    if (m) {
      const n = Number(m[1]);
      if (n > maxA) maxA = n;
    }
  }
  return `a${maxA + 1}`;
}

/** ts of the last event, or null for an empty room. */
export function lastTs(room: Room): string | null {
  for (let i = room.events.length - 1; i >= 0; i--) {
    const ev = room.events[i]!;
    const ts = ev.type === "member" ? ev.joined_at : "ts" in ev ? ev.ts : null;
    if (ts) return ts;
  }
  return null;
}

/**
 * Assign `seq` (DR-0016 §2.2) to every event in line order, in-place on the
 * already-loaded event objects. Legacy (pre-DR-0016) rows carry no `seq` and
 * are backfilled 1-origin from the running counter; rows that already carry a
 * persisted `seq` (post-DR-0016 daemon writes) keep that value and advance the
 * counter to match. Disk is never rewritten — this is purely an in-memory
 * reconstruction so old logs behave as if they'd always had `seq`. Returns the
 * final counter value, i.e. the room's `lastSeq` high-water mark.
 */
function backfillSeq(events: StorageEvent[]): number {
  let seq = 0;
  for (const ev of events) {
    if (typeof ev.seq === "number" && Number.isFinite(ev.seq)) {
      seq = ev.seq;
    } else {
      seq += 1;
      ev.seq = seq;
    }
  }
  return seq;
}

function computeDerived(room: Room): void {
  let lastMid = 0;
  let earliestJoin = Number.POSITIVE_INFINITY;
  const sids = new Set<string>();
  let title: string | undefined;
  let archived = false;
  let kind: RoomKind = "normal";
  const next: string[] = [];
  const prev: string[] = [];
  room.lastSeq = backfillSeq(room.events);
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
      case "archive":
        archived = ev.archived;
        break;
      case "kind":
        kind = ev.kind;
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
  room.archived = archived;
  room.kind = kind;
  room.next = next;
  room.prev = prev;
  // Non-`"normal"` rooms never dedup:
  // - broadcast: kawaz needs multiple parallel broadcast rooms (dev / debug /
  //   ...) — a same-sid-set dedup key would fold every create_room{kind:"broadcast"}
  //   call into the very first one (DR-0013 §2.1, r12 mid=3).
  // - 1on1: pairing is (u1, target_sid); another create_room --kind 1on1 for
  //   the same sid must NOT fold into a different room's dedup entry, and
  //   webui's "reuse-if-exists" auto-create (DR-0014 §2.2) does its own lookup
  //   by kind === "1on1" instead of trusting the dedup index.
  // `dedupEligible: false` here matches next_room's prev-linked room treatment.
  room.dedupEligible = prev.length === 0 && kind === "normal";
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
    lastSeq: 0,
    createdAt: Date.now(),
    dedupEligible: true,
    dedupKey: "",
    archived: false,
    kind: "normal",
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
      log.warn(
        `room ${id}: torn tail recovered to ${path.basename(tornPath)} (${raw.length - keepLen} bytes)`,
      );
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

/**
 * Append one event to the room's file (durable log) and in-memory mirror.
 *
 * Design rationale: disk write happens first, in-memory mirror update second.
 * If `fs.writeSync` (or the lazy `fs.openSync`) throws (disk full / EIO), the
 * exception propagates before any in-memory field is touched, so `events` /
 * `lastMid` / `title` / `next` / `prev` never get ahead of what's durably on
 * disk. Reversing this order (memory first) would let a write failure leave
 * `lastMid` advanced past disk, risking duplicate mid assignment on the next
 * `msg` append while the daemon keeps running (server.ts's handleRequest
 * try/catch turns the thrown error into a sendErr response to the caller).
 *
 * `fs.writeSync` doesn't always throw on a failed write: POSIX write(2) may
 * return having written fewer bytes than requested (short write) without
 * signalling an error, e.g. when disk space runs out mid-call. Left
 * unchecked, that would silently leave a truncated/corrupt line on disk while
 * this function still advances `room.events`/`lastMid` as if the full event
 * was durably persisted — the exact in-memory-ahead-of-disk hazard this
 * function is designed to prevent. Comparing the returned byte count against
 * what was requested turns a short write into the same throw-before-mutating
 * path as any other write failure.
 *
 * `seq` (DR-0016) is the one field stamped BEFORE the write rather than after
 * — it has to be baked into the serialized line, not just the in-memory
 * mirror. It's stamped in-place onto the caller's `ev` object (not a copy) so
 * that call sites which pass this same object on to `deliver` afterward
 * automatically broadcast a seq-bearing event with zero changes at each call
 * site. `room.lastSeq` itself still only advances after a successful write,
 * preserving the disk-first invariant above: if the write throws, `ev.seq`
 * is left stamped with a value that was never durably assigned, but that's
 * harmless — the event was never pushed to `room.events` (never delivered),
 * and a retried `appendEvent` call recomputes `room.lastSeq + 1` fresh,
 * overwriting the stale stamp.
 */
export function appendEvent(room: Room, ev: StorageEvent): void {
  ev.seq = room.lastSeq + 1;
  const line = `${JSON.stringify(ev)}\n`;
  if (room.fd === null) room.fd = fs.openSync(room.file, "a");
  const expected = Buffer.byteLength(line);
  const written = fs.writeSync(room.fd, line);
  if (written !== expected) {
    throw new Error(
      `short write appending to room ${room.id}: wrote ${written} of ${expected} bytes`,
    );
  }

  room.events.push(ev);
  room.lastSeq = ev.seq;
  if (ev.type === "msg" && ev.mid > room.lastMid) room.lastMid = ev.mid;
  if (ev.type === "title") room.title = ev.title;
  if (ev.type === "archive") room.archived = ev.archived;
  if (ev.type === "kind") {
    room.kind = ev.kind;
    // Non-`"normal"` rooms (broadcast / 1on1) are dedup-exempt (see
    // computeDerived's identical comment) — createRoom already seeds
    // dedupEligible=false for these, but a later kind mutation must never
    // re-enable folding either.
    room.dedupEligible = false;
  }
  if (ev.type === "next") room.next.push(ev.room);
  if (ev.type === "prev") {
    room.prev.push(ev.room);
    room.dedupEligible = false;
  }
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
