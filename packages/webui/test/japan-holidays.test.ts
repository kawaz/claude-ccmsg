// The holiday names of the Timeline's day bands (DR-0054). They come from
// holidays-jp's file of a year (`https://holidays-jp.github.io/api/v1/<年>/
// date.json`, `{"YYYY-MM-DD": "name"}`), fetched by the browser the first time
// a band of the year is drawn and kept in localStorage with no expiry. A year
// that has ended is settled and, once kept, never fetched again; this year and
// the years ahead are used as kept and fetched again once per page, in case a
// holiday moved. A year that cannot be had (offline, 404 for a year the list
// does not have yet, an answer of the wrong shape) has no names, is not kept,
// and is not asked for again while the page is open. fetch and localStorage
// are replaced here ("now" is 2026-11-17): no test reaches the network.
import { afterEach, beforeEach, describe, expect, setSystemTime, test } from "bun:test";
import { MemStorage, stubGlobal } from "./helpers.ts";
import {
  _resetJapanHolidaysForTest,
  holidaysStorageKey,
  holidaysUrl,
  japanHolidayName,
  requestJapanHolidays,
  subscribeJapanHolidays,
} from "../src/client/japan-holidays.ts";

/** 2026 as holidays-jp serves it (its shape and its names, verbatim). */
const HOLIDAYS_2026 = {
  "2026-01-01": "元日",
  "2026-01-12": "成人の日",
  "2026-02-11": "建国記念の日",
  "2026-02-23": "天皇誕生日",
  "2026-03-20": "春分の日",
  "2026-04-29": "昭和の日",
  "2026-05-03": "憲法記念日",
  "2026-05-04": "みどりの日",
  "2026-05-05": "こどもの日",
  "2026-05-06": "憲法記念日 振替休日",
  "2026-07-20": "海の日",
  "2026-08-11": "山の日",
  "2026-09-21": "敬老の日",
  "2026-09-22": "国民の休日",
  "2026-09-23": "秋分の日",
  "2026-10-12": "スポーツの日",
  "2026-11-03": "文化の日",
  "2026-11-23": "勤労感謝の日",
};

const HOLIDAYS_2027 = { "2027-01-01": "元日", "2027-01-11": "成人の日" };

interface Sent {
  url: string;
  init: RequestInit | undefined;
}

let sent: Sent[] = [];
let restoreFetch = (): void => {};
let restoreStorage = (): void => {};
let storage = new MemStorage();

function urlOf(input: string | URL | Request): string {
  return typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
}

/** Answer each fetch with what `respond` gives for its URL. */
function serve(respond: (url: string) => Response | Promise<Response>): void {
  restoreFetch = stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
    const url = urlOf(input);
    sent.push({ url, init });
    return respond(url);
  });
}

function serveYears(byYear: Record<number, object>): void {
  serve((url) => {
    for (const [year, body] of Object.entries(byYear)) {
      if (url === holidaysUrl(Number(year))) return Response.json(body);
    }
    return new Response("Not Found", { status: 404 });
  });
}

/** Let the fetches that were started settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** A new page: what it knew of the years is gone, what was kept stays. */
function reopen(): void {
  _resetJapanHolidaysForTest();
  restoreFetch();
  restoreFetch = () => {};
  sent = [];
}

beforeEach(() => {
  _resetJapanHolidaysForTest();
  sent = [];
  setSystemTime(Date.parse("2026-11-17T03:00:00Z"));
  storage = new MemStorage();
  restoreStorage = stubGlobal("localStorage", storage);
});

afterEach(() => {
  restoreFetch();
  restoreFetch = () => {};
  restoreStorage();
  setSystemTime();
});

describe("japanHolidayName", () => {
  // The name is the data's string as it is, a substitute holiday's and the
  // citizens' holiday's included; a day that is none has none.
  test("names a holiday, a substitute holiday and a citizens' holiday, and no other day", async () => {
    serveYears({ 2026: HOLIDAYS_2026 });
    requestJapanHolidays(2026);
    await settle();
    expect(japanHolidayName("2026-11-23")).toBe("勤労感謝の日");
    expect(japanHolidayName("2026-05-06")).toBe("憲法記念日 振替休日");
    expect(japanHolidayName("2026-09-22")).toBe("国民の休日");
    expect(japanHolidayName("2026-11-16")).toBeNull();
  });

  // Of the new-year days only the 1st is a holiday: the 31st and the 2nd are
  // ordinary days in the list, each in its own year's file.
  test("around the new year only the 1st is one", async () => {
    serveYears({ 2026: HOLIDAYS_2026, 2027: HOLIDAYS_2027 });
    requestJapanHolidays(2026);
    requestJapanHolidays(2027);
    await settle();
    expect(japanHolidayName("2026-12-31")).toBeNull();
    expect(japanHolidayName("2027-01-01")).toBe("元日");
    expect(japanHolidayName("2027-01-02")).toBeNull();
  });

  // Before the year is asked for and while it is on its way, no day of it has
  // a name (the band is drawn without one, and gets it on arrival).
  test("none before the year arrives", async () => {
    let release = (): void => {};
    serve(
      () =>
        new Promise<Response>((resolve) => {
          release = () => resolve(Response.json(HOLIDAYS_2026));
        }),
    );
    expect(japanHolidayName("2026-11-23")).toBeNull();
    requestJapanHolidays(2026);
    await settle();
    expect(japanHolidayName("2026-11-23")).toBeNull();
    release();
    await settle();
    expect(japanHolidayName("2026-11-23")).toBe("勤労感謝の日");
  });
});

