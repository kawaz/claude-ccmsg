import type { PeerInfo } from "@ccmsg/protocol";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { timelineHref } from "../locator.ts";
import { isMemberConnected, memberLabel } from "../utils.ts";
import { Avatar, UserAvatar } from "../avatar.tsx";

/** A room member's chip: avatar, label, and whether its session is
 * connected now. `peers` (the live roster) decides the grey "offline"
 * treatment and whether the chip links to the session's Timeline. The User
 * (u1, `id === ADMIN_ID`) is never offline — no `peers` row backs it.
 *
 * Presentation only: everything it draws comes from its props, so the
 * catalog can draw one outside a room. */
export function MemberChip({
  id,
  room,
  peers,
}: {
  id: string;
  room: RoomState | undefined;
  peers: readonly PeerInfo[];
}) {
  const member = room?.membersById.get(id);
  const isAdmin = id === ADMIN_ID;
  const offline = !isAdmin && !!member && !isMemberConnected(member, peers);
  const classes = ["chip"];
  if (isAdmin) classes.push("chip-user");
  if (offline) classes.push("chip-offline");
  // アバターの seed はメンバーの sid (フル UUID)。User (u1) は seed に依らない
  // 固定アイコンで識別する (DR: セッション/メンバー識別性の担保)。
  const avatarSeed = member?.sid ?? id;

  return (
    <span class="chip-wrap">
      <span
        class={classes.join(" ")}
        title={isAdmin ? "User (u1)" : offline ? `${id} (未接続)` : id}
      >
        {isAdmin ? <UserAvatar size={16} /> : <Avatar seed={avatarSeed} size={16} />}
        {memberLabel(id, room)}
      </span>
      {/* 接続中 (peers に居る = セッションが生きている) メンバーだけ、その
       * セッションの Timeline へ飛ぶリンクを添える。offline メンバーは
       * セッション view が空振りするので出さない。 */}
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
    </span>
  );
}
