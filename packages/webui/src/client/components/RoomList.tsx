import type { AppState, RoomState } from "../store.ts";
import { selectedRoomId } from "../store.ts";
import { roomHref } from "../locator.ts";
import { activeRoomsSorted, relTime, splitRoomsByArchived } from "../utils.ts";

function RoomRow({ room, active }: { room: RoomState; active: boolean }) {
  const memberCount = [...room.membersById.values()].filter((m) => !m.left).length;
  // DR-0013: broadcast rooms carry a small text badge in the row title. The
  // badge sits at the left so ellipsis clips the title tail (not the badge)
  // when the sidebar is narrow; a background color via `.room-kind-badge`
  // makes it read as a chip in both light and dark themes without invasive
  // markup. Text-based (not an emoji glyph) so screen readers pronounce it.
  return (
    <li key={room.id} class={active ? "active" : undefined}>
      <a href={roomHref(room.id)}>
        <span class="room-title">
          {room.kind === "broadcast" && (
            <span class="room-kind-badge" title="broadcast room (DR-0013)">
              BC
            </span>
          )}
          {room.title || room.id}
        </span>
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
  const currentRoomId = selectedRoomId(state);
  return (
    <>
      <ul id="room-list">
        {active.map((room) => (
          <RoomRow key={room.id} room={room} active={room.id === currentRoomId} />
        ))}
      </ul>
      {archived.length > 0 && (
        <details id="room-list-archived">
          <summary>アーカイブ ({archived.length})</summary>
          <ul>
            {archived.map((room) => (
              <RoomRow key={room.id} room={room} active={room.id === currentRoomId} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}
