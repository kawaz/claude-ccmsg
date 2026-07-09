// Central store for the webui client (DR-0005 §1): typed AppState, a typed
// Action union, and a pure reducer. WS-delivered protocol events are folded in
// through the same `protocol-event` action as UI-originated actions (mention
// toggle, locator change, ...) so there is exactly one state-transition path.
// Effects (WS connect/reconnect, hello/subscribe handshake, localStorage) live
// in ws.ts and dispatch actions here; nothing in this file touches the network
// or the DOM.
import type { DeliveredEvent, MemberEvent, PeerInfo, RoomSummary } from "@ccmsg/protocol";

/** Reserved uid for the User (kawaz); mirrors @ccmsg/protocol USER_UID. */
export const USER_UID = 0;

export interface MemberInfo extends MemberEvent {
  left: boolean;
}

export interface RoomState {
  id: string;
  title?: string;
  membersByUid: Map<number, MemberInfo>;
  memberOrder: number[];
  msgs: Map<number, DeliveredEvent & { type: "msg" }>;
  timeline: DeliveredEvent[];
  lastMid: number;
  lastTs: string | null;
}

export type ConnStatus = "connecting" | "connected" | "disconnected" | "restarting";

export interface AppState {
  rooms: Map<string, RoomState>;
  peers: PeerInfo[];
  currentRoomId: string | null;
  /** message anchor requested by the URL locator (`#room-mNN`), if any. */
  currentMid: number | null;
  /** mention targets staged for the composer of the current room. */
  mentionTo: Set<number>;
  connStatus: ConnStatus;
  sidebarOpen: boolean;
}

export function initialState(): AppState {
  return {
    rooms: new Map(),
    peers: [],
    currentRoomId: null,
    currentMid: null,
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
  | { type: "locator/changed"; room: string | null; mid: number | null }
  | { type: "mention/toggle"; uid: number }
  | { type: "sidebar/set"; open: boolean };

function newRoom(id: string): RoomState {
  return {
    id,
    title: undefined,
    membersByUid: new Map(),
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

function upsertMember(room: RoomState, m: MemberEvent): RoomState {
  const membersByUid = new Map(room.membersByUid);
  const memberOrder = membersByUid.has(m.uid) ? room.memberOrder : [...room.memberOrder, m.uid];
  membersByUid.set(m.uid, { ...m, left: membersByUid.get(m.uid)?.left ?? false });
  return { ...room, membersByUid, memberOrder };
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
      const membersByUid = new Map(room.membersByUid);
      const m = membersByUid.get(ev.uid);
      if (m) membersByUid.set(ev.uid, { ...m, left: true });
      room = { ...room, membersByUid, timeline: [...room.timeline, ev] };
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
      return {
        ...state,
        currentRoomId: action.room,
        currentMid: action.mid,
        mentionTo: new Set(),
        sidebarOpen: false,
      };
    case "mention/toggle": {
      const mentionTo = new Set(state.mentionTo);
      if (mentionTo.has(action.uid)) mentionTo.delete(action.uid);
      else mentionTo.add(action.uid);
      return { ...state, mentionTo };
    }
    case "sidebar/set":
      return { ...state, sidebarOpen: action.open };
    default:
      return state;
  }
}
