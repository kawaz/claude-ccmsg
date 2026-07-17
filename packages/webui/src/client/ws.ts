// Effect layer for the wire protocol over `/ws` (DR-0003, DR-0004 §2/§4,
// DR-0005 §1: "副作用...は store の外 (effect 層) に隔離"). Owns the
// WebSocket lifecycle (connect/reconnect/hello/subscribe handshake) and
// translates everything it observes into store actions; the reducer never
// touches the network. HTTP/WS connections are pinned to role "user" (u1)
// server-side regardless of what we send, so we always hello as user.
//
// Responses vs. pushed events share one socket with no request id in the wire
// protocol. The daemon processes each line synchronously in receipt order, so
// replies to our requests arrive in the same order we sent them; anything
// without an `ok` field is a push (subscribe backlog/live event, or an
// ephemeral `ev` frame), never a reply. That's the only reliable way to tell
// the two apart from the client side.
import type {
  AgentsResponse,
  AgentsStreamEvent,
  ArchiveRoomResponse,
  CreateRoomResponse,
  DeliveredEvent,
  ErrorResponse,
  FsListResponse,
  FsReadResponse,
  FsWriteResponse,
  InviteResponse,
  KickResponse,
  PeersResponse,
  PeersStreamEvent,
  PingResponse,
  PostResponse,
  ReadResponse,
  Request,
  Response,
  RoomsResponse,
  SessionSearchRequest,
  SessionSearchResponse,
  SessionStatusResponse,
  SessionStatusStreamEvent,
  SessionStatusSubscribeResponse,
  SessionStatusUnsubscribeResponse,
  SetTitleResponse,
  StreamEvent,
  TranslateResponse,
  TranscriptReadResponse,
  TranscriptSubscribeResponse,
  TranscriptUnsubscribeResponse,
} from "@ccmsg/protocol";
import type { Action, AppState } from "./store.ts";
import { readStorage, writeStorage } from "./storage.ts";

const SINCE_KEY = "ccmsg.since_seq";
const RECONNECT_DELAYS_MS = [250, 500, 1000, 2000, 4000, 8000, 15000, 30000];

