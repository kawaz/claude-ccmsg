// Which band ↑ / ↓ on a day band steps to (DR-0054 §9), over the dates of the
// bands of the view on show, top to bottom. The step is by place in the list,
// not by date: the band right above or right below. When the band pressed is
// gone by the time the step is taken (older rows of its own day came in above
// it, and the day's band moved up to them), the step is taken from the band of
// its date, or, with none, from where its date would be.
import { describe, expect, test } from "bun:test";
import { stepDayBand } from "../src/client/components/timeline/useDayJump.ts";

const DAYS = ["2026-09-01", "2026-09-02", "2026-10-20", "2026-11-03"];

describe("stepDayBand", () => {
  test("the band right above and right below", () => {
    expect(stepDayBand(DAYS, { index: 2 }, "up")).toBe(1);
    expect(stepDayBand(DAYS, { index: 2 }, "down")).toBe(3);
  });

  // At either end there is none that way: the caller reads older pages in, or
  // goes to the top or the end.
  test("none past either end", () => {
    expect(stepDayBand(DAYS, { index: 0 }, "up")).toBeNull();
    expect(stepDayBand(DAYS, { index: 3 }, "down")).toBeNull();
    expect(stepDayBand([], { day: "2026-10-20" }, "up")).toBeNull();
  });

  // The band pressed is gone: from the band of its date.
  test("from the band of the date when the band pressed is gone", () => {
    expect(stepDayBand(DAYS, { day: "2026-10-20" }, "up")).toBe(1);
    expect(stepDayBand(DAYS, { day: "2026-10-20" }, "down")).toBe(3);
    expect(stepDayBand(DAYS, { day: "2026-09-01" }, "up")).toBeNull();
  });

  // No band of that date either: from where its date would be.
  test("from where the date would be when no band has it", () => {
    expect(stepDayBand(DAYS, { day: "2026-10-01" }, "up")).toBe(1);
    expect(stepDayBand(DAYS, { day: "2026-10-01" }, "down")).toBe(2);
    expect(stepDayBand(DAYS, { day: "2026-08-01" }, "up")).toBeNull();
    expect(stepDayBand(DAYS, { day: "2026-12-01" }, "down")).toBeNull();
  });
});
