// UDS + HTTP/WS server + wire protocol dispatch + delivery (DR-0003, DR-0004).
import * as fs from "node:fs";
import {
  ADMIN_ID,
  DEFAULT_DEDUP_WINDOW_MS,
  DEFAULT_HTTP_ALLOW,
  DEFAULT_HTTP_BIND,
  DEFAULT_JOIN_BACKLOG,
  ErrorCode,
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
import { fsList, fsRead, validateRepoRoot } from "./fs-access.ts";
import {
  createTranscriptTailStore,
  stopAllTailWatches,
  transcriptRead,
  transcriptSubscribe,
  transcriptUnsubscribe,
  transcriptUnsubscribeAll,
  validateTranscriptPath,
  type TranscriptTailStore,
} from "./transcript.ts";
import {
  createAgentsPoller,
  maybeStartAgentsPoller,
  maybeStopAgentsPoller,
  stopAgentsPoller,
  type AgentsPoller,
} from "./agents.ts";
import { tryAcquireLock, type LockHandle } from "./flock.ts";
import { startHttpListener, type HttpFallback, type HttpListener } from "./http.ts";
import { parseAllowList, type Cidr } from "./ip-allowlist.ts";
import { createOriginsFile } from "./origins-file.ts";
import { fetchTailscaleServeOrigins } from "./tailscale-origin.ts";
import {
  appendEvent,
  closeRoom,
  lastTs,
  memberIdBySid,
  nextAgentMemberId,
  parseMidSelector,
  presentMembers,
  readMsgs,
  scanRooms,
  type Room,
} from "./storage.ts";

/**
 * A connection abstracted over its transport. UDS and HTTP/WS conns both boil down
 * to "can accept a line of wire protocol"; dispatch/delivery/subscribe never touch
 * the transport directly (DR-0004 §2 seam).
 */
export interface Conn {
  write(line: string): void;
  identity: Identity | null;
  subscribed: boolean;
}

interface SessionEntry {
  meta: {
    sid: string;
    repo: string;
    ws: string;
    cwd: string;
    /** present iff hello announced a transcript_path that validated (DR-0009). */
    transcript_path?: string;
    /** present iff hello announced a repo_root that validated (DR-0008 addendum). */
    repo_root?: string;
    /** present iff hello announced a non-empty branch/bookmark name. */
    branch?: string;
  };
  conns: Set<Conn>;
  /** ISO time this entry was first created in this daemon process; a later
   * hello for the same sid reuses the existing entry and never touches this
   * (DR: webui session-list ordering wants a stable "connected since", not a
   * value that jumps on every reconnect). Only a full sid removal (conns
   * drops to zero, see removeConn) followed by a fresh hello resets it. */
  connectedAt: string;
  /** ISO time of this sid's most recent request on any of its connections;
   * unset until the first request after hello. Updated from the single
   * choke point in handleRequest so subscribe-stream pushes (which aren't
   * requests) correctly leave a session looking idle. */
  lastActivityAt?: string;
}

interface Listener {
  stop(closeActiveConnections?: boolean): void;
}

export interface Daemon {
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
  httpListeners: HttpListener[];
  /** raw CCMSG_HTTP_ALLOW entries currently in effect, for status/ping display. */
  httpAllow: string[];
  dedupWindowMs: number;
  shuttingDown: boolean;
  /** `claude agents --json` merged poll state (DR-0009-agents addendum). */
  agentsPoller: AgentsPoller;
  /** live-tail Watch state per sid (DR-0009 live-tail addendum). */
  transcriptTail: TranscriptTailStore;
}

const nowIso = (): string => new Date().toISOString();

export function send(conn: Conn, obj: unknown): void {
  try {
    conn.write(`${JSON.stringify(obj)}\n`);
  } catch {
    // transport may be closing; delivery is best-effort
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
  // latest hello wins for repo/ws/cwd metadata. transcript_path is the one
  // exception (DR-0009 addendum): unlike repo/ws/cwd, it only ever arrives via
  // the hook-supplied CCMSG_TRANSCRIPT_PATH env prefix (session-start.ts /
  // user-prompt-submit.ts), and a re-subscribe after the stream died is a
  // common, legitimate path that omits it (e.g. a UserPromptSubmit-suggested
  // `CCMSG_SID=<sid> ccmsg subscribe` typed without the transcript prefix). A
  // hello that omits transcript_path preserves whatever was already adopted
  // instead of clearing it — otherwise every such re-subscribe would silently
  // kill the webui's Timeline view for a session that never stopped having a
  // transcript.
  //
  // repo_root (DR-0008 addendum) follows the repo/ws/cwd rule instead
  // (latest-hello-wins, no preserve-on-omit): unlike transcript_path's
  // historical env-prefix-only sourcing, repo_root rides in the very same
  // per-hello session-state-file payload the CLI's resolveIdentity already
  // reads fresh for repo/ws on every hello (see hooks/session-start.ts's
  // SessionFileData) — so it's just as reliably present on every re-hello.
  // If a later hello genuinely omits/rejects it (e.g. cwd moved to a plain
  // checkout with no workspace layer), that reflects the session's *current*
  // state; silently keeping a stale, wider containment root across such a
  // change would be a fs-access scoping regression, not a UX nicety worth
  // preserving. branch rides the same per-hello payload, so it follows the
  // same latest-hello-wins, no-preserve-on-omit rule.
  const transcriptPath = id.transcript_path ?? entry?.meta.transcript_path;
  const meta = {
    sid: id.sid,
    repo: id.repo,
    ws: id.ws,
    cwd: id.cwd,
    ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
    ...(id.repo_root ? { repo_root: id.repo_root } : {}),
    ...(id.branch ? { branch: id.branch } : {}),
  };
  if (!entry) {
    entry = { meta, conns: new Set(), connectedAt: nowIso() };
    daemon.sessions.set(id.sid, entry);
  } else {
    entry.meta = meta;
  }
  entry.conns.add(conn);
}

export function removeConn(daemon: Daemon, conn: Conn): void {
  daemon.connections.delete(conn);
  daemon.subscribers.delete(conn);
  maybeStopAgentsPoller(daemon.agentsPoller, daemon.subscribers);
  transcriptUnsubscribeAll(daemon.transcriptTail, conn);
  const id = conn.identity;
  if (id && id.role === "session") {
    const entry = daemon.sessions.get(id.sid);
    if (entry) {
      entry.conns.delete(conn);
      if (entry.conns.size === 0) daemon.sessions.delete(id.sid);
    }
  }
}

/** id the connection posts as in this room: "u1" for the admin user, member id for a session, null if a session that isn't a member. */
function resolveFrom(conn: Conn, room: Room): string | null {
  const id = conn.identity;
  if (!id) return null;
  if (id.role === "user") return ADMIN_ID;
  return memberIdBySid(room).get(id.sid) ?? null;
}

function subscriberSeesRoom(conn: Conn, room: Room): boolean {
  const id = conn.identity;
  if (!id) return false;
  if (id.role === "user") return true; // admin (u1) sees every room (DR-0003 §5)
  return memberIdBySid(room).has(id.sid);
}

/**
 * DR-0011 §1: `to`-delivery filter for a single msg event, applied to both live
 * `deliver` and since-replay/backlog. A `to`-less msg is visible to anyone who
 * already passed `subscriberSeesRoom` (unchanged, full-room behavior). A
 * `to`-bearing msg additionally requires the subscriber to be: the admin User
 * (u1, exempt — the webui is an observation surface, no agent-style context
 * cost), the msg's own sender (resolved to their member id), or a member id
 * listed in `to`. This does NOT gate storage/`read`/`rooms` — those stay
 * unfiltered so a skipped mid is a deliberate pull signal, not a hidden one.
 */
function msgVisibleTo(sub: Conn, room: Room, ev: MsgEvent): boolean {
  if (!ev.to) return true;
  const id = sub.identity;
  if (!id) return false;
  if (id.role === "user") return true; // admin exempt
  const memberId = memberIdBySid(room).get(id.sid);
  if (memberId === undefined) return false;
  if (memberId === ev.from) return true; // sender always counts as a recipient of their own msg
  return ev.to.includes(memberId);
}

function normalizeTo(to: string | string[] | undefined): string[] | undefined {
  if (to === undefined) return undefined;
  const arr = Array.isArray(to) ? to : [to];
  const ids = arr.filter((s): s is string => typeof s === "string" && s.length > 0);
  return ids.length > 0 ? ids : undefined;
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
 * never pushed back to them. Membership/link/title events go to everyone incl. the actor
 * (DR-0011 §1: the `to`-delivery filter below is msg-only too, same reasoning).
 */
function deliver(daemon: Daemon, room: Room, ev: StorageEvent, author: Author): void {
  for (const sub of daemon.subscribers) {
    if (!subscriberSeesRoom(sub, room)) continue;
    if (ev.type === "msg") {
      if (isAuthorSub(sub, author)) continue;
      if (!msgVisibleTo(sub, room, ev)) continue;
    }
    writeDelivered(sub, room.id, ev);
  }
}

/**
 * Initial/backlog delivery of a room to one subscriber.
 * - with sinceMid: positional delta — everything after the msg with that mid (BBS replay).
 * - without: present member state + title/link events + the last N=50 msgs (join snapshot).
 * suppressAuthorId drops the author's own just-posted msg from their snapshot (echo rule).
 * Both paths apply the same `to`-delivery filter as live `deliver` (DR-0011 §1-2): an
 * offline member reconnecting via since-replay must not see a `to` msg that excluded
 * them any more than a live subscriber would.
 */
function sendBacklog(conn: Conn, room: Room, sinceMid?: number, suppressAuthorId?: string): void {
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
      const ev = room.events[i]!;
      if (ev.type === "msg" && !msgVisibleTo(conn, room, ev)) continue;
      writeDelivered(conn, room.id, ev);
    }
    return;
  }

  const presentIds = new Set(presentMembers(room).map((m) => m.id));
  const msgEvents = room.events.filter((e): e is MsgEvent => e.type === "msg");
  const recent = new Set(msgEvents.slice(-DEFAULT_JOIN_BACKLOG));
  for (const ev of room.events) {
    if (ev.type === "leave") continue;
    if (ev.type === "member" && !presentIds.has(ev.id)) continue;
    if (ev.type === "msg") {
      if (!recent.has(ev)) continue;
      if (suppressAuthorId !== undefined && ev.from === suppressAuthorId) continue;
      if (!msgVisibleTo(conn, room, ev)) continue;
    }
    writeDelivered(conn, room.id, ev);
  }
}

/** Deliver a brand-new room's snapshot to every subscriber that sees it. */
function deliverNewRoom(daemon: Daemon, room: Room, author: Author, authorId: string | null): void {
  for (const sub of daemon.subscribers) {
    if (!subscriberSeesRoom(sub, room)) continue;
    const suppress = isAuthorSub(sub, author) && authorId !== null ? authorId : undefined;
    sendBacklog(sub, room, undefined, suppress);
  }
}

// --- room creation ---------------------------------------------------------

// Room ids are opaque, daemon-issued, unique strings — the `rN` shape here is a free
// generation choice (DR-0006 §3), NOT a wire contract. Clients (and the daemon's own
// lookup / filename mapping) treat ids as opaque. Never parse structure out of a room
// id. The next number is derived from the highest `rN` already on disk/in-memory, so
// numbering survives a daemon restart without colliding with existing rooms.
//
// The webui's locator (packages/webui/src/client/locator.ts) splits hash-fragment
// routing between room and session views on the leading literal "r" vs "s" — that
// disambiguation relies on room ids always starting with "r". If this id format ever
// changes, check that invariant test too.
function generateRoomId(daemon: Daemon): string {
  let n = 1;
  for (const id of daemon.rooms.keys()) {
    const m = /^r(\d+)$/.exec(id);
    if (m) {
      const v = Number(m[1]);
      if (v >= n) n = v + 1;
    }
  }
  let id = `r${n}`;
  while (daemon.rooms.has(id)) id = `r${++n}`;
  return id;
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
  let seq = 1;
  for (const sid of orderedSids) {
    const meta = daemon.sessions.get(sid)?.meta;
    const ev: MemberEvent = {
      type: "member",
      id: `a${seq++}`,
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

// fs_list/fs_read/transcript_read require hello too (DR-0008 / DR-0009): the
// containment/lookup check itself doesn't depend on the *caller's* identity —
// it only cares about the target sid's registered state. Requiring hello here
// is defense in depth: it keeps every op that touches session state on one
// uniform "must identify first" rule rather than special-casing these as the
// sole unauthenticated readers of another session's filesystem/transcript.
const IDENTITY_OPS = new Set([
  "post",
  "create_room",
  "next_room",
  "set_title",
  "subscribe",
  "notify",
  "leave",
  "invite",
  "fs_list",
  "fs_read",
  "transcript_read",
  "agents",
  "transcript_subscribe",
  "transcript_unsubscribe",
]);

/** set_title clamp: keep room titles reasonably short in room lists / tab titles. */
const SET_TITLE_MAX_LEN = 200;

export function handleRequest(daemon: Daemon, conn: Conn, line: string): void {
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
  // single choke point for "this sid did something" (checked post-dispatch so
  // a session's very first request, hello itself, also counts — conn.identity
  // is null until dispatch's "hello" case sets it).
  const id = conn.identity;
  if (id && id.role === "session") {
    const entry = daemon.sessions.get(id.sid);
    if (entry) entry.lastActivityAt = nowIso();
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
        const transcriptPath = validateTranscriptPath(req.sid, req.transcript_path);
        const cwd = req.cwd ?? "";
        const repoRoot = validateRepoRoot(cwd, req.repo_root);
        const id: SessionIdentity = {
          role: "session",
          sid: req.sid,
          repo: req.repo ?? "",
          ws: req.ws ?? "",
          cwd,
          ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
          ...(repoRoot ? { repo_root: repoRoot } : {}),
          ...(req.branch ? { branch: req.branch } : {}),
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
        // provenance (DR-0009-agents addendum): which bun executable and entry
        // script this running daemon actually is, so version skew across faces
        // (e.g. ~/.claude-personal vs a work overlay) is observable.
        exe: process.execPath,
        script: Bun.main,
        http: daemon.httpListeners.map((l) => l.address),
        httpAllow: daemon.httpAllow,
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
      if (to) {
        // `to` is a delivery filter now (DR-0011 §1): an unresolvable id silently
        // drops the msg into a black hole (delivered to nobody but the sender/u1),
        // with no error and no observable signal to the poster. Reject typos/stale
        // ids up front instead — present member ids (memberIdBySid) plus the
        // always-exempt admin (ADMIN_ID) are the only valid delivery targets.
        const known = new Set(memberIdBySid(room).values());
        known.add(ADMIN_ID);
        const unknown = to.filter((t) => !known.has(t));
        if (unknown.length > 0) {
          sendErr(conn, ErrorCode.invalid_args, `to: unknown member id(s): ${unknown.join(", ")}`);
          return;
        }
      }
      const mid = room.lastMid + 1;
      const ev: MsgEvent = {
        type: "msg",
        mid,
        from,
        ...(to ? { to } : {}),
        ts: nowIso(),
        msg: req.msg,
      };
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
      for (const sid of members)
        if (typeof sid === "string" && !ordered.includes(sid)) ordered.push(sid);
      if (ordered.length === 0) {
        sendErr(conn, ErrorCode.invalid_args, "create_room needs at least one member");
        return;
      }
      const key = [...new Set(ordered)].sort().join(",");
      const existingId = daemon.dedupIndex.get(key);
      const existing = existingId ? daemon.rooms.get(existingId) : undefined;
      if (
        existing &&
        existing.dedupEligible &&
        Date.now() - existing.createdAt < daemon.dedupWindowMs
      ) {
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
        send(conn, {
          ok: true,
          room: existing.id,
          reused: true,
          ...(mid !== undefined ? { mid } : {}),
        });
        return;
      }

      const room = createRoom(daemon, ordered, true);
      writeMembers(daemon, room, ordered);
      if (req.title)
        appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
      let mid: number | undefined;
      let authorId: string | null = null;
      if (req.msg) {
        authorId = resolveFrom(conn, room);
        if (authorId !== null) {
          mid = room.lastMid + 1;
          appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
        }
      }
      daemon.dedupIndex.set(room.dedupKey, room.id);
      deliverNewRoom(daemon, room, authorOf(conn), authorId);
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
      const room = createRoom(
        daemon,
        inherited.map((m) => m.sid),
        false,
      );
      // Renumber per namespace, preserving each member's u/a namespace and relative
      // join order. Guests (u2+) stay guests; agents (a-namespace) stay agents.
      let aSeq = 1;
      let uSeq = 2; // u1 is the implicit admin, never present in `inherited`
      for (const m of inherited) {
        const isGuest = m.id.startsWith("u");
        appendEvent(room, {
          type: "member",
          id: isGuest ? `u${uSeq++}` : `a${aSeq++}`,
          sid: m.sid,
          repo: m.repo,
          ws: m.ws,
          cwd: m.cwd,
          joined_at: nowIso(),
          ...(isGuest ? { role: "guest" as const } : {}),
        } satisfies MemberEvent);
      }
      appendEvent(room, { type: "prev", room: old.id, ts: nowIso() });
      const nextEv: StorageEvent = { type: "next", room: room.id, ts: nowIso() };
      appendEvent(old, nextEv);
      if (req.title)
        appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
      let mid: number | undefined;
      let authorId: string | null = null;
      if (req.msg) {
        authorId = resolveFrom(conn, room);
        if (authorId !== null) {
          mid = room.lastMid + 1;
          appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
        }
      }
      // old room subscribers see the `next` link live; new room subscribers get its snapshot
      deliver(daemon, old, nextEv, authorOf(conn));
      deliverNewRoom(daemon, room, authorOf(conn), authorId);
      send(conn, { ok: true, room: room.id, ...(mid !== undefined ? { mid } : {}) });
      return;
    }

    case "set_title": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      // same authorization as post: admin User (implicit member of every room) or a
      // resolvable member session. Non-member sessions are refused.
      if (resolveFrom(conn, room) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const title = typeof req.title === "string" ? req.title.trim() : "";
      if (title === "") {
        sendErr(conn, ErrorCode.invalid_args, "set_title requires a non-empty title");
        return;
      }
      if (title.length > SET_TITLE_MAX_LEN) {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `title must be ${SET_TITLE_MAX_LEN} characters or fewer`,
        );
        return;
      }
      const ev: TitleEvent = { type: "title", title, ts: nowIso() };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, title });
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
      // agents polling (DR-0009-agents addendum) only ever runs while a user-role
      // subscriber is connected — a session subscribing never starts it.
      if (conn.identity?.role === "user") {
        maybeStartAgentsPoller(
          daemon.agentsPoller,
          daemon.subscribers,
          daemon.log,
          (agents, polledAt) => {
            for (const sub of daemon.subscribers) {
              if (sub.identity?.role === "user") {
                send(sub, { ev: "agents", agents, polled_at: polledAt });
              }
            }
          },
        );
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
      const peers = [...daemon.sessions.values()]
        .filter((s) => s.conns.size > 0)
        .map((s) => ({
          ...s.meta,
          connected_at: s.connectedAt,
          ...(s.lastActivityAt ? { last_activity_at: s.lastActivityAt } : {}),
        }));
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
      const from: NotifyFrom =
        id.role === "user" ? { role: "user" } : { role: "session", sid: id.sid };
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

    case "fs_list": {
      const result = fsList(daemon.sessions, req.sid, req.path);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_read": {
      const result = fsRead(daemon.sessions, req.sid, req.path);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "transcript_read": {
      const result = transcriptRead(daemon.sessions, req.sid, req.before, req.max_bytes);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    // user role only (webui-only op): the merged `claude agents --json` poll
    // result is not something a session (AI) needs to see.
    case "agents": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'agents' requires user role");
        return;
      }
      send(conn, {
        ok: true,
        agents: daemon.agentsPoller.cache.agents,
        polled_at: daemon.agentsPoller.cache.polledAt,
      });
      return;
    }

    // user role only, same rationale as "agents": live-tailing a transcript is a
    // webui viewer feature, not something a session needs from the wire protocol.
    case "transcript_subscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'transcript_subscribe' requires user role");
        return;
      }
      const result = transcriptSubscribe(
        daemon.transcriptTail,
        daemon.sessions,
        req.sid,
        conn,
        daemon.log,
      );
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "transcript_unsubscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'transcript_unsubscribe' requires user role");
        return;
      }
      const result = transcriptUnsubscribe(daemon.transcriptTail, req.sid, conn);
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "leave": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const memberId = resolveFrom(conn, room);
      if (memberId === null || memberId === ADMIN_ID) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const ev: LeaveEvent = { type: "leave", id: memberId, ts: nowIso() };
      // capture recipients before membership shrinks so the leaver gets confirmation too
      const recipients = [...daemon.subscribers].filter((s) => subscriberSeesRoom(s, room));
      appendEvent(room, ev);
      for (const r of recipients) writeDelivered(r, room.id, ev);
      send(conn, { ok: true, room: room.id });
      return;
    }

    case "invite": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      // same authorization as set_title: admin User or a resolvable member session.
      if (resolveFrom(conn, room) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      const targetSid = typeof req.sid === "string" ? req.sid : "";
      if (targetSid === "") {
        sendErr(conn, ErrorCode.invalid_args, "invite requires sid");
        return;
      }
      // the invite target must be a currently connected session — same live registry
      // create_room's `members` reads from, not an arbitrary historical sid.
      const targetEntry = daemon.sessions.get(targetSid);
      if (!targetEntry) {
        sendErr(conn, ErrorCode.session_not_found, `no connected session: ${targetSid}`);
        return;
      }
      const existingId = memberIdBySid(room).get(targetSid);
      if (existingId !== undefined) {
        send(conn, { ok: true, room: room.id, id: existingId, already: true });
        return;
      }
      const id = nextAgentMemberId(room);
      const ev: MemberEvent = {
        type: "member",
        id,
        sid: targetSid,
        repo: targetEntry.meta.repo,
        ws: targetEntry.meta.ws,
        cwd: targetEntry.meta.cwd,
        joined_at: nowIso(),
      };
      appendEvent(room, ev);
      // invite changes membership outside the create_room([...]) sid set that seeded
      // room.dedupKey, so a same-sid create_room within the dedup window (DR-0003 §4)
      // must no longer fold into this room — same treatment as next_room's `prev` link
      // (storage.ts appendEvent), applied here since a plain "member" event can't be
      // distinguished from an initial create_room member by type alone.
      room.dedupEligible = false;
      // the invited target, if already subscribed, gets a full room snapshot (title,
      // member list, recent history) just like a brand-new create_room/next_room member
      // (deliverNewRoom) — this is genuinely new context to them, not an incremental
      // update. Existing members only need the single MemberEvent line.
      const targetSub = [...daemon.subscribers].find(
        (s) => s.identity?.role === "session" && s.identity.sid === targetSid,
      );
      if (targetSub) sendBacklog(targetSub, room);
      for (const sub of daemon.subscribers) {
        if (sub === targetSub) continue; // already covered by their snapshot above
        if (!subscriberSeesRoom(sub, room)) continue;
        writeDelivered(sub, room.id, ev);
      }
      send(conn, { ok: true, room: room.id, id, already: false });
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
  stopAgentsPoller(daemon.agentsPoller);
  stopAllTailWatches(daemon.transcriptTail);
  try {
    daemon.server?.stop();
  } catch {
    // ignore
  }
  // Notify every connection — UDS and WS alike, `send` doesn't care which — before
  // tearing down the HTTP listeners so the WS side actually gets the frame out.
  const ev = { ev: "restarting", ...(reason ? { reason } : {}) };
  for (const conn of daemon.connections) send(conn, ev);
  for (const listener of daemon.httpListeners) {
    try {
      listener.stop();
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
  /** Non-/ws HTTP requests are delegated here (e.g. webui static/app routes); 404 if absent. */
  fallback?: HttpFallback;
}

/** `CCMSG_HTTP_BIND`: comma-separated `host:port` list, `off` to disable, default DEFAULT_HTTP_BIND (DR-0004 §3). */
function resolveHttpBinds(): string[] {
  const raw = process.env.CCMSG_HTTP_BIND;
  if (raw === "off") return [];
  const spec = raw && raw.trim() !== "" ? raw : DEFAULT_HTTP_BIND;
  return spec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
}

/** `CCMSG_HTTP_ALLOW`: comma-separated CIDR/IP source allowlist, default
 *  DEFAULT_HTTP_ALLOW (DR-0004 §3 addendum). Empty/whitespace-only falls back to the
 *  default rather than "allow nothing" — an explicit empty allowlist isn't a supported
 *  way to lock the transport down; use CCMSG_HTTP_BIND=off for that. */
function resolveHttpAllowSpec(): string {
  const raw = process.env.CCMSG_HTTP_ALLOW;
  return raw && raw.trim() !== "" ? raw : DEFAULT_HTTP_ALLOW;
}

/** `CCMSG_HTTP_ALLOW_ORIGIN`: comma-separated extra allowed `Origin` values, on top of
 *  the request's own bind address (always implicitly allowed, see http.ts
 *  isAllowedOrigin). For a reverse proxy in front of this daemon (tailscale serve:
 *  `https://<machine>.<tailnet>.ts.net`) whose Origin doesn't match any bind literally
 *  (2026-07-10, DR-0004 trust-model addendum). Unset/empty = no extra origins. */
function resolveHttpAllowOrigin(): Set<string> {
  const raw = process.env.CCMSG_HTTP_ALLOW_ORIGIN;
  if (!raw || raw.trim() === "") return new Set();
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s !== ""),
  );
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

  const httpAllowSpec = resolveHttpAllowSpec();
  let httpAllowCidrs: Cidr[];
  try {
    httpAllowCidrs = parseAllowList(httpAllowSpec);
  } catch (e) {
    const msg = `invalid CCMSG_HTTP_ALLOW: ${String(e)}`;
    log.error(msg);
    if (opts.foreground) process.stderr.write(`ccmsg: ${msg}\n`);
    lock.release();
    process.exit(1);
  }
  const httpAllow = httpAllowSpec
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");

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
    httpListeners: [],
    httpAllow,
    dedupWindowMs: resolveDedupWindow(),
    shuttingDown: false,
    agentsPoller: createAgentsPoller(),
    transcriptTail: createTranscriptTailStore(),
  };

  interface UdsConnState {
    conn: Conn;
    decoder: TextDecoder;
    buffer: string;
    /** Bytes not yet accepted by the kernel due to backpressure (DR-0008: fs_read
     *  responses can be hundreds of KB, well past the point tiny room/post replies
     *  ever hit). `socket.write()` uses sendto(2) directly and returns a short
     *  count instead of blocking/queueing when the socket buffer is full — unlike
     *  Bun's higher-level `ws.send()` on the HTTP/WS side, nothing retries the
     *  remainder for us. `flushPending` below is that retry, driven by both the
     *  writer and the socket's own `drain` event. */
    pending: Buffer[];
  }

  function flushPending(socket: Bun.Socket<UdsConnState>): void {
    const state = socket.data;
    while (state.pending.length > 0) {
      const chunk = state.pending[0]!;
      let n: number;
      try {
        n = socket.write(chunk);
      } catch {
        // socket closing mid-flush; drop the rest, delivery is best-effort
        state.pending.length = 0;
        return;
      }
      if (n < 0) {
        // socket closed/shutting down (Bun: write() returns -1)
        state.pending.length = 0;
        return;
      }
      if (n === chunk.length) {
        state.pending.shift();
        continue;
      }
      // partial write: keep the unsent remainder at the front of the queue and
      // wait for the next `drain` event rather than busy-retrying here.
      state.pending[0] = chunk.subarray(n);
      break;
    }
    try {
      socket.flush();
    } catch {
      // socket may be closing; delivery is best-effort
    }
  }

  const server = Bun.listen<UdsConnState>({
    unix: paths.sock,
    socket: {
      open(socket) {
        const conn: Conn = {
          write(line) {
            const state = socket.data;
            state.pending.push(Buffer.from(line, "utf-8"));
            flushPending(socket);
          },
          identity: null,
          subscribed: false,
        };
        socket.data = { conn, decoder: new TextDecoder(), buffer: "", pending: [] };
        daemon.connections.add(conn);
      },
      drain(socket) {
        flushPending(socket);
      },
      data(socket, chunk) {
        const state = socket.data;
        state.buffer += state.decoder.decode(chunk, { stream: true });
        let idx: number;
        while ((idx = state.buffer.indexOf("\n")) >= 0) {
          const rawLine = state.buffer.slice(0, idx);
          state.buffer = state.buffer.slice(idx + 1);
          if (rawLine.trim() !== "") handleRequest(daemon, state.conn, rawLine);
        }
      },
      close(socket) {
        const state = socket.data;
        if (state) removeConn(daemon, state.conn);
      },
      error(_socket, err) {
        daemon.log.error(`socket error: ${String(err)}`);
      },
    },
  });
  daemon.server = server;

  fs.chmodSync(paths.sock, 0o600);
  fs.writeFileSync(paths.pid, `${process.pid}\n`);
  log.info(
    `listening on ${paths.sock} (v${VERSION}, ${rooms.size} rooms, dedup ${daemon.dedupWindowMs}ms)`,
  );

  const httpAllowOrigin = resolveHttpAllowOrigin();
  // Persisted extra origins (`ccmsg origins add`, origins-file.ts) — read
  // lazily by the listener on Origin-check misses, so additions apply to the
  // next request with no daemon restart and no env involved.
  const originsFile = createOriginsFile(paths.allowedOrigins, log);
  const httpListeners: HttpListener[] = [];
  for (const bindSpec of resolveHttpBinds()) {
    try {
      const listener = startHttpListener(
        daemon,
        bindSpec,
        httpAllowCidrs,
        httpAllowOrigin,
        opts.fallback,
        originsFile,
      );
      httpListeners.push(listener);
      log.info(`http listening on ${listener.address}`);
    } catch (e) {
      log.error(`failed to bind http ${bindSpec}: ${String(e)}`);
    }
  }
  daemon.httpListeners = httpListeners;

  // Zero-config tailscale serve origin auto-allow (docs/issue/2026-07-11-tailscale-
  // serve-origin-auto-allow.md, DR-0004 trust-model addendum): best-effort, async,
  // never delays or blocks startup. `extraOrigins`/`httpAllowOrigin` is the very Set
  // instance each HTTP listener's closure already holds (see isAllowedOrigin in
  // http.ts) — mutating it after the fact is enough for future requests to see the
  // added origins, no wiring needed back into the listeners themselves.
  if (httpListeners.length > 0) {
    const boundPorts = new Set(
      httpListeners
        .map((l) => Number(l.address.slice(l.address.lastIndexOf(":") + 1)))
        .filter((p) => Number.isInteger(p)),
    );
    const tailscaleBin = process.env.CCMSG_TAILSCALE_BIN;
    void fetchTailscaleServeOrigins(boundPorts, {
      ...(tailscaleBin && tailscaleBin !== "" ? { bin: tailscaleBin } : {}),
      log,
    }).then((origins) => {
      for (const origin of origins) httpAllowOrigin.add(origin);
    });
  }

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
