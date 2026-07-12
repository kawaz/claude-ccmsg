import type { PeerInfo } from "@ccmsg/protocol";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { timelineHref } from "../locator.ts";
import { isMemberConnected, memberLabel } from "../utils.ts";
import { Avatar, UserAvatar } from "../avatar.tsx";

/** DR-0012: room member chip + connectivity state + kick. `peers` (the live
 * `PeersResponse` roster, from AppState) decides the grey/strikethrough
 * "offline" treatment — a member can be present-but-disconnected without
 * having left the room, distinct from `left` (which already renders the
 * chip absent entirely, see RoomView's activeMembers filter upstream of
 * this component). The User (u1, `id === ADMIN_ID`) never gets an offline
 * treatment or a kick button — it's not backed by a `peers` row at all, and
 * kick is scoped to agent members only (DR-0012 §1: "エージェント同士が互い
 * を蹴れる設計は事故源"; the ✕ button IS the admin-only kick surface). */
export function MemberChip({
  id,
  room,
  selected,
  peers,
}: {
  id: string;
  room: RoomState | undefined;
  selected: boolean;
  peers: PeerInfo[];
}) {
  const { store, ws } = useApp();
  const member = room?.membersById.get(id);
  const isAdmin = id === ADMIN_ID;
  const offline = !isAdmin && !!member && !isMemberConnected(member, peers);
  const classes = ["chip"];
  if (isAdmin) classes.push("chip-user");
  if (selected) classes.push("chip-selected");
  if (offline) classes.push("chip-offline");
  // アバターの seed はメンバーの sid (フル UUID)。User (u1) は seed に依らない
  // 固定アイコンで識別する (DR: セッション/メンバー識別性の担保)。
  const avatarSeed = member?.sid ?? id;

  function handleKick(e: MouseEvent): void {
    e.stopPropagation(); // ✕ クリックが親 <button> の mention/toggle を巻き込まないように
    if (!room) return;
    if (!window.confirm(`${memberLabel(id, room)} を room から強制退出させますか?`)) return;
    void ws.kick(room.id, id);
  }

  return (
    <span class="chip-wrap">
      <button
        type="button"
        class={classes.join(" ")}
        title={isAdmin ? "User (u1)" : offline ? `${id} (未接続)` : id}
        onClick={() => store.dispatch({ type: "mention/toggle", id })}
      >
        {isAdmin ? <UserAvatar size={16} /> : <Avatar seed={avatarSeed} size={16} />}
        {memberLabel(id, room)}
      </button>
      {/* 接続中 (peers に居る = セッションが生きている) メンバーだけ、その
       * セッションの Timeline へ飛ぶリンクを添える (kawaz 2026-07-12)。chip
       * 本体のクリックは mention トグルのままにしたいので、別アンカーとして
       * 隣に置く。offline メンバーはセッション view が空振りするので出さない。 */}
      {!isAdmin && member && !offline && (
        <a
          class="chip-timeline-link"
          href={timelineHref(member.sid)}
          title={`${memberLabel(id, room)} の Timeline を開く`}
          aria-label={`${memberLabel(id, room)} の Timeline を開く`}
        >
          TL
        </a>
      )}
      {!isAdmin && (
        <button
          type="button"
          class="chip-kick"
          title="強制退出 (kick)"
          aria-label={`${memberLabel(id, room)} を強制退出`}
          onClick={handleKick}
        >
          ✕
        </button>
      )}
    </span>
  );
}
