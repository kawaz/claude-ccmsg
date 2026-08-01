// Central store for the webui client (DR-0005 §1): typed AppState, a typed
// Action union, and a pure reducer. WS-delivered protocol events are folded in
// through the same `protocol-event` action as UI-originated actions (mention
// toggle, locator change, ...) so there is exactly one state-transition path.
// Effects (WS connect/reconnect, hello/subscribe handshake, localStorage, and
// DR-0008 fs_list/fs_read calls) live in ws.ts / the FileTree & FileViewer
// components and dispatch actions here; nothing in this file touches the
// network or the DOM.
import {
  ADMIN_ID,
  type AgentInfo,
  type DeliveredEvent,
  type FsEntry,
  type FsReadResponse,
  type MemberEvent,
  type PeerInfo,
  type RoomKind,
  type RoomSummary,
  type SessionApiError,
  type SessionErrorEntry,
  type SessionSearchHit,
  type SessionStatusSnapshot,
  type TranscriptReadResponse,
} from "@ccmsg/protocol";
import { DEFAULT_STATS_PERIOD, type AgentRef, type Locator, type SessionTab } from "./locator.ts";
import type { ProbeRecord } from "./llm-usage-view.ts";
import type { StatsPeriod } from "./llm-stats-view.ts";

export { ADMIN_ID };

export interface MemberInfo extends MemberEvent {
  left: boolean;
}

export interface RoomState {
  id: string;
  title?: string;
  membersById: Map<string, MemberInfo>;
  memberOrder: string[];
  msgs: Map<number, DeliveredEvent & { type: "msg" }>;
  timeline: DeliveredEvent[];
  lastMid: number;
  lastTs: string | null;
  /** archived flag (DR-0012), last archive event wins; absent/false = not
   * archived. Mirrors RoomSummary.archived / ArchiveEvent — a display-
   * organization flag only, no lifecycle effect on the room itself. */
  archived?: boolean;
  /** room kind (DR-0013). "broadcast" opens the broadcast Composer variant
   * (hint + broadcast-target picker) and paints the sidebar row with a
   * broadcast badge. Absent = "normal" (default at construction below). */
  kind: RoomKind;
  /** Whether this room's history has been fetched (`op:"room_history"`).
   * `rooms/loaded` gives every room its metadata (title, members, last_mid) but
   * no events, so a room stays "idle" until the user opens it — that's what
   * keeps a reload from pulling every room's whole log. "loaded" is what stops
   * RoomView from re-fetching (and duplicating non-msg events in `timeline`,
   * which has no id to dedup on the way `msgs` does). */
  history: "idle" | "loading" | "loaded" | "error";
}

export type ConnStatus = "connecting" | "connected" | "disconnected" | "restarting";

export type View = "room" | "session" | "timeline" | "usage";

/** A URL that named a session or room which is not there. */
export type MissingTarget = { kind: "session" | "room"; id: string };

/** Selected-file state within a SessionTreeState (DR-0008): mirrors the
 * loading/loaded/error lifecycle of a single fs_read round trip. `path` lets
 * a component tell "still loading *this* path" apart from "stale result for
 * a path we've since navigated away from" without a separate stale flag. */
export interface FileViewState {
  path: string;
  status: "loading" | "loaded" | "error";
  /** present when status is "loaded" */
  response?: FsReadResponse;
  /** present when status is "error" */
  error?: string;
  /** The daemon's error code, when it sent one. Only `not_found` is acted on:
   * it is the one failure that means "this address names nothing", which the
   * viewer presents as a 404 rather than as a generic error — markdown links
   * resolve without checking existence (kawaz r55 m129), so landing on a
   * missing file is now an ordinary, expected outcome. */
  errorCode?: string;
}

/** Timeline (transcript) state for one session (DR-0009), cached alongside
 * the file tree so switching tabs/sessions never discards loaded pages. Mirrors
 * FileViewState's loading/loaded/error split; "idle" (not in FileViewState)
 * exists because the Timeline additionally has a real "never fetched yet"
 * moment distinct from "loaded 0 lines" (an empty transcript). */
export interface TimelineState {
  status: "idle" | "loading" | "loaded" | "error";
  /** raw jsonl lines currently cached, oldest first (client parses each as JSON) */
  lines: string[];
  /** byte offset of the earliest loaded line — pass as `before` to page older */
  start: number;
  /** byte offset just past the last loaded line's newline, as of the last
   * tail read (a "load older" page doesn't move this: it only extends
   * backwards from `start`, see applyTimelineLoaded) */
  end: number;
  /** transcript size as of the last response received (daemon-reported) */
  size: number;
  /** true once a response's `start` was 0 — no more "older" to load */
  atStart: boolean;
  /** present when status is "error" */
  error?: string;
  /** set when a `timeline/tail` push arrived non-contiguous with the cached
   * `end` (subscribe/read race, or a gap opened while disconnected) — see
   * applyTimelineTail's doc comment for why the push itself is still
   * dropped. Timeline.tsx's resync effect watches this flag and issues a
   * background transcript_read to catch the cache up; a later
   * `timeline/loaded` (which never carries this field) clears it. Absent
   * (not just `false`) in the common case so existing equality-style
   * assertions on a fresh TimelineState are unaffected. */
  needsResync?: boolean;
}

/** Per-session file-browsing state (DR-0008), keyed by sid in AppState so
 * switching between sessions preserves each one's expanded dirs / loaded
 * listings / open file instead of refetching on every visit. Also holds the
 * session's Timeline cache (DR-0009) — same per-sid keying, same rationale. */
export const DEFAULT_TIMELINE_SEARCH = {
  queryText: "👺\\s*[A-Za-z0-9α-ωΑ-Ω\\-]{2,}",
  caseSensitive: false,
  regex: true,
} as const;