describe("requestJapanHolidays", () => {
  // The request is the year's URL and carries nothing of the page: no cookie,
  // no referrer (the webui's URL names the session).
  test("asks for the year's file with no credentials and no referrer", async () => {
    serveYears({ 2026: HOLIDAYS_2026 });
    requestJapanHolidays(2026);
    await settle();
    expect(sent.map((request) => request.url)).toEqual([
      "https://holidays-jp.github.io/api/v1/2026/date.json",
    ]);
    expect(sent[0]?.init?.credentials).toBe("omit");
    expect(sent[0]?.init?.referrerPolicy).toBe("no-referrer");
  });

  // Every band of a year asks for it; the year is fetched once, whether it is
  // on its way or arrived.
  test("fetches a year once", async () => {
    serveYears({ 2026: HOLIDAYS_2026 });
    requestJapanHolidays(2026);
    requestJapanHolidays(2026);
    await settle();
    requestJapanHolidays(2026);
    await settle();
    expect(sent).toHaveLength(1);
  });

  // A year the list does not have (404, as for a year too far ahead): its
  // days have no names, and it is not asked for again on the next band.
  test("a year that is not there has no names and is not asked for again", async () => {
    serveYears({ 2026: HOLIDAYS_2026 });
    requestJapanHolidays(2031);
    await settle();
    requestJapanHolidays(2031);
    await settle();
    expect(japanHolidayName("2031-01-01")).toBeNull();
    expect(sent).toHaveLength(1);
  });

  // An answer that is not JSON, or JSON of the wrong shape (a key that is not
  // a date, a name that is not a string), is no list: no names at all, rather
  // than the part that looked right.
  test("an answer of the wrong shape gives no names", async () => {
    const answers: Record<number, () => Response> = {
      2026: () => new Response("<html>oops</html>", { status: 200 }),
      2027: () => Response.json({ "2027/01/01": "元日" }),
      2028: () => Response.json({ "2028-01-01": 1 }),
      2029: () => Response.json(["2029-01-01"]),
    };
    serve((url) => {
      for (const [year, answer] of Object.entries(answers)) {
        if (url === holidaysUrl(Number(year))) return answer();
      }
      return new Response("Not Found", { status: 404 });
    });
    for (const year of [2026, 2027, 2028, 2029]) requestJapanHolidays(year);
    await settle();
    expect(japanHolidayName("2026-11-23")).toBeNull();
    expect(japanHolidayName("2027-01-01")).toBeNull();
    expect(japanHolidayName("2028-01-01")).toBeNull();
    expect(japanHolidayName("2029-01-01")).toBeNull();
  });

  // Offline (fetch rejects): no names, no retry.
  test("a fetch that fails gives no names and is not retried", async () => {
    serve(() => Promise.reject(new TypeError("Failed to fetch")));
    requestJapanHolidays(2026);
    await settle();
    requestJapanHolidays(2026);
    await settle();
    expect(japanHolidayName("2026-11-23")).toBeNull();
    expect(sent).toHaveLength(1);
  });

  // The bands re-read the names when a year arrives (useSyncExternalStore).
  test("tells the listeners when a year arrives", async () => {
    serveYears({ 2026: HOLIDAYS_2026 });
    let heard = 0;
    const unsubscribe = subscribeJapanHolidays(() => {
      heard += 1;
    });
    requestJapanHolidays(2026);
    await settle();
    unsubscribe();
    expect(heard).toBe(1);
  });
});

