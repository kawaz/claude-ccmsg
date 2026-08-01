// Aggregation for the spend section: the parts a reader would be misled by if
// they were wrong — which figure a day's total comes from, how a window that
// straddles a month boundary rolls up, and that the gateway's unattributed
// "-" bucket keeps its money instead of being dropped as a non-credential.
import { describe, expect, test } from "bun:test";
import type { LlmStatsResponse } from "@ccmsg/protocol";
import {
  credentialLabel,
  dailyTotals,
  dayTotalUsd,
  formatBucket,
  formatShare,
  formatTokens,
  formatUsd,
  axisTicks,
  axisBucketLabel,
  bucketKey,
  bucketTotals,
  OTHER_SERIES,
  chartData,
  contextTotals,
  isStatsPeriod,
  niceCeiling,
  periodDays,
  showsLabel,
  shareOf,
  windowTotalUsd,
} from "../src/client/llm-stats-view.ts";

/** Two days either side of a month boundary, shaped like the live endpoint:
 * a named credential with two models, and the "-" bucket the gateway uses for
 * traffic it cannot attribute. */
const DAYS: LlmStatsResponse["days"] = {
  "2026-06-30": {
    credentials: {
      "claude-a": {
        "claude-opus-5": { requests: 10, input_tokens: 100, output_tokens: 50, usd: 4 },
      },
    },
    total_usd: 4,
  },
  "2026-07-01": {
    credentials: {
      "claude-a": {
        "claude-opus-5": { requests: 5, input_tokens: 10, output_tokens: 5, usd: 1 },
        "claude-sonnet-5": { requests: 2, usd: 0.5 },
      },
      "-": {
        "gpt-5.6-sol": { requests: 3, cache_read_input_tokens: 2_000_000, usd: 2.5 },
      },
    },
    total_usd: 4,
  },
};

describe("dayTotalUsd", () => {
  test("prefers the gateway's own total over the per-model sum", () => {
    // The gateway can charge for something it does not break out by model, so
    // its figure is authoritative even when it exceeds what the models add to.
    const day = { credentials: { c: { m: { usd: 1 } } }, total_usd: 9 };
    expect(dayTotalUsd(day)).toBe(9);
  });

  test("falls back to the per-model sum when the gateway sent no total", () => {
    const day = { credentials: { c: { m1: { usd: 1.5 }, m2: { usd: 2 } } } };
    expect(dayTotalUsd(day)).toBe(3.5);
  });

  test("a day with no credentials totals zero rather than NaN", () => {
    expect(dayTotalUsd({ credentials: {} })).toBe(0);
  });
});

describe("dailyTotals", () => {
  const rows = dailyTotals(DAYS);

  test("lists days newest first", () => {
    expect(rows.map((row) => row.key)).toEqual(["2026-07-01", "2026-06-30"]);
  });

  test("sums models across every credential, biggest spend first", () => {
    const models = rows[0]!.models;
    expect(models.map((m) => [m.model, m.usd])).toEqual([
      ["gpt-5.6-sol", 2.5],
      ["claude-opus-5", 1],
      ["claude-sonnet-5", 0.5],
    ]);
  });

  test("counters missing from upstream count as zero, not NaN", () => {
    const sonnet = rows[0]!.models.find((m) => m.model === "claude-sonnet-5");
    expect(sonnet).toMatchObject({ requests: 2, inputTokens: 0, outputTokens: 0 });
  });

  test("keeps the unattributed '-' bucket as a credential of its own", () => {
    const credentials = rows[0]!.credentials;
    // Credentials sort by spend like models do, so the unattributed bucket
    // leads here on the strength of its own figure.
    expect(credentials.map((c) => [c.credential, c.usd])).toEqual([
      ["-", 2.5],
      ["claude-a", 1.5],
    ]);
  });
});