export interface SessionTreeState {
  /** loaded directory listings, keyed by relpath ("" = session root) */
  dirs: Map<string, FsEntry[]>;
  /** fs_list error message for a relpath that failed to load, keyed the same as `dirs` */
  dirErrors: Map<string, string>;
  /** relpaths currently expanded in the tree UI */
  expanded: Set<string>;
  /** relpath selected via the `#s<sid>:<relpath>` locator, if any */
  selectedPath: string | null;
  /** Optional one-based line range selected by a Timeline Read link. */
  selectedLineRange: { start: number; end: number } | null;
  /** Document a markdown link was followed from (`?from=` in the locator), if
   * this selection came from one. Consulted only when the target 404s, to
   * offer alternate readings of the link (kawaz r55 m152). */
  selectedFrom: string | null;
  file: FileViewState | null;
  timeline: TimelineState;
  /** Timeline's in-view search controls, cached per sid so Session Search can
   * hand off a query before navigating and later visits preserve edits. */
  timelineSearch: { queryText: string; caseSensitive: boolean; regex: boolean };
  /** Ephemeral metadata for a historical result that was opened without being
   * pinned. Persisted pins keep their own copy in AppState.pinnedSessions. */
  searchHit?: SessionSearchHit;
}

/** Provenance of the running daemon (U1 footer), from a `ping` reply's
 * exe/script/version fields — which face's plugin cache (personal / a work
 * overlay / ...) this daemon actually runs from was previously unobservable
 * from the webui. `null` until the first ping reply lands (ws.ts's onOpen
 * handshake fires one after hello). */
export interface DaemonInfo {
  version: string;
  exe?: string;
  script?: string;
}

export interface AppState {
  rooms: Map<string, RoomState>;
  roomsLoaded: boolean;
  peers: PeerInfo[];
  peersLoaded: boolean;
  /** `claude agents --json` rows, merged with `peers` by sessionId in the
   * Sidebar Sessions list (U1, see utils.ts's toSessionRow/offlineAgentRows).
   * Populated by ws.ts's onOpen `op:"agents"` fetch and kept live via
   * `ev:"agents"` push — no manual refresh needed. */
  agents: AgentInfo[];
  agentsLoaded: boolean;
  daemonInfo: DaemonInfo | null;
  /** DR-0023 host translation capability, probed once after each hello. */
  hostTranslatorAvailable: boolean;
  /** Web gateway (hyoui) の base URL。hello response の
   * `terminal_gateway_url` を保持し、SessionView の Terminal タブは
   * この値が非 null かつ agent の hyoui_session_id が解決済みの時のみ
   * 表示する (issue 2026-07-21-webui-terminal-tab-embed)。daemon の
   * `<dataDir>/config.json` の `terminal_gateway_url` 未設定なら null。 */
  terminalGatewayUrl: string | null;
  /** hello response の `llm_usage_available`。daemon が LLM gateway の usage
   * URL を設定している時だけ true になり、topbar の Usage ボタンと /usage
   * 画面はこの時のみ出す (未設定の環境には存在しない機能に倒す —
   * terminal_gateway_url と同じ姿勢)。URL 自体は daemon 側が fetch するので
   * webui には来ない。 */
  llmUsageAvailable: boolean;
  /** 直近の probe (`llm_usage` の refresh) が credential 毎に返した limits と
   * probe_error。gateway の cached 応答にはこの 2 つが乗らないので、保持して
   * いないと手動更新の直後に一瞬出て次の poll で消える。credential 名 → 記録。 */
  llmUsageProbes: Map<string, ProbeRecord>;
  /** hello response の `llm_stats_available`。llmUsageAvailable と同じ役割の
   * 利用料 endpoint 版で、/usage 画面の利用料セクションはこれが true の時
   * だけ出す。2 つの endpoint は独立に設定できるので flag も独立。 */
  llmStatsAvailable: boolean;
  /** /usage のどちらのタブを見ているか。クオータと利用料は問いが違うので
   * 画面を分けてある。 */
  usageTab: "quota" | "stats";
  /** 利用料タブの集計単位。URL の `/usage/stats/<period>` 由来で、リロード・
   * ブックマーク・戻るで同じ単位に戻すため locator に載せている。 */
  usagePeriod: StatsPeriod;
  /** which top-level screen the locator currently selects. */
  view: View;
  /** Session tab selected by the real-path locator. */
  currentTab: SessionTab | null;
  /** Structurally invalid SPA path shown inside the content area. */
  unknownPath: string | null;
  /** Session or room named by the URL that does not exist, shown in the
   * content area without changing the URL (`missingTarget()` in navigation.ts
   * decides). Held as the pair rather than as a finished sentence so the view
   * can present it as the 404 it is, with the id in its own monospace slot. */
  missingTarget: MissingTarget | null;
  currentRoomId: string | null;
  /** message anchor requested by the URL locator (`#room-mNN`), if any. */
  currentMid: number | null;
  /** session selected via the `#s<sid>` locator (DR-0008), if any. */
  currentSid: string | null;
  /** DR-0025 Phase 2: agent-transcript sub-selection under `currentSid`,
   * populated from the timeline locator's optional `agent` field. Present
   * only while the URL is `#t<sid>:<ref>`; a plain `#t<sid>` or any
   * non-timeline view leaves this null. */
  currentAgent: AgentRef | null;
  sessionTrees: Map<string, SessionTreeState>;
  /** Folded status snapshot (DR-0020 Phase 1/2), keyed by sid. Populated by
   * ws.ts's `sessionStatusSubscribe` response (initial) and kept live via
   * `ev:"session_status"` pushes, same subscribe-while-visible lifecycle as
   * SessionTreeState.timeline. Only the sid(s) SessionView currently
   * subscribes to (Files, Status, or Timeline tab open) ever have an entry here
   * — Files needs DR-0024 external_files; absence means "not subscribed", not
   * "known-empty" (Phase 3 §2.1
   * decision (a): sidebar mini badge only shows for the session currently
   * open, see SessionList.tsx). */
  sessionStatuses: Map<string, SessionStatusSnapshot>;
  /** Connected sessions whose latest main-context turn ended on a harness
   * API-error row (SessionApiError), keyed by sid. Populated by ws.ts's onOpen
   * `op:"session_errors"` fetch and kept live via `ev:"session_errors"` pushes
   * — the same one-shot + push pairing `agents` uses.
   *
   * Deliberately NOT the same thing as `sessionStatuses` above: that map only
   * ever holds the sid(s) SessionView is actively subscribed to (DR-0020 §2.1
   * (a)), whereas this one carries *every* connected session that is currently
   * stopped, which is exactly what the sidebar needs to colour other sessions'
   * rows without a status subscription per visible peer. Always replaced whole
   * (the daemon sends the full list, never a delta), so a recovered session
   * simply stops appearing. */
  sessionErrors: Map<string, SessionApiError>;
  /** Pinned sessions (DR-0021 §2.4/§3.2, SS-Q2=a), keyed by sid.
   * Source of truth is webui localStorage, NOT the daemon — main.tsx hydrates
   * this from `parsePinnedSessions(localStorage...)` once at startup
   * (`pinned/hydrated`) and persists it whenever a pin action replaces the Map
   * (subscribe-driven effect, mirrors ws.ts's since_seq
   * save-on-change; the reducer itself never touches localStorage, DR-0005
   * §1). Search-origin pins carry their jsonl `file`; arbitrary SessionView
   * pins may not have a transcript, so SessionView uses the stored file only
   * as transcript capability evidence rather than treating every pin as one. */
  pinnedSessions: Map<string, SessionSearchHit>;
  /** mention targets staged for the composer of the current room. */
  mentionTo: Set<string>;
  connStatus: ConnStatus;
  sidebarOpen: boolean;
}

