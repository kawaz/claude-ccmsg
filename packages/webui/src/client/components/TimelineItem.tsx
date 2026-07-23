import { useEffect, useState } from "preact/hooks";
import type { DeliveredEvent, PeerInfo } from "@ccmsg/protocol";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { anchorId, messageHref, roomHref } from "../locator.ts";
import { formatMsgTime, memberLabel } from "../utils.ts";
import { Avatar, UserAvatar, hueForSeed } from "../avatar.tsx";
import { MarkdownView, type FilePathLinker } from "../markdown-view.tsx";
import { shouldRenderAsMarkdown } from "./timeline-item-markdown.ts";
import {
  extractInlineCodeTokens,
  hrefFromStatEntry,
  parseFilePathRef,
  refToAbsolutePath,
  type FilePathResolveCtx,
} from "../filepath-ref.ts";
import {
  enqueueFilePathProbe,
  getFilePathStatus,
  subscribeFilePathCache,
} from "../filepath-existence-cache.ts";

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

/** Build the per-message linker MarkdownView calls on every inline-code
 * token. The linker:
 *   1. parses the token into a ref (bails to null if it doesn't look like a
 *      file — the "extension or line info" heuristic in parseFilePathRef);
 *   2. absolute-resolves the ref against the sender's cwd/repo_root — that
 *      absolute path is the cache key;
 *   3. asks the filepath-existence-cache for the daemon's fs_stat_batch
 *      answer — returns the FileViewer href only when the daemon confirmed
 *      a real file. Missing / pending / declined all return null (plain
 *      inline code).
 * Reads cache state synchronously; the useEffect below is what actually
 * populates the cache by enqueueing every candidate on mount. */
function makeFilePathLinker(
  ctx: FilePathResolveCtx | undefined,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- `tick` forces closure identity to change on cache updates so MarkdownView's useMemo re-runs
  _cacheTick: number,
): FilePathLinker | undefined {
  if (!ctx) return undefined;
  return (token: string) => {
    const ref = parseFilePathRef(token);
    if (!ref) return null;
    const abs = refToAbsolutePath(ref, ctx);
    if (!abs) return null;
    const status = getFilePathStatus(ctx.sid, abs);
    if (!status || status === "pending") return null;
    return hrefFromStatEntry(ctx.sid, status, ref);
  };
}

/** Enqueue every candidate absolute path from a message body into the
 * filepath-existence-cache. Runs in an effect so a re-render (streaming
 * event addition, unrelated store change) does not re-enqueue — the cache
 * itself dedupes, but skipping the extraction pass when nothing changed
 * keeps the render path cheap. */
function useFilePathProbeEnqueue(
  source: string | undefined,
  ctx: FilePathResolveCtx | undefined,
): void {
  useEffect(() => {
    if (!ctx || !source) return;
    for (const token of extractInlineCodeTokens(source)) {
      const ref = parseFilePathRef(token);
      if (!ref) continue;
      const abs = refToAbsolutePath(ref, ctx);
      if (!abs) continue;
      enqueueFilePathProbe(ctx.sid, abs);
    }
  }, [source, ctx?.sid, ctx?.cwd, ctx?.repoRoot]);
}

/** Subscribe to cache updates so a batch response triggers a re-render;
 * returns a monotonic tick that changes on every notification, letting
 * MarkdownView's useMemo re-evaluate (via the linker identity). */
function useFilePathCacheTick(): number {
  const [tick, setTick] = useState(0);
  useEffect(() => subscribeFilePathCache(() => setTick((n) => n + 1)), []);
  return tick;
}

/** The `msg` event's rendering — hoisted into its own component so the
 * filepath-linkifier hooks (useState for the cache tick, useEffect for the
 * probe enqueue) have a stable call-order across renders. Every other event
 * type stays inline in TimelineItem because it doesn't need hooks. */
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

  const filePathCtx = filePathCtxForSender(room, peers, event.from);
  const renderAsMarkdown = shouldRenderAsMarkdown(event.from);
  // Only agent-authored markdown messages carry file-path links; enqueuing
  // is skipped for user-authored plaintext messages (no MarkdownView, no
  // linkification target) so the cache doesn't accumulate probes for text
  // the viewer already sees verbatim.
  const probeSource = renderAsMarkdown ? event.msg : undefined;
  useFilePathProbeEnqueue(probeSource, filePathCtx);
  const cacheTick = useFilePathCacheTick();
  const linker = makeFilePathLinker(filePathCtx, cacheTick);

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
        {renderAsMarkdown ? <MarkdownView source={event.msg} filePathLinker={linker} /> : event.msg}
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
