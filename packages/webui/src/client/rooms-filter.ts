// Pure derivations for SessionView's Rooms tab (U3): which rooms a given
// session participates in, and which other connected sessions share its cwd
// (so their rooms can be surfaced as a secondary "related" section). Kept out
// of utils.ts as a standalone module — these read `state.rooms`/`state.peers`
// directly rather than a single PeerInfo/RoomState like utils.ts's helpers,
// and are exercised in isolation by rooms-filter.test.ts.
import type { PeerInfo } from "@ccmsg/protocol";
import type { RoomState } from "./store.ts";

/** Rooms the given session (`sid`) currently participates in: any room with
 * an active (not-left) member row whose `sid` field matches. A room's member
 * rows are keyed by member id (`a1`, `u2`, ...), not sid, so this scans
 * values rather than doing a Map.get. */
export function roomsForSession(rooms: Map<string, RoomState>, sid: string): RoomState[] {
  return [...rooms.values()].filter((room) =>
    [...room.membersById.values()].some((m) => m.sid === sid && !m.left),
  );
}

/** Other connected sessions sharing `sid`'s cwd, self excluded. `sid` not
 * found in `peers` (e.g. it disconnected) yields an empty list rather than
 * throwing — same "peer absent = nothing to show" policy SessionView already
 * applies to `hasTranscript`. */
export function sameCwdSids(peers: PeerInfo[], sid: string): string[] {
  const self = peers.find((p) => p.sid === sid);
  if (!self) return [];
  return peers.filter((p) => p.sid !== sid && p.cwd === self.cwd).map((p) => p.sid);
}

/** Rooms any session in `sids` participates in, excluding rooms already
 * present in `exclude` — used to keep the "同 cwd セッションが参加中の room"
 * section from repeating rooms already listed under "このセッションが参加中
 * の room". */
export function roomsForSids(
  rooms: Map<string, RoomState>,
  sids: string[],
  exclude: RoomState[] = [],
): RoomState[] {
  const excludeIds = new Set(exclude.map((r) => r.id));
  const sidSet = new Set(sids);
  return [...rooms.values()].filter(
    (room) =>
      !excludeIds.has(room.id) &&
      [...room.membersById.values()].some((m) => sidSet.has(m.sid) && !m.left),
  );
}
