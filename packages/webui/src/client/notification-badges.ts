// The 🔔 / 🔐 badges of a session (DR-0050 §3, §7): whether they show, what
// their counters read, and where pressing one goes. Pure, per DR-0005 §1, so
// the display rule the TL header and the Sessions list share is testable
// without either.
import type { PermitRequestRecord, SessionSayTotal, UnreadSay } from "@ccmsg/protocol";
import { timelineHref, type TimelineFilter } from "./locator.ts";

/** One kind's count in a session: how many are unread (the counter), and
 * how many there are, read or not (whether the badges show). */
export interface NotificationKindCount {
  unread: number;
  total: number;
}

/** A session's says and requests for permission, the main thread's and its
 * workers' says (the daemon's `say_unread` and its `totals`) and the main
 * thread's requests (`permit_requests`). */
export type NotificationCounts = Readonly<Record<TimelineFilter, NotificationKindCount>>;

/** The kinds in the order the badges stand: 🔔 then 🔐. */
export const NOTIFICATION_KINDS: readonly TimelineFilter[] = ["say", "permit"];

/** The counts of a session with no say and no request: no badges. */
export const NO_NOTIFICATIONS: NotificationCounts = {
  say: { unread: 0, total: 0 },
  permit: { unread: 0, total: 0 },
};

/** The counter shown over the badge's corner: none for 0, the number from 1,
 * and `99+` past 99 so the counter keeps its width. */
export function badgeCounterText(count: number): string | null {
  if (count <= 0) return null;
  return count > 99 ? "99+" : String(count);
}

/** Whether a session's badges show: both when the session has a say or a
 * request at all, read or not, none when it has neither. What is unread only
 * sets the counters. A badge selected as the Timeline's filter keeps them
 * shown with neither too, since pressing it again is the way back out. */
export function badgesShown(counts: NotificationCounts, selected: TimelineFilter | null): boolean {
  return counts.say.total > 0 || counts.permit.total > 0 || selected !== null;
}

/** Every session's counts out of everything the daemon reports, by sid. A
 * session with no say and no request is absent. */
export function notificationCountsBySid(
  says: readonly UnreadSay[],
  totals: readonly SessionSayTotal[],
  requests: readonly PermitRequestRecord[],
): Map<string, NotificationCounts> {
  const out = new Map<string, { say: NotificationKindCount; permit: NotificationKindCount }>();
  const of = (sid: string) => {
    let counts = out.get(sid);
    if (counts === undefined) {
      counts = { say: { unread: 0, total: 0 }, permit: { unread: 0, total: 0 } };
      out.set(sid, counts);
    }
    return counts;
  };
  for (const total of totals) of(total.session_id).say.total += total.count;
  for (const unread of says) of(unread.session_id).say.unread += 1;
  for (const request of requests) {
    const permit = of(request.sid).permit;
    permit.total += 1;
    if (!request.read) permit.unread += 1;
  }
  return out;
}

/** `sid`'s counts out of everything the daemon reports. */
export function notificationCountsOf(
  sid: string,
  says: readonly UnreadSay[],
  totals: readonly SessionSayTotal[],
  requests: readonly PermitRequestRecord[],
): NotificationCounts {
  return (
    notificationCountsBySid(
      says.filter((s) => s.session_id === sid),
      totals.filter((t) => t.session_id === sid),
      requests.filter((r) => r.sid === sid),
    ).get(sid) ?? NO_NOTIFICATIONS
  );
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
