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
  type DeliveredEvent,
  type FsEntry,
  type FsReadResponse,
  type MemberEvent,
  type PeerInfo,
  type RoomSummary,
  type TranscriptReadResponse,
} from "@ccmsg/protocol";
import type { Locator } from "./locator.ts";

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
}

export type ConnStatus = "connecting" | "connected" | "disconnected" | "restarting";

export type View = "room" | "session" | "timeline";

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
}

/** Per-session file-browsing state (DR-0008), keyed by sid in AppState so
 * switching between sessions preserves each one's expanded dirs / loaded
 * listings / open file instead of refetching on every visit. Also holds the
 * session's Timeline cache (DR-0009) — same per-sid keying, same rationale. */
export interface SessionTreeState {
  /** loaded directory listings, keyed by relpath ("" = session root) */
  dirs: Map<string, FsEntry[]>;
  /** fs_list error message for a relpath that failed to load, keyed the same as `dirs` */
  dirErrors: Map<string, string>;
  /** relpaths currently expanded in the tree UI */
  expanded: Set<string>;
  /** relpath selected via the `#s<sid>:<relpath>` locator, if any */
  selectedPath: string | null;
  file: FileViewState | null;
  timeline: TimelineState;
}

export interface AppState {
  rooms: Map<string, RoomState>;
  peers: PeerInfo[];
  /** which top-level screen the locator currently selects. */
  view: View;
  currentRoomId: string | null;
  /** message anchor requested by the URL locator (`#room-mNN`), if any. */
  currentMid: number | null;
  /** session selected via the `#s<sid>` locator (DR-0008), if any. */
  currentSid: string | null;
  sessionTrees: Map<string, SessionTreeState>;
  /** mention targets staged for the composer of the current room. */
  mentionTo: Set<string>;
  connStatus: ConnStatus;
  sidebarOpen: boolean;
}

export function initialState(): AppState {
  return {
    rooms: new Map(),
    peers: [],
    view: "room",
    currentRoomId: null,
    currentMid: null,
    currentSid: null,
    sessionTrees: new Map(),
    mentionTo: new Set(),
    connStatus: "connecting",
    sidebarOpen: false,
  };
}

export type Action =
  | { type: "conn/status"; status: ConnStatus }
  | { type: "rooms/loaded"; rooms: RoomSummary[] }
  | { type: "peers/loaded"; peers: PeerInfo[] }
  | { type: "protocol-event"; event: DeliveredEvent }
  | { type: "locator/changed"; locator: Locator }
  | { type: "mention/toggle"; id: string }
  | { type: "sidebar/set"; open: boolean }
  | { type: "fs/dir-toggled"; sid: string; path: string }
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
    }
  | { type: "timeline/loading"; sid: string }
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
    };

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
    file: null,
    timeline: newTimelineState(),
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

/** Fold one delivered protocol event (subscribe backlog/live, DR-0003) into room state. */
function applyProtocolEvent(state: AppState, ev: DeliveredEvent): AppState {
  const roomId = ev.r;
  let [room, rooms] = withRoom(state.rooms, roomId);
  switch (ev.type) {
    case "member":
      room = upsertMember(room, ev);
      room = { ...room, timeline: [...room.timeline, ev] };
      break;
    case "leave": {
      const membersById = new Map(room.membersById);
      const m = membersById.get(ev.id);
      if (m) membersById.set(ev.id, { ...m, left: true });
      room = { ...room, membersById, timeline: [...room.timeline, ev] };
      break;
    }
    case "msg":
      if (!room.msgs.has(ev.mid)) {
        const msgs = new Map(room.msgs);
        msgs.set(ev.mid, ev);
        room = { ...room, msgs, timeline: [...room.timeline, ev] };
      }
      room = { ...room, lastMid: Math.max(room.lastMid, ev.mid), lastTs: ev.ts };
      break;
    case "title":
      room = { ...room, title: ev.title, timeline: [...room.timeline, ev] };
      break;
    case "next":
    case "prev":
      room = { ...room, timeline: [...room.timeline, ev] };
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
function applyLocatorChanged(state: AppState, locator: Locator): AppState {
  if (locator.view === "room") {
    return {
      ...state,
      view: "room",
      currentRoomId: locator.room,
      currentMid: locator.mid,
      mentionTo: new Set(),
      sidebarOpen: false,
    };
  }
  if (locator.view === "timeline") {
    // Ensures a tree (and its nested idle TimelineState) exists so Timeline's
    // effect has something to read on first visit — same reasoning as the
    // session/path branch below, just without a selectedPath to set.
    const [, sessionTrees] = withSessionTree(state.sessionTrees, locator.sid);
    return {
      ...state,
      view: "timeline",
      currentSid: locator.sid,
      sessionTrees,
      mentionTo: new Set(),
      sidebarOpen: false,
    };
  }
  let [tree, sessionTrees] = withSessionTree(state.sessionTrees, locator.sid);
  if (tree.selectedPath !== locator.path) {
    tree = { ...tree, selectedPath: locator.path };
    sessionTrees = new Map(sessionTrees);
    sessionTrees.set(locator.sid, tree);
  }
  return {
    ...state,
    view: "session",
    currentSid: locator.sid,
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

export function reducer(state: AppState, action: Action): AppState {
  switch (action.type) {
    case "conn/status":
      return { ...state, connStatus: action.status };
    case "rooms/loaded":
      return applyRoomsLoaded(state, action.rooms);
    case "peers/loaded":
      return { ...state, peers: action.peers };
    case "protocol-event":
      return applyProtocolEvent(state, action.event);
    case "locator/changed":
      return applyLocatorChanged(state, action.locator);
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
          ? { path: action.path, status: "error", error: action.error }
          : { path: action.path, status: "loaded", response: action.response };
      sessionTrees.set(action.sid, { ...tree, file });
      return { ...state, sessionTrees };
    }
    case "sidebar/set":
      return { ...state, sidebarOpen: action.open };
    case "timeline/loading": {
      const [tree, sessionTrees] = withSessionTree(state.sessionTrees, action.sid);
      sessionTrees.set(action.sid, {
        ...tree,
        timeline: { ...tree.timeline, status: "loading", error: undefined },
      });
      return { ...state, sessionTrees };
    }
    case "timeline/loaded":
      return applyTimelineLoaded(state, action);
    default:
      return state;
  }
}
