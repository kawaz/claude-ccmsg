// DR-0014 の 1on1 room の引き当て。セッションの Timeline が、そのセッションの
// 1on1 room に記録された say を自分の TL に重ねるために使う。
import type { AppState, RoomState } from "./store.ts";

/** Find an existing `kind:"1on1"` room whose single non-u1 member sid matches
 * `sid`. Distinguished by `room.kind` alone (title strings are display-only
 * per DR-0014 §2.1: "判別は kind フィールドで行う"). Returns null when no such
 * room exists. */
export function findExistingOneOnOne(state: AppState, sid: string): RoomState | null {
  for (const room of state.rooms.values()) {
    if (room.kind !== "1on1") continue;
    // u1 is implicit (no member row per DR-0006), so the room's member list
    // is exactly the target session — modulo "left" flags after a kick or
    // leave. Filter to present members and require exactly one, matching sid.
    const present = [...room.membersById.values()].filter((m) => !m.left);
    if (present.length !== 1) continue;
    if (present[0]!.sid === sid) return room;
  }
  return null;
}
