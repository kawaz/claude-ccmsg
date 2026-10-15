/** @jsxImportSource preact */
import type { RoomState } from "../store.ts";
import { sessionHref } from "../locator.ts";

/** Rooms are read-only (DR-0036 §2): the view shows a past conversation and
 * takes no new message. RoomView shows this line under the header. For a
 * 1on1 room with one present member it names where the person writes to
 * that session instead — the session's own input box — and links there. */
export function RoomReadOnlyNote({ room }: { room: RoomState }) {
  const present = room.memberOrder
    .map((id) => room.membersById.get(id))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.left);
  const [only, ...others] = present;
  return (
    <p class="room-readonly-note">
      この room は読み取り専用です。
      {room.kind === "1on1" && only !== undefined && others.length === 0 ? (
        <>
          セッションへの入力は<a href={sessionHref(only.sid)}>セッション画面の入力欄</a>から。
        </>
      ) : null}
    </p>
  );
}