describe("bucketTotals", () => {
  const months = bucketTotals(DAYS, "monthly");

  test("groups days into buckets, newest first, with the covered day count", () => {
    expect(months.map((m) => [m.key, m.usd, m.dayCount])).toEqual([
      ["2026-07", 4, 1],
      ["2026-06", 4, 1],
    ]);
  });

  test("daily buckets are the gateway's own days", () => {
    expect(bucketTotals(DAYS, "daily").map((b) => b.key)).toEqual(["2026-07-01", "2026-06-30"]);
  });

  // The two days straddle a month boundary but fall in the same ISO week
  // (2026-06-30 is a Tuesday, 2026-07-01 the Wednesday after it) — the case a
  // naive "slice the month off the key" grouping would get wrong.
  test("weekly buckets follow the ISO week across a month boundary", () => {
    const weeks = bucketTotals(DAYS, "weekly");
    expect(weeks).toHaveLength(1);
    expect(weeks[0]!.usd).toBe(8);
    expect(weeks[0]!.dayCount).toBe(2);
  });

  test("yearly buckets collapse to the calendar year", () => {
    expect(bucketTotals(DAYS, "yearly").map((b) => [b.key, b.usd])).toEqual([["2026", 8]]);
  });

  test("merges a model that appears on several days of the bucket", () => {
    const july = bucketTotals(
      {
        "2026-07-01": { credentials: { c: { m: { requests: 1, usd: 1 } } }, total_usd: 1 },
        "2026-07-02": { credentials: { c: { m: { requests: 2, usd: 3 } } }, total_usd: 3 },
      },
      "monthly",
    );
    expect(july).toHaveLength(1);
    expect(july[0]!.dayCount).toBe(2);
    expect(july[0]!.usd).toBe(4);
    expect(july[0]!.models).toEqual([expect.objectContaining({ model: "m", usd: 4, requests: 3 })]);
  });

  test("an empty window rolls up to no buckets rather than to one empty one", () => {
    expect(bucketTotals({}, "monthly")).toEqual([]);
  });
});

describe("bucketKey", () => {
  test("takes the span's key off a YYYY-MM-DD date", () => {
    expect(bucketKey("2026-07-31", "daily")).toBe("2026-07-31");
    expect(bucketKey("2026-07-31", "monthly")).toBe("2026-07");
    expect(bucketKey("2026-07-31", "yearly")).toBe("2026");
    expect(bucketKey("2026-07-31", "weekly")).toBe("2026-W31");
  });

  // The ISO week-year is not the calendar year at the turn. 2026 runs to
  // W53, and that week reaches into January: 2027-01-03 is a Sunday still
  // inside 2026-W53. Taking the year from the date string instead of from the
  // ISO calculation would file those days under 2027 and split one week's
  // spend across two buckets every new year.
  test("the ISO week-year wins over the calendar year at the boundary", () => {
    expect(bucketKey("2026-12-28", "weekly")).toBe("2026-W53");
    expect(bucketKey("2026-12-31", "weekly")).toBe("2026-W53");
    expect(bucketKey("2027-01-03", "weekly")).toBe("2026-W53");
    expect(bucketKey("2027-01-04", "weekly")).toBe("2027-W01");
  });

  test("weeks run Monday to Sunday", () => {
    // 2026-07-27 is a Monday; the Sunday that closes that week is 2026-08-02.
    expect(bucketKey("2026-07-27", "weekly")).toBe("2026-W31");
    expect(bucketKey("2026-08-02", "weekly")).toBe("2026-W31");
    expect(bucketKey("2026-08-03", "weekly")).toBe("2026-W32");
  });

  // Spend under a key the gateway formats differently must stay visible;
  // folding it into a neighbouring bucket would misstate that bucket.
  test("gives an unrecognised key its own bucket in every span", () => {
    for (const period of ["daily", "weekly", "monthly", "yearly"] as const) {
      expect(bucketKey("week-31", period)).toBe("week-31");
    }
    expect(bucketTotals({ "week-31": { credentials: {}, total_usd: 2 } }, "monthly")[0]!.key).toBe(
      "week-31",
    );
  });
});