export function initialState(): AppState {
  return {
    rooms: new Map(),
    roomsLoaded: false,
    peers: [],
    peersLoaded: false,
    agents: [],
    agentsLoaded: false,
    daemonInfo: null,
    hostTranslatorAvailable: false,
    terminalGatewayUrl: null,
    llmUsageAvailable: false,
    llmUsageProbes: new Map(),
    llmStatsAvailable: false,
    usageTab: "quota",
    usagePeriod: DEFAULT_STATS_PERIOD,
    view: "room",
    currentTab: null,
    unknownPath: null,
    missingTarget: null,
    currentRoomId: null,
    currentMid: null,
    currentSid: null,
    currentAgent: null,
    sessionTrees: new Map(),
    sessionStatuses: new Map(),
    sessionErrors: new Map(),
    pinnedSessions: new Map(),
    mentionTo: new Set(),
    connStatus: "connecting",
    sidebarOpen: false,
  };
}

export type Action =
  | { type: "conn/status"; status: ConnStatus }
  | { type: "rooms/loaded"; rooms: RoomSummary[] }
  // One room's `op:"room_history"` round trip (RoomView opens a room). The
  // snapshot events themselves arrive as ordinary delivered events and fold in
  // through applyProtocolEvent; these two only move the room's `history` flag.
  // Reconnect-time invalidation: a room this connection holds no `since_seq`
  // cursor for gets no delta replay, so whatever events the store still has for
  // it are a snapshot from a dead socket with an unknown gap at the end.
  // Dropping them back to "idle" makes the next open refetch.
  | { type: "rooms/history-reset"; rooms: string[] }
  | { type: "room-history/loading"; room: string }
  | { type: "room-history/loaded"; room: string; error?: string }
  | { type: "peers/loaded"; peers: PeerInfo[] }
  // Both the one-shot `op:"agents"` reply (initial paint) and the pushed
  // `ev:"agents"` stream event (subsequent changes) fold in here — the
  // reducer just replaces the list either way, same as peers/loaded.
  | { type: "agents/loaded"; agents: AgentInfo[] }
  // Both the one-shot `op:"session_errors"` reply and the pushed
  // `ev:"session_errors"` stream event fold in here (same pairing as
  // agents/loaded). The wire shape is a flat list keyed by `sid`; the reducer
  // is the one place that turns it into the by-sid Map the sidebar looks rows
  // up in, so ws.ts stays a verbatim relay.
  | { type: "session-errors/loaded"; errors: SessionErrorEntry[] }
  | { type: "daemon-info/loaded"; version: string; exe?: string; script?: string }
  | { type: "translator/availability"; host: boolean }
  | { type: "terminal-gateway/loaded"; url: string | null }
  | { type: "llm-usage/availability"; available: boolean }
  | { type: "llm-stats/availability"; available: boolean }
  | { type: "llm-usage/probed"; records: ReadonlyMap<string, ProbeRecord> }
  | { type: "protocol-event"; event: DeliveredEvent }
  | { type: "locator/changed"; locator: Locator }
  | { type: "navigation/missing"; target: MissingTarget | null }
  | { type: "mention/toggle"; id: string }
  | { type: "sidebar/set"; open: boolean }
  | { type: "fs/dir-toggled"; sid: string; path: string }
  // Additive-only counterpart of fs/dir-toggled: opens every listed path and
  // never closes one, so the auto-expand that reveals a selected file cannot
  // collapse a directory the user opened by hand.
  | { type: "fs/dirs-expanded"; sid: string; paths: readonly string[] }
  // entries on success, error on fs_list failure — never both (mirrors
  // fs/file-loaded's success/error split one line below).
  | { type: "fs/dir-loaded"; sid: string; path: string; entries?: FsEntry[]; error?: string }
  | { type: "fs/file-loading"; sid: string; path: string }
  | {
      type: "fs/file-loaded";
      sid: string;
      path: string;
      response?: FsReadResponse;
      error?: string;
      errorCode?: string;
    }
  // In-place content/lock update for a file already "loaded" — the preview
  // task-list toggle writes the flipped source straight into the cached
  // response instead of refetching, so the view updates without the
  // loading→loaded cycle that would remount the preview and lose scroll
  // position. Ignored unless the cached file is this exact path in "loaded"
  // state, so a late-arriving patch can't resurrect a navigated-away file.
  | {
      type: "fs/file-patched";
      sid: string;
      path: string;
      content: string;
      /** post-write lock tokens; omitted when the patch is a local rollback
       * (no write happened, so the tokens on file are still current). */
      mtime?: string;
      size?: number;
    }
  | { type: "timeline/loading"; sid: string }
  | {
      type: "timeline/search-changed";
      sid: string;
      search: { queryText: string; caseSensitive: boolean; regex: boolean };
    }
  | {
      type: "session-search/opened";
      hit: SessionSearchHit;
      search: { queryText: string; caseSensitive: boolean; regex: boolean };
    }
  // "replace" (initial load / refresh, before omitted) discards the cache and
  // takes the response as-is; "prepend" (older-page load) splices the older
  // lines in front of what's cached — see applyTimelineLoaded for the offset
  // bookkeeping either mode implies. error XOR response, never both.
  | {
      type: "timeline/loaded";
      sid: string;
      mode: "replace" | "prepend";
      response?: TranscriptReadResponse;
      error?: string;
    }
  // Live-tail push (DR-0009 addendum, transcript_subscribe): relayed
  // verbatim from ws.ts's `ev:"transcript"` handler. See applyTimelineTail
  // for the contiguity check that decides whether it's actually appended.
  | {
      type: "timeline/tail";
      sid: string;
      lines: string[];
      start: number;
      end: number;
      size: number;
    }
  // Drops the cached transcript of sessions whose SessionView has been
  // evicted from App's LRU (see session-view-cache.ts's
  // evictedSessionViewSids for why the transcript specifically, and why the
  // rest of the tree stays). Resets each sid's TimelineState to its initial
  // "idle" shape rather than deleting the tree, so a revisit takes the same
  // first-visit path as a session that was never opened.
  | { type: "timeline/evicted"; sids: string[] }
  // Folded status snapshot (DR-0020 Phase 1/2): dispatched both from
  // sessionStatusSubscribe's resolved response (initial paint) and from
  // ws.ts's `ev:"session_status"` push handler (every later recompute) —
  // always a full replace of the sid's entry, never a partial merge (the
  // daemon always sends the whole recomputed snapshot, see
  // SessionStatusStreamEvent's doc comment in protocol/src/index.ts).
  | { type: "session-status/loaded"; sid: string; snapshot: SessionStatusSnapshot }
  // Dispatched when SessionView's subscribe effect tears down (tab switched
  // away from Status/Timeline, session switched, or unmount) — drops the
  // cached snapshot so a stale (no-longer-live) badge/mini-panel/Status tab
  // can't linger past the unsubscribe. Matches sessionStatuses' "absence =
  // not subscribed" contract (see AppState's doc comment).
  | { type: "session-status/cleared"; sid: string }
  // Pinned sessions (DR-0021 §2.4/§3.2). "hydrated" is a full replace, fired
  // once at startup from main.tsx after reading localStorage — never
  // dispatched again afterward (unlike rooms/loaded, which can legitimately
  // re-fire on reconnect). "toggled" is SessionView's sid-keyed header action;
  // "removed" also supports the sidebar Pinned section's explicit unpin.
  | { type: "pinned/hydrated"; hits: SessionSearchHit[] }
  | { type: "pinned/added"; hit: SessionSearchHit }
  | { type: "pinned/removed"; sid: string }
  | { type: "pinned/toggled"; hit: SessionSearchHit };

