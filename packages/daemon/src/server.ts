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
  type ArchiveEvent,
  type ErrorResponse,
  type Identity,
  type KindEvent,
  type LeaveEvent,
  type MemberEvent,
  type MsgEvent,
  type NotifyFrom,
  type Paths,
  type PeerInfo,
  type Request,
  type RoomKind,
  type SessionIdentity,
  type SessionLaunchResponse,
  type SessionSearchResponse,
  type StorageEvent,
  type TitleEvent,
  type TranslateResponse,
} from "@ccmsg/protocol";
import { Logger } from "./log.ts";
import { loadConfig, type DaemonConfig } from "./config.ts";
import { dirTree } from "./dir-tree.ts";
import { fsList, fsRead, fsReadExternal, fsWrite, validateRepoRoot } from "./fs-access.ts";
import { executeSessionLaunch, validateSessionLaunch } from "./session-launch.ts";
import { sessionSearch } from "./session-search.ts";
import {
  createSessionStatusStore,
  getSessionStatus,
  sessionStatusUnsubscribeAll,
  stopAllSessionStatus,
  subscribeSessionStatus,
  unsubscribeSessionStatus,
  type SessionStatusStore,
} from "./session-status.ts";
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
import { createTranslateService, type TranslateService } from "./translate-helper.ts";
import {
  appendEvent,
  closeRoom,
  compareIds,
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
  /** User configuration is parsed once at daemon startup (DR-0018 LN-Q4). */
  config: DaemonConfig;
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
  /** folded transcript status subscriptions per sid (DR-0020 Phase 1). */
  sessionStatus: SessionStatusStore;
  /** Persistent macOS Translation.framework helper (DR-0023). */
  translator: TranslateService;
  /** peersCompareKey() as of the last `ev:"peers"` broadcast (issue 2026-07-12-
   * peers-live-update-protocol) — lets maybeBroadcastPeers skip a push when a
   * hello re-send (or any other registerSession/removeConn call) didn't actually
   * change the peers list. "" before the first push. */
  peersSnapshot: string;
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

function sendReplyViaTlError(conn: Conn, room: Room | null): void {
  // `room=null` は create_room/next_room の pre-check 経路 (RL-Q1、kawaz r26
  // mid=103) — 対象 room がまだ存在しないので room id を含めず「session 発の
  // 初期 --msg 自体を諦めろ」と誘導する。room 指定時は既存 post/reply ガードの
  // 文言 (room id 込み) を維持する。
  const suffix = room
    ? `do not post/reply into ${room.id}`
    : `do not attach --msg on a session-initiated 1on1 create_room/next_room`;
  sendErr(
    conn,
    ErrorCode.reply_via_tl,
    `this 1on1 room is routed "tl": respond via your normal assistant output ` +
      `(transcript) — ${suffix}`,
  );
}

/** id the connection acts as inside `room`, for delivery-time bookkeeping like
 * reply_hint. Returns ADMIN_ID for the user role, the member id for a member
 * session, or null when the subscriber isn't a member (u1 always resolves;
 * a non-member session subscriber never reaches writeDelivered because
 * subscriberSeesRoom would have filtered them out first). */
function recipientId(conn: Conn, room: Room): string | null {
  const id = conn.identity;
  if (!id) return null;
  if (id.role === "user") return ADMIN_ID;
  return memberIdBySid(room).get(id.sid) ?? null;
}

/** DR-0017 §2.3 reply_hint composer. Returns the per-recipient hint telling a
 * receiver HOW to respond — exactly three shapes:
 * - `"none"`: archived room, silent (no response expected).
 * - `"tl"`: 1on1 room + u1-authored, agent responds via its normal assistant
 *   output (transcript) — the webui SessionView Timeline picks it up.
 * - `"r<N>m<M>"` (everything else): respond with `ccmsg reply r<N>m<M> <text>`.
 *   The daemon's reply op computes the delivery targets (§2.2), so unlike the
 *   old DR-0014 routing notation this hint carries no `to` reconstruction —
 *   the receiver only needs to name the msg it's answering. */
function computeReplyHint(room: Room, ev: MsgEvent): string {
  if (room.archived) return "none";
  if (room.kind === "1on1" && ev.from === ADMIN_ID) return "tl";
  return `${room.id}m${ev.mid}`;
}

function writeDelivered(conn: Conn, room: Room, ev: StorageEvent): void {
  if (ev.type === "msg") {
    const rid = recipientId(conn, room);
    if (rid !== null) {
      // reply_hint is a delivery-time wire hint (DR-0017 §2.3), never stored
      // in the room's jsonl — the route depends on live room state (archived
      // flips it to "none" retroactively for later replays), so persisting a
      // snapshot at post time would go stale.
      const reply_hint = computeReplyHint(room, ev);
      send(conn, { ...ev, r: room.id, reply_hint });
      return;
    }
  }
  send(conn, { ...ev, r: room.id });
}

// --- identity / registry ---------------------------------------------------

/**
 * DR-0013 §2.2 auto-populate: append a MemberEvent to every broadcast room
 * this sid is not already a member of. Called from the "new session entry
 * appeared" side of registerSession — a re-hello that only updates metadata
 * (repo/ws/branch) must not append duplicate member rows, and never for the
 * admin User (u1 is implicit in every room, DR-0006 §2). The auto-populate
 * event is DELIBERATELY not deliver()-ed to subscribers (§2.3 asks for the
 * append-to-jsonl side but skips the stream); appendEvent alone gives us that.
 */
function joinAllBroadcasts(daemon: Daemon, sid: string): void {
  const entry = daemon.sessions.get(sid);
  if (!entry) return;
  for (const room of daemon.rooms.values()) {
    if (room.kind !== "broadcast") continue;
    if (memberIdBySid(room).has(sid)) continue;
    const ev: MemberEvent = {
      type: "member",
      id: nextAgentMemberId(room),
      sid,
      repo: entry.meta.repo,
      ws: entry.meta.ws,
      cwd: entry.meta.cwd,
      joined_at: nowIso(),
    };
    appendEvent(room, ev);
  }
}

/**
 * DR-0013 §2.2 auto-populate: append a LeaveEvent to every broadcast room
 * this sid was a member of. Called from the "session entry fully removed"
 * side of detachSession — a partial detach (this conn moved to a different sid
 * but the sid still has other conns open, e.g. the user opened a second webui
 * tab as an observer of the same session) must NOT leave the room, so we key
 * off "did the sessions map entry disappear?" rather than "did this conn go
 * away?". Same "storage only, not delivered" treatment as the join side
 * (§2.3).
 */
function leaveAllBroadcasts(daemon: Daemon, sid: string): void {
  for (const room of daemon.rooms.values()) {
    if (room.kind !== "broadcast") continue;
    const memberId = memberIdBySid(room).get(sid);
    if (memberId === undefined) continue;
    const ev: LeaveEvent = { type: "leave", id: memberId, ts: nowIso() };
    appendEvent(room, ev);
  }
}

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
  const isNewEntry = !entry;
  if (!entry) {
    entry = { meta, conns: new Set(), connectedAt: nowIso() };
    daemon.sessions.set(id.sid, entry);
  } else {
    entry.meta = meta;
  }
  entry.conns.add(conn);
  // DR-0013 §2.2 auto-populate: first hello for this sid → add it to every
  // broadcast room. A re-hello (isNewEntry === false) is deliberately a no-op:
  // this sid is already a member of every broadcast room from its earlier
  // registration, and the auto-populate contract talks about session lifecycle
  // ("hello 到達 = 新規 session"), not per-connection re-hellos.
  if (isNewEntry) joinAllBroadcasts(daemon, id.sid);
  // Push ev:"peers" on: new sid registration (entry was just created above) or a
  // hello that actually changed repo/ws/branch/transcript_path/repo_root (entry.meta
  // reassigned above). maybeBroadcastPeers itself no-ops a same-content re-hello via
  // its JSON snapshot compare (issue 2026-07-12-peers-live-update-protocol) — this
  // call site doesn't need to distinguish "new" from "updated" from "unchanged".
  maybeBroadcastPeers(daemon);
}

