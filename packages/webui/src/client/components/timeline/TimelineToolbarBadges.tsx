import { useApp } from "../../context.ts";
import { shallowEqual, useStoreState } from "../../useStore.ts";
import { badgeHref, notificationCountsOf } from "../../notification-badges.ts";
import { NotificationBadges } from "../NotificationBadges.tsx";

/** The 🔔🔐 badges at the left end of the Timeline toolbar (DR-0050 §3).
 * They count the main thread's unread, so an agent's TL — which shows none of
 * those bubbles — carries none. The filter and position are the URL's, and
 * only while it names this session. */
export function TimelineToolbarBadges({ sid }: { sid: string }) {
  const { store } = useApp();
  const view = useStoreState(
    store,
    (s) => {
      const counts = notificationCountsOf(sid, s.unreadSays, s.permitUnread);
      const here = s.currentSid === sid;
      return {
        say: counts.say,
        permit: counts.permit,
        filter: here ? s.timelineFilter : null,
        position: here ? (s.timelinePosition ?? "head") : "head",
      };
    },
    shallowEqual,
  );
  return (
    <NotificationBadges
      class="tl-toolbar-badges"
      counts={{ say: view.say, permit: view.permit }}
      selected={view.filter}
      hrefOf={(kind) => badgeHref(sid, kind, { position: view.position, filter: view.filter })}
    />
  );
}
