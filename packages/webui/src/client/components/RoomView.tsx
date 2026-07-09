import { useEffect } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { AppState } from "../store.ts";
import { anchorId } from "../locator.ts";
import { MemberChip } from "./MemberChip.tsx";
import { TimelineItem } from "./TimelineItem.tsx";
import { Composer } from "./Composer.tsx";

export function RoomView({ state }: { state: AppState }) {
  const room = state.currentRoomId ? state.rooms.get(state.currentRoomId) : undefined;
  const mid = state.currentMid;

  // `#room-mNN` anchor scroll (DR-0004 §5): only fires when the locator's
  // room/mid pair changes, not on every timeline update, so it doesn't fight
  // manual scrolling while new messages stream in.
  useEffect(() => {
    if (!room || mid === null) return;
    document.getElementById(anchorId(room.id, mid))?.scrollIntoView({ block: "center" });
  }, [room?.id, mid]);

  if (!room) {
    return (
      <main id="room-view">
        <p id="empty-state">room を選んでください</p>
      </main>
    );
  }

  const activeMembers = room.memberOrder
    .map((id) => room.membersById.get(id))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.left);

  return (
    <main id="room-view">
      <header class="room-header">
        <h2>{room.title || room.id}</h2>
        <div class="member-chips">
          <MemberChip id={ADMIN_ID} room={room} selected={state.mentionTo.has(ADMIN_ID)} />
          {activeMembers.map((m) => (
            <MemberChip key={m.id} id={m.id} room={room} selected={state.mentionTo.has(m.id)} />
          ))}
        </div>
      </header>
      <div class="timeline">
        {room.timeline.map((ev, i) => (
          <TimelineItem key={i} event={ev} room={room} />
        ))}
      </div>
      <Composer room={room} mentionTo={state.mentionTo} />
    </main>
  );
}
