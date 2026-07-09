import type { AppState } from "../store.ts";
import { roomHref } from "../locator.ts";
import { activeRoomsSorted, relTime } from "../utils.ts";

export function RoomList({ state }: { state: AppState }) {
  return (
    <ul id="room-list">
      {activeRoomsSorted(state.rooms).map((room) => {
        const memberCount = [...room.membersByUid.values()].filter((m) => !m.left).length;
        return (
          <li key={room.id} class={room.id === state.currentRoomId ? "active" : undefined}>
            <a href={roomHref(room.id)}>
              <span class="room-title">{room.title || room.id}</span>
              <span class="room-meta">
                {memberCount} 名 · #{room.lastMid} · {relTime(room.lastTs)}
              </span>
            </a>
          </li>
        );
      })}
    </ul>
  );
}
