import type { DeliveredEvent } from "@ccmsg/protocol";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { anchorId, messageHref, roomHref } from "../locator.ts";
import { memberLabel, relTime } from "../utils.ts";

export function TimelineItem({ event, room }: { event: DeliveredEvent; room: RoomState }) {
  switch (event.type) {
    case "msg":
      return (
        <div
          class={"msg" + (event.from === ADMIN_ID ? " msg-user" : "")}
          id={anchorId(room.id, event.mid)}
        >
          <div class="msg-meta">
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
