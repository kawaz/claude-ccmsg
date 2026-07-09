import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";

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
  return (
    <button
      type="button"
      class={classes.join(" ")}
      title={id === ADMIN_ID ? "User (u1)" : id}
      onClick={() => store.dispatch({ type: "mention/toggle", id })}
    >
      {memberLabel(id, room)}
    </button>
  );
}
