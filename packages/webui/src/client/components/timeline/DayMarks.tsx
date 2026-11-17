// What the Timeline draws between its items to say when they were (DR-0054):
// the band of a calendar day, the gap of two or more days above a band, and,
// at the end, how long ago the session's last turn ended.
//
// None of them is an item of the conversation: they carry no position
// (`data-timeline-uuid`), no kind (`data-notif`), no jsonl toggle, no menu, no
// search unit, and cannot be selected. They name themselves with
// `data-tl-marker`, which scrollAnchor.ts (what to hold when older rows come
// in) reads. A band and a gap also say the views they are in
// (`data-tl-views`, all of the Timeline and each filter), for app.css to show
// the current view's. Assistive technology reads each as a separator with its
// words as the name.
import { useEffect } from "preact/hooks";
import { useSyncExternalStore } from "preact/compat";
import {
  japanHolidayName,
  requestJapanHolidays,
  subscribeJapanHolidays,
} from "../../japan-holidays.ts";
import {
  dayLabel,
  isoDateOf,
  yearOf,
  type CalendarDay,
  type DayGap,
} from "../../timeline-day-marks.ts";
import { useSecondTick } from "../../useSecondTick.ts";
import { formatDuration } from "../../utils.ts";
import type { TimelineView } from "./useDayMarks.ts";

/** The band over the first item of `day`. It is drawn at once with the date
 * and the weekday; the name of a Japanese holiday joins them when the year's
 * list arrives (japan-holidays.ts). */
export function DayBand({ day, views }: { day: CalendarDay; views: readonly TimelineView[] }) {
  const iso = isoDateOf(day);
  const year = yearOf(day);
  useEffect(() => requestJapanHolidays(year), [year]);
  const holiday = useSyncExternalStore(subscribeJapanHolidays, () => japanHolidayName(iso));
  const label = dayLabel(day, holiday);
  return (
    <div
      class="tl-day"
      role="separator"
      aria-label={label}
      data-tl-marker="day"
      data-tl-views={views.join(" ")}
    >
      <time class="tl-day-label" dateTime={iso}>
        {label}
      </time>
    </div>
  );
}

/** The words of a gap: the calendar days since the item above, and the time
 * since it as the Timeline writes elapsed times. */
export function dayGapLabel(gap: DayGap): string {
  return `${gap.days}日ぶり（${formatDuration(gap.ms)} 空き）`;
}

/** The mark above a band whose item came two or more days after the one above
 * it: how many days nothing came. */
export function DayGapMark({ gap, views }: { gap: DayGap; views: readonly TimelineView[] }) {
  const label = dayGapLabel(gap);
  return (
    <div
      class="tl-day-gap"
      role="separator"
      aria-label={label}
      data-tl-marker="gap"
      data-tl-views={views.join(" ")}
    >
      <span class="tl-day-gap-label">{label}</span>
    </div>
  );
}

/** The words of the end of the Timeline, `elapsedMs` after the last turn
 * ended. */
export function turnIdleLabel(elapsedMs: number): string {
  return `最後のターンから ${formatDuration(elapsedMs)}`;
}

/** The end of the Timeline while the session's main thread answers no turn:
 * how long ago the last one ended (`endedAt`, epoch ms). It counts on by the
 * second, as 応答中 does. */
export function TurnIdleMark({ endedAt }: { endedAt: number }) {
  const now = useSecondTick();
  const label = turnIdleLabel(now - endedAt);
  return (
    <div class="tl-turn-idle" role="separator" aria-label={label} data-tl-marker="idle">
      <span class="tl-turn-idle-label">{label}</span>
    </div>
  );
}
