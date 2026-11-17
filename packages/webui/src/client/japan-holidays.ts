// The names of Japan's public holidays, for the Timeline's day bands (DR-0054).
//
// They come from holidays-jp (https://holidays-jp.github.io/), which serves
// the Cabinet Office's list as one JSON file a year: `{"YYYY-MM-DD": "name"}`.
// The browser fetches a year the first time a band of that year is drawn and
// keeps it in localStorage with no expiry, so a band is drawn with its name at
// once, offline too. A year that has ended is settled: once kept, it is not
// fetched again. This year and the years ahead can still change (a law moves
// a holiday), so the kept value is used at once and fetched again once while
// the page is open, and replaced when it changed.
//
// A year that cannot be had (offline, a year the list does not have yet, an
// answer of the wrong shape) is not kept, and its days have no names until it
// can: the band shows the date and the weekday, and nothing says the fetch
// failed. It is not fetched again while the page is open.
//
// The request carries the year and nothing else: no cookie, no referrer (the
// webui's URL names the session).
import * as v from "valibot";
import { jsonText, parseWith } from "@ccmsg/protocol";
import { readStorage, writeStorage } from "./storage.ts";

/** How long a year's fetch may take before it counts as failed. */
const FETCH_TIMEOUT_MS = 10_000;

/** One year of holidays as holidays-jp serves it and as it is kept. A key
 * that is not a date makes the whole value unusable. */
const HolidaysSchema = v.record(v.pipe(v.string(), v.isoDate()), v.string());
const HolidaysTextSchema = jsonText(HolidaysSchema);

type Holidays = v.InferOutput<typeof HolidaysSchema>;

/** What the page knows of a year: its names (null while none are known), and
 * whether it was fetched (or is being fetched) since the page opened. */
interface YearState {
  names: ReadonlyMap<string, string> | null;
  fetched: boolean;
}

const years = new Map<number, YearState>();
const listeners = new Set<() => void>();

/** The URL of `year`'s holidays. */
export function holidaysUrl(year: number): string {
  return `https://holidays-jp.github.io/api/v1/${year}/date.json`;
}

/** The localStorage key `year` is kept under. */
export function holidaysStorageKey(year: number): string {
  return `ccmsg.japanHolidays.${year}`;
}

function namesOf(holidays: Holidays): ReadonlyMap<string, string> {
  return new Map(Object.entries(holidays));
}

/** What the page knows of `year`, reading what is kept the first time. A
 * kept value that does not read is as good as none. */
function yearState(year: number): YearState {
  const known = years.get(year);
  if (known !== undefined) return known;
  const raw = readStorage(holidaysStorageKey(year));
  const kept = raw === null ? null : parseWith(HolidaysTextSchema, raw);
  const state = { names: kept?.ok === true ? namesOf(kept.value) : null, fetched: false };
  years.set(year, state);
  return state;
}

/** The year, or null when it could not be had. */
async function fetchYear(year: number): Promise<Holidays | null> {
  try {
    const response = await fetch(holidaysUrl(year), {
      credentials: "omit",
      referrerPolicy: "no-referrer",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    const parsed = v.safeParse(HolidaysSchema, body);
    return parsed.success ? parsed.output : null;
  } catch {
    // Offline, timed out, refused, or not JSON: the year cannot be had now.
    return null;
  }
}

function sameNames(a: ReadonlyMap<string, string> | null, b: ReadonlyMap<string, string>): boolean {
  return a !== null && a.size === b.size && [...b].every(([day, name]) => a.get(day) === name);
}

/**
 * Make `year`'s holidays known, as a band of the year is drawn: fetch it
 * unless it was fetched since the page opened, or it is a year that has ended
 * (by the browser's clock) and is kept. What arrives is kept and the
 * listeners hear of it, when it differs from what was known.
 */
export function requestJapanHolidays(year: number): void {
  const state = yearState(year);
  if (state.fetched) return;
  if (state.names !== null && year < new Date().getFullYear()) return;
  state.fetched = true;
  void fetchYear(year).then((holidays) => {
    if (holidays === null) return;
    const names = namesOf(holidays);
    if (sameNames(state.names, names)) return;
    state.names = names;
    writeStorage(holidaysStorageKey(year), JSON.stringify(holidays));
    for (const listener of listeners) listener();
  });
}

/** The holiday `isoDate` (`YYYY-MM-DD`) is, or null when it is none or its
 * year is not known (yet). */
export function japanHolidayName(isoDate: string): string | null {
  return yearState(Number(isoDate.slice(0, 4))).names?.get(isoDate) ?? null;
}

/** Hear when a year's holidays arrive (useSyncExternalStore's subscribe). */
export function subscribeJapanHolidays(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Test only: forget what the page knows of every year (what is kept in
 * localStorage stays). */
export function _resetJapanHolidaysForTest(): void {
  years.clear();
}