/** Which room the sidebar's RoomList should highlight as "active" (kawaz
 * 2026-07-12: ROOM を選択した後も SESSIONS 側のハイライトが残ったままで、
 * 「元の SESSION クリックしても遷移しない」ように見えていた). Root cause:
 * `currentRoomId`/`currentSid` are two independently-updated fields —
 * `applyLocatorChanged`'s room branch never clears `currentSid`, and its
 * session/timeline branch never clears `currentRoomId` — deliberately, since
 * each still backs its own per-view state (SessionTreeState caching, the
 * room-mid anchor-scroll effect, etc.) across a view switch. But the
 * sidebar's "which row is highlighted" question only has one right answer:
 * whichever the locator (`state.view`) currently points at. These two
 * selectors are the single source of truth for that — RoomList/SessionList
 * must read active-ness through them, never through `currentRoomId`/
 * `currentSid` directly. */
export function selectedRoomId(state: AppState): string | null {
  return state.view === "room" ? state.currentRoomId : null;
}

/** Sidebar SessionList counterpart to `selectedRoomId` — see its doc comment
 * for the shared root-cause analysis. Active for both "session" (Files tab)
 * and "timeline" views, since SessionRowItem's href picks whichever of the
 * two a row leads to and both represent "this session is selected". */
export function selectedSid(state: AppState): string | null {
  return state.view === "session" || state.view === "timeline" ? state.currentSid : null;
}

function newRoom(id: string): RoomState {
  return {
    id,
    title: undefined,
    membersById: new Map(),
    memberOrder: [],
    msgs: new Map(),
    timeline: [],
    lastMid: 0,
    lastTs: null,
    kind: "normal",
    history: "idle",
  };
}

