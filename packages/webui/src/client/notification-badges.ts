// The 🔔 / 🔐 badges of a session (DR-0050 §3, §7): whether they show, what
// their counters read, and where pressing one goes. Pure, per DR-0005 §1, so
// the display rule the TL header and the Sessions list share is testable
// without either.
import type { PermitRequestRecord, UnreadSay } from "@ccmsg/protocol";
import { timelineHref, type TimelineFilter } from "./locator.ts";

/** A session's unread says and unread requests for permission, the main
 * thread's only (the daemon's `say_unread` and `permit_requests`). */
export interface NotificationCounts {
  say: number;
  permit: number;
}

/** The kinds in the order the badges stand: 🔔 then 🔐. */
export const NOTIFICATION_KINDS: readonly TimelineFilter[] = ["say", "permit"];

/** The counter shown over the badge's top right: none for 0, the number from
 * 1, and `99+` past 99 so the counter keeps its width. */
export function badgeCounterText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** Whether a session's row in the Sessions list carries its badges: both
 * when either kind has something unread, none at 0 / 0. The Timeline
 * toolbar's are always there (DR-0050 §3): they are the way into the filter,
 * which shows a session's every say and request, read or not. */
export function rowBadgesShown(counts: NotificationCounts): boolean {
  return counts.say > 0 || counts.permit > 0;
}

/** `sid`'s unread counts out of everything the daemon reports. */
export function notificationCountsOf(
  sid: string,
  says: readonly UnreadSay[],
  requests: readonly PermitRequestRecord[],
): NotificationCounts {
  let say = 0;
  for (const unread of says) if (unread.session_id === sid) say += 1;
  let permit = 0;
  for (const request of requests) if (request.sid === sid && !request.read) permit += 1;
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
  const what = kind === "say" ? `未読の say ${count} 件` : `未確認の許可依頼 ${count} 件`;
  const only = kind === "say" ? "say" : "許可依頼";
  return selected
    ? `${what} — ${only}だけを表示中。押すと全部を表示`
    : `${what} — 押すと${only}だけを表示`;
}
