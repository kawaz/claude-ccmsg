// The 🔔 / 🔐 badges of a session (DR-0050 §3, §7), and the TL header's ⭐
// and 👤 after them (DR-0058 §5, §11): whether they show, what their counters
// read, and where pressing one goes. Pure, per DR-0005 §1, so
// the display rule the TL header and the Sessions list share is testable
// without either.
import type { UnreadPermit, UnreadSay } from "@ccmsg/protocol";
import { timelineHref, type TimelineFilter } from "./locator.ts";

/** A session's unread says and unread requests for permission (the
 * daemon's `say_unread` and `permit_state`). */
export interface NotificationCounts {
  say: number;
  permit: number;
}

/** The kinds a session is notified of: the say (🔔) and the request for
 * permission (🔐). */
export type NotificationKind = Exclude<TimelineFilter, "prompt" | "bookmark">;

/** The kinds in the order the badges stand: 🔔 then 🔐. */
export const NOTIFICATION_KINDS: readonly NotificationKind[] = ["say", "permit"];

/** The TL header's badges, in their order: 🔔 🔐 ⭐ 👤 (DR-0058 §5, §11). The
 * ⭐ counts the session's bookmarks and the 👤 (the person's prompts) counts
 * nothing; nothing reads them: the Sessions rows carry 🔔 🔐 alone. */
export const TOOLBAR_BADGE_KINDS: readonly TimelineFilter[] = [
  ...NOTIFICATION_KINDS,
  "bookmark",
  "prompt",
];

/** What each badge counts: the unread says and requests, and in the TL header
 * the bookmarks too. */
export interface BadgeCounts extends NotificationCounts {
  bookmark?: number;
}

/** The number a badge of `kind` shows. The 👤 shows none: a prompt is the
 * person's own, nothing to be read. */
export function badgeCount(counts: BadgeCounts, kind: TimelineFilter): number {
  switch (kind) {
    case "prompt":
      return 0;
    case "bookmark":
      return counts.bookmark ?? 0;
    case "say":
    case "permit":
      return counts[kind];
  }
}

/** The badges a session's row in the Sessions list carries (DR-0050 §7): the
 * kinds with something unread, in the badges' order, none at 0 / 0. The
 * Timeline toolbar carries both always (NOTIFICATION_KINDS, §3): they are the
 * way into the filter, which shows a session's every say and request, read or
 * not. */
export function rowBadgeKinds(counts: NotificationCounts): readonly NotificationKind[] {
  return NOTIFICATION_KINDS.filter((kind) => counts[kind] > 0);
}

/** `sid`'s unread counts out of everything the daemon reports. */
export function notificationCountsOf(
  sid: string,
  says: readonly UnreadSay[],
  permits: readonly UnreadPermit[],
): NotificationCounts {
  let say = 0;
  for (const unread of says) if (unread.session_id === sid) say += 1;
  let permit = 0;
  for (const unread of permits) if (unread.session_id === sid) permit += 1;
  return { say, permit };
}

/** Where a badge goes. Selecting a kind opens the Timeline's tail with only
 * that kind (the newest at the bottom, whatever was selected is let go);
 * pressing the selected one takes the filter off and leaves the position — the
 * selected bubble — where it is. */
export function badgeHref(
  sid: string,
  kind: TimelineFilter,
  current: { position: string; filter: TimelineFilter | null },
): string {
  return current.filter === kind
    ? timelineHref(sid, current.position)
    : timelineHref(sid, "head", kind);
}

/** What a badge says to a reader who cannot see the emoji or the colour. */
export function badgeLabel(kind: TimelineFilter, count: number, selected: boolean): string {
  if (kind === "prompt") {
    return selected ? "ユーザの発言だけを表示中。押すと全部を表示" : "押すとユーザの発言だけを表示";
  }
  const what =
    kind === "say"
      ? `未読の say ${count} 件`
      : kind === "permit"
        ? `未確認の許可依頼 ${count} 件`
        : `ブックマーク ${count} 件`;
  const only = kind === "say" ? "say" : kind === "permit" ? "許可依頼" : "ブックマーク";
  return selected
    ? `${what} — ${only}だけを表示中。押すと全部を表示`
    : `${what} — 押すと${only}だけを表示`;
}