/** Copy-on-write room lookup: returns [room, roomsMapWithThatRoom]. */
function withRoom(rooms: Map<string, RoomState>, id: string): [RoomState, Map<string, RoomState>] {
  const existing = rooms.get(id) ?? newRoom(id);
  const next = new Map(rooms);
  next.set(id, existing);
  return [existing, next];
}

function newTimelineState(): TimelineState {
  return {
    status: "idle",
    lines: [],
    start: 0,
    end: 0,
    size: 0,
    atStart: false,
  };
}

function newSessionTree(): SessionTreeState {
  return {
    dirs: new Map(),
    dirErrors: new Map(),
    expanded: new Set(),
    selectedPath: null,
    selectedLineRange: null,
    selectedFrom: null,
    file: null,
    timeline: newTimelineState(),
    timelineSearch: { ...DEFAULT_TIMELINE_SEARCH },
  };
}

/** Copy-on-write session-tree lookup, mirrors withRoom above. */
function withSessionTree(
  trees: Map<string, SessionTreeState>,
  sid: string,
): [SessionTreeState, Map<string, SessionTreeState>] {
  const existing = trees.get(sid) ?? newSessionTree();
  const next = new Map(trees);
  next.set(sid, existing);
  return [existing, next];
}

function upsertMember(room: RoomState, m: MemberEvent): RoomState {
  const membersById = new Map(room.membersById);
  const memberOrder = membersById.has(m.id) ? room.memberOrder : [...room.memberOrder, m.id];
  membersById.set(m.id, { ...m, left: membersById.get(m.id)?.left ?? false });
  return { ...room, membersById, memberOrder };
}

function applyRoomsLoaded(state: AppState, summaries: RoomSummary[]): AppState {
  let rooms = state.rooms;
  for (const summary of summaries) {
    let room: RoomState;
    [room, rooms] = withRoom(rooms, summary.id);
    if (summary.title) room = { ...room, title: summary.title };
    if (summary.archived !== undefined) room = { ...room, archived: summary.archived };
    // DR-0013: broadcast kind reaches the initial paint via the `op:"rooms"`
    // reply — subsequent creates come through the KindEvent path in
    // applyProtocolEvent below. Absent = "normal", already the newRoom default.
    if (summary.kind !== undefined) room = { ...room, kind: summary.kind };
    room = {
      ...room,
      lastMid: summary.last_mid ?? room.lastMid,
      lastTs: summary.last_ts ?? room.lastTs,
    };
    for (const m of summary.members) room = upsertMember(room, m);
    rooms = new Map(rooms);
    rooms.set(summary.id, room);
  }
  return { ...state, rooms };
}

/** Drop the named rooms' fetched events, keeping the metadata the `op:"rooms"`
 * reply owns (title, members, last_mid — the sidebar keeps painting). Back at
 * "idle", a room refetches its history the next time it is opened. */
function forgetRoomHistories(state: AppState, roomIds: string[]): AppState {
  if (roomIds.length === 0) return state;
  const rooms = new Map(state.rooms);
  for (const id of roomIds) {
    const room = rooms.get(id);
    if (!room) continue;
    rooms.set(id, { ...room, timeline: [], msgs: new Map(), history: "idle" });
  }
  return { ...state, rooms };
}

function setRoomHistory(state: AppState, roomId: string, history: RoomState["history"]): AppState {
  const [room, rooms] = withRoom(state.rooms, roomId);
  rooms.set(roomId, { ...room, history });
  return { ...state, rooms };
}

/** Fold one delivered protocol event (subscribe backlog/live, DR-0003) into room state.
 * Every branch also refreshes `lastTs` from its own event's timestamp (member's
 * `joined_at`, everything else's `ts`) to match daemon storage.ts's `lastTs()`, which
 * takes the last *any* event's ts, not just msg — otherwise a live-subscribed client's
 * room-list order (e.g. after an archive toggle) would only match a post-reload refetch
 * once a msg happened to land afterward.
 *
 * A known room whose history hasn't been fetched yet takes the metadata half
 * only: members, title, archived, kind, lastMid, lastTs all update (the sidebar
 * row has to stay live), but nothing is appended to `timeline`/`msgs`. Such a
 * room is a sidebar entry built from the `op:"rooms"` reply, and the events
 * reaching it arrive out of order relative to history it doesn't have yet — the
 * daemon's recent-replay window pushes the last few minutes of msgs on
 * subscribe, which would otherwise sit in `timeline` *before* the older msgs a
 * later `op:"room_history"` appends. Dropping them costs nothing: the fetch
 * that runs when the room is opened includes them. */
