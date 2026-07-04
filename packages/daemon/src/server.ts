// UDS server + wire protocol dispatch + delivery (DR-0003).
import * as fs from "node:fs";
import type { Socket } from "bun";
import {
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_JOIN_BACKLOG,
  ErrorCode,
  USER_UID,
  VERSION,
  resolvePaths,
  type Identity,
  type LeaveEvent,
  type MemberEvent,
  type MsgEvent,
  type NotifyFrom,
  type Paths,
  type Request,
  type SessionIdentity,
  type StorageEvent,
  type TitleEvent,
} from "@ccmsg/protocol";
import { Logger } from "./log.ts";
import { tryAcquireLock, type LockHandle } from "./flock.ts";
import {
  appendEvent,
  closeRoom,
  lastTs,
  memberUidBySid,
  parseMidSelector,
  presentMembers,
  readMsgs,
  scanRooms,
  type Room,
} from "./storage.ts";

interface Conn {
  socket: Socket<Conn>;
  decoder: TextDecoder;
  buffer: string;
  identity: Identity | null;
  subscribed: boolean;
}

interface SessionEntry {
  meta: { sid: string; repo: string; ws: string; cwd: string };
  conns: Set<Conn>;
}

interface Listener {
  stop(closeActiveConnections?: boolean): void;
}

interface Daemon {
  paths: Paths;
  version: string;
  startTime: number;
  rooms: Map<string, Room>;
  /** dedupKey -> room id (dedup-eligible rooms only, latest createdAt wins). */
  dedupIndex: Map<string, string>;
  connections: Set<Conn>;
  sessions: Map<string, SessionEntry>;
  subscribers: Set<Conn>;
  log: Logger;
  lock: LockHandle;
  server: Listener | null;
  dedupWindowMs: number;
  shuttingDown: boolean;
}

const nowIso = (): string => new Date().toISOString();

function send(conn: Conn, obj: unknown): void {
  try {
    conn.socket.write(`${JSON.stringify(obj)}\n`);
  } catch {
    // socket may be closing; delivery is best-effort
  }
}

function sendErr(conn: Conn, code: string, msg: string): void {
  send(conn, { ok: false, error: { code, msg } });
}

function writeDelivered(conn: Conn, roomId: string, ev: StorageEvent): void {
  send(conn, { ...ev, r: roomId });
}

// --- identity / registry ---------------------------------------------------

function registerSession(daemon: Daemon, conn: Conn, id: SessionIdentity): void {
  let entry = daemon.sessions.get(id.sid);
  if (!entry) {
    entry = { meta: { sid: id.sid, repo: id.repo, ws: id.ws, cwd: id.cwd }, conns: new Set() };
    daemon.sessions.set(id.sid, entry);
  } else {
    // latest hello wins for metadata
    entry.meta = { sid: id.sid, repo: id.repo, ws: id.ws, cwd: id.cwd };
  }
  entry.conns.add(conn);
}

function removeConn(daemon: Daemon, conn: Conn): void {
  daemon.connections.delete(conn);
  daemon.subscribers.delete(conn);
  const id = conn.identity;
  if (id && id.role === "session") {
    const entry = daemon.sessions.get(id.sid);
    if (entry) {
      entry.conns.delete(conn);
      if (entry.conns.size === 0) daemon.sessions.delete(id.sid);
    }
  }
}

/** uid the connection posts as in this room: 0 for user, member uid for a session, null if a session that isn't a member. */
function resolveFrom(conn: Conn, room: Room): number | null {
  const id = conn.identity;
  if (!id) return null;
  if (id.role === "user") return USER_UID;
  return memberUidBySid(room).get(id.sid) ?? null;
}

function subscriberSeesRoom(conn: Conn, room: Room): boolean {
  const id = conn.identity;
  if (!id) return false;
  if (id.role === "user") return true; // user (uid 0) sees every room (DR-0003 §5)
  return memberUidBySid(room).has(id.sid);
}

function normalizeTo(to: number | number[] | undefined): number[] | undefined {
  if (to === undefined) return undefined;
  const arr = Array.isArray(to) ? to : [to];
  const ints = arr.filter((n) => Number.isInteger(n));
  return ints.length > 0 ? ints : undefined;
}

// --- delivery --------------------------------------------------------------

interface Author {
  role: "user" | "session";
  sid?: string;
}

function authorOf(conn: Conn): Author {
  const id = conn.identity;
  if (id && id.role === "session") return { role: "session", sid: id.sid };
  return { role: "user" };
}

