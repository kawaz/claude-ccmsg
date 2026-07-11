import type { DeliveredEvent } from "@ccmsg/protocol";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { anchorId, messageHref, roomHref } from "../locator.ts";
import { memberLabel, relTime } from "../utils.ts";
import { Avatar, UserAvatar } from "../avatar.tsx";

/** DR-0012 (U1 icon addendum): the from-avatar next to a msg's from label.
 * `room.membersById` keeps a member's row after they leave (`left: true`,
 * see store.ts's applyProtocolEvent "leave" case — the row is flipped, never
 * deleted), so this resolves a sid for messages from members who have since
 * left the room, not just currently-active ones. ADMIN_ID gets the fixed
 * UserAvatar (seed-independent, same convention as MemberChip); an unknown
 * `from` (member row somehow absent — shouldn't happen but the log is the
 * source of truth, not membersById) renders no icon rather than guessing a
 * seed. */
function FromAvatar({ from, room }: { from: string; room: RoomState }) {
  if (from === ADMIN_ID) return <UserAvatar size={16} />;
  const sid = room.membersById.get(from)?.sid;
  if (!sid) return null;
  return <Avatar seed={sid} size={16} />;
}

export function TimelineItem({ event, room }: { event: DeliveredEvent; room: RoomState }) {
  switch (event.type) {
    case "msg":
      return (
        <div
          class={"msg" + (event.from === ADMIN_ID ? " msg-user" : "")}
          id={anchorId(room.id, event.mid)}
        >
          <div class="msg-meta">
            <FromAvatar from={event.from} room={room} />
            <span class="msg-from">{memberLabel(event.from, room)}</span>
            {event.to?.length ? (
              <span class="msg-to">→ {event.to.map((id) => memberLabel(id, room)).join(", ")}</span>
            ) : null}
            <span class="msg-time">{relTime(event.ts)}</span>
            <a class="msg-anchor" href={messageHref(room.id, event.mid)}>
              #{room.id}-m{event.mid}
            </a>
          </div>
          <div class="msg-body">{event.msg}</div>
        </div>
      );
    case "member":
      return <div class="event event-member">+ {memberLabel(event.id, room)} が参加</div>;
    case "leave":
      return <div class="event event-leave">− {memberLabel(event.id, room)} が退出</div>;
    case "title":
      return <div class="event event-title">title: {event.title}</div>;
    case "archive":
      return (
        <div class="event event-archive">
          {event.archived ? "📥 アーカイブされました" : "アーカイブ解除されました"}
        </div>
      );
    case "next":
      return (
        <div class="event event-link">
          <a href={roomHref(event.room)}>→ 次スレ {event.room}</a>
        </div>
      );
    case "prev":
      return (
        <div class="event event-link">
          <a href={roomHref(event.room)}>← 前スレ {event.room}</a>
        </div>
      );
    default:
      return <div class="event">{JSON.stringify(event)}</div>;
  }
}
