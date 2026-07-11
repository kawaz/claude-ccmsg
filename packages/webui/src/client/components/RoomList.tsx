import type { AppState, RoomState } from "../store.ts";
import { roomHref } from "../locator.ts";
import { activeRoomsSorted, relTime, splitRoomsByArchived } from "../utils.ts";

function RoomRow({ room, active }: { room: RoomState; active: boolean }) {
  const memberCount = [...room.membersById.values()].filter((m) => !m.left).length;
  return (
    <li key={room.id} class={active ? "active" : undefined}>
      <a href={roomHref(room.id)}>
        <span class="room-title">{room.title || room.id}</span>
        <span class="room-meta">
          {memberCount} 名 · #{room.lastMid} · {relTime(room.lastTs)}
        </span>
      </a>
    </li>
  );
}

/** DR-0012: room list splits into "非アーカイブ" (shown as before) and a
 * collapsed "アーカイブ (N)" `<details>` at the bottom, default-closed —
 * archived rooms are still reachable (click through like any other room),
 * just folded out of the way so an ever-growing room count doesn't crowd the
 * sidebar (kawaz: 「今だと無限にルームが増える」). No `<details>` at all when
 * there are zero archived rooms, so the common case shows exactly the same
 * list as before this feature. */
export function RoomList({ state }: { state: AppState }) {
  const { active, archived } = splitRoomsByArchived(activeRoomsSorted(state.rooms));
  return (
    <>
      <ul id="room-list">
        {active.map((room) => (
          <RoomRow key={room.id} room={room} active={room.id === state.currentRoomId} />
        ))}
      </ul>
      {archived.length > 0 && (
        <details id="room-list-archived">
          <summary>アーカイブ ({archived.length})</summary>
          <ul>
            {archived.map((room) => (
              <RoomRow key={room.id} room={room} active={room.id === state.currentRoomId} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