function isAuthorSub(sub: Conn, author: Author): boolean {
  const id = sub.identity;
  if (!id) return false;
  if (author.role === "user") return id.role === "user";
  return id.role === "session" && id.sid === author.sid;
}

/**
 * Live-deliver a single event to all subscribers that see the room.
 * echo suppression (DR-0003 §5) applies to `msg` only: the author's own post is
 * never pushed back to them. Membership/link/title events go to everyone incl. the actor.
 */
function deliver(daemon: Daemon, room: Room, ev: StorageEvent, author: Author): void {
  for (const sub of daemon.subscribers) {
    if (!subscriberSeesRoom(sub, room)) continue;
    if (ev.type === "msg" && isAuthorSub(sub, author)) continue;
    writeDelivered(sub, room.id, ev);
  }
}

/**
 * Initial/backlog delivery of a room to one subscriber.
 * - with sinceMid: positional delta — everything after the msg with that mid (BBS replay).
 * - without: present member state + title/link events + the last N=50 msgs (join snapshot).
 * suppressAuthorUid drops the author's own just-posted msg from their snapshot (echo rule).
 */
function sendBacklog(conn: Conn, room: Room, sinceMid?: number, suppressAuthorUid?: number): void {
  if (sinceMid !== undefined) {
    // resume just after the last msg the client has already seen. Anchoring on
    // "last msg with mid <= sinceMid" is correct at both ends: a caught-up client
    // (sinceMid >= lastMid) gets nothing, a client missing the start (sinceMid <
    // firstMid) gets everything. Non-msg events after that anchor are included.
    let start = 0;
    for (let i = 0; i < room.events.length; i++) {
      const ev = room.events[i]!;
      if (ev.type === "msg" && ev.mid <= sinceMid) start = i + 1;
    }
    for (let i = start; i < room.events.length; i++) {
      writeDelivered(conn, room.id, room.events[i]!);
    }
    return;
  }

  const presentUids = new Set(presentMembers(room).map((m) => m.uid));
  const msgEvents = room.events.filter((e): e is MsgEvent => e.type === "msg");
  const recent = new Set(msgEvents.slice(-DEFAULT_JOIN_BACKLOG));
  for (const ev of room.events) {
    if (ev.type === "leave") continue;
    if (ev.type === "member" && !presentUids.has(ev.uid)) continue;
    if (ev.type === "msg") {
      if (!recent.has(ev)) continue;
      if (suppressAuthorUid !== undefined && ev.from === suppressAuthorUid) continue;
    }
    writeDelivered(conn, room.id, ev);
  }
}

/** Deliver a brand-new room's snapshot to every subscriber that sees it. */
function deliverNewRoom(daemon: Daemon, room: Room, author: Author, authorUid: number | null): void {
  for (const sub of daemon.subscribers) {
    if (!subscriberSeesRoom(sub, room)) continue;
    const suppress = isAuthorSub(sub, author) && authorUid !== null ? authorUid : undefined;
    sendBacklog(sub, room, undefined, suppress);
  }
}

// --- room creation ---------------------------------------------------------

// Room ids are opaque, daemon-issued, unique strings — the `r-` shape here is a free
// implementation choice, NOT a wire contract. Clients (and the daemon's own lookup /
// filename mapping) treat ids as opaque, so this could be a bare counter or any other
// unique token without changing semantics. Never parse structure out of a room id.
function generateRoomId(daemon: Daemon): string {
  for (;;) {
    const id = `r-${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`;
    if (!daemon.rooms.has(id)) return id;
  }
}

function createRoom(daemon: Daemon, orderedSids: string[], dedupEligible: boolean): Room {
  const id = generateRoomId(daemon);
  const room: Room = {
    id,
    file: `${daemon.paths.roomsDir}/${id}.jsonl`,
    events: [],
    lastMid: 0,
    createdAt: Date.now(),
    dedupEligible,
    dedupKey: [...new Set(orderedSids)].sort().join(","),
    next: [],
    prev: [],
    fd: null,
    fsyncTimer: null,
  };
  daemon.rooms.set(id, room);
  return room;
}

function writeMembers(daemon: Daemon, room: Room, orderedSids: string[]): void {
  let uid = 1;
  for (const sid of orderedSids) {
    const meta = daemon.sessions.get(sid)?.meta;
    const ev: MemberEvent = {
      type: "member",
      uid: uid++,
      sid,
      repo: meta?.repo ?? "",
      ws: meta?.ws ?? "",
      cwd: meta?.cwd ?? "",
      joined_at: nowIso(),
    };
    appendEvent(room, ev);
  }
}

