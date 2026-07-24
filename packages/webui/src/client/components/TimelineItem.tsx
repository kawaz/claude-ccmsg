import type { DeliveredEvent, PeerInfo } from "@ccmsg/protocol";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { anchorId, messageHref, roomHref } from "../locator.ts";
import { formatMsgTime, memberLabel } from "../utils.ts";
import { Avatar, UserAvatar, hueForSeed } from "../avatar.tsx";
import { shouldRenderAsMarkdown } from "./timeline-item-markdown.ts";
import type { FilePathResolveCtx } from "../filepath-ref.ts";
import { LinkedMarkdownView } from "../filepath-linker.tsx";

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
export function MemberAvatar({ id, room }: { id: string; room: RoomState | undefined }) {
  if (id === ADMIN_ID) return <UserAvatar size={16} />;
  const sid = room?.membersById.get(id)?.sid;
  if (!sid) return null;
  return <Avatar seed={sid} size={16} />;
}

/** 第 2 アクセント hue の room 内 index ベース導出 (kawaz r56m13):
 * `hue2 = (hue + 360 * (N-1) / A) mod 360` — N はそのエージェントの room 内
 * member id `aN` の N、A は room 内の非 admin member 数。sid ベースの
 * `hueForSeed2` だとアイコン (hue) と偶発的に近くなる事例があったのを、
 * 「ルーム内では絶対に別色」となる導出に切り替えたもの。u1 (admin) は
 * A のカウントから除外 (「エージェントの数」なので)。member が room を
 * 出入りすると A/N が変わって既存メンバーの hue2 も動くのは仕様として許容
 * (index に閉じ込めるための必然)。room / member 未解決や id が `aN` 形式で
 * ない場合は `hue` そのまま (= 単色に degrade、視覚的に無害な fallback)。 */
export function hue2FromMember(hue: number, room: RoomState | undefined, fromId: string): number {
  if (!room) return hue;
  const member = room.membersById.get(fromId);
  if (!member || member.role === "admin") return hue;
  let a = 0;
  for (const m of room.membersById.values()) {
    if (m.role !== "admin") a++;
  }
  if (a === 0) return hue;
  const match = /^a(\d+)$/.exec(member.id);
  if (!match) return hue;
  const n = Number(match[1]);
  return (hue + (360 * (n - 1)) / a) % 360;
}

/** kawaz r46 m55-m58: resolve the sender-scoped `FilePathResolveCtx` used to
 * linkify `filepath[:LINE[:COL]]` code spans in the message body. Returns
 * `undefined` when we can't attribute the message to a session with a known
 * cwd — MarkdownView then renders inline code plainly, same as before this
 * DR. Kept as a pure function on top of `MemberInfo` + `PeerInfo[]` so it's
 * trivially testable in isolation. */
export function filePathCtxForSender(
  room: RoomState,
  peers: readonly PeerInfo[],
  from: string,
): FilePathResolveCtx | undefined {
  if (from === ADMIN_ID) return undefined;
  const member = room.membersById.get(from);
  if (!member) return undefined;
  // MemberEvent already carries cwd — that's enough for a resolver context
  // even if the peer disconnected (state.peers row would be gone) since we
  // only need repo_root beyond that, and its absence just means "no
  // repo-root rebase, cwd is the tree base".
  const peer = peers.find((p) => p.sid === member.sid);
  return { sid: member.sid, cwd: member.cwd, repoRoot: peer?.repo_root };
}

/** The `msg` event's rendering — hoisted into its own component so the
 * filepath-linkifier hooks (used inside `LinkedMarkdownView`) have a stable
 * call-order across renders. Every other event type stays inline in
 * TimelineItem because it doesn't need hooks. */
function MsgItem({
  event,
  room,
  peers,
  now,
}: {
  event: Extract<DeliveredEvent, { type: "msg" }>;
  room: RoomState;
  peers: readonly PeerInfo[];
  now: number;
}) {
  // 送信者ごとにメッセージカードを identicon 基調色で薄く色付けする
  // (kawaz 2026-07-20: 「エージェント同士のメッセージボックスみんな
  // 同じ色だと分かりにくい」)。u1 (msg-user) は緑系 --user-bubble-bg
  // で既に区別されているので対象外。sid が membersById に無い場合は
  // from id そのものを seed にフォールバック (Avatar が描かれない
  // ケースでも背景色は付く)。
  const isUser = event.from === ADMIN_ID;
  const seed = room.membersById.get(event.from)?.sid ?? event.from;
  const hue = isUser ? undefined : hueForSeed(seed);
  // 第 2 アクセント hue: room 内 member index ベースで導出 (kawaz r56m13)。
  // 詳細は hue2FromMember 参照。ルーム内で必ず分離するので、hue1 が近い 2 者
  // でも hue2 は絶対に別値になる。
  const hue2 = isUser || hue === undefined ? undefined : hue2FromMember(hue, room, event.from);

  const filePathCtx = filePathCtxForSender(room, peers, event.from);
  const renderAsMarkdown = shouldRenderAsMarkdown(event.from);

  return (
    <div
      class={"msg" + (isUser ? " msg-user" : "")}
      id={anchorId(room.id, event.mid)}
      style={
        hue !== undefined
          ? { "--member-hue": String(hue), "--member-hue2": String(hue2) }
          : undefined
      }
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
        {renderAsMarkdown ? (
          // Only agent-authored markdown messages carry file-path links; user
          // (u1) messages fall through to restricted mode below where the
          // linker context is dropped anyway.
          <LinkedMarkdownView source={event.msg} ctx={filePathCtx} />
        ) : (
          // kawaz r55 m12: user-authored msgs get restricted markdown — only
          // inline code / fenced blocks / blockquotes render as markdown,
          // everything else (headings, lists, emphasis, autolinks, HTML) is
          // shown verbatim so `#123` doesn't disappear as an H1 and
          // `<R G B>` doesn't lose its brackets. Previously this branch
          // rendered `event.msg` as a raw string which lost inline code
          // rendering the user did intend.
          <LinkedMarkdownView source={event.msg} ctx={undefined} restricted />
        )}
      </div>
    </div>
  );
}

export function TimelineItem({
  event,
  room,
  peers,
  now,
}: {
  event: DeliveredEvent;
  room: RoomState;
  peers: readonly PeerInfo[];
  now: number;
}) {
  switch (event.type) {
    case "msg":
      return <MsgItem event={event} room={room} peers={peers} now={now} />;
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
