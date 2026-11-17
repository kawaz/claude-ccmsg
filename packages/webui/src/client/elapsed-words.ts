// The words of the Timeline's marks of time gone by (DR-0054): the gap above
// a day band and the time since the last turn at the end. Each is the
// largest unit in Japanese (`9日`, `3時間`), with the time as the Timeline
// writes elapsed times (`formatDuration`) after it in parentheses, drawn
// fainter. What the mark means (a gap, the time since the last turn) is left
// to where it stands and how it looks; assistive technology gets a sentence.
import { formatDuration } from "./utils.ts";

const SECOND_MS = 1000;
const MINUTE_MS = 60 * SECOND_MS;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/** What a mark of elapsed time shows: the main words and, fainter, the
 * detail in parentheses (null when it would say no more than the main words). */
export interface ElapsedWords {
  main: string;
  detail: string | null;
  /** The sentence assistive technology reads. */
  spoken: string;
}

/** `ms` in its largest unit, rounded down: `N日`, `N時間`, `N分` or `N秒`. */
export function largestUnit(ms: number): string {
  const total = Math.max(0, ms);
  if (total >= DAY_MS) return `${Math.floor(total / DAY_MS)}日`;
  if (total >= HOUR_MS) return `${Math.floor(total / HOUR_MS)}時間`;
  if (total >= MINUTE_MS) return `${Math.floor(total / MINUTE_MS)}分`;
  return `${Math.floor(total / SECOND_MS)}秒`;
}

/** `ms` in words with the two units `formatDuration` shows (`3時間20分`). */
export function spokenDuration(ms: number): string {
  const totalSec = Math.max(0, Math.floor(ms / SECOND_MS));
  const totalMin = Math.floor(totalSec / 60);
  const totalHour = Math.floor(totalMin / 60);
  if (totalMin < 1) return `${totalSec}秒`;
  if (totalHour < 1) return `${totalMin}分${totalSec % 60}秒`;
  if (totalHour < 24) return `${totalHour}時間${totalMin % 60}分`;
  return `${Math.floor(totalHour / 24)}日${totalHour % 24}時間`;
}

/** The detail of `ms`: its `formatDuration`, unless under a minute, where it
 * would say the same as the main words (`12秒` and `12s`). */
function detailOf(ms: number): string | null {
  return ms < MINUTE_MS ? null : formatDuration(ms);
}

/** The gap above a day band: `days` calendar days between the item above and
 * the band's, `ms` of time between them. The main words count the calendar
 * days (as the band does), the detail the time, which may differ (two
 * calendar days can be 1d2h apart). */
export function gapWords(days: number, ms: number): ElapsedWords {
  return {
    main: `${days}日`,
    detail: formatDuration(ms),
    spoken: `前の項目から${days}日（${spokenDuration(ms)}）`,
  };
}

/** The end of the Timeline, `ms` after the last turn ended. */
export function idleWords(ms: number): ElapsedWords {
  return {
    main: largestUnit(ms),
    detail: detailOf(ms),
    spoken: `最後のターンから${spokenDuration(ms)}`,
  };
}