describe("windowTotalUsd", () => {
  test("adds every day in the window", () => {
    expect(windowTotalUsd(DAYS)).toBe(8);
  });

  test("is zero for an empty window", () => {
    expect(windowTotalUsd({})).toBe(0);
  });
});

describe("formatUsd", () => {
  test("two decimals with thousands separators", () => {
    expect(formatUsd(1548.119857)).toBe("$1,548.12");
    expect(formatUsd(0)).toBe("$0.00");
  });

  // A model that cost something must never read as having cost nothing.
  test("floors a nonzero amount that would round to zero", () => {
    expect(formatUsd(0.003)).toBe("<$0.01");
    expect(formatUsd(-0.003)).toBe(">-$0.01");
  });

  test("negatives keep the sign outside the currency mark", () => {
    expect(formatUsd(-12.5)).toBe("-$12.50");
  });

  test("a non-finite figure degrades instead of printing NaN", () => {
    expect(formatUsd(Number.NaN)).toBe("$-");
  });
});

describe("formatTokens", () => {
  test("scales to the magnitude that is being asked about", () => {
    expect(formatTokens(950)).toBe("950");
    expect(formatTokens(1_500)).toBe("1.5k");
    expect(formatTokens(2_400_000)).toBe("2.4M");
    expect(formatTokens(267_628_570)).toBe("267.6M");
    expect(formatTokens(1_200_000_000)).toBe("1.2B");
  });
});

describe("formatShare", () => {
  test("rounds to whole percent", () => {
    expect(formatShare(0.335)).toBe("34%");
    expect(formatShare(1)).toBe("100%");
    expect(formatShare(0)).toBe("0%");
  });

  // 300M input tokens beside a cache-read column 400x its size is still 300M
  // tokens; "0%" would read as "none".
  test("floors a nonzero share that would round away", () => {
    expect(formatShare(0.002)).toBe("<1%");
    expect(formatShare(0.999)).toBe(">99%");
  });

  test("a non-finite share degrades instead of printing NaN", () => {
    expect(formatShare(Number.NaN)).toBe("-");
  });
});

describe("shareOf", () => {
  test("is a fraction of the total", () => {
    expect(shareOf(25, 100)).toBe(0.25);
  });

  test("an all-zero window shares out as zero rather than NaN", () => {
    expect(shareOf(0, 0)).toBe(0);
  });

  test("clamps a part that exceeds its total (gateway total_usd < model sum)", () => {
    expect(shareOf(5, 2)).toBe(1);
  });
});

describe("labels", () => {
  test("names the unattributed bucket instead of showing a bare dash", () => {
    expect(credentialLabel("-")).toBe("(クレデンシャル未割当)");
  });

  test("leaves an operator's own credential name alone", () => {
    expect(credentialLabel("claude-a")).toBe("claude-a");
  });

  test("bucket keys read as the span they name", () => {
    expect(formatBucket("2026-07-31")).toBe("2026-07-31");
    expect(formatBucket("2026-07")).toBe("2026年7月");
    expect(formatBucket("2026-W31")).toBe("2026年 第31週");
    expect(formatBucket("2026")).toBe("2026年");
    expect(formatBucket("week-31")).toBe("week-31");
  });
});

// ---------------------------------------------------------------------------
// Context kinds and chart geometry.

describe("periods", () => {
  // The counts are wider than the span they draw so the oldest bucket on
  // screen is whole; "yearly" asks for a century of days on purpose, since the
  // gateway clamps and that is what "everything" means here.
  test("each span asks for enough history to fill itself", () => {
    expect(periodDays("daily")).toBe(32);
    expect(periodDays("weekly")).toBe(96);
    expect(periodDays("monthly")).toBe(397);
    expect(periodDays("yearly")).toBe(36_524);
  });

  test("only the four spans are spans", () => {
    expect(isStatsPeriod("daily")).toBe(true);
    expect(isStatsPeriod("yearly")).toBe(true);
    expect(isStatsPeriod("hourly")).toBe(false);
    expect(isStatsPeriod("")).toBe(false);
  });
});