// --- request dispatch ------------------------------------------------------

const IDENTITY_OPS = new Set(["post", "create_room", "next_room", "subscribe", "notify", "leave"]);

function handleRequest(daemon: Daemon, conn: Conn, line: string): void {
  let req: Request;
  try {
    req = JSON.parse(line) as Request;
  } catch {
    sendErr(conn, ErrorCode.bad_request, "invalid JSON");
    return;
  }
  if (typeof req !== "object" || req === null || typeof (req as { op?: unknown }).op !== "string") {
    sendErr(conn, ErrorCode.bad_request, "missing op");
    return;
  }
  if (IDENTITY_OPS.has(req.op) && conn.identity === null) {
    sendErr(conn, ErrorCode.hello_required, `op '${req.op}' requires hello first`);
    return;
  }
  try {
    dispatch(daemon, conn, req);
  } catch (e) {
    daemon.log.error(`op '${req.op}' failed: ${String(e)}`);
    sendErr(conn, "internal", String(e));
  }
}

function dispatch(daemon: Daemon, conn: Conn, req: Request): void {
  switch (req.op) {
    case "hello": {
      if (req.role === "user") {
        conn.identity = { role: "user" };
      } else {
        if (!req.sid) {
          sendErr(conn, ErrorCode.invalid_args, "session hello requires sid");
          return;
        }
        const id: SessionIdentity = {
          role: "session",
          sid: req.sid,
          repo: req.repo ?? "",
          ws: req.ws ?? "",
          cwd: req.cwd ?? "",
        };
        conn.identity = id;
        registerSession(daemon, conn, id);
      }
      send(conn, { ok: true, version: daemon.version });
      return;
    }

    case "ping": {
      send(conn, {
        ok: true,
        pong: true,
        version: daemon.version,
        uptime: (Date.now() - daemon.startTime) / 1000,
        pid: process.pid,
        rooms: daemon.rooms.size,
        clients: daemon.connections.size,
      });
      return;
    }

    case "post": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const from = resolveFrom(conn, room);
      if (from === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const to = normalizeTo(req.to);
      const mid = room.lastMid + 1;
      const ev: MsgEvent = { type: "msg", mid, from, ...(to ? { to } : {}), ts: nowIso(), msg: req.msg };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, mid });
      return;
    }

    case "create_room": {
      const members = Array.isArray(req.members) ? req.members : [];
      const ordered: string[] = [];
      const id = conn.identity!;
      if (id.role === "session") ordered.push(id.sid);
      for (const sid of members) if (typeof sid === "string" && !ordered.includes(sid)) ordered.push(sid);
      if (ordered.length === 0) {
        sendErr(conn, ErrorCode.invalid_args, "create_room needs at least one member");
        return;
      }
      const key = [...new Set(ordered)].sort().join(",");
      const existingId = daemon.dedupIndex.get(key);
      const existing = existingId ? daemon.rooms.get(existingId) : undefined;
      if (existing && existing.dedupEligible && Date.now() - existing.createdAt < daemon.dedupWindowMs) {
        // dedup: fold the late create's initial msg into the existing room (DR-0003 §4)
        let mid: number | undefined;
        if (req.msg) {
          const from = resolveFrom(conn, existing);
          if (from !== null) {
            mid = existing.lastMid + 1;
            const ev: MsgEvent = { type: "msg", mid, from, ts: nowIso(), msg: req.msg };
            appendEvent(existing, ev);
            deliver(daemon, existing, ev, authorOf(conn));
          }
        }
        send(conn, { ok: true, room: existing.id, reused: true, ...(mid !== undefined ? { mid } : {}) });
        return;
      }

      const room = createRoom(daemon, ordered, true);
      writeMembers(daemon, room, ordered);
      if (req.title) appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
      let mid: number | undefined;
      let authorUid: number | null = null;
      if (req.msg) {
        authorUid = resolveFrom(conn, room);
        if (authorUid !== null) {
          mid = room.lastMid + 1;
          appendEvent(room, { type: "msg", mid, from: authorUid, ts: nowIso(), msg: req.msg });
        }
      }
      daemon.dedupIndex.set(room.dedupKey, room.id);
      deliverNewRoom(daemon, room, authorOf(conn), authorUid);
      send(conn, { ok: true, room: room.id, reused: false, ...(mid !== undefined ? { mid } : {}) });
      return;
    }

    case "next_room": {
      const old = daemon.rooms.get(req.room);
      if (!old) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      if (resolveFrom(conn, old) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const inherited = presentMembers(old);
      const room = createRoom(daemon, inherited.map((m) => m.sid), false);
      let uid = 1;
      for (const m of inherited) {
        appendEvent(room, {
          type: "member",
          uid: uid++,
          sid: m.sid,
          repo: m.repo,
          ws: m.ws,
          cwd: m.cwd,
          joined_at: nowIso(),
        } satisfies MemberEvent);
      }
      appendEvent(room, { type: "prev", room: old.id, ts: nowIso() });
      const nextEv: StorageEvent = { type: "next", room: room.id, ts: nowIso() };
      appendEvent(old, nextEv);
      if (req.title) appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
      let mid: number | undefined;
      let authorUid: number | null = null;
      if (req.msg) {
        authorUid = resolveFrom(conn, room);
        if (authorUid !== null) {
          mid = room.lastMid + 1;
          appendEvent(room, { type: "msg", mid, from: authorUid, ts: nowIso(), msg: req.msg });
        }
      }
      // old room subscribers see the `next` link live; new room subscribers get its snapshot
      deliver(daemon, old, nextEv, authorOf(conn));
      deliverNewRoom(daemon, room, authorOf(conn), authorUid);
      send(conn, { ok: true, room: room.id, ...(mid !== undefined ? { mid } : {}) });
      return;
    }

    case "subscribe": {
      conn.subscribed = true;
      daemon.subscribers.add(conn);
      send(conn, { ok: true, subscribed: true });
      // handler runs to completion synchronously, so no live event interleaves the snapshot
      for (const room of daemon.rooms.values()) {
        if (!subscriberSeesRoom(conn, room)) continue;
        const sinceMid = req.since?.[room.id];
        sendBacklog(conn, room, sinceMid);
      }
      return;
    }

    case "read": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const msgs = readMsgs(room, parseMidSelector(req.mids));
      send(conn, { ok: true, room: room.id, msgs });
      return;
    }

    case "rooms": {
      const rooms = [...daemon.rooms.values()].map((r) => ({
        id: r.id,
        ...(r.title ? { title: r.title } : {}),
        members: presentMembers(r),
        last_mid: r.lastMid,
        last_ts: lastTs(r),
      }));
      send(conn, { ok: true, rooms });
      return;
    }

    case "peers": {
      const peers = [...daemon.sessions.values()].filter((s) => s.conns.size > 0).map((s) => s.meta);
      send(conn, { ok: true, peers });
      return;
    }

    case "notify": {
      const id = conn.identity!;
      const targetSid = req.sid ?? (id.role === "session" ? id.sid : undefined);
      const targetUser = req.sid === undefined && id.role === "user";
      let delivered = 0;
      // Stamp the sender from the connection identity (never the client's self-claim),
      // so the receiver can distinguish self-notify from peer-notify and refuse to
      // auto-execute a peer's command-shaped text (DR-0003 §7).
      const from: NotifyFrom = id.role === "user" ? { role: "user" } : { role: "session", sid: id.sid };
      const ephem = { ev: "notify", text: req.text, from };
      for (const sub of daemon.subscribers) {
        const sid = sub.identity;
        if (!sid) continue;
        if (targetUser && sid.role === "user") {
          send(sub, ephem);
          delivered++;
        } else if (targetSid && sid.role === "session" && sid.sid === targetSid) {
          send(sub, ephem);
          delivered++;
        }
      }
      send(conn, { ok: true, delivered });
      return;
    }

    case "leave": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const uid = resolveFrom(conn, room);
      if (uid === null || uid === USER_UID) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const ev: LeaveEvent = { type: "leave", uid, ts: nowIso() };
      // capture recipients before membership shrinks so the leaver gets confirmation too
      const recipients = [...daemon.subscribers].filter((s) => subscriberSeesRoom(s, room));
      appendEvent(room, ev);
      for (const r of recipients) writeDelivered(r, room.id, ev);
      send(conn, { ok: true, room: room.id });
      return;
    }

    case "shutdown": {
      send(conn, { ok: true, stopping: true });
      gracefulShutdown(daemon, req.reason);
      return;
    }

    default: {
      sendErr(conn, ErrorCode.unknown_op, `unknown op: ${(req as { op: string }).op}`);
      return;
    }
  }
}

