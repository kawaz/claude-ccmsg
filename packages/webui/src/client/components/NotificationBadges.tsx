// A session's 🔔 (says) and 🔐 (requests for permission) badges (DR-0050 §3,
// §7), with the unread count as the counter: always in the TL header, and in
// the Sessions list only while either kind has something unread (the caller
// decides, rowBadgesShown).
// Each badge is a link: which kind the Timeline shows alone is the URL's
// `?filter=`, so pressing one is a navigation, and a middle click opens that
// look in another window as the session tabs do. The link only wraps the
// emoji's CountBadge, with no room of its own and none between the two, so
// the pair is as wide as the two emoji written as text, counter or not.
import type { TimelineFilter } from "../locator.ts";
import { badgeLabel, NOTIFICATION_KINDS, type NotificationCounts } from "../notification-badges.ts";
import { CountBadge } from "./CountBadge.tsx";

const EMOJI: Record<TimelineFilter, string> = { say: "🔔", permit: "🔐" };

export function NotificationBadges({
  counts,
  selected,
  hrefOf,
  class: className,
}: {
  counts: NotificationCounts;
  /** The kind the Timeline is filtered to, shown in the selected colour. The
   * Sessions list passes null: its badges always open a filter. */
  selected: TimelineFilter | null;
  hrefOf: (kind: TimelineFilter) => string;
  class?: string;
}) {
  return (
    <span class={className === undefined ? "notif-badges" : `notif-badges ${className}`}>
      {NOTIFICATION_KINDS.map((kind) => {
        const count = counts[kind];
        const isSelected = selected === kind;
        const label = badgeLabel(kind, count, isSelected);
        return (
          <a
            key={kind}
            href={hrefOf(kind)}
            class={`notif-badge notif-badge-${kind}`}
            aria-current={isSelected ? "true" : undefined}
            aria-label={label}
            title={label}
          >
            <CountBadge count={count}>{EMOJI[kind]}</CountBadge>
          </a>
        );
      })}
    </span>
  );
}
