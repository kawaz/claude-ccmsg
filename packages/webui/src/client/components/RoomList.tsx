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

/** Room list layout (top → bottom):
 * 1. Flat `#room-list` at top — broadcast rooms only (kawaz r55m30:
 *    broadcast は常にセクション群の一番上、折り畳まないで直置き)。
 * 2. `<details id="room-list-normal" open>` "ルーム (N)" — 通常 room
 *    (非アーカイブ・非1on1・非broadcast) を折り畳み可能に。以前はフラット
 *    に並んでいたが、数が増えると邪魔なのでセクション化。デフォルト open
 *    で今までの見え方を維持しつつユーザが畳めるようにする (kawaz r55m30)。
 * 3. `<details id="room-list-1on1">` "1on1 (N)" (default-closed, mid=61)。
 * 4. `<details id="room-list-archived">` "アーカイブ (N)" (default-closed,
 *    DR-0012)。
 * Rooms in any `<details>` stay reachable (click through like any other
 * room). Each `<details>` (と broadcast の flat `<ul>`) は自グループが空
 * のとき丸ごと省略される。An archived 1on1 room lands in the アーカイブ
 * group, not duplicated — `splitRoomsByArchived` runs first, then
 * `splitRoomsByKind` only sees what's left, then broadcast は `flat` から
 * kind で更に切り出す。 */
export function RoomList({ state }: { state: AppState }) {
  const { active, archived } = splitRoomsByArchived(activeRoomsSorted(state.rooms));
  const { flat, oneOnOne } = splitRoomsByKind(active);
  const broadcast = flat.filter((r) => r.kind === "broadcast");
  const normal = flat.filter((r) => r.kind !== "broadcast");
  const currentRoomId = selectedRoomId(state);
  return (
    <>
      {broadcast.length > 0 && (
        <ul id="room-list">
          {broadcast.map((room) => (
            <RoomRow key={room.id} room={room} active={room.id === currentRoomId} />
          ))}
        </ul>
      )}
      {normal.length > 0 && (
        <details id="room-list-normal" open>
          <summary>ルーム ({normal.length})</summary>
          <ul>
            {normal.map((room) => (
              <RoomRow key={room.id} room={room} active={room.id === currentRoomId} />
            ))}
          </ul>
        </details>
      )}
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
