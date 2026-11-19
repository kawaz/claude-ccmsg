// Where the Timeline puts the band of a day and the gap of days (DR-0054),
// fixed without a Timeline. The rule, as kawaz asked for it (2026-11-17):
// - two items next to each other on different calendar days: a band with the
//   lower item's date goes right above the lower item
// - one calendar day apart: the band only
// - two or more calendar days apart: also a mark above the band that says how
//   long the gap was ("前のアイテム → 空き → 帯 → 下側のアイテム")
// - the first item of the loaded window gets the band of its day too, so the
//   top of what is loaded says what day it is on
// Calendar days are the wall clock's, in a zone the test names (the Timeline
// uses the browser's own): the result must not depend on the zone the tests
// happen to run in.
import { describe, expect, test } from "bun:test";
import {
  calendarDayOf,
  dayLabel,
  dayMarksOf,
  isoDateOf,
  itemSpanOf,
  tailBandOf,
  yearOf,
  type DayOf,
  type ItemSpan,
} from "../src/client/timeline-day-marks.ts";

const TOKYO = calendarDayOf("Asia/Tokyo");
const NEW_YORK = calendarDayOf("America/New_York");

/** The span of an item of one row at `ts`. */
function at(ts: string, dayOf: DayOf = TOKYO): ItemSpan | null {
  return itemSpanOf([ts], dayOf);
}

/** The calendar day of a date written `YYYY-MM-DD`, as the marks carry it. */
function day(iso: string): number {
  return Date.parse(`${iso}T00:00:00Z`) / 86_400_000;
}

describe("calendarDayOf", () => {
  // The day is the one the zone's clock shows, not the UTC date: 15:00 UTC is
  // midnight in Tokyo (UTC+9).
  test("reads the date off the named zone's clock", () => {
    expect(TOKYO(Date.parse("2026-11-15T14:59:59Z"))).toBe(day("2026-11-15"));
    expect(TOKYO(Date.parse("2026-11-15T15:00:00Z"))).toBe(day("2026-11-16"));
    expect(NEW_YORK(Date.parse("2026-11-16T04:59:59Z"))).toBe(day("2026-11-15"));
    expect(NEW_YORK(Date.parse("2026-11-16T05:00:00Z"))).toBe(day("2026-11-16"));
  });

  // New York springs forward on 2026-03-08 (a day of 23 hours) and falls back
  // on 2026-11-01 (25 hours). Midnight moves by an hour in UTC across each, and
  // the days stay one apart: a day count of elapsed milliseconds / 24h would
  // put two instants 24 hours apart on the same or on non-adjacent days here.
  test("counts a 23-hour and a 25-hour day as one day each", () => {
    expect(NEW_YORK(Date.parse("2026-03-08T04:59:59Z"))).toBe(day("2026-03-07"));
    expect(NEW_YORK(Date.parse("2026-03-08T05:00:00Z"))).toBe(day("2026-03-08"));
    expect(NEW_YORK(Date.parse("2026-03-09T03:59:59Z"))).toBe(day("2026-03-08"));
    expect(NEW_YORK(Date.parse("2026-03-09T04:00:00Z"))).toBe(day("2026-03-09"));
    expect(NEW_YORK(Date.parse("2026-11-01T03:59:59Z"))).toBe(day("2026-10-31"));
    expect(NEW_YORK(Date.parse("2026-11-02T04:59:59Z"))).toBe(day("2026-11-01"));
    expect(NEW_YORK(Date.parse("2026-11-02T05:00:00Z"))).toBe(day("2026-11-02"));
  });
});

describe("itemSpanOf", () => {
  // A fold group is dated from its first stamped row to its last; rows with
  // no time (a broken line) or an unreadable one are passed over.
  test("runs from the first to the last readable stamp", () => {
    expect(
      itemSpanOf([null, "2026-11-15T10:00:00Z", "not a time", "2026-11-16T10:00:00Z", null], TOKYO),
    ).toEqual({
      first: { ms: Date.parse("2026-11-15T10:00:00Z"), day: day("2026-11-15") },
      last: { ms: Date.parse("2026-11-16T10:00:00Z"), day: day("2026-11-16") },
    });
  });

  test("one stamp is both ends", () => {
    const span = at("2026-11-15T10:00:00Z");
    expect(span?.first).toEqual(span?.last);
  });

  // No time at all: the item cannot be dated, and the marks pass it over.
  test("null without a readable stamp", () => {
    expect(itemSpanOf([], TOKYO)).toBeNull();
    expect(itemSpanOf([null, "garbage"], TOKYO)).toBeNull();
  });
});