describe("contextTotals", () => {
  const models = [
    {
      model: "a",
      usd: 1,
      requests: 1,
      inputTokens: 100,
      outputTokens: 200,
      cacheCreationTokens: 300,
      cacheReadTokens: 400,
    },
    {
      model: "b",
      usd: 1,
      requests: 1,
      inputTokens: 100,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
    },
  ];

  test("sums each counter across models, in a fixed order", () => {
    expect(contextTotals(models).map((entry) => [entry.kind, entry.tokens])).toEqual([
      ["input", 200],
      ["output", 200],
      ["cacheCreation", 300],
      ["cacheRead", 400],
    ]);
  });

  test("shares are of total tokens and add up to one", () => {
    const totals = contextTotals(models);
    expect(totals[0]!.share).toBeCloseTo(200 / 1100, 10);
    expect(totals.reduce((sum, entry) => sum + entry.share, 0)).toBeCloseTo(1, 10);
  });

  // A bucket with spend but no reported tokens must not divide by zero.
  test("a bucket with no tokens shares out as zero, not NaN", () => {
    const totals = contextTotals([
      {
        model: "a",
        usd: 5,
        requests: 1,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      },
    ]);
    expect(totals.every((entry) => entry.share === 0)).toBe(true);
  });
});

describe("niceCeiling / axisTicks", () => {
  test("rounds up to a number a reader can do arithmetic with", () => {
    expect(niceCeiling(0.7)).toBe(1);
    expect(niceCeiling(37)).toBe(50);
    expect(niceCeiling(1548)).toBe(2000);
    expect(niceCeiling(2000)).toBe(2000);
  });

  test("an empty or unusable range has no scale to draw", () => {
    expect(niceCeiling(0)).toBe(0);
    expect(niceCeiling(Number.NaN)).toBe(0);
    expect(axisTicks(0)).toEqual([0]);
  });

  test("ticks run from zero to the ceiling in even steps", () => {
    expect(axisTicks(37)).toEqual([0, 12.5, 25, 37.5, 50]);
  });
});

