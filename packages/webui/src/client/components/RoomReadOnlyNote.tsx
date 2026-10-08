/** @jsxImportSource preact */
import type { RoomState } from "../store.ts";
import { sessionHref } from "../locator.ts";

/** A 1on1 room keeps says and past messages to read, and takes no new message
 * (DR-0035 §2, the daemon refuses post / reply / next_room on it). RoomView
 * shows this line in place of the composer; it names where the person writes
 * to the session instead — the session's own input box — and links there when
 * the room's one present member is known. Renders nothing for any other kind. */
export function RoomReadOnlyNote({ room }: { room: RoomState }) {
  if (room.kind !== "1on1") return null;
  const present = room.memberOrder
    .map((id) => room.membersById.get(id))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.left);
  const target = "セッション画面の入力欄";
  return (
    <p class="room-readonly-note">
      この 1on1 room は読み取り専用です。セッションへの入力は
      {present.length === 1 ? <a href={sessionHref(present[0]!.sid)}>{target}</a> : target}
      から。
    </p>
  );
}