/** Stop counting `conn` under `sid`'s session entry — the shared tail end of both
 *  a full disconnect (removeConn) and a re-hello that moves this conn to a
 *  different sid or away from session role entirely (dispatch's "hello" case).
 *  Without this second caller, a conn that re-hellos under a new identity stayed
 *  in its *previous* sid's `conns` Set forever (that sid's entry.conns.size never
 *  dropped to 0 on its own), so the stale sid lingered in `peers`/ev:"peers" as a
 *  ghost peer until the conn closed entirely — adversarial review finding,
 *  2026-07-12, made externally visible by ev:"peers" push + the webui's live peer
 *  list (the underlying registry gap predates that push). */
function detachSession(daemon: Daemon, conn: Conn, sid: string): void {
  const entry = daemon.sessions.get(sid);
  if (!entry) return;
  entry.conns.delete(conn);
  if (entry.conns.size === 0) {
    daemon.sessions.delete(sid);
    // DR-0013 §2.2 auto-populate: session fully gone → append LeaveEvent to
    // every broadcast room it was in. A partial detach (this conn is closing
    // but the sid still has other conns) must NOT leave, hence the size===0
    // gate — the sid is still "connected" as far as the broadcast contract is
    // concerned. Same "not delivered to subscribers" treatment as the join
    // side (see leaveAllBroadcasts's doc comment / §2.3).
    leaveAllBroadcasts(daemon, sid);
  }
  // Deliberately does NOT call maybeBroadcastPeers itself: both callers (removeConn,
  // dispatch's "hello" case) may follow this with a registerSession/further mutation
  // of their own in the same turn, and pushing here too would mean two ev:"peers"
  // frames (one showing the stale mid-transition state) for what's semantically one
  // registry change. Each caller pushes once, after every mutation it's going to make
  // is done.
}

export function removeConn(daemon: Daemon, conn: Conn): void {
  daemon.connections.delete(conn);
  daemon.subscribers.delete(conn);
  maybeStopAgentsPoller(daemon.agentsPoller, daemon.subscribers);
  sessionStatusUnsubscribeAll(daemon.sessionStatus, daemon.transcriptTail, conn);
  transcriptUnsubscribeAll(daemon.transcriptTail, conn);
  const id = conn.identity;
  if (id && id.role === "session") {
    detachSession(daemon, conn, id.sid);
    // full disconnect (last conn for this sid gone, not just one of several)
    // (issue 2026-07-12-peers-live-update-protocol) — a session with another
    // still-open conn stays in the peers list, so maybeBroadcastPeers itself
    // no-ops via its snapshot compare when detachSession didn't actually remove
    // the sessions entry.
    maybeBroadcastPeers(daemon);
  }
}

/** Compute the peers list exactly as the `peers` op returns it (only sessions
 * with at least one live connection) — shared by that op and the ev:"peers"
 * push below so the two never drift apart. */
function currentPeers(daemon: Daemon): PeerInfo[] {
  return [...daemon.sessions.values()]
    .filter((s) => s.conns.size > 0)
    .map((s) => ({
      ...s.meta,
      connected_at: s.connectedAt,
      ...(s.lastActivityAt ? { last_activity_at: s.lastActivityAt } : {}),
    }));
}