// --- lifecycle -------------------------------------------------------------

function buildDedupIndex(rooms: Map<string, Room>): Map<string, string> {
  const index = new Map<string, string>();
  for (const room of rooms.values()) {
    if (!room.dedupEligible || room.dedupKey === "") continue;
    const cur = index.get(room.dedupKey);
    if (!cur) {
      index.set(room.dedupKey, room.id);
    } else {
      const curRoom = rooms.get(cur)!;
      if (room.createdAt > curRoom.createdAt) index.set(room.dedupKey, room.id);
    }
  }
  return index;
}

function gracefulShutdown(daemon: Daemon, reason?: string): void {
  if (daemon.shuttingDown) return;
  daemon.shuttingDown = true;
  daemon.log.info(`graceful shutdown (${reason ?? ""})`);
  try {
    daemon.server?.stop();
  } catch {
    // ignore
  }
  const ev = { ev: "restarting", ...(reason ? { reason } : {}) };
  for (const conn of daemon.connections) {
    try {
      conn.socket.write(`${JSON.stringify(ev)}\n`);
      conn.socket.flush();
    } catch {
      // ignore
    }
  }
  for (const room of daemon.rooms.values()) closeRoom(room);
  try {
    fs.unlinkSync(daemon.paths.sock);
  } catch {
    // ignore
  }
  try {
    fs.unlinkSync(daemon.paths.pid);
  } catch {
    // ignore
  }
  daemon.lock.release();
  process.exit(0);
}

