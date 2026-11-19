// Where the Timeline draws the day it is on (DR-0054): a band over the first
// item of each calendar day, and, when the items on either side of it are two
// or more days apart, a mark above the band that says how long nothing came.
//
// Pure, per DR-0005 §1, so the placement rule is testable without a Timeline.
// What a calendar day is (which timezone) comes in as a function, so a test
// fixes the zone instead of inheriting the one it runs in.

const DAY_MS = 86_400_000;

/** A calendar date, as the number of days from 1970-01-01 to it. It names the
 * date itself (the day the clock on the wall shows), not an instant, so two
 * dates are as many days apart as their numbers, on days of 23 or 25 hours
 * as on the rest. */
export type CalendarDay = number;

/** The calendar day an instant falls on, where the clock reads it. */
export type DayOf = (ms: number) => CalendarDay;

/**
 * The calendar day of an instant in `timeZone` (an IANA name), or in the
 * browser's own zone when it is left out. The year, month and day are read
 * off the zone's clock, so the hours a day has on a change of summer time do
 * not move it.
 */
export function calendarDayOf(timeZone?: string): DayOf {
  const format = new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "numeric",
    day: "numeric",
    ...(timeZone !== undefined ? { timeZone } : {}),
  });
  return (ms) => {
    let year = 0;
    let month = 0;
    let day = 0;
    for (const part of format.formatToParts(ms)) {
      if (part.type === "year") year = Number(part.value);
      else if (part.type === "month") month = Number(part.value);
      else if (part.type === "day") day = Number(part.value);
    }
    return Date.UTC(year, month - 1, day) / DAY_MS;
  };
}

/** An instant and the calendar day it falls on. */
export interface Stamp {
  ms: number;
  day: CalendarDay;
}

/** When an item of the Timeline starts and ends. Most items are one row and
 * start and end at once; a fold group holds many rows and runs from its first
 * stamped row to its last. */
export interface ItemSpan {
  first: Stamp;
  last: Stamp;
}

function stampOf(ts: string | null, dayOf: DayOf): Stamp | null {
  if (ts === null) return null;
  const ms = Date.parse(ts);
  return Number.isNaN(ms) ? null : { ms, day: dayOf(ms) };
}

/** The span of an item whose rows carry `stamps` (ISO times, in order), or
 * null when none of them carries a readable one. */
export function itemSpanOf(stamps: readonly (string | null)[], dayOf: DayOf): ItemSpan | null {
  let first: Stamp | null = null;
  for (const ts of stamps) {
    first = stampOf(ts, dayOf);
    if (first !== null) break;
  }
  if (first === null) return null;
  for (let i = stamps.length - 1; i >= 0; i--) {
    const last = stampOf(stamps[i] ?? null, dayOf);
    if (last !== null) return { first, last };
  }
  return { first, last: first };
}

/** How long nothing came between two items: the calendar days from the end of
 * the one above to the start of the one below, and the time between them. */
export interface DayGap {
  days: number;
  ms: number;
}

/** What goes above an item: the band of the day it starts on, with the gap
 * above it when the gap is two or more days. */
export interface DayMark {
  day: CalendarDay;
  gap: DayGap | null;
}

/**
 * The marks above each of the items the Timeline shows, top to bottom (null
 * where none goes). `spans[i]` is item i's span, null for an item with no
 * time, which is passed over as if it were not there.
 *
 * - The first item with a time gets the band of its day: what day the top of
 *   the loaded window is on.
 * - An item that starts on another day than the item above it started on gets
 *   the band of its day.
 * - It also gets the gap when two or more calendar days lie between the end of
 *   the item above and its own start. The gap is measured from the end, not
 *   the start, of the item above: a fold group whose rows ran on into the
 *   next day left no empty day, though it started two days before.
 */
export function dayMarksOf(spans: readonly (ItemSpan | null)[]): (DayMark | null)[] {
  let above: ItemSpan | null = null;
  return spans.map((span) => {
    if (span === null) return null;
    const previous = above;
    above = span;
    if (previous === null) return { day: span.first.day, gap: null };
    if (span.first.day === previous.first.day) return null;
    const days = span.first.day - previous.last.day;
    return {
      day: span.first.day,
      gap: days >= 2 ? { days, ms: span.first.ms - previous.last.ms } : null,
    };
  });
}

/**
 * The day of the band at the end of the Timeline: `today` when the last item
 * with a time (`spans`, top to bottom, as `dayMarksOf` takes them) started on
 * an earlier day, so that the end says what day it is now, below the last
 * item. Null when the last item started today (its band, or the band of its
 * day above it, already says so), when no item has a time, and when the last
 * item started after `today` (a clock ahead of this one; a band of today below
 * it would go against the order of the days).
 */
export function tailBandOf(
  spans: readonly (ItemSpan | null)[],
  today: CalendarDay,
): CalendarDay | null {
  for (let i = spans.length - 1; i >= 0; i--) {
    const span = spans[i];
    if (span === null || span === undefined) continue;
    return span.first.day < today ? today : null;
  }
  return null;
}

const DATE_FORMAT = new Intl.DateTimeFormat("ja-JP", {
  year: "numeric",
  month: "long",
  day: "numeric",
  timeZone: "UTC",
});
const WEEKDAY_FORMAT = new Intl.DateTimeFormat("ja-JP", { weekday: "short", timeZone: "UTC" });

/** The band's words for `day`: `2026年11月16日（月）`, with the name of the
 * holiday after the weekday when the day is one (`2026年11月23日（月、勤労感謝の
 * 日）`). The parentheses are the full-width ones. */
export function dayLabel(day: CalendarDay, holiday: string | null): string {
  const ms = day * DAY_MS;
  const weekday = WEEKDAY_FORMAT.format(ms);
  return `${DATE_FORMAT.format(ms)}（${holiday !== null ? `${weekday}、${holiday}` : weekday}）`;
}

/** `day` as `YYYY-MM-DD`. */
export function isoDateOf(day: CalendarDay): string {
  return new Date(day * DAY_MS).toISOString().slice(0, 10);
}

/** The year `day` is in. */
export function yearOf(day: CalendarDay): number {
  return new Date(day * DAY_MS).getUTCFullYear();
}