describe("keeping the years", () => {
  // What arrives is kept as it came, under the year's key.
  test("keeps a year that arrived", async () => {
    serveYears({ 2026: HOLIDAYS_2026 });
    requestJapanHolidays(2026);
    await settle();
    expect(JSON.parse(storage.getItem(holidaysStorageKey(2026)) ?? "null")).toEqual(HOLIDAYS_2026);
  });

  // A year that has ended does not change: a new page uses what is kept, at
  // once and offline, and does not fetch it again.
  test("a year that has ended is used as kept and not fetched again", async () => {
    storage.setItem(
      holidaysStorageKey(2025),
      JSON.stringify({ "2025-11-24": "勤労感謝の日 振替休日" }),
    );
    serveYears({});
    expect(japanHolidayName("2025-11-24")).toBe("勤労感謝の日 振替休日");
    requestJapanHolidays(2025);
    await settle();
    expect(sent).toHaveLength(0);
    expect(japanHolidayName("2025-11-24")).toBe("勤労感謝の日 振替休日");
  });

  // This year can still change (a law moves a holiday): what is kept is used
  // at once, and fetched again once per page; a change replaces both what is
  // shown and what is kept, and the listeners hear of it.
  test("this year is used as kept, fetched again once per page, and replaced when it changed", async () => {
    storage.setItem(holidaysStorageKey(2026), JSON.stringify({ "2026-07-20": "海の日" }));
    serveYears({ 2026: HOLIDAYS_2026 });
    let heard = 0;
    const unsubscribe = subscribeJapanHolidays(() => {
      heard += 1;
    });
    expect(japanHolidayName("2026-07-20")).toBe("海の日");
    expect(japanHolidayName("2026-11-23")).toBeNull();
    requestJapanHolidays(2026);
    requestJapanHolidays(2026);
    await settle();
    expect(sent).toHaveLength(1);
    expect(japanHolidayName("2026-11-23")).toBe("勤労感謝の日");
    expect(JSON.parse(storage.getItem(holidaysStorageKey(2026)) ?? "null")).toEqual(HOLIDAYS_2026);
    expect(heard).toBe(1);

    // The next page fetches it again; the same answer changes nothing.
    reopen();
    serveYears({ 2026: HOLIDAYS_2026 });
    requestJapanHolidays(2026);
    await settle();
    unsubscribe();
    expect(sent).toHaveLength(1);
    expect(heard).toBe(1);
  });

  // A year ahead is like this year: fetched again even when kept.
  test("a year ahead is fetched again even when kept", async () => {
    storage.setItem(holidaysStorageKey(2027), JSON.stringify(HOLIDAYS_2027));
    serveYears({ 2027: HOLIDAYS_2027 });
    requestJapanHolidays(2027);
    await settle();
    expect(sent).toHaveLength(1);
  });

  // When fetching again fails, what is kept stays, shown and stored.
  test("a failed fetch keeps what is kept", async () => {
    storage.setItem(holidaysStorageKey(2026), JSON.stringify(HOLIDAYS_2026));
    serve(() => Promise.reject(new TypeError("Failed to fetch")));
    requestJapanHolidays(2026);
    await settle();
    expect(japanHolidayName("2026-11-23")).toBe("勤労感謝の日");
    expect(JSON.parse(storage.getItem(holidaysStorageKey(2026)) ?? "null")).toEqual(HOLIDAYS_2026);
  });

  // A kept value that does not read (broken, or of another shape) is as good
  // as none: no names from it, and the year is fetched, even one that ended.
  test("a kept value that does not read is dropped and the year fetched", async () => {
    storage.setItem(holidaysStorageKey(2025), "{not json");
    storage.setItem(holidaysStorageKey(2024), JSON.stringify(["2024-01-01"]));
    serveYears({ 2025: { "2025-01-01": "元日" }, 2024: { "2024-01-01": "元日" } });
    expect(japanHolidayName("2025-01-01")).toBeNull();
    requestJapanHolidays(2025);
    requestJapanHolidays(2024);
    await settle();
    expect(sent).toHaveLength(2);
    expect(japanHolidayName("2025-01-01")).toBe("元日");
    expect(JSON.parse(storage.getItem(holidaysStorageKey(2024)) ?? "null")).toEqual({
      "2024-01-01": "元日",
    });
  });

  // A year the list does not have (404) and an answer of the wrong shape are
  // not kept: the next page asks again.
  test("a 404 or a wrong answer is not kept", async () => {
    serve((url) =>
      url === holidaysUrl(2027)
        ? Response.json({ "2027/01/01": "元日" })
        : new Response("Not Found", { status: 404 }),
    );
    requestJapanHolidays(2031);
    requestJapanHolidays(2027);
    await settle();
    expect(storage.getItem(holidaysStorageKey(2031))).toBeNull();
    expect(storage.getItem(holidaysStorageKey(2027))).toBeNull();
  });

  // Where localStorage throws (private mode, storage turned off), the years
  // are fetched and shown as without it.
  test("works without localStorage", async () => {
    restoreStorage();
    restoreStorage = stubGlobal("localStorage", {
      getItem() {
        throw new Error("SecurityError");
      },
      setItem() {
        throw new Error("SecurityError");
      },
    });
    serveYears({ 2026: HOLIDAYS_2026 });
    requestJapanHolidays(2026);
    await settle();
    expect(japanHolidayName("2026-11-23")).toBe("勤労感謝の日");
  });
});
