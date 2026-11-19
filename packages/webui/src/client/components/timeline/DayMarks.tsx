// What the Timeline draws between its items to say when they were (DR-0054):
// the band of a calendar day, with ↑ / ↓ to step to the band before and after
// it; the mark of the time gone by above a band whose day came two or more
// days after the item above; and, at the end, the same mark saying how long
// ago the last turn of the thread the Timeline shows (the session's main
// thread, or an agent) ended.
//
// None of them is an item of the conversation: they carry no position
// (`data-timeline-uuid`), no kind (`data-notif`), no jsonl toggle, no menu and
// no search unit, and nothing of them can be selected. They name themselves
// with `data-tl-marker`, which scrollAnchor.ts (what to hold when older rows
// come in) reads. A band and a gap also say the views they are in
// (`data-tl-views`, all of the Timeline and each filter), for app.css to show
// the current view's.
//
// Design rationale: the words (and the arrows' signs) are not text in the DOM
// but generated content drawn by app.css from `data-label`: a selection
// dragged across a mark takes in its text on WebKit (Safari) even with
// `user-select: none` (seen on WebKit 27.2, the copied text had the band's
// date and the gap's words; Chromium leaves them out). Generated content is in
// no selection on either engine. What a mark says reaches assistive
// technology as the `aria-label` of a separator. A separator's children are
// presentational, so the band's separator is its date alone and the two
// buttons sit beside it, not inside it.
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
import { gapWords, idleWords, type ElapsedWords } from "../../elapsed-words.ts";
import { useSecondTick } from "../../useSecondTick.ts";
import type { DayStep } from "./useDayJump.ts";
import type { TimelineView } from "./useDayMarks.ts";

/** What a press of ↑ / ↓ on a band asks for: step from `band` (the band's
 * element) toward `step`. */
export type DayStepPress = (band: HTMLElement, step: DayStep) => void;

const STEP_NAMES: Record<DayStep, string> = { up: "前の日付へ", down: "次の日付へ" };
const STEP_SIGNS: Record<DayStep, string> = { up: "↑", down: "↓" };

function StepButton({ step, onStep }: { step: DayStep; onStep: DayStepPress }) {
  return (
    <button
      type="button"
      class="tl-day-step"
      data-step={step}
      data-label={STEP_SIGNS[step]}
      aria-label={STEP_NAMES[step]}
      title={STEP_NAMES[step]}
      onClick={(event) => {
        const band = event.currentTarget.closest<HTMLElement>("[data-tl-marker='day']");
        if (band !== null) onStep(band, step);
      }}
    />
  );
}

/** The band over the first item of `day` (or, at the end of the Timeline,
 * the band of today below the last item), with ↑ / ↓ on either side of the
 * date. It is drawn at once with the date and the weekday; the name of a
 * Japanese holiday joins them when the year's list arrives
 * (japan-holidays.ts).
 *
 * `top` names the views in which the band is above every item: app.css hides
 * its ↑ there when nothing older is left to read (`data-at-start` on the rows,
 * or a filter, which shows every say / request already). `today` marks the
 * band of the browser's calendar day now as the current date
 * (`aria-current="date"`), which app.css also sets apart to the eye. */
export function DayBand({
  day,
  views,
  top = [],
  today,
  onStep,
}: {
  day: CalendarDay;
  views: readonly TimelineView[];
  top?: readonly TimelineView[];
  today: boolean;
  onStep: DayStepPress;
}) {
  const iso = isoDateOf(day);
  const year = yearOf(day);
  useEffect(() => requestJapanHolidays(year), [year]);
  const holiday = useSyncExternalStore(subscribeJapanHolidays, () => japanHolidayName(iso));
  const label = dayLabel(day, holiday);
  return (
    <div
      class="tl-day"
      data-tl-marker="day"
      data-tl-views={views.join(" ")}
      data-tl-top={top.length > 0 ? top.join(" ") : undefined}
      data-tl-day={iso}
    >
      <span class="tl-day-pill">
        <StepButton step="up" onStep={onStep} />
        <time
          class="tl-day-label"
          role="separator"
          aria-label={label}
          dateTime={iso}
          aria-current={today ? "date" : undefined}
          data-label={label}
        />
        <StepButton step="down" onStep={onStep} />
      </span>
    </div>
  );
}

/** The mark of how much time went by: above a band whose item came two or
 * more days after the item above, and at the end of the Timeline after the
 * last turn. One look for both; `marker` says which it is. The detail is drawn
 * fainter after the main words (app.css). */
function ElapsedMark({
  marker,
  words,
  views,
}: {
  marker: "gap" | "idle";
  words: ElapsedWords;
  views?: readonly TimelineView[];
}) {
  return (
    <div
      class="tl-elapsed"
      role="separator"
      aria-label={words.spoken}
      data-tl-marker={marker}
      data-tl-views={views?.join(" ")}
    >
      <span
        class="tl-elapsed-label"
        data-label={words.main}
        data-detail={words.detail ?? undefined}
      />
    </div>
  );
}

/** The mark above a band whose item came two or more days after the one above
 * it: how many days nothing came. */
export function DayGapMark({ gap, views }: { gap: DayGap; views: readonly TimelineView[] }) {
  return <ElapsedMark marker="gap" words={gapWords(gap.ms)} views={views} />;
}

/** The end of the Timeline while the thread it shows (the session's main
 * thread, or an agent) answers no turn: how long ago the last one ended
 * (`endedAt`, epoch ms). It counts on by the second, as 応答中 does. */
export function TurnIdleMark({ endedAt }: { endedAt: number }) {
  const now = useSecondTick();
  return <ElapsedMark marker="idle" words={idleWords(now - endedAt)} />;
}