describe("dayMarksOf", () => {
  // Nothing loaded, nothing to mark.
  test("no items, no marks", () => {
    expect(dayMarksOf([])).toEqual([]);
  });

  // The top of the window: its first item says what day it is on, and there
  // is nothing above it to measure a gap from.
  test("the first item gets the band of its day and no gap", () => {
    expect(dayMarksOf([at("2026-11-16T01:00:00Z")])).toEqual([
      { day: day("2026-11-16"), gap: null },
    ]);
  });

  // Items on the same day: one band, at the top.
  test("items of one day share the band above the first", () => {
    expect(
      dayMarksOf([
        at("2026-11-16T00:00:00Z"),
        at("2026-11-16T05:00:00Z"),
        at("2026-11-16T14:59:59Z"),
      ]),
    ).toEqual([{ day: day("2026-11-16"), gap: null }, null, null]);
  });

  // The next day: a band right above the first item of it, and no gap (one
  // day apart is just the night).
  test("one calendar day apart: the band only", () => {
    expect(dayMarksOf([at("2026-11-16T14:00:00Z"), at("2026-11-16T15:30:00Z")])).toEqual([
      { day: day("2026-11-16"), gap: null },
      { day: day("2026-11-17"), gap: null },
    ]);
  });

  // Two or more calendar days apart: the band and, above it, the gap. The gap
  // has the calendar days between the two items and the time between them.
  test("two or more calendar days apart: the band and the gap above it", () => {
    expect(dayMarksOf([at("2026-11-13T05:00:00Z"), at("2026-11-16T01:00:00Z")])).toEqual([
      { day: day("2026-11-13"), gap: null },
      {
        day: day("2026-11-16"),
        gap: {
          days: 3,
          ms: Date.parse("2026-11-16T01:00:00Z") - Date.parse("2026-11-13T05:00:00Z"),
        },
      },
    ]);
    // Weeks apart reads the same way.
    expect(dayMarksOf([at("2026-10-01T05:00:00Z"), at("2026-10-22T05:00:00Z")])[1]?.gap?.days).toBe(
      21,
    );
  });

  // The count is of calendar days, not of 24-hour periods: 23:30 to 00:30 two
  // days on is 25 hours but two days apart, and 00:10 to 23:50 the next day is
  // almost 48 hours but one day apart.
  test("days are counted on the calendar, not by elapsed time", () => {
    const late = dayMarksOf([at("2026-11-13T14:30:00Z"), at("2026-11-14T15:30:00Z")]);
    expect(late[1]?.gap?.days).toBe(2);
    const early = dayMarksOf([at("2026-11-12T15:10:00Z"), at("2026-11-14T14:50:00Z")]);
    expect(early[1]).toEqual({ day: day("2026-11-14"), gap: null });
  });

  // Across the 23-hour day in New York: 23:30 EST on 03-07 to 00:30 EDT on
  // 03-09 is 24 hours, yet two calendar days, so the gap shows.
  test("a summer-time change does not move the count", () => {
    const marks = dayMarksOf([
      at("2026-03-08T04:30:00Z", NEW_YORK),
      at("2026-03-09T04:30:00Z", NEW_YORK),
    ]);
    expect(marks[1]).toEqual({ day: day("2026-03-09"), gap: { days: 2, ms: 86_400_000 } });
    // And across the 25-hour day: 00:10 EDT to 23:50 EST on 11-01 is over 24
    // hours on one calendar day: no band at all.
    expect(
      dayMarksOf([at("2026-11-01T04:10:00Z", NEW_YORK), at("2026-11-02T04:50:00Z", NEW_YORK)]),
    ).toEqual([{ day: day("2026-11-01"), gap: null }, null]);
  });

  // Months and years turn like any other day.
  test("the end of a month and of a year are days like the others", () => {
    expect(dayMarksOf([at("2026-11-30T05:00:00Z"), at("2026-12-01T05:00:00Z")])[1]).toEqual({
      day: day("2026-12-01"),
      gap: null,
    });
    const newYear = dayMarksOf([at("2026-12-30T05:00:00Z"), at("2027-01-02T05:00:00Z")]);
    expect(newYear[1]?.day).toBe(day("2027-01-02"));
    expect(newYear[1]?.gap?.days).toBe(3);
  });

  // An item with no time is not there for the marks: it gets none, and the
  // items on either side of it are compared with each other.
  test("an item without a time is passed over", () => {
    expect(
      dayMarksOf([
        null,
        at("2026-11-13T05:00:00Z"),
        null,
        null,
        at("2026-11-16T05:00:00Z"),
        null,
      ]).map((mark) => (mark === null ? null : [mark.day, mark.gap?.days ?? 0])),
    ).toEqual([null, [day("2026-11-13"), 0], null, null, [day("2026-11-16"), 3], null]);
  });

  // A fold group that ran on into the next day: the item after it on that next
  // day starts a new day (the band), but no day went by empty (no gap), though
  // the group started two days before. The gap is measured from where the item
  // above ended.
  test("the gap is measured from the end of the item above", () => {
    const fold = itemSpanOf(["2026-11-13T05:00:00Z", "2026-11-15T05:00:00Z"], TOKYO);
    expect(dayMarksOf([fold, at("2026-11-15T06:00:00Z")])[1]).toEqual({
      day: day("2026-11-15"),
      gap: null,
    });
    expect(dayMarksOf([fold, at("2026-11-18T05:00:00Z")])[1]?.gap).toEqual({
      days: 3,
      ms: 3 * 86_400_000,
    });
  });
});