function applyProtocolEvent(state: AppState, ev: DeliveredEvent): AppState {
  const roomId = ev.r;
  // A room the store has never seen is one the daemon just introduced — a fresh
  // create_room, or an invite that added this client — and it introduces it by
  // delivering the room's whole snapshot. That IS the history, so the room is
  // born "loaded" and folds events normally; only a room already known (and
  // therefore already listed without its events) waits for an explicit fetch.
  const known = state.rooms.has(roomId);
  let [room, rooms] = withRoom(state.rooms, roomId);
  if (!known) room = { ...room, history: "loaded" };
  // "loading" counts as painted: the history snapshot's own events arrive
  // between the request and its reply, so waiting for "loaded" would drop the
  // very events being fetched. The only other events that can land in that
  // window are live ones the daemon delivered after the request left the client
  // and before it handled it; a msg among them dedups by mid below, and a
  // duplicated member/title line in `timeline` is the accepted cost of not
  // buffering a whole second event queue for a sub-millisecond race.
  const painted = room.history === "loading" || room.history === "loaded";
  const withEvent = (r: RoomState, appended: DeliveredEvent): RoomState =>
    painted ? { ...r, timeline: [...r.timeline, appended] } : r;
  switch (ev.type) {
    case "member":
      room = upsertMember(room, ev);
      room = { ...withEvent(room, ev), lastTs: ev.joined_at };
      break;
    case "leave": {
      const membersById = new Map(room.membersById);
      const m = membersById.get(ev.id);
      if (m) membersById.set(ev.id, { ...m, left: true });
      room = { ...withEvent({ ...room, membersById }, ev), lastTs: ev.ts };
      break;
    }
    case "msg":
      if (painted && !room.msgs.has(ev.mid)) {
        const msgs = new Map(room.msgs);
        msgs.set(ev.mid, ev);
        room = { ...room, msgs, timeline: [...room.timeline, ev] };
      }
      room = { ...room, lastMid: Math.max(room.lastMid, ev.mid), lastTs: ev.ts };
      break;
    case "title":
      room = { ...withEvent(room, ev), title: ev.title, lastTs: ev.ts };
      break;
    case "archive":
      room = { ...withEvent(room, ev), archived: ev.archived, lastTs: ev.ts };
      break;
    case "kind":
      // DR-0013: KindEvent lands in a fresh broadcast room's initial snapshot
      // (deliverNewRoom → sendBacklog); folding it into room.kind keeps the
      // sidebar badge and Composer variant live even without an intervening
      // `op:"rooms"` refresh. lastTs bumped like the other display-metadata
      // events so the room-list order matches storage.ts's lastTs() at the
      // moment the new broadcast lands.
      room = { ...room, kind: ev.kind, timeline: [...room.timeline, ev], lastTs: ev.ts };
      break;
    case "next":
    case "prev":
      room = { ...room, timeline: [...room.timeline, ev], lastTs: ev.ts };
      break;
    default:
      return state;
  }
  rooms = new Map(rooms);
  rooms.set(roomId, room);
  return { ...state, rooms };
}

/** Fold a URL-locator change (DR-0008: `#rXXXX[-mNN]` or `#s<sid>[:<path>]`;
 * DR-0009: `#t<sid>`) into which top-level view is shown and which
 * room/session(+path) it points at. This only records *what's selected*; it
 * doesn't fetch anything — FileTree/FileViewer/Timeline own the
 * fs_list/fs_read/transcript_read round trips their own useEffects trigger
 * off `currentSid`/`selectedPath`/`timeline.status` (DR-0005 §1: reducer
 * stays pure, effects live in components/ws.ts). */
function agentRefKey(agent: AgentRef | null | undefined): string {
  if (!agent) return "";
  return `${agent.runId ?? ""}|${agent.agentId ?? ""}|${agent.teammate ?? ""}`;
}

function applyLocatorChanged(state: AppState, locator: Locator): AppState {
  if (locator.view === "unknown") {
    return { ...state, unknownPath: locator.pathname, sidebarOpen: false };
  }
  if (locator.view === "session-root") return state;
  if (locator.view === "usage") {
    // Leaves currentSid/currentRoomId alone: the usage screen is a detour, and
    // keeping the selection means the sidebar still shows where the user came
    // from and the back button returns to a live view.
    return {
      ...state,
      view: "usage",
      usageTab: locator.tab,
      // The span survives a hop to the quota tab and back, so returning to
      // spend lands on what was being read rather than resetting.
      ...(locator.tab === "stats" ? { usagePeriod: locator.period } : {}),
      currentTab: null,
      unknownPath: null,
      missingTarget: null,
      currentAgent: null,
      mentionTo: new Set(),
      sidebarOpen: false,
    };
  }
  if (locator.view === "room") {
    return {
      ...state,
      view: "room",
      currentTab: null,
      unknownPath: null,
      missingTarget: null,
      currentRoomId: locator.room,
      currentMid: locator.mid,
      currentAgent: null,
      mentionTo: new Set(),
      sidebarOpen: false,
    };
  }
  if (locator.view === "timeline") {
    // Ensures a tree (and its nested idle TimelineState) exists so Timeline's
    // effect has something to read on first visit — same reasoning as the
    // session/path branch below, just without a selectedPath to set.
    let [, sessionTrees] = withSessionTree(state.sessionTrees, locator.sid);
    const nextAgent = locator.agent ?? null;
    // DR-0025 Phase 2: agent ref switch invalidates the timeline byte-cache
    // (different underlying jsonl file). Reset the sid's TimelineState so
    // Timeline's initial-load effect refetches with the new agent params.
    if (agentRefKey(state.currentAgent) !== agentRefKey(nextAgent)) {
      const tree = sessionTrees.get(locator.sid);
      if (tree) {
        sessionTrees = new Map(sessionTrees);
        sessionTrees.set(locator.sid, {
          ...tree,
          timeline: {
            status: "idle",
            lines: [],
            start: 0,
            end: 0,
            size: 0,
            atStart: false,
          },
        });
      }
    }
    return {
      ...state,
      view: "timeline",
      currentTab: "timeline",
      unknownPath: null,
      missingTarget: null,
      currentSid: locator.sid,
      currentAgent: nextAgent,
      sessionTrees,
      mentionTo: new Set(),
      sidebarOpen: false,
    };
  }
  let [tree, sessionTrees] = withSessionTree(state.sessionTrees, locator.sid);
  const selectedLineRange = locator.lineRange ?? null;
  const selectedFrom = locator.from ?? null;
  if (
    tree.selectedPath !== locator.path ||
    tree.selectedLineRange?.start !== selectedLineRange?.start ||
    tree.selectedLineRange?.end !== selectedLineRange?.end ||
    tree.selectedFrom !== selectedFrom
  ) {
    tree = { ...tree, selectedPath: locator.path, selectedLineRange, selectedFrom };
    sessionTrees = new Map(sessionTrees);
    sessionTrees.set(locator.sid, tree);
  }
  return {
    ...state,
    view: "session",
    currentTab: locator.tab ?? "files",
    unknownPath: null,
    missingTarget: null,
    currentSid: locator.sid,
    currentAgent: null,
    sessionTrees,
    mentionTo: new Set(),
    sidebarOpen: false,
  };
}

