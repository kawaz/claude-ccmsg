import { USER_UID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";

export function MemberChip({
  uid,
  room,
  selected,
}: {
  uid: number;
  room: RoomState | undefined;
  selected: boolean;
}) {
  const { store } = useApp();
  const classes = ["chip"];
  if (uid === USER_UID) classes.push("chip-user");
  if (selected) classes.push("chip-selected");
  return (
    <button
      type="button"
      class={classes.join(" ")}
      title={uid === USER_UID ? "User (uid 0)" : `uid ${uid}`}
      onClick={() => store.dispatch({ type: "mention/toggle", uid })}
    >
      {memberLabel(uid, room)}
    </button>
  );
}
