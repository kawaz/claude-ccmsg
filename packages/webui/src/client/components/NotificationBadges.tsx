// A session's 🔔 (says) and 🔐 (requests for permission) badges (DR-0050 §3,
// §7), with the unread count as the counter: both always in the TL header,
// and in the Sessions list only the kinds with something unread (the caller
// passes which, rowBadgeKinds).
// Each badge is a link: which kind the Timeline shows alone is the URL's
// `?filter=`, so pressing one is a navigation, and a middle click opens that
// look in another window as the session tabs do. The link wraps the emoji's
// CountBadge; how much room the links have is the place's (the caller's
// `class`): in a Sessions row none, and none between the two, so the pair is
// as wide as the two emoji written as text, counter or not; in the TL toolbar,
// the way into the filter, room to press and a gap between the two.
import type { TimelineFilter } from "../locator.ts";
import { badgeLabel, type NotificationCounts } from "../notification-badges.ts";
import { CountBadge } from "./CountBadge.tsx";

const EMOJI: Record<TimelineFilter, string> = { say: "🔔", permit: "🔐" };

export function NotificationBadges({
  kinds,
  counts,
  selected,
  hrefOf,
  class: className,
}: {
  /** The badges to show, in their order. */
  kinds: readonly TimelineFilter[];
  counts: NotificationCounts;
  /** The kind the Timeline is filtered to, shown in the selected colour. The
   * Sessions list passes null: its badges always open a filter. */
  selected: TimelineFilter | null;
  hrefOf: (kind: TimelineFilter) => string;
  class?: string;
}) {
  return (
    <span class={className === undefined ? "notif-badges" : `notif-badges ${className}`}>
      {kinds.map((kind) => {
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