/** Fold `timeline/loaded` into the sid's cached TimelineState (DR-0009). Two
 * merge modes, matching the two calls Timeline.tsx makes:
 *  - "replace" (before omitted: initial load or the "更新" refresh button)
 *    discards whatever was cached and takes the response as the new tail.
 *  - "prepend" ("older を読み込む": before = current `start`) splices the
 *    older page in front of the cached lines. `end` deliberately keeps the
 *    *previous* value rather than the response's own `end` — this page's
 *    `end` describes where *this older batch* stops (at/around the old
 *    `start`), not how far into the file we've read overall, which is still
 *    bounded by the last tail read. `start` moves back to the response's
 *    `start`, becoming the new "how far back have we loaded" boundary for any
 *    further "older" page. */
function applyTimelineLoaded(
  state: AppState,
  action: Extract<Action, { type: "timeline/loaded" }>,
): AppState {
  const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
  if (action.error !== undefined) {
    sessionTrees.set(action.sid, {
      ...tree,
      timeline: { ...tree.timeline, status: "error", error: action.error },
    });
    return { ...state, sessionTrees };
  }
  const res = action.response;
  if (!res) return state; // unreachable: loaded always carries error xor response
  const prev = tree.timeline;
  const lines = action.mode === "prepend" ? [...res.lines, ...prev.lines] : res.lines;
  const timeline: TimelineState = {
    status: "loaded",
    lines,
    start: res.start,
    end: action.mode === "prepend" ? prev.end : res.end,
    size: res.size,
    atStart: res.start === 0,
  };
  sessionTrees.set(action.sid, { ...tree, timeline });
  return { ...state, sessionTrees };
}

/** Fold a `timeline/tail` live-tail push into the sid's cached TimelineState
 * (DR-0009 addendum). Only appended when contiguous with what's cached
 * (`action.start === tree.timeline.end`) and the cache is actually
 * "loaded" — a subscribe response can start delivering before the initial
 * transcript_read lands, or the tail's `start` can land mid-gap after a
 * "load older" page (whose `end` deliberately doesn't move, see
 * applyTimelineLoaded). Still "loaded" but non-contiguous (the gap case, not
 * the not-loaded-yet case) sets `needsResync` instead of just dropping the
 * push — without it the daemon's tail cursor and this cache's `end` diverge
 * permanently (every later push's `start` keeps tracking the daemon's
 * cursor, never this cache's stale `end` again), so live tail would go
 * silent until a manual "更新" click. Timeline.tsx's resync effect reads
 * `needsResync` and issues the background re-read that clears it (via the
 * next `timeline/loaded`, which constructs a fresh TimelineState with no
 * `needsResync` field at all). While a resync is already flagged, further
 * pushes are dropped without re-flagging (`prev.needsResync` guard) so the
 * effect isn't re-triggered on every subsequent push before its own re-read
 * lands. */
