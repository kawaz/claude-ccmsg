import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";
import { Avatar, UserAvatar } from "../avatar.tsx";

export function MemberChip({
  id,
  room,
  selected,
}: {
  id: string;
  room: RoomState | undefined;
  selected: boolean;
}) {
  const { store } = useApp();
  const classes = ["chip"];
  if (id === ADMIN_ID) classes.push("chip-user");
  if (selected) classes.push("chip-selected");
  // アバターの seed はメンバーの sid (フル UUID)。User (u1) は seed に依らない
  // 固定アイコンで識別する (DR: セッション/メンバー識別性の担保)。
  const avatarSeed = room?.membersById.get(id)?.sid ?? id;
  return (
    <button
      type="button"
      class={classes.join(" ")}
      title={id === ADMIN_ID ? "User (u1)" : id}
      onClick={() => store.dispatch({ type: "mention/toggle", id })}
    >
      {id === ADMIN_ID ? <UserAvatar size={16} /> : <Avatar seed={avatarSeed} size={16} />}
      {memberLabel(id, room)}
    </button>
  );
}