export interface StartOptions {
  foreground?: boolean;
}

export function startDaemon(opts: StartOptions = {}): void {
  const paths = resolvePaths();
  fs.mkdirSync(paths.stateDir, { recursive: true });
  fs.mkdirSync(paths.roomsDir, { recursive: true });
  const log = new Logger(paths.log, !!opts.foreground);

  const lock = tryAcquireLock(paths.lock);
  if (!lock) {
    log.info("another daemon holds the lock; exiting");
    if (opts.foreground) process.stderr.write("ccmsg: daemon already running\n");
    process.exit(0);
  }

  // stale socket left by a crashed predecessor: the lock holder is authoritative
  try {
    if (fs.existsSync(paths.sock)) fs.unlinkSync(paths.sock);
  } catch {
    // ignore
  }

  const rooms = scanRooms(paths.roomsDir, log);
  const daemon: Daemon = {
    paths,
    version: VERSION,
    startTime: Date.now(),
    rooms,
    dedupIndex: buildDedupIndex(rooms),
    connections: new Set(),
    sessions: new Map(),
    subscribers: new Set(),
    log,
    lock,
    server: null,
    dedupWindowMs: resolveDedupWindow(),
    shuttingDown: false,
  };

  const server = Bun.listen<Conn>({
    unix: paths.sock,
    socket: {
      open(socket) {
        const conn: Conn = {
          socket,
          decoder: new TextDecoder(),
          buffer: "",
          identity: null,
          subscribed: false,
        };
        socket.data = conn;
        daemon.connections.add(conn);
      },
      data(socket, chunk) {
        const conn = socket.data;
        conn.buffer += conn.decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = conn.buffer.indexOf("\n")) >= 0) {
          const rawLine = conn.buffer.slice(0, idx);
          conn.buffer = conn.buffer.slice(idx + 1);
          if (rawLine.trim() !== "") handleRequest(daemon, conn, rawLine);
        }
      },
      close(socket) {
        const conn = socket.data;
        if (conn) removeConn(daemon, conn);
      },
      error(_socket, err) {
        daemon.log.error(`socket error: ${String(err)}`);
      },
    },
  });
  daemon.server = server;

  fs.chmodSync(paths.sock, 0o600);
  fs.writeFileSync(paths.pid, `${process.pid}\n`);
  log.info(`listening on ${paths.sock} (v${VERSION}, ${rooms.size} rooms, dedup ${daemon.dedupWindowMs}ms)`);

  process.on("SIGTERM", () => gracefulShutdown(daemon, "signal"));
  process.on("SIGINT", () => gracefulShutdown(daemon, "signal"));
}

function resolveDedupWindow(): number {
  const raw = process.env.CCMSG_DEDUP_WINDOW_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n >= 0) return n;
  }
  return DEFAULT_DEDUP_WINDOW_MS;
}