describe("chartData", () => {
  function bucket(key: string, models: Array<[string, number]>) {
    return {
      key,
      usd: models.reduce((sum, [, usd]) => sum + usd, 0),
      dayCount: 1,
      credentials: [],
      models: models.map(([model, usd]) => ({
        model,
        usd,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      })),
    };
  }

  // The table reads newest-first; the chart reads left to right in time. Each
  // is right for its own form, so the chart re-sorts rather than inheriting.
  test("bars run oldest first, whatever order the buckets arrive in", () => {
    const data = chartData([bucket("2026-07-02", [["a", 1]]), bucket("2026-07-01", [["a", 2]])]);
    expect(data.bars.map((bar) => bar.key)).toEqual(["2026-07-01", "2026-07-02"]);
    expect(data.bars.map((bar) => bar.axisLabel)).toEqual(["07-01", "07-02"]);
  });

  // Colour follows the entity, not its rank inside one bar — otherwise a model
  // changes colour as the reader moves along the axis.
  test("series order is total spend across the window, and stacking follows it", () => {
    const data = chartData([
      bucket("2026-07-01", [
        ["cheap", 1],
        ["dear", 10],
      ]),
      bucket("2026-07-02", [
        ["cheap", 5],
        ["dear", 1],
      ]),
    ]);
    expect(data.models).toEqual(["dear", "cheap"]);
    expect(data.bars[1]!.segments.map((s) => s.model)).toEqual(["dear", "cheap"]);
  });

  test("segments stack from the baseline as fractions of the tallest bar", () => {
    const data = chartData([
      bucket("2026-07-01", [
        ["a", 3],
        ["b", 1],
      ]),
    ]);
    expect(data.max).toBe(4);
    expect(data.bars[0]!.segments).toEqual([
      { model: "a", usd: 3, start: 0, end: 0.75 },
      { model: "b", usd: 1, start: 0.75, end: 1 },
    ]);
  });

  // A ninth series is never a generated hue: the palette is eight slots, and
  // the tail folds into one named bucket instead.
  test("models past the palette fold into one 'other' series", () => {
    const models: Array<[string, number]> = Array.from({ length: 10 }, (_, i) => [`m${i}`, 10 - i]);
    const data = chartData([bucket("2026-07-01", models)]);
    expect(data.models).toHaveLength(9);
    expect(data.models[8]).toBe("その他");
    const other = data.bars[0]!.segments.find((s) => s.model === "その他");
    // m8 (2) + m9 (1): the two that did not get a slot.
    expect(other?.usd).toBe(3);
  });

  test("a model absent from a bucket contributes no segment", () => {
    const data = chartData([bucket("2026-07-01", [["a", 1]]), bucket("2026-07-02", [["b", 1]])]);
    expect(data.bars[0]!.segments.map((s) => s.model)).toEqual(["a"]);
    expect(data.bars[1]!.segments.map((s) => s.model)).toEqual(["b"]);
  });

  test("an all-zero window produces no geometry rather than NaN fractions", () => {
    const data = chartData([bucket("2026-07-01", [["a", 0]])]);
    expect(data.max).toBe(0);
    expect(data.bars[0]!.segments).toEqual([]);
  });

  test("no buckets is an empty chart, not a crash", () => {
    expect(chartData([])).toEqual({ models: [], folded: [], bars: [], max: 0, ticks: [0] });
  });
});

describe("axisBucketLabel", () => {
  // The year repeats under every tick of a one-month window and says nothing
  // the window does not already say; the hover and the table keep it.
  test("drops the repeated year from dense spans", () => {
    expect(axisBucketLabel("2026-07-28")).toBe("07-28");
    expect(axisBucketLabel("2026-W31")).toBe("W31");
  });

  test("leaves sparse spans at their full label", () => {
    expect(axisBucketLabel("2026-07")).toBe("2026年7月");
    expect(axisBucketLabel("2026")).toBe("2026年");
    expect(axisBucketLabel("week-31")).toBe("week-31");
  });
});