/** The subset of currentPeers() compared to decide whether anything worth a push
 * actually changed. Deliberately excludes `last_activity_at`: that field is
 * re-stamped on literally every request (handleRequest's post-dispatch choke
 * point), including the very hello call that runs registerSession/removeConn's
 * maybeBroadcastPeers itself — comparing it would make an identical hello
 * re-send look "changed" purely from its own request landing between the two
 * snapshots, defeating the "no push on unchanged re-hello" requirement (issue
 * 2026-07-12-peers-live-update-protocol). `connected_at` stays in: it's stable
 * across re-hellos for the same still-open sid (registerSession never touches
 * it) and only differs across a genuine full-disconnect-then-rejoin. */
function peersCompareKey(daemon: Daemon): string {
  return JSON.stringify(
    [...daemon.sessions.values()]
      .filter((s) => s.conns.size > 0)
      .map((s) => ({ ...s.meta, connected_at: s.connectedAt })),
  );
}

/** Push ev:"peers" (user-role subscribers only, DR-0009-agents' precedent for
 * webui-only push events) to every subscriber, but only when peersCompareKey
 * actually differs from the last broadcast — a hello re-send with unchanged
 * repo/ws/branch/transcript_path/repo_root must not spam a push (issue
 * 2026-07-12-peers-live-update-protocol). No polling: called only from the two
 * registry mutation points (registerSession, removeConn) that can change the
 * result, so this stays purely event-driven, unlike the agents poller. */
