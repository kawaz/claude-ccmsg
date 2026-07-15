import type { AppState, RoomState } from "../store.ts";
import { selectedRoomId } from "../store.ts";
import { roomHref } from "../locator.ts";
import { activeRoomsSorted, relTime, splitRoomsByArchived, splitRoomsByKind } from "../utils.ts";

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

/** Room list splits into a flat section (non-archived, non-1on1 rooms, shown
 * as before) and two collapsed `<details>` groups below it, both
 * default-closed (no `open` attribute): "1on1 (N)" (mid=61, same folding
 * pattern applied to `kind:"1on1"` rooms) and "アーカイブ (N)" (DR-0012).
 * Rooms in either group stay reachable (click through like any other room),
 * just folded out of the way so an ever-growing room count doesn't crowd the
 * sidebar. An archived 1on1 room lands in the アーカイブ group, not
 * duplicated into both — `splitRoomsByArchived` runs first, then
 * `splitRoomsByKind` only sees what's left. Either `<details>` is omitted
 * entirely when its group is empty, so the common case (no archived, no
 * 1on1) shows exactly the flat list. */
export function RoomList({ state }: { state: AppState }) {
  const { active, archived } = splitRoomsByArchived(activeRoomsSorted(state.rooms));
  const { flat, oneOnOne } = splitRoomsByKind(active);
  const currentRoomId = selectedRoomId(state);
  return (
    <>
      <ul id="room-list">
        {flat.map((room) => (
          <RoomRow key={room.id} room={room} active={room.id === currentRoomId} />
        ))}
      </ul>
      {oneOnOne.length > 0 && (
        <details id="room-list-1on1">
          <summary>1on1 ({oneOnOne.length})</summary>
          <ul>
            {oneOnOne.map((room) => (
              <RoomRow key={room.id} room={room} active={room.id === currentRoomId} />
            ))}
          </ul>
        </details>
      )}
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