// kawaz (2026-11-19): 「TLの最終アイテムと今日の日付が違う場合は最終アイテムの
// 下に今日の日付のtl-dayを置く」. The day an item is on is the day it starts
// on, as for the bands above the items: a band of today below the last item
// is where the band of a next item, coming in today, would go.
describe("tailBandOf", () => {
  const TODAY = day("2026-11-19");

  // The last item started on an earlier day: today's band goes below it, one
  // day or weeks after alike.
  test("today when the last item started on an earlier day", () => {
    expect(tailBandOf([at("2026-11-18T05:00:00Z")], TODAY)).toBe(TODAY);
    expect(tailBandOf([at("2026-10-01T05:00:00Z")], TODAY)).toBe(TODAY);
  });

  // The last item started today: its day is already on show above it.
  test("none when the last item started today", () => {
    expect(tailBandOf([at("2026-11-17T05:00:00Z"), at("2026-11-19T05:00:00Z")], TODAY)).toBeNull();
  });

  // A fold group that ran on into today started on an earlier day: a next
  // item today would get the band of today, so the end gets it too.
  test("an item that started before today and ran on into it", () => {
    const fold = itemSpanOf(["2026-11-18T05:00:00Z", "2026-11-19T05:00:00Z"], TOKYO);
    expect(tailBandOf([fold], TODAY)).toBe(TODAY);
  });

  // Items without a time are passed over, as by dayMarksOf; with none dated
  // there is no day to compare, and no band.
  test("the last item with a time decides; none without one", () => {
    expect(tailBandOf([at("2026-11-18T05:00:00Z"), null], TODAY)).toBe(TODAY);
    expect(tailBandOf([at("2026-11-19T05:00:00Z"), null], TODAY)).toBeNull();
    expect(tailBandOf([null, null], TODAY)).toBeNull();
    expect(tailBandOf([], TODAY)).toBeNull();
  });

  // A last item on a later day than today (a clock behind the one that wrote
  // it): a band of today below it would go against the order of the days.
  test("none when the last item is on a later day than today", () => {
    expect(tailBandOf([at("2026-11-20T05:00:00Z")], TODAY)).toBeNull();
  });
});

describe("dayLabel", () => {
  // The date and the weekday, both from Intl (ja-JP), in full-width
  // parentheses.
  test("the date and the weekday", () => {
    expect(dayLabel(day("2026-11-16"), null)).toBe("2026年11月16日（月）");
    expect(dayLabel(day("2027-01-03"), null)).toBe("2027年1月3日（日）");
  });

  // A holiday's name follows the weekday after 、, as the data says it.
  test("a holiday's name after the weekday", () => {
    expect(dayLabel(day("2026-11-23"), "勤労感謝の日")).toBe("2026年11月23日（月、勤労感謝の日）");
    expect(dayLabel(day("2026-05-06"), "憲法記念日 振替休日")).toBe(
      "2026年5月6日（水、憲法記念日 振替休日）",
    );
  });
});

describe("isoDateOf / yearOf", () => {
  // What the holiday list is looked up by: the band's own date, as written.
  test("the band's date as YYYY-MM-DD and its year", () => {
    expect(isoDateOf(day("2026-11-23"))).toBe("2026-11-23");
    expect(isoDateOf(day("2027-01-01"))).toBe("2027-01-01");
    expect(yearOf(day("2026-12-31"))).toBe(2026);
    expect(yearOf(day("2027-01-01"))).toBe(2027);
  });
});
