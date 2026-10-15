import type { JSX } from "preact";
import type { AppState, RoomState } from "../store.ts";
import { selectedRoomId } from "../store.ts";
import { roomHref } from "../locator.ts";
import { activeRoomsSorted, relTime, splitRoomsByArchived, splitRoomsByKind } from "../utils.ts";
import { Fold } from "./Fold.tsx";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";

function roomListSlice(state: AppState) {
  return { rooms: state.rooms, roomList: state.roomList, currentRoomId: selectedRoomId(state) };
}

function RoomRow({ room, active }: { room: RoomState; active: boolean }) {
  const memberCount = [...room.membersById.values()].filter((m) => !m.left).length;
  // DR-0013: broadcast rooms carry a small text badge at the left of the row
  // title, so ellipsis clips the title tail (not the badge) when the sidebar
  // is narrow. Text-based (not an emoji glyph) so screen readers pronounce it.
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

function RoomRows({ rooms, currentRoomId }: { rooms: RoomState[]; currentRoomId: string | null }) {
  return (
    <ul>
      {rooms.map((room) => (
        <RoomRow key={room.id} room={room} active={room.id === currentRoomId} />
      ))}
    </ul>
  );
}

/** The past rooms, read-only (DR-0036 §2), folded away until opened: opening
 * the fold is what fetches the list (`rooms`), since the logs no longer
 * change and nothing has to be kept current. Inside, the rooms go newest
 * first, with 1on1 rooms and archived rooms in their own folds (an archived
 * 1on1 room lands under アーカイブ — `splitRoomsByArchived` runs first). */
export function RoomList() {
  const { store, ws } = useApp();
  const state = useStoreState(store, roomListSlice, shallowEqual);
  const onToggle = (e: JSX.TargetedEvent<HTMLDetailsElement, Event>): void => {
    if (!e.currentTarget.open || store.getState().roomList !== "idle") return;
    store.dispatch({ type: "rooms/loading" });
    void ws
      .rooms()
      .then((res) => {
        store.dispatch(
          res.ok ? { type: "rooms/loaded", rooms: res.rooms } : { type: "rooms/failed" },
        );
      })
      .catch(() => store.dispatch({ type: "rooms/failed" }));
  };
  const { active, archived } = splitRoomsByArchived(activeRoomsSorted(state.rooms));
  const { flat, oneOnOne } = splitRoomsByKind(active);
  return (
    <Fold
      id="room-list-fold"
      summary="Rooms (読み取り専用)"
      summaryClass="room-list-summary"
      onToggle={onToggle}
    >
      {state.roomList === "loading" ? <p class="room-list-status">読み込み中…</p> : null}
      {state.roomList === "error" ? (
        <p class="room-list-status">room の一覧を読み込めませんでした</p>
      ) : null}
      {state.roomList === "loaded" && state.rooms.size === 0 ? (
        <p class="room-list-status">room はありません</p>
      ) : null}
      {flat.length > 0 && <RoomRows rooms={flat} currentRoomId={state.currentRoomId} />}
      {oneOnOne.length > 0 && (
        <Fold id="room-list-1on1" summary={`1on1 (${oneOnOne.length})`}>
          <RoomRows rooms={oneOnOne} currentRoomId={state.currentRoomId} />
        </Fold>
      )}
      {archived.length > 0 && (
        <Fold id="room-list-archived" summary={`アーカイブ (${archived.length})`}>
          <RoomRows rooms={archived} currentRoomId={state.currentRoomId} />
        </Fold>
      )}
    </Fold>
  );
}
