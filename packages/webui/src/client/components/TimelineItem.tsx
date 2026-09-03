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

/** バルーン配色の hue (kawaz r55m54): **アイコンの色は使わない**。
 * room id (`rN`) をシードに room ごとの基準色 cR を決め、そこから room 内の
 * member index で等分割する:
 *
 *   `cN = hue(cR) + 360 * N / A`  (N = member id `aN` の N、A = room の
 *   非 admin member 数)
 *
 * 狙いは「色数を減らして見やすくする」こと — アイコン由来 hue と第 2
 * アクセント hue を混ぜると色が増えすぎて視認性が落ちた (r55m54)。room 内で
 * 必ず等間隔に分離し、room が違えば基準色から違う。u1 (admin) は A から除外。
 * room / member 未解決や id が `aN` 形式でない場合は基準色 cR をそのまま返す。 */
export function bubbleHue(room: RoomState | undefined, fromId: string): number | undefined {
  if (!room) return undefined;
  const base = hueForSeed(room.id);
  if (fromId === ADMIN_ID) return base;
  // N = member id `aN` の N、A = room の非 admin member 数。alive かどうかは
  // 一切見ない (kawaz r55m60) — active 数を分母にすると、既に room を離れた
  // エージェントの過去発言が色を失う / 残った member と衝突する (r55m59)。
  // id 由来の N は離脱があっても不変なので、過去ログの色が保たれる。
  const match = /^a(\d+)$/.exec(fromId);
  if (!match) return base;
  let a = 0;
  for (const m of room.membersById.values()) {
    if (m.role !== "admin") a++;
  }
  if (a === 0) return base;
  return (base + (360 * Number(match[1])) / a) % 360;
}

/** kawaz r46 m55-m58: resolve the sender-scoped `FilePathResolveCtx` used to
 * linkify `filepath[:LINE[:COL]]` code spans in the message body. Returns
 * `undefined` when we can't attribute the message to a session with a known
 * cwd — MarkdownView then renders inline code plainly, same as before this
 * DR. Kept as a pure function on top of `MemberInfo` + `PeerInfo[]` so it's
 * trivially testable in isolation. */
/** The repository a user-authored (u1) message in this room refers to when it
 * writes `#N`: the room's session members share it in the common case (a room
 * is a conversation about one repo), so take the first member that announced
 * one. `undefined` when no member did — `#N` then stays plain text, same as
 * for an agent message from a repo-less session. */
export function issueRepoForRoom(room: RoomState): string | undefined {
  for (const member of room.membersById.values()) {
    if (member.repo) return member.repo;
  }
  return undefined;
}

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
  return { sid: member.sid, cwd: member.cwd, repoRoot: peer?.repo_root, repo: member.repo };
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
  // バルーン配色は room 基準色 + member index 等分割 (kawaz r55m54)。
  // アイコン (identicon) の色は参照しない — 詳細は bubbleHue 参照。
  const hue = isUser ? undefined : bubbleHue(room, event.from);

  const filePathCtx = filePathCtxForSender(room, peers, event.from);
  const renderAsMarkdown = shouldRenderAsMarkdown(event.from);

  return (
    <div
      class={"msg" + (isUser ? " msg-user" : "")}
      id={anchorId(room.id, event.mid)}
      style={hue !== undefined ? { "--member-hue": String(hue) } : undefined}
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
          // (u1) messages fall through to restricted mode below, which keeps
          // `#N` issue links (kawaz r259m55) but no file-path linker.
          <LinkedMarkdownView source={event.msg} ctx={filePathCtx} />
        ) : (
          // kawaz r55 m12: user-authored msgs get restricted markdown — only
          // inline code / fenced blocks / blockquotes render as markdown,
          // everything else (headings, lists, emphasis, autolinks, HTML) is
          // shown verbatim so `#123` doesn't disappear as an H1 and
          // `<R G B>` doesn't lose its brackets. Previously this branch
          // rendered `event.msg` as a raw string which lost inline code
          // rendering the user did intend.
          <LinkedMarkdownView
            source={event.msg}
            ctx={undefined}
            restricted
            issueRepo={issueRepoForRoom(room)}
          />
        )}
      </div>
    </div>
  );
}

/** A `say` event's bubble (kawaz r244 m5-m6). Reads as a message rather than
 * as a thin status line because it carries what the machine actually said —
 * the text is the content, not metadata about the room. The 既読 button is
 * the only way the unread 📣 in the Sessions list goes away, so it stays
 * visible until acked and then reports the ack rather than vanishing (a
 * disappearing control leaves the reader unsure whether the click landed). */
function SayItem({
  event,
  now,
  unread,
  onRead,
}: {
  event: Extract<DeliveredEvent, { type: "say" }>;
  now: number;
  unread: boolean;
  onRead?: (seq: number) => void;
}) {
  const seq = event.seq;
  return (
    <div class={unread ? "say say-unread" : "say"}>
      <div class="say-meta">
        <span class="say-icon" aria-hidden="true">
          📣
        </span>
        <span class="say-from">say</span>
      </div>
      {/* Rendered as plain text: this is argv handed to /usr/bin/say, so
          markdown-ish characters in it are literal, not formatting. */}
      <div class="say-body">{event.text}</div>
      {/* 時刻は本文の下 (kawaz r244 m16): TL の吹き出し (.tl-bubble-footer) も
          ROOM 側の慣習も「発言のあとに時刻」で読むので、say だけ右上に置くと
          浮く。既読の操作も時刻と同じ足元の行に置いて 1 行にまとめる。 */}
      <div class="say-footer">
        <span class="say-time">{formatMsgTime(event.ts, now)}</span>
        {seq !== undefined && unread ? (
          <button type="button" class="say-read-btn" onClick={() => onRead?.(seq)}>
            既読
          </button>
        ) : (
          <span class="say-read-done">既読</span>
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
  onSayRead,
}: {
  event: DeliveredEvent;
  room: RoomState;
  peers: readonly PeerInfo[];
  now: number;
  /** Sends the `say_read` ack for a 📣 bubble. Absent in read-only contexts
   * (the component catalog), where the button simply does nothing. */
  onSayRead?: (seq: number) => void;
}) {
  switch (event.type) {
    case "msg":
      return <MsgItem event={event} room={room} peers={peers} now={now} />;
    case "say":
      return (
        <SayItem
          event={event}
          now={now}
          unread={event.seq !== undefined && room.sayUnread.has(event.seq)}
          onRead={onSayRead}
        />
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
