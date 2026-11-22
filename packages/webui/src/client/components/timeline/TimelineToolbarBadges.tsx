import { useApp } from "../../context.ts";
import { shallowEqual, useStoreState } from "../../useStore.ts";
import { badgeHref, notificationCountsOf, TOOLBAR_BADGE_KINDS } from "../../notification-badges.ts";
import { NotificationBadges } from "../NotificationBadges.tsx";
import { unsentCount } from "../../comment-view.ts";

/** The 🔔🔐⭐👤💬🔍 badges at the left end of the Timeline toolbar (DR-0050 §3,
 * DR-0058 §5, §11, DR-0062 §13, DR-0022). They count the main thread's unread,
 * the session's bookmarks and its unsent comments, so an agent's TL — which shows none of those bubbles and selects
 * no position — carries none. The filter and position are the URL's, and
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
        bookmark: s.bookmarks.get(sid)?.length ?? 0,
        comment: unsentCount(s.comments.get(sid)?.values() ?? []),
        filter: here ? s.timelineFilter : null,
        position: here ? (s.timelinePosition ?? "head") : "head",
      };
    },
    shallowEqual,
  );
  return (
    <NotificationBadges
      class="tl-toolbar-badges"
      kinds={TOOLBAR_BADGE_KINDS}
      counts={{
        say: view.say,
        permit: view.permit,
        bookmark: view.bookmark,
        comment: view.comment,
      }}
      selected={view.filter}
      hrefOf={(kind) => badgeHref(sid, kind, { position: view.position, filter: view.filter })}
    />
  );
}