function maybeBroadcastPeers(daemon: Daemon): void {
  const key = peersCompareKey(daemon);
  if (key === daemon.peersSnapshot) return;
  daemon.peersSnapshot = key;
  const peers = currentPeers(daemon);
  for (const sub of daemon.subscribers) {
    if (sub.identity?.role === "user") send(sub, { ev: "peers", peers });
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

/** DR-0013 §2.3: broadcast room の member / leave イベントは jsonl には残るが
 * subscribe stream には配信しない (通常 room は現状通り配信)。auto-populate で
 * session が increments/decrements するたびに他 broadcast member の agent
 * コンテキストが「A が join した / A が leave した」で埋まるのを避けるため。
 * kind / title / archive / msg / next / prev はいずれも通常 room と同じく配信。 */
function isSuppressedForBroadcastStream(room: Room, ev: StorageEvent): boolean {
  return room.kind === "broadcast" && (ev.type === "member" || ev.type === "leave");
}

/**
 * Live-deliver a single event to all subscribers that see the room.
 * echo suppression (DR-0003 §5) applies to `msg` only: the author's own post is
 * never pushed back to them. Membership/link/title events go to everyone incl. the actor
 * (DR-0011 §1: the `to`-delivery filter below is msg-only too, same reasoning).
 */
function deliver(daemon: Daemon, room: Room, ev: StorageEvent, author: Author): void {
  if (isSuppressedForBroadcastStream(room, ev)) return;
  for (const sub of daemon.subscribers) {
    if (!subscriberSeesRoom(sub, room)) continue;
    if (ev.type === "msg") {
      if (isAuthorSub(sub, author)) continue;
      if (!msgVisibleTo(sub, room, ev)) continue;
    }
    writeDelivered(sub, room, ev);
  }
}

/**
 * `since_seq` value validity (DR-0016 §2.5): must be a finite non-negative
 * number. A room's `since_seq` entry reaches here straight from
 * `JSON.parse(line) as Request` with no schema validation upstream, so a
 * malformed/malicious value (string, negative, NaN, Infinity) is a real
 * possibility, not just a type-checker formality. An invalid value is treated
 * as "no cursor for this room" — safe side is full backlog replay (duplicate
 * delivery), never an out-of-range array/loop hazard.
 */
function isValidSeqCursor(v: number | undefined): v is number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0;
}

/**
 * Initial/backlog delivery of a room to one subscriber.
 * - with sinceSeq (valid per isValidSeqCursor): positional delta anchored on
 *   `seq`, which spans EVERY event type (DR-0016) — takes priority over
 *   sinceMid when both are supplied.
 * - else with sinceMid: positional delta — everything after the msg with that mid
 *   (BBS replay, msg-only cursor, old-client compat).
 * - without either: present member state + title/link events + the last N=50 msgs
 *   (join snapshot); a user-role subscriber's conn gets every msg instead of just
 *   the last 50 (issue 2026-07-12-peers-live-update-protocol's sibling change —
 *   the cap only protects an agent session's context budget).
 * suppressAuthorId drops the author's own just-posted msg from their snapshot (echo rule).
 * All paths apply the same `to`-delivery filter as live `deliver` (DR-0011 §1-2): an
 * offline member reconnecting via since-replay must not see a `to` msg that excluded
 * them any more than a live subscriber would.
 */
function sendBacklog(
  conn: Conn,
  room: Room,
  sinceMid?: number,
  suppressAuthorId?: string,
  sinceSeq?: number,
): void {
  if (isValidSeqCursor(sinceSeq)) {
    // Anchoring on "last event with seq <= sinceSeq" is correct at both ends:
    // a caught-up client (sinceSeq >= room.lastSeq) gets nothing, a client
    // whose cursor predates the room's start gets everything. Every event in
    // room.events carries a seq by this point (loadRoom backfills legacy rows,
    // appendEvent stamps new ones — DR-0016 §2.1/§2.2), so this is a plain
    // positional scan, not a search over possibly-undefined values.
    let start = 0;
    for (let i = 0; i < room.events.length; i++) {
      const ev = room.events[i]!;
      if (ev.seq !== undefined && ev.seq <= sinceSeq) start = i + 1;
    }
    for (let i = start; i < room.events.length; i++) {
      const ev = room.events[i]!;
      // DR-0013 §2.3 (see the sinceMid branch below for the same rule).
      if (isSuppressedForBroadcastStream(room, ev)) continue;
      if (ev.type === "msg" && !msgVisibleTo(conn, room, ev)) continue;
      writeDelivered(conn, room, ev);
    }
    return;
  }
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
      // DR-0013 §2.3: broadcast room の member/leave は since replay でも配信しない。
      // live deliver と since replay の両輪でスキップして、遅れて再接続した member
      // の subscribe stream にも noise を復元させない。
      if (isSuppressedForBroadcastStream(room, ev)) continue;
      if (ev.type === "msg" && !msgVisibleTo(conn, room, ev)) continue;
      writeDelivered(conn, room, ev);
    }
    return;
  }

  const presentIds = new Set(presentMembers(room).map((m) => m.id));
  const msgEvents = room.events.filter((e): e is MsgEvent => e.type === "msg");
  // user role has no context budget to protect (kawaz 2026-07-12: "ユーザ向けは
  // コンテキストとか気にする必要ないのでないなら全部流し直して") — only session
  // (agent) subscribers keep the DEFAULT_JOIN_BACKLOG=50 cap that exists to bound
  // an agent's context cost. subscribe requires hello (IDENTITY_OPS), so
  // conn.identity is always set here.
  const capped =
    conn.identity?.role === "user" ? msgEvents : msgEvents.slice(-DEFAULT_JOIN_BACKLOG);
  const recent = new Set(capped);
  for (const ev of room.events) {
    if (ev.type === "leave") continue;
    if (ev.type === "member" && !presentIds.has(ev.id)) continue;
    // DR-0013 §2.3: broadcast room の member は snapshot 経路でも配信しない
    // (webui は rooms 応答で member 一覧を取得する契約)。leave は上の一律 continue
    // で既に落ちているので追加の broadcast チェック不要。
    if (room.kind === "broadcast" && ev.type === "member") continue;
    if (ev.type === "msg") {
      if (!recent.has(ev)) continue;
      if (suppressAuthorId !== undefined && ev.from === suppressAuthorId) continue;
      if (!msgVisibleTo(conn, room, ev)) continue;
    }
    writeDelivered(conn, room, ev);
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

/** Append a LeaveEvent for `memberId` and broadcast it to every subscriber that sees
 *  the room. Recipients are captured before membership shrinks so a leaving/kicked
 *  member's own subscribed connection still gets the confirmation. Shared by
 *  voluntary `leave` and admin-only `kick` (DR-0012) — both produce the identical
 *  storage event, only the actor/authorization differs. */
function appendLeaveAndBroadcast(daemon: Daemon, room: Room, memberId: string): void {
  const ev: LeaveEvent = { type: "leave", id: memberId, ts: nowIso() };
  const recipients = [...daemon.subscribers].filter((s) => subscriberSeesRoom(s, room));
  appendEvent(room, ev);
  // membership shrank below the sid set that seeded room.dedupKey (invite's
  // mirror image, see the identical comment on the `invite` case below): a
  // same-sid create_room within the dedup window must no longer fold into
  // this room, otherwise the fold's resolveFrom(leaver, room) comes back
  // null, the msg silently fails to append, and the caller still gets back
  // `{ok:true, reused:true}` with no mid — a swallowed post disguised as
  // success.
  room.dedupEligible = false;
  for (const r of recipients) writeDelivered(r, room, ev);
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

function createRoom(
  daemon: Daemon,
  orderedSids: string[],
  dedupEligible: boolean,
  kind: RoomKind = "normal",
): Room {
  const id = generateRoomId(daemon);
  const room: Room = {
    id,
    file: `${daemon.paths.roomsDir}/${id}.jsonl`,
    events: [],
    lastMid: 0,
    lastSeq: 0,
    createdAt: Date.now(),
    // broadcast rooms are always dedup-exempt regardless of the caller's request
    // — multiple broadcasts with the same member set (dev / debug / ...) are
    // explicitly allowed (DR-0013 §2.1, r12 mid=3「一個限定である必要無し」)
    // and would otherwise fold into the same room.
    dedupEligible: kind === "broadcast" ? false : dedupEligible,
    dedupKey: [...new Set(orderedSids)].sort().join(","),
    archived: false,
    kind,
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

// fs_list/fs_read/fs_read_external/fs_write/transcript_read require hello too
// (DR-0008 / DR-0024 / DR-0019 / DR-0009): the
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
  "archive_room",
  "kick",
  "subscribe",
  "notify",
  "dir_tree",
  "session_launch",
  "session_launcher_config",
  "leave",
  "invite",
  "fs_list",
  "fs_read",
  "fs_read_external",
  "fs_write",
  "transcript_read",
  "session_search",
  "agents",
  "transcript_subscribe",
  "transcript_unsubscribe",
  "session_status",
  "session_status_subscribe",
  "session_status_unsubscribe",
  "translate",
]);

/** set_title clamp: keep room titles reasonably short in room lists / tab titles. */
const SET_TITLE_MAX_LEN = 200;

/** Slow ops (translate / session_launch / session_search) use a 2-phase reply
 * (see RequestAcceptedResponse in the protocol): the direct reply is an
 * immediate ack on the arrival-order contract, and the outcome is pushed later
 * as an `ev:"*_result"` stream event correlated by the client's request_id.
 * This helper validates the id, sends the ack, and returns a completion
 * callback that pushes the result event — or silently drops it when the
 * connection is already gone (the daemon keeps no per-request state, so a
 * disconnect leaves nothing to clean up beyond the op's own promise chain,
 * which settles into this no-op). Events are pushed only to the requesting
 * conn, not to subscribers. */
/** Final outcome payload of a 2-phase op — exactly what the matching
 * `ev:"*_result"` event carries beside its ev/request_id envelope. */
type TwoPhaseResult =
  | SessionLaunchResponse
  | SessionSearchResponse
  | TranslateResponse
  | ErrorResponse;

function acceptTwoPhase(
  daemon: Daemon,
  conn: Conn,
  op: string,
  ev: string,
  requestId: unknown,
): ((result: TwoPhaseResult) => void) | null {
  if (typeof requestId !== "string" || requestId === "") {
    sendErr(conn, ErrorCode.invalid_args, `${op} requires a non-empty string request_id`);
    return null;
  }
  send(conn, { ok: true, accepted: true, request_id: requestId });
  return (result) => {
    // A conn that disconnected while the op ran is no longer in
    // daemon.connections; its transport write would be a silent no-op anyway
    // (see send()), but skipping explicitly documents the discard contract.
    if (!daemon.connections.has(conn)) return;
    send(conn, { ev, request_id: requestId, ...result });
  };
}

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
      const prevId = conn.identity;
      let newId: Identity;
      if (req.role === "user") {
        newId = { role: "user" };
      } else {
        if (!req.sid) {
          sendErr(conn, ErrorCode.invalid_args, "session hello requires sid");
          return;
        }
        const transcriptPath = validateTranscriptPath(req.sid, req.transcript_path);
        const cwd = req.cwd ?? "";
        const repoRoot = validateRepoRoot(cwd, req.repo_root);
        newId = {
          role: "session",
          sid: req.sid,
          repo: req.repo ?? "",
          ws: req.ws ?? "",
          cwd,
          ...(transcriptPath ? { transcript_path: transcriptPath } : {}),
          ...(repoRoot ? { repo_root: repoRoot } : {}),
          ...(req.branch ? { branch: req.branch } : {}),
        };
      }
      // A re-hello that moves this conn away from its previous sid (a different
      // sid, or role no longer "session") must stop counting it there first, or
      // the old sid's entry never reaches conns.size===0 on its own and lingers
      // as a ghost peer (see detachSession's doc comment).
      const movedAwayFromSession =
        prevId?.role === "session" && (newId.role !== "session" || newId.sid !== prevId.sid);
      if (movedAwayFromSession) detachSession(daemon, conn, prevId.sid);
      conn.identity = newId;
      if (newId.role === "session") {
        // pushes ev:"peers" itself, covering both the detach above and this
        // registration as one combined change (see detachSession's doc comment).
        registerSession(daemon, conn, newId);
      } else if (movedAwayFromSession) {
        // detach-only change (session -> user role): still need the push detachSession
        // deliberately didn't make.
        maybeBroadcastPeers(daemon);
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
      // A session's response to u1 in a 1on1 room belongs in its normal
      // assistant transcript, which the webui SessionView already follows.
      // Reject every session-authored 1on1 post at the room boundary rather
      // than trying to infer which prior msg it answers or track pending state.
      // u1/webui posts remain the legitimate incoming-message path.
      if (room.kind === "1on1" && conn.identity?.role === "session") {
        sendReplyViaTlError(conn, room);
        return;
      }
      const to = normalizeTo(req.to);
      // DR-0013 §2.4: broadcast room では role:"session" (agent) からの post は
      // `to` に "u1" (ADMIN_ID) を含めることが必須。「u1 に届かない agent の
      // broadcast 発話」を意味論として封じる (broadcast の目的は kawaz への
      // 集約通信なので、u1 抜きの agent 発話は broadcast context の外側)。
      // u1 (User) 発の post は制約なし — 既存の to semantics (省略=全員 /
      // 単一 / 複数 mention) がそのまま働く (§2.5)。u1 の実装位置は
      // conn.identity.role === "user"、ADMIN_ID 決定は resolveFrom を経由。
      if (room.kind === "broadcast" && conn.identity?.role === "session") {
        if (!to || !to.includes(ADMIN_ID)) {
          sendErr(
            conn,
            ErrorCode.broadcast_agent_target_required,
            `broadcast room post from an agent must include '${ADMIN_ID}' in to`,
          );
          return;
        }
      }
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

    case "reply": {
      // DR-0017 §2.2: reply to an existing msg — the daemon computes the
      // delivery targets so the replier never assembles a `to` list itself
      // (the misassembled-to failure mode is the whole reason this op exists).
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
      const target = room.events.find((e): e is MsgEvent => e.type === "msg" && e.mid === req.mid);
      if (!target) {
        sendErr(conn, ErrorCode.msg_not_found, `no msg m${req.mid} in ${req.room}`);
        return;
      }
      if (target.from === from) {
        sendErr(
          conn,
          ErrorCode.self_reply,
          `m${req.mid} is your own msg — reply targets someone else's`,
        );
        return;
      }
      // §2.5: a "tl"-routed msg (1on1, u1-authored) is answered on the
      // replier's own transcript, not in the room. Rejecting with guidance
      // corrects the wrong-channel choice the moment it happens, instead of
      // silently rerouting to a room post kawaz would then read in the wrong
      // surface.
      if (room.kind === "1on1" && target.from === ADMIN_ID) {
        sendReplyViaTlError(conn, room);
        return;
      }
      // Targets = original author + everyone the original msg addressed,
      // minus the replier, plus u1 (always-delivered admin; also satisfies
      // the broadcast room's agent-post constraint by construction). Sorted
      // for a stable wire shape.
      const parts = new Set<string>([target.from, ...(target.to ?? [])]);
      parts.delete(from);
      parts.add(ADMIN_ID);
      const to = [...parts].sort(compareIds);
      const mid = room.lastMid + 1;
      const ev: MsgEvent = {
        type: "msg",
        mid,
        from,
        to,
        ts: nowIso(),
        msg: req.msg,
        reply_to: `${room.id}m${req.mid}`,
      };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, mid, to });
      return;
    }

    case "create_room": {
      const explicitMembers = Array.isArray(req.members) ? req.members : [];
      const kind: RoomKind =
        req.kind === "broadcast" ? "broadcast" : req.kind === "1on1" ? "1on1" : "normal";

      if (kind === "1on1") {
        // DR-0014 §2.1 1on1 room = "u1 + 単一 session の 2 者 room".
        // members must be exactly one non-empty sid string. Empty / multiple /
        // non-string entries all fail with one_on_one_requires_single_member so
        // the caller can't accidentally open a 3-party or 0-party priv room —
        // 1on1's whole point is "2 者確定なので配信対象は必然的に絞られる".
        const targetSids = explicitMembers.filter(
          (s): s is string => typeof s === "string" && s !== "",
        );
        if (targetSids.length !== 1) {
          sendErr(
            conn,
            ErrorCode.one_on_one_requires_single_member,
            "create_room --kind 1on1 requires exactly one member sid",
          );
          return;
        }
        const targetSid = targetSids[0]!;
        // RL-Q1 (kawaz r26 mid=103, 「混ぜない」裁定): session 発の初期 --msg は
        // 1on1 room に対して post ガード (§2.5 reply_via_tl) と同じ理由で拒否
        // する — 1on1 の返信レールは TL (transcript) で、room msg 経路ではない。
        // 副作用 (KindEvent/member 書き込み) を残さないため、room 作成前に落とす。
        // broadcast の初期 msg 例外 (§2.10) は unchanged: 1on1 のみに適用。
        if (req.msg !== undefined && conn.identity?.role === "session") {
          sendReplyViaTlError(conn, null);
          return;
        }
        // include_self is deliberately NOT honored for 1on1 (§2.1: session-role
        // caller does NOT auto-prepend). If a session creates a 1on1 with its
        // OWN sid, the resulting room has member.sid == self.sid, member.id = a1,
        // and u1 stays implicit — the same 2-party shape as a webui-created one.
        const room = createRoom(daemon, [targetSid], false, "1on1");
        // Kind marker first (same rationale as broadcast: mid-creation crash
        // recovery must not resurface a 1on1 as "normal" and then start
        // dedup-folding future creates into it).
        appendEvent(room, { type: "kind", kind: "1on1", ts: nowIso() } satisfies KindEvent);
        if (req.title)
          appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
        writeMembers(daemon, room, [targetSid]);
        let mid: number | undefined;
        let authorId: string | null = null;
        if (req.msg) {
          authorId = resolveFrom(conn, room);
          if (authorId !== null) {
            mid = room.lastMid + 1;
            appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
          }
        }
        // 1on1 rooms are dedup-exempt (createRoom seeded dedupEligible=false,
        // storage.ts's computeDerived enforces the same on restart) — the
        // webui's "reuse existing 1on1 with this sid, else create" auto-create
        // (§2.2) does its own lookup by kind==="1on1" instead of relying on
        // the dedup index. So we deliberately do NOT populate dedupIndex here.
        deliverNewRoom(daemon, room, authorOf(conn), authorId);
        send(conn, {
          ok: true,
          room: room.id,
          reused: false,
          ...(mid !== undefined ? { mid } : {}),
        });
        return;
      }

      if (kind === "broadcast") {
        // DR-0013 §2.2 broadcast rooms auto-populate from the live session
        // registry; the caller's `members` list is irrelevant and (§2.9) folded
        // to a non-fatal warning rather than an error. The warning is echoed
        // by the CLI to stderr (index.ts) so a habitual `--members` on a
        // broadcast create still visibly nags. `include_self` is likewise
        // ignored — the caller's own sid enters through the normal
        // auto-populate scan just like every other active session.
        const warning =
          explicitMembers.length > 0
            ? "--members is ignored for broadcast rooms (members are auto-populated)"
            : undefined;
        const room = createRoom(daemon, [], false, "broadcast");
        // KindEvent is written FIRST so a mid-creation crash between here and
        // the member snapshot below still recovers the room as broadcast on
        // daemon restart (storage.ts computeDerived reads events in order).
        // If it came last, a partial file could resurface as "normal" and
        // then start dedup-folding future broadcast creates into it.
        appendEvent(room, { type: "kind", kind: "broadcast", ts: nowIso() } satisfies KindEvent);
        if (req.title)
          appendEvent(room, { type: "title", title: req.title, ts: nowIso() } satisfies TitleEvent);
        // Snapshot every currently-connected session as initial members (§2.2
        // 「broadcast room 作成時に既に active な session も同一契機で自動 join」).
        // Sorting by sid keeps the a1/a2/... assignment deterministic across
        // daemon restarts / test runs so a downstream that reads member.id
        // sees a stable order.
        const activeSids = [...daemon.sessions.values()]
          .filter((s) => s.conns.size > 0)
          .map((s) => s.meta.sid)
          .sort();
        let seq = 1;
        for (const sid of activeSids) {
          const meta = daemon.sessions.get(sid)!.meta;
          appendEvent(room, {
            type: "member",
            id: `a${seq++}`,
            sid,
            repo: meta.repo,
            ws: meta.ws,
            cwd: meta.cwd,
            joined_at: nowIso(),
          } satisfies MemberEvent);
        }
        // Initial msg is treated as a normal post from the caller (§2.10:
        // the §2.4 agent-must-target-u1 rule DELIBERATELY does not apply to
        // create_room's own initial msg — u1's own opening line has no
        // "must be addressed to u1" self-reference to enforce, and forbidding
        // a session caller's opener would just push kawaz to a two-step
        // create + post workflow with no meaningful gain).
        let mid: number | undefined;
        let authorId: string | null = null;
        if (req.msg) {
          authorId = resolveFrom(conn, room);
          if (authorId !== null) {
            mid = room.lastMid + 1;
            appendEvent(room, { type: "msg", mid, from: authorId, ts: nowIso(), msg: req.msg });
          }
        }
        // Broadcast rooms are dedup-exempt (see createRoom's kind === broadcast
        // branch); we deliberately do NOT populate dedupIndex.
        deliverNewRoom(daemon, room, authorOf(conn), authorId);
        send(conn, {
          ok: true,
          room: room.id,
          reused: false,
          ...(mid !== undefined ? { mid } : {}),
          ...(warning ? { warning } : {}),
        });
        return;
      }

      const ordered: string[] = [];
      const id = conn.identity!;
      // Auto-prepend caller sid unless include_self=false (CLI --exclude-self,
      // for an observer session that watches a room without participating).
      // User-role callers (webui backend) never auto-include either way — u1 is
      // implicit in every room already (DR-0006 §2).
      const includeSelf = req.include_self !== false;
      if (id.role === "session" && includeSelf) ordered.push(id.sid);
      for (const sid of explicitMembers)
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
      // RL-Q1 (kawaz r26 mid=103): 1on1 の次スレも 1on1 (§2 kind inheritance)
      // なので、create_room 側と同じく session 発の初期 --msg は "tl" 経路に
      // 誘導する (post ガード §2.5 と同じ理由)。next_room 自体 (msg なし) は
      // 正当な操作なので通す。broadcast の初期 msg 例外 (§2.10) は unchanged。
      if (req.msg !== undefined && old.kind === "1on1" && conn.identity?.role === "session") {
        sendReplyViaTlError(conn, old);
        return;
      }
      const inherited = presentMembers(old);
      const room = createRoom(
        daemon,
        inherited.map((m) => m.sid),
        false,
        // DR-0013 §2.8 / DR-0014 §2 next_room inherits kind: broadcast の
        // 次スレは broadcast (auto-populate と §2.4 post 制約もそのまま新 room に
        // 適用され、以降の hello/disconnect が新 room も拾う)、1on1 の次スレは
        // 1on1 (reply_hint = "tl" 挙動もそのまま維持)。normal はそのまま normal。
        old.kind,
      );
      // KindEvent must be written BEFORE members / prev so a mid-creation crash
      // still recovers the next-room's kind on daemon restart (same rationale
      // as create_room's non-`"normal"` branches above).
      if (old.kind !== "normal")
        appendEvent(room, { type: "kind", kind: old.kind, ts: nowIso() } satisfies KindEvent);
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

    case "archive_room": {
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      // same authorization as set_title: admin User (implicit member of every room)
      // or a resolvable member session.
      if (resolveFrom(conn, room) === null) {
        sendErr(conn, ErrorCode.not_a_member, `not a member of ${req.room}`);
        return;
      }
      if (typeof req.archived !== "boolean") {
        sendErr(conn, ErrorCode.invalid_args, "archive_room requires a boolean archived");
        return;
      }
      const archived = req.archived;
      if (room.archived === archived) {
        // toggle already at the requested value: skip the redundant append/broadcast
        // (DR-0012 — archive is a display flag, re-asserting the same state is a no-op).
        send(conn, { ok: true, room: room.id, archived });
        return;
      }
      const ev: ArchiveEvent = { type: "archive", archived, ts: nowIso() };
      appendEvent(room, ev);
      deliver(daemon, room, ev, authorOf(conn));
      send(conn, { ok: true, room: room.id, archived });
      return;
    }

    case "kick": {
      // admin User only (DR-0012): a room's agents must not be able to evict each
      // other. Unlike member-scoped ops (post/set_title/leave), a session caller here
      // gets a straight permission rejection rather than not_a_member — same pattern
      // as the other user-role-only ops below (agents/transcript_subscribe).
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'kick' requires user role");
        return;
      }
      const room = daemon.rooms.get(req.room);
      if (!room) {
        sendErr(conn, ErrorCode.room_not_found, `no such room: ${req.room}`);
        return;
      }
      const targetId = typeof req.id === "string" ? req.id : "";
      // ADMIN_ID (u1) has no member row (implicit member, DR-0006) so it's never in
      // presentIds — self-kick is naturally invalid_args, no separate guard needed.
      const presentIds = new Set(presentMembers(room).map((m) => m.id));
      if (targetId === "" || !presentIds.has(targetId)) {
        sendErr(
          conn,
          ErrorCode.invalid_args,
          `not a member of ${req.room}: ${targetId || "(missing id)"}`,
        );
        return;
      }
      appendLeaveAndBroadcast(daemon, room, targetId);
      send(conn, { ok: true, room: room.id, id: targetId });
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
        const sinceSeq = req.since_seq?.[room.id];
        sendBacklog(conn, room, sinceMid, undefined, sinceSeq);
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
        ...(r.archived ? { archived: true } : {}),
        // DR-0013 broadcast / DR-0014 1on1: surface non-`"normal"` kind so
        // CLI can badge and webui can pick the right Composer variant (or
        // reuse an existing 1on1 room, §2.2 auto-create). "normal" is the
        // absence of the field.
        ...(r.kind !== "normal" ? { kind: r.kind } : {}),
      }));
      send(conn, { ok: true, rooms });
      return;
    }

    case "peers": {
      send(conn, { ok: true, peers: currentPeers(daemon) });
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

    case "session_launcher_config": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_launcher_config' requires user role");
        return;
      }
      const launcher = daemon.config.session_launcher;
      if (!launcher) {
        sendErr(conn, ErrorCode.launcher_not_configured, "session launcher is not configured");
        return;
      }
      send(conn, {
        ok: true,
        root_dirs: launcher.root_dirs,
        default_prompt: launcher.default_prompt,
      });
      return;
    }

    case "dir_tree": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'dir_tree' requires user role");
        return;
      }
      const result = dirTree(daemon.config.session_launcher, req.roots, req.depth, req.filter);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "session_launch": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_launch' requires user role");
        return;
      }
      const launcher = daemon.config.session_launcher;
      const validation = validateSessionLaunch(launcher, req);
      if (!validation.ok) {
        sendErr(conn, validation.code, validation.msg);
        return;
      }
      const complete = acceptTwoPhase(
        daemon,
        conn,
        "session_launch",
        "session_launch_result",
        req.request_id,
      );
      if (!complete) return;
      // The validation success branch proves launcher exists: an absent config
      // returns launcher_not_configured before process execution is reachable.
      void executeSessionLaunch(validation, launcher!.timeout_seconds).then(
        (result) => complete(result),
        (e) => {
          daemon.log.error(`op 'session_launch' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "session_search": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_search' requires user role");
        return;
      }
      const complete = acceptTwoPhase(
        daemon,
        conn,
        "session_search",
        "session_search_result",
        req.request_id,
      );
      if (!complete) return;
      // The bounded filesystem scan is read-only but slow enough that its
      // outcome travels on the result event rather than a deferred reply.
      void sessionSearch(req, daemon.log).then(
        (result) => {
          if (!result.ok) complete({ ok: false, error: { code: result.code, msg: result.msg } });
          else complete(result.data);
        },
        (e) => {
          daemon.log.error(`op 'session_search' failed: ${String(e)}`);
          complete({ ok: false, error: { code: "internal", msg: String(e) } });
        },
      );
      return;
    }

    case "fs_list": {
      const result = fsList(daemon.sessions, req.sid, req.path, {
        allowVirtual: conn.identity?.role === "user",
      });
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_read": {
      const result = fsRead(daemon.sessions, req.sid, req.path, {
        allowVirtual: conn.identity?.role === "user",
      });
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_read_external": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_read_external' requires user role");
        return;
      }
      const result = fsReadExternal(daemon.sessions, daemon.sessionStatus, req.sid, req.path);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "fs_write": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'fs_write' requires user role");
        return;
      }
      const result = fsWrite(daemon.sessions, req.sid, req.path, req.content);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, ...result.data });
      return;
    }

    case "transcript_read": {
      const result = transcriptRead(daemon.sessions, req.sid, req.before, req.max_bytes, {
        allowVirtual: conn.identity?.role === "user",
      });
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

    case "translate": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'translate' requires user role");
        return;
      }
      if (!Array.isArray(req.texts) || req.texts.some((text) => typeof text !== "string")) {
        sendErr(conn, ErrorCode.invalid_args, "translate requires a string[] texts");
        return;
      }
      const complete = acceptTwoPhase(
        daemon,
        conn,
        "translate",
        "translate_result",
        req.request_id,
      );
      if (!complete) return;
      // Translation.framework and helper process I/O are async; the outcome
      // (including capability failures like translate_unavailable) travels on
      // the result event rather than a deferred reply.
      void daemon.translator.translate(req.texts).then(
        (result) => {
          if (result.ok) complete({ ok: true, results: result.results });
          else complete({ ok: false, error: { code: result.code, msg: result.msg } });
        },
        (error) => {
          daemon.log.error(`op 'translate' failed: ${String(error)}`);
          complete({
            ok: false,
            error: { code: ErrorCode.translate_helper_failed, msg: String(error) },
          });
        },
      );
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

    case "session_status": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_status' requires user role");
        return;
      }
      const result = getSessionStatus(daemon.sessionStatus, daemon.sessions, req.sid);
      if (!result.ok) {
        sendErr(conn, result.code, result.msg);
        return;
      }
      send(conn, { ok: true, sid: req.sid, ...result.data });
      return;
    }

    case "session_status_subscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_status_subscribe' requires user role");
        return;
      }
      const result = subscribeSessionStatus(
        daemon.sessionStatus,
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
      send(conn, { ok: true, sid: req.sid, ...result.data });
      return;
    }

    case "session_status_unsubscribe": {
      if (conn.identity?.role !== "user") {
        sendErr(conn, ErrorCode.bad_request, "op 'session_status_unsubscribe' requires user role");
        return;
      }
      unsubscribeSessionStatus(daemon.sessionStatus, daemon.transcriptTail, req.sid, conn);
      send(conn, { ok: true, sid: req.sid });
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
      appendLeaveAndBroadcast(daemon, room, memberId);
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
        writeDelivered(sub, room, ev);
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
  daemon.translator.stop();
  stopAllSessionStatus(daemon.sessionStatus, daemon.transcriptTail);
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
  const config = loadConfig(paths.config, log);
  const daemon: Daemon = {
    paths,
    config,
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
    sessionStatus: createSessionStatusStore(),
    translator: createTranslateService(),
    peersSnapshot: "",
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
