import type { DeliveredEvent } from "@ccmsg/protocol";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { anchorId, messageHref, roomHref } from "../locator.ts";
import { formatMsgTime, memberLabel } from "../utils.ts";
import { Avatar, UserAvatar } from "../avatar.tsx";
import { MarkdownView } from "../markdown-view.tsx";
import { shouldRenderAsMarkdown } from "./timeline-item-markdown.ts";

/** DR-0012 (U1 icon addendum): a member's avatar shown next to its label
 * in msg-meta. Used both for the message sender (`from`) and for each
 * mention target in `to` — kawaz 2026-07-13 requested the same avatar
 * treatment on the `→ X, Y, Z` mention list so it reads symmetrically with
 * the sender. `room.membersById` keeps a member's row after they leave
 * (`left: true`, see store.ts's applyProtocolEvent "leave" case — the row is
 * flipped, never deleted), so this resolves a sid for messages / mentions
 * involving members who have since left the room, not just currently-active
 * ones. ADMIN_ID gets the fixed UserAvatar (seed-independent, same
 * convention as MemberChip); an unknown id (member row somehow absent —
 * shouldn't happen but the log is the source of truth, not membersById)
 * renders no icon rather than guessing a seed. */
function MemberAvatar({ id, room }: { id: string; room: RoomState }) {
  if (id === ADMIN_ID) return <UserAvatar size={16} />;
  const sid = room.membersById.get(id)?.sid;
  if (!sid) return null;
  return <Avatar seed={sid} size={16} />;
}

export function TimelineItem({
  event,
  room,
  now,
}: {
  event: DeliveredEvent;
  room: RoomState;
  now: number;
}) {
  switch (event.type) {
    case "msg":
      return (
        <div
          class={"msg" + (event.from === ADMIN_ID ? " msg-user" : "")}
          id={anchorId(room.id, event.mid)}
        >
          <div class="msg-meta">
            <MemberAvatar id={event.from} room={room} />
            <span class="msg-from">{memberLabel(event.from, room)}</span>
            {(() => {
              // u1 (ADMIN_ID) は always-exempt 配信で常に受け取っており、
              // agent 同士の会話画面に "→ u1" を毎回添えるのはノイズ (kawaz
              // 2026-07-20: 「エージェント同士の会話にユーザを含める必要なし。
              // ユーザには全部見える仕様でしょ」)。表示上は除外し、除外後が
              // 空 (= u1 単独宛) なら → 表記自体を出さない。
              const displayTo = event.to?.filter((id) => id !== ADMIN_ID) ?? [];
              return displayTo.length ? (
                <span class="msg-to">
                  →{" "}
                  {displayTo.map((id, i) => (
                    // ": " 区切りテキストとアイコン+名前ペアを混ぜる。key は id 単体だと
                    // 同一 id が to に重複した時に衝突するので `${id}-${i}` にする
                    // (protocol 的には重複しない想定だが、防御的に i を混ぜる)。
                    <span key={`${id}-${i}`} class="msg-to-item">
                      {i > 0 ? ", " : null}
                      <MemberAvatar id={id} room={room} />
                      {memberLabel(id, room)}
                    </span>
                  ))}
                </span>
              ) : null;
            })()}
            {/* 年月日 + 時刻 + 相対時間 (kawaz r17 mid=30): 時刻だけだと日を
             * 跨いだ msg の古さが読めない。now は RoomView の useNow (3 分
             * おきの雑更新)。 */}
            <span class="msg-time">{formatMsgTime(event.ts, now)}</span>
            <a class="msg-anchor" href={messageHref(room.id, event.mid)}>
              #{room.id}-m{event.mid}
            </a>
          </div>
          <div class="msg-body">
            {shouldRenderAsMarkdown(event.from) ? <MarkdownView source={event.msg} /> : event.msg}
          </div>
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