function loadSince(): Record<string, number> {
  const raw = readStorage(SINCE_KEY);
  if (!raw) return {};
  try {
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

function saveSince(since: Record<string, number>): void {
  // storage unavailable (private mode, quota) — since-tracking degrades to
  // full resync on reconnect, which is still correct, just more backlog.
  writeStorage(SINCE_KEY, JSON.stringify(since));
}

export interface WsHandle {
  connect(): void;
  close(): void;
  post(room: string, msg: string, to?: string[]): Promise<PostResponse | ErrorResponse>;
  /** Rename a room (set_title); the new title reaches all clients (incl. this
   * one) via the broadcast title event on the subscribe stream, not this
   * response — callers don't need to dispatch anything themselves. */
  setTitle(room: string, title: string): Promise<SetTitleResponse | ErrorResponse>;
  /** Toggle a room's archived flag (DR-0012 archive_room). The new flag
   * reaches all clients (incl. this one) via the broadcast archive event on
   * the subscribe stream, not this response — same non-optimistic-update
   * convention as setTitle above. */
  archiveRoom(room: string, archived: boolean): Promise<ArchiveRoomResponse | ErrorResponse>;
  /** Force-remove a member from a room (DR-0012 kick, admin User only). The
   * removal reaches all clients via the broadcast leave event on the
   * subscribe stream (same LeaveEvent shape a voluntary leave produces), not
   * this response. */
  kick(room: string, id: string): Promise<KickResponse | ErrorResponse>;
  /** Create a room whose sole initial member (besides the always-implicit
   * User/u1) is `memberSid` (U3: SessionView's "+ 新規 Room"). `title`
   * omitted lets the daemon default it, same as any other create_room call. */
  createRoom(memberSid: string, title?: string): Promise<CreateRoomResponse | ErrorResponse>;
  /** Create a `kind:"1on1"` priv room for `memberSid` (DR-0014 §2.2 auto-
   * create, called by SessionView's floating composer when no existing 1on1
   * exists for this session). The daemon enforces exactly one member (empty
   * or multiple returns `one_on_one_requires_single_member`) and the returned
   * room carries `kind:"1on1"` in its rooms-response entry, so subsequent
   * lookups can dedupe by that field rather than trusting the title string. */
  createOneOnOneRoom(
    memberSid: string,
    title?: string,
  ): Promise<CreateRoomResponse | ErrorResponse>;
  peers(): Promise<PeersResponse | ErrorResponse>;
  read(room: string, mids: string | number[]): Promise<ReadResponse | ErrorResponse>;
  /** Add a connected session to an existing room (DR-0011 §1-4: SessionList's
   * drag-a-session-row-onto-the-chat gesture, handled in RoomView's drop
   * zone). Success reaches this room's member list via the broadcast member
   * event on the subscribe stream (same as any other member join), not this
   * response — the caller only needs `already` to decide whether to show a
   * soft "already a member" notice. */
  invite(room: string, sid: string): Promise<InviteResponse | ErrorResponse>;
  /** List a directory under a connected session's cwd (DR-0008 fs_list, "" / absent = root). */
  fsList(sid: string, path?: string): Promise<FsListResponse | ErrorResponse>;
  /** Read a file under a connected session's cwd (DR-0008 fs_read). */
  fsRead(sid: string, path: string): Promise<FsReadResponse | ErrorResponse>;
  /** Read one exact absolute path from the session's transcript-derived
   * external_files allowlist (DR-0024 fs_read_external). */
  fsReadExternal(sid: string, path: string): Promise<FsReadResponse | ErrorResponse>;
  /** Create a new UTF-8 text file under docs/inbox/ relative to a connected
   * session's cwd (DR-0019 fs_write), while remaining inside its containment
   * root. Never overwrites — an existing path replies `file_exists`, a path
   * outside cwd/docs/inbox/ replies `path_not_writable`. */
  fsWrite(sid: string, path: string, content: string): Promise<FsWriteResponse | ErrorResponse>;
  /** Read a slice of a connected session's transcript jsonl (DR-0009
   * transcript_read). `before` omitted = tail of the file; pass the previous
   * reply's `start` to page older. */
  transcriptRead(
    sid: string,
    opts?: { before?: number; max_bytes?: number },
  ): Promise<TranscriptReadResponse | ErrorResponse>;
  /** Follow a connected session's transcript live (DR-0009 live-tail
   * addendum): appended complete lines arrive as `ev:"transcript"` pushes
   * (handled in onMessage below, folded into store as `timeline/tail`) until
   * transcriptUnsubscribe or disconnect. */
  transcriptSubscribe(sid: string): Promise<TranscriptSubscribeResponse | ErrorResponse>;
  transcriptUnsubscribe(sid: string): Promise<TranscriptUnsubscribeResponse | ErrorResponse>;
  /** One-shot fetch of a connected session's folded status snapshot (DR-0020
   * Phase 1 session_status) — todos/workflows/background as currently folded
   * by the daemon from its transcript jsonl. Not called by any component
   * today (subscribe's own response already carries the initial snapshot,
   * see below); kept for parity with the protocol's non-live op and any
   * future one-shot refresh need. */
  sessionStatus(sid: string): Promise<SessionStatusResponse | ErrorResponse>;
  /** Follow a connected session's folded status live (DR-0020 Phase 1
   * session_status_subscribe): the response itself carries the current
   * snapshot (unlike transcriptSubscribe, which only returns a size) —
   * callers dispatch `session-status/loaded` from the resolved response,
   * then again for every subsequent `ev:"session_status"` push (handled in
   * onMessage below) until sessionStatusUnsubscribe or disconnect. */
  sessionStatusSubscribe(sid: string): Promise<SessionStatusSubscribeResponse | ErrorResponse>;
  sessionStatusUnsubscribe(sid: string): Promise<SessionStatusUnsubscribeResponse | ErrorResponse>;
  /** One-shot fetch of the latest `claude agents --json` poll result (U1).
   * Called once in onOpen's handshake for the initial paint; subsequent
   * changes arrive unprompted as `ev:"agents"` pushes (see onMessage below). */
  agents(): Promise<AgentsResponse | ErrorResponse>;
  /** Search historical Claude Code session transcripts under daemon-detected
   * config dirs (DR-0021 Phase 1 op, Phase 2 client wiring; user role only).
   * `params` excludes `op` — the wire shape is assembled here, same
   * convention as fsList/transcriptRead's option-object callers. */
  sessionSearch(
    params: Omit<SessionSearchRequest, "op">,
  ): Promise<SessionSearchResponse | ErrorResponse>;
  /** Round trip to the daemon, carrying provenance (exe/script/version, U1
   * footer) alongside the existing liveness fields. Called once in onOpen's
   * handshake, not polled — provenance only changes across a daemon restart,
   * which already re-runs the whole handshake. */
  ping(): Promise<PingResponse | ErrorResponse>;
  /** Translate complete texts through the daemon host. Unlike browser
   * translation, callers must not split or skip Japanese-containing segments. */
  translate(texts: string[]): Promise<TranslateResponse | ErrorResponse>;
}

export function createWsClient(
  dispatch: (action: Action) => void,
  getState: () => AppState,
): WsHandle {
  let ws: WebSocket | null = null;
  let pending: Array<(v: Response) => void> = [];
  let reconnectAttempt = 0;
  let closedByUs = false;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  const since = loadSince();

  function send<T extends Response>(req: Request): Promise<T> {
    return new Promise((resolve, reject) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        reject(new Error("ws not open"));
        return;
      }
      pending.push(resolve as (v: Response) => void);
      ws.send(JSON.stringify(req));
    });
  }

  async function onOpen(): Promise<void> {
    reconnectAttempt = 0;
    dispatch({ type: "conn/status", status: "connected" });
    // Capability belongs to the current daemon process. Clear a previous
    // connection's answer before probing this hello so stale host tabs cannot
    // survive a reconnect to a different/non-macOS daemon.
    dispatch({ type: "translator/availability", host: false });
    // Snapshot store emptiness BEFORE the handshake runs — the `op:"rooms"`
    // reply below dispatches rooms/loaded, which repopulates state.rooms from
    // whatever the daemon knows, and any getState() read after that point
    // sees a non-empty map even on a fresh page reload. Reload has to be
    // distinguished from in-page reconnect right here, at t0.
    //
    // Page reload starts from a fresh empty store — the localStorage-carried
    // `since_seq` cursor is stale in the sense that "we've seen up to seq N" no
    // longer holds against an empty scrollback. Omit `since_seq` so the daemon
    // replays the full backlog (u1 role is uncapped, see server.ts's
    // sendBacklog non-since branch) and RoomView paints with real history
    // instead of only msgs newer than the pre-reload cursor (kawaz 2026-07-14:
    // "ROOMを選択した時に過去ログが空になる… ユーザ向けには全ログを再送信して復元されるように").
    // In-page reconnects still send `since_seq` — the store retained its state
    // across the disconnect, so BBS delta replay is the correct/cheap thing
    // (packages/cli's reconnect.test.ts contract for daemon-restart transparency).
    const spaHasState = getState().rooms.size > 0;
    try {
      await send({ op: "hello", role: "user" });
      const rooms = await send<RoomsResponse>({ op: "rooms" });
      if (rooms.ok) dispatch({ type: "rooms/loaded", rooms: rooms.rooms });
      await send(spaHasState ? { op: "subscribe", since_seq: since } : { op: "subscribe" });
      const peers = await send<PeersResponse>({ op: "peers" });
      if (peers.ok) dispatch({ type: "peers/loaded", peers: peers.peers });
      // U1: initial `claude agents --json` paint + daemon provenance for the
      // footer. Neither failure here should abort the handshake above (both
      // already landed) — a rejection just falls through to the catch below
      // and skips these two dispatches, same as any other mid-handshake drop.
      const agentsRes = await send<AgentsResponse>({ op: "agents" });
      if (agentsRes.ok) dispatch({ type: "agents/loaded", agents: agentsRes.agents });
      const ping = await send<PingResponse>({ op: "ping" });
      if (ping.ok)
        dispatch({
          type: "daemon-info/loaded",
          version: ping.version,
          exe: ping.exe,
          script: ping.script,
        });
      // DR-0023 host capability probe. An empty batch verifies the daemon can
      // find/build its helper without starting TranslationSession or translating
      // dummy content; a later per-item model error hides the tab at first use.
      const translate = await send<TranslateResponse>({ op: "translate", texts: [] });
      dispatch({ type: "translator/availability", host: translate.ok });
    } catch {
      // socket dropped mid-handshake; onClose already schedules the reconnect.
    }
  }

  function onMessage(data: string): void {
    let obj: StreamEvent | Response;
    try {
      obj = JSON.parse(data);
    } catch {
      return;
    }
    if (Object.hasOwn(obj, "ok")) {
      const settle = pending.shift();
      settle?.(obj as Response);
      return;
    }
    const streamEv = obj as StreamEvent;
    if ("ev" in streamEv && streamEv.ev === "restarting") {
      dispatch({ type: "conn/status", status: "restarting" });
      return;
    }
    if ("ev" in streamEv && streamEv.ev === "notify") return; // not surfaced in the UI (yet)
    // U1: live push whenever the daemon's merged `claude agents --json` poll
    // result changes (only emitted while >=1 user-role subscriber is
    // connected) — folds straight into the same agents/loaded action the
    // one-shot op:"agents" reply in onOpen uses, so the reducer has exactly
    // one code path for "replace the agents list".
    if ("ev" in streamEv && streamEv.ev === "agents") {
      dispatch({ type: "agents/loaded", agents: (streamEv as AgentsStreamEvent).agents });
      return;
    }
    // U1: live push whenever the connected-session list changes (registers,
    // fully disconnects, or updates hello metadata) — folds straight into the
    // same peers/loaded action the one-shot op:"peers" reply in onOpen uses,
    // so the reducer has exactly one code path for "replace the peers list"
    // (same pattern as ev:"agents" above; issue
    // 2026-07-12-peers-live-update-protocol).
    if ("ev" in streamEv && streamEv.ev === "peers") {
      dispatch({ type: "peers/loaded", peers: (streamEv as PeersStreamEvent).peers });
      return;
    }
    // Live-tail push for a session's transcript (DR-0009 addendum,
    // transcript_subscribe): folded into the sid's TimelineState by the
    // reducer's applyTimelineTail, which is the one place that decides
    // whether this batch is contiguous with what's cached (see its doc
    // comment) — this layer just relays the wire shape verbatim.
    if ("ev" in streamEv && streamEv.ev === "transcript") {
      dispatch({
        type: "timeline/tail",
        sid: streamEv.sid,
        lines: streamEv.lines,
        start: streamEv.start,
        end: streamEv.end,
        size: streamEv.size,
      });
      return;
    }
    // Live-tail push for a session's folded status (DR-0020 Phase 1/2
    // session_status_subscribe): folds straight into `session-status/loaded`,
    // the same action sessionStatusSubscribe's own resolved response
    // dispatches for the initial snapshot — the reducer has exactly one
    // "replace this sid's snapshot" code path (same pattern as
    // ev:"transcript" above, minus contiguity bookkeeping since this is
    // always a full recomputed snapshot, not an append).
    if ("ev" in streamEv && streamEv.ev === "session_status") {
      const ev = streamEv as SessionStatusStreamEvent;
      dispatch({
        type: "session-status/loaded",
        sid: ev.sid,
        snapshot: {
          todos: ev.todos,
          workflows: ev.workflows,
          background: ev.background,
          ...(ev.context ? { context: ev.context } : {}),
          teammates: ev.teammates ?? [],
          external_files: ev.external_files ?? [],
        },
      });
      return;
    }
    const delivered = streamEv as DeliveredEvent;
    // Cursor advances on every StorageEvent delivery that carries a seq
    // (DR-0016 §2.4: all event types, not just msg) — ephemeral stream events
    // (notify/restarting/agents/peers/transcript) are handled above and never
    // reach here.
    if (typeof delivered.seq === "number") {
      since[delivered.r] = Math.max(since[delivered.r] ?? 0, delivered.seq);
      saveSince(since);
    }
    dispatch({ type: "protocol-event", event: delivered });
  }

  // Settles every in-flight send() with a synthetic error response instead of
  // leaving its Promise pending forever, and empties the queue so a stale
  // resolver can never be mis-matched (via onMessage's pending.shift()) to a
  // reply that arrives on a later, reconnected socket.
  function flushPending(): void {
    const stale = pending;
    pending = [];
    for (const settle of stale) {
      settle({ ok: false, error: { code: "connection_closed", msg: "ws connection closed" } });
    }
  }

  function onClose(): void {
    dispatch({ type: "conn/status", status: "disconnected" });
    flushPending();
    if (closedByUs) return;
    const delay =
      RECONNECT_DELAYS_MS[Math.min(reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)] ?? 30000;
    reconnectAttempt++;
    reconnectTimer = setTimeout(connect, delay);
  }

  function connect(): void {
    closedByUs = false;
    // A manual connect() supersedes any scheduled auto-reconnect; without this,
    // the pending timer would fire later and knock down the fresh socket.
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    // Belt-and-suspenders: also flush on connect() itself, in case it's ever
    // invoked (e.g. a manual reconnect) without onClose having run first.
    flushPending();
    const previous = ws;
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${proto}//${location.host}/ws`);
    ws = socket;
    // Every listener below is guarded with `socket !== ws`: once `connect()`
    // runs again, `ws` points at the newer socket but this `socket` const
    // still names the one this closure was created for. A stale socket's
    // events (a delayed reply, or its own close firing after we've already
    // moved on) must never touch `pending`/dispatch on behalf of the current
    // connection — that's the mis-delivery this whole file exists to avoid.
    socket.addEventListener("open", () => {
      if (socket !== ws) return;
      void onOpen();
    });
    socket.addEventListener("message", (e) => {
      if (socket !== ws) return;
      onMessage(e.data as string);
    });
    socket.addEventListener("close", () => {
      if (socket !== ws) return;
      onClose();
    });
    // Close the outgoing socket now that `ws` no longer references it, so it
    // stops holding a live connection open in the background. Its close
    // event (real or synthetic) is a no-op thanks to the guard above.
    if (previous) {
      try {
        previous.close();
      } catch {
        // best-effort; the socket is being discarded either way.
      }
    }
  }

  return {
    connect,
    close() {
      closedByUs = true;
      // Cancel a scheduled auto-reconnect too: close() means "stop", including
      // the reconnect already queued by a close event that preceded this call.
      if (reconnectTimer !== null) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      ws?.close();
    },
    post: (room, msg, to) => send({ op: "post", room, msg, ...(to && to.length ? { to } : {}) }),
    setTitle: (room, title) => send({ op: "set_title", room, title }),
    archiveRoom: (room, archived) => send({ op: "archive_room", room, archived }),
    kick: (room, id) => send({ op: "kick", room, id }),
    createRoom: (memberSid, title) =>
      send({ op: "create_room", members: [memberSid], ...(title ? { title } : {}) }),
    createOneOnOneRoom: (memberSid, title) =>
      send({
        op: "create_room",
        members: [memberSid],
        kind: "1on1",
        ...(title ? { title } : {}),
      }),
    peers: () => send({ op: "peers" }),
    read: (room, mids) => send({ op: "read", room, mids }),
    invite: (room, sid) => send({ op: "invite", room, sid }),
    fsList: (sid, path) => send({ op: "fs_list", sid, ...(path !== undefined ? { path } : {}) }),
    fsRead: (sid, path) => send({ op: "fs_read", sid, path }),
    fsReadExternal: (sid, path) => send({ op: "fs_read_external", sid, path }),
    fsWrite: (sid, path, content) => send({ op: "fs_write", sid, path, content }),
    transcriptRead: (sid, opts) =>
      send({
        op: "transcript_read",
        sid,
        ...(opts?.before !== undefined ? { before: opts.before } : {}),
        ...(opts?.max_bytes !== undefined ? { max_bytes: opts.max_bytes } : {}),
      }),
    transcriptSubscribe: (sid) => send({ op: "transcript_subscribe", sid }),
    transcriptUnsubscribe: (sid) => send({ op: "transcript_unsubscribe", sid }),
    sessionStatus: (sid) => send({ op: "session_status", sid }),
    sessionStatusSubscribe: (sid) => send({ op: "session_status_subscribe", sid }),
    sessionStatusUnsubscribe: (sid) => send({ op: "session_status_unsubscribe", sid }),
    agents: () => send({ op: "agents" }),
    sessionSearch: (params) => send({ op: "session_search", ...params }),
    ping: () => send({ op: "ping" }),
    translate: (texts) => send({ op: "translate", texts }),
  };
}