describe("showsLabel", () => {
  // A month of daily bars cannot carry 32 labels; the newest is always one of
  // the ones that survives, since it is the bar being read.
  test("thins labels but always keeps the newest bar", () => {
    expect(showsLabel(31, 32)).toBe(true);
    expect(showsLabel(0, 32)).toBe(false);
    expect([...Array(32).keys()].filter((i) => showsLabel(i, 32))).toHaveLength(8);
  });

  test("labels every bar when they all fit", () => {
    expect([...Array(5).keys()].every((i) => showsLabel(i, 5))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Legend filtering. Selecting models narrows the aggregation itself, not just
// what is drawn — so every total on screen is the total of what is on screen.

describe("model filtering", () => {
  const DAYS_2: LlmStatsResponse["days"] = {
    "2026-07-01": {
      credentials: {
        "cred-a": {
          opus: { requests: 2, input_tokens: 10, usd: 6 },
          sonnet: { requests: 4, input_tokens: 20, usd: 3 },
        },
        "cred-b": { haiku: { requests: 8, usd: 1 } },
      },
      // Deliberately higher than the models sum (10): the gateway charges for
      // something it does not break out, which is why it wins unfiltered.
      total_usd: 12,
    },
  };

  test("no filter keeps the gateway's own authoritative total", () => {
    expect(windowTotalUsd(DAYS_2)).toBe(12);
    expect(bucketTotals(DAYS_2, "daily")[0]!.usd).toBe(12);
  });

  // Under a filter that total covers models the reader excluded, so the sum of
  // what survived is the only figure matching the screen.
  test("a filter totals the retained models rather than the gateway's figure", () => {
    const filter = new Set(["opus"]);
    expect(windowTotalUsd(DAYS_2, filter)).toBe(6);
    const bucket = bucketTotals(DAYS_2, "daily", filter)[0]!;
    expect(bucket.usd).toBe(6);
    expect(bucket.models.map((m) => m.model)).toEqual(["opus"]);
  });

  test("selecting several models sums exactly those", () => {
    expect(windowTotalUsd(DAYS_2, new Set(["opus", "haiku"]))).toBe(7);
  });

  test("token counters follow the filter, so the context split matches", () => {
    const bucket = bucketTotals(DAYS_2, "daily", new Set(["sonnet"]))[0]!;
    expect(bucket.models[0]!.inputTokens).toBe(20);
    expect(contextTotals(bucket.models)[0]!.tokens).toBe(20);
  });

  // A credential whose every model was excluded has nothing to report; an
  // empty row would read as "spent nothing on this key".
  test("a credential left with no models drops out entirely", () => {
    const bucket = bucketTotals(DAYS_2, "daily", new Set(["haiku"]))[0]!;
    expect(bucket.credentials.map((c) => c.credential)).toEqual(["cred-b"]);
  });

  test("a filter naming nothing present yields an empty, zeroed bucket", () => {
    const bucket = bucketTotals(DAYS_2, "daily", new Set(["gone"]))[0]!;
    expect(bucket.usd).toBe(0);
    expect(bucket.models).toEqual([]);
    expect(bucket.credentials).toEqual([]);
  });

  test("daily rollups honour the filter the same way", () => {
    expect(dailyTotals(DAYS_2, new Set(["opus"]))[0]!.usd).toBe(6);
    expect(dailyTotals(DAYS_2)[0]!.usd).toBe(12);
  });
});

describe("chartData with a reused series order", () => {
  function bucketOf(key: string, models: Array<[string, number]>) {
    return {
      key,
      usd: models.reduce((sum, [, usd]) => sum + usd, 0),
      dayCount: 1,
      credentials: [],
      models: models.map(([model, usd]) => ({
        model,
        usd,
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheCreationTokens: 0,
        cacheReadTokens: 0,
      })),
    };
  }

  // Colour follows the entity: filtering to one model must not promote it to
  // the first slot and repaint it.
  test("keeps the legend and the colour order of the unfiltered window", () => {
    const all = [
      bucketOf("2026-07-01", [
        ["dear", 10],
        ["cheap", 1],
      ]),
    ];
    const legend = chartData(all);
    expect(legend.models).toEqual(["dear", "cheap"]);

    const filtered = [bucketOf("2026-07-01", [["cheap", 1]])];
    const data = chartData(filtered, { series: legend.models, folded: legend.folded });
    expect(data.models).toEqual(["dear", "cheap"]);
    expect(data.bars[0]!.segments.map((s) => s.model)).toEqual(["cheap"]);
  });

  test("reports what the folded entry stands for", () => {
    const models: Array<[string, number]> = Array.from({ length: 10 }, (_, i) => [`m${i}`, 10 - i]);
    const legend = chartData([bucketOf("2026-07-01", models)]);
    expect(legend.models.at(-1)).toBe(OTHER_SERIES);
    // The two that did not get a colour slot.
    expect(legend.folded.sort()).toEqual(["m8", "m9"]);
  });

  test("a model absent from a reused legend contributes no segment", () => {
    const data = chartData([bucketOf("2026-07-01", [["ghost", 5]])], {
      series: ["dear"],
      folded: [],
    });
    expect(data.models).toEqual(["dear"]);
    expect(data.bars[0]!.segments).toEqual([]);
  });
});