function applyTimelineTail(
  state: AppState,
  action: Extract<Action, { type: "timeline/tail" }>,
): AppState {
  const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
  const prev = tree.timeline;
  if (prev.status !== "loaded" || prev.needsResync) return state;
  if (action.start !== prev.end) {
    const timeline: TimelineState = { ...prev, needsResync: true };
    sessionTrees.set(action.sid, { ...tree, timeline });
    return { ...state, sessionTrees };
  }
  const timeline: TimelineState = {
    ...prev,
    lines: [...prev.lines, ...action.lines],
    end: action.end,
    size: action.size,
  };
  sessionTrees.set(action.sid, { ...tree, timeline });
  return { ...state, sessionTrees };
}

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "conn/status":
      return { ...state, connStatus: action.status };
    case "rooms/history-reset":
      return forgetRoomHistories(state, action.rooms);
    case "rooms/loaded":
      return { ...applyRoomsLoaded(state, action.rooms), roomsLoaded: true };
    case "room-history/loading":
      return setRoomHistory(state, action.room, "loading");
    case "room-history/loaded":
      return setRoomHistory(state, action.room, action.error !== undefined ? "error" : "loaded");
    case "peers/loaded":
      return { ...state, peers: action.peers, peersLoaded: true };
    case "agents/loaded":
      return { ...state, agents: action.agents, agentsLoaded: true };
    case "session-errors/loaded":
      return {
        ...state,
        sessionErrors: new Map(
          action.errors.map((e) => [e.sid, { text: e.text, timestamp: e.timestamp }]),
        ),
      };
    case "daemon-info/loaded":
      return {
        ...state,
        daemonInfo: { version: action.version, exe: action.exe, script: action.script },
      };
    case "translator/availability":
      return { ...state, hostTranslatorAvailable: action.host };
    case "terminal-gateway/loaded":
      return { ...state, terminalGatewayUrl: action.url };
    case "llm-usage/availability":
      return { ...state, llmUsageAvailable: action.available };
    case "llm-stats/availability":
      return { ...state, llmStatsAvailable: action.available };
    // Merged rather than replaced: a probe that failed for one credential
    // still answered for the others, and dropping the ones it did not mention
    // would lose readings the failure says nothing about.
    case "llm-usage/probed": {
      if (action.records.size === 0) return state;
      const llmUsageProbes = new Map(state.llmUsageProbes);
      for (const [name, record] of action.records) llmUsageProbes.set(name, record);
      return { ...state, llmUsageProbes };
    }
    case "protocol-event":
      return applyProtocolEvent(state, action.event);
    case "locator/changed":
      return applyLocatorChanged(state, action.locator);
    case "navigation/missing":
      return { ...state, missingTarget: action.target };
    case "mention/toggle": {
      const mentionTo = new Set(state.mentionTo);
      if (mentionTo.has(action.id)) mentionTo.delete(action.id);
      else mentionTo.add(action.id);
      return { ...state, mentionTo };
    }
    case "fs/dir-toggled": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      const expanded = new Set(tree.expanded);
      if (expanded.has(action.path)) expanded.delete(action.path);
      else expanded.add(action.path);
      sessionTrees.set(action.sid, { ...tree, expanded });
      return { ...state, sessionTrees };
    }
    case "fs/dirs-expanded": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      // Identity-stable when everything asked for is already open — the
      // caller re-runs on tree changes and a fresh Set each time would
      // re-render the whole tree for nothing.
      if (action.paths.every((path) => tree.expanded.has(path))) return state;
      const expanded = new Set(tree.expanded);
      for (const path of action.paths) expanded.add(path);
      sessionTrees.set(action.sid, { ...tree, expanded });
      return { ...state, sessionTrees };
    }
    case "fs/dir-loaded": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      const dirs = new Map(tree.dirs);
      const dirErrors = new Map(tree.dirErrors);
      if (action.error !== undefined) {
        dirErrors.set(action.path, action.error);
        dirs.delete(action.path);
      } else {
        dirs.set(action.path, action.entries ?? []);
        dirErrors.delete(action.path);
      }
      sessionTrees.set(action.sid, { ...tree, dirs, dirErrors });
      return { ...state, sessionTrees };
    }
    case "fs/file-loading": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      sessionTrees.set(action.sid, {
        ...tree,
        file: { path: action.path, status: "loading" },
      });
      return { ...state, sessionTrees };
    }
    case "fs/file-loaded": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      const file: FileViewState =
        action.error !== undefined
          ? {
              path: action.path,
              status: "error",
              error: action.error,
              ...(action.errorCode !== undefined ? { errorCode: action.errorCode } : {}),
            }
          : { path: action.path, status: "loaded", response: action.response };
      sessionTrees.set(action.sid, { ...tree, file });
      return { ...state, sessionTrees };
    }
    case "fs/file-patched": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      const current = tree.file;
      if (!current || current.path !== action.path || current.status !== "loaded") return state;
      const response = current.response;
      if (!response) return state; // unreachable: "loaded" always carries a response
      sessionTrees.set(action.sid, {
        ...tree,
        file: {
          ...current,
          response: {
            ...response,
            content: action.content,
            ...(action.mtime !== undefined ? { mtime: action.mtime } : {}),
            ...(action.size !== undefined ? { size: action.size } : {}),
          },
        },
      });
      return { ...state, sessionTrees };
    }
    case "sidebar/set":
      return { ...state, sidebarOpen: action.open };
    case "timeline/search-changed": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      sessionTrees.set(action.sid, { ...tree, timelineSearch: action.search });
      return { ...state, sessionTrees };
    }
    case "session-search/opened": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.hit.sid);
      sessionTrees.set(action.hit.sid, {
        ...tree,
        searchHit: action.hit,
        timelineSearch: action.search,
      });
      return { ...state, sessionTrees };
    }
    case "timeline/loading": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      sessionTrees.set(action.sid, {
        ...tree,
        timeline: { ...tree.timeline, status: "loading", error: undefined },
      });
      return { ...state, sessionTrees };
    }
    case "timeline/evicted": {
      // Only touch sids that actually hold something — an eviction for a
      // session whose Timeline was never opened must not fabricate a tree
      // entry (absence is meaningful for `sessionTrees` the same way it is
      // for `sessionStatuses`), and re-idling an already-idle timeline would
      // hand every subscriber a new state object for no change.
      const targets = action.sids.filter((sid) => {
        const timeline = state.sessionTrees.get(sid)?.timeline;
        return timeline !== undefined && timeline.status !== "idle";
      });
      if (targets.length === 0) return state;
      const sessionTrees = new Map(state.sessionTrees);
      for (const sid of targets) {
        const tree = sessionTrees.get(sid);
        if (!tree) continue; // unreachable: filtered above
        sessionTrees.set(sid, { ...tree, timeline: newTimelineState() });
      }
      return { ...state, sessionTrees };
    }
    case "timeline/loaded":
      return applyTimelineLoaded(state, action);
    case "timeline/tail":
      return applyTimelineTail(state, action);
    case "session-status/loaded": {
      const sessionStatuses = new Map(state.sessionStatuses);
      sessionStatuses.set(action.sid, action.snapshot);
      return { ...state, sessionStatuses };
    }
    case "session-status/cleared": {
      if (!state.sessionStatuses.has(action.sid)) return state;
      const sessionStatuses = new Map(state.sessionStatuses);
      sessionStatuses.delete(action.sid);
      return { ...state, sessionStatuses };
    }
    case "pinned/hydrated": {
      const pinnedSessions = new Map(action.hits.map((hit) => [hit.sid, hit] as const));
      return { ...state, pinnedSessions };
    }
    case "pinned/added": {
      const pinnedSessions = new Map(state.pinnedSessions);
      pinnedSessions.set(action.hit.sid, action.hit);
      return { ...state, pinnedSessions };
    }
    case "pinned/removed": {
      if (!state.pinnedSessions.has(action.sid)) return state;
      const pinnedSessions = new Map(state.pinnedSessions);
      pinnedSessions.delete(action.sid);
      return { ...state, pinnedSessions };
    }
    case "pinned/toggled": {
      const pinnedSessions = new Map(state.pinnedSessions);
      if (pinnedSessions.has(action.hit.sid)) pinnedSessions.delete(action.hit.sid);
      else pinnedSessions.set(action.hit.sid, action.hit);
      return { ...state, pinnedSessions };
    }
    default:
      return state;
  }
}
