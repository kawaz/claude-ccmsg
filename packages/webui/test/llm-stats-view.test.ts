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
  formatMonth,
  formatTokens,
  formatUsd,
  monthKey,
  monthlyTotals,
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

describe("monthlyTotals", () => {
  const months = monthlyTotals(DAYS);

  test("groups days by month, newest first, with the covered day count", () => {
    expect(months.map((m) => [m.key, m.usd, m.dayCount])).toEqual([
      ["2026-07", 4, 1],
      ["2026-06", 4, 1],
    ]);
  });

  test("merges a model that appears on several days of the month", () => {
    const july = monthlyTotals({
      "2026-07-01": { credentials: { c: { m: { requests: 1, usd: 1 } } }, total_usd: 1 },
      "2026-07-02": { credentials: { c: { m: { requests: 2, usd: 3 } } }, total_usd: 3 },
    });
    expect(july).toHaveLength(1);
    expect(july[0]!.dayCount).toBe(2);
    expect(july[0]!.usd).toBe(4);
    expect(july[0]!.models).toEqual([expect.objectContaining({ model: "m", usd: 4, requests: 3 })]);
  });

  test("an empty window rolls up to no months rather than to one empty one", () => {
    expect(monthlyTotals({})).toEqual([]);
  });
});

describe("monthKey", () => {
  test("takes the month off a YYYY-MM-DD key", () => {
    expect(monthKey("2026-07-31")).toBe("2026-07");
  });

  // Spend that happened under a key the gateway formats differently must stay
  // visible; folding it into a neighbouring month would misstate that month.
  test("gives an unrecognised key its own bucket", () => {
    expect(monthKey("week-31")).toBe("week-31");
    expect(monthlyTotals({ "week-31": { credentials: {}, total_usd: 2 } })[0]!.key).toBe("week-31");
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

  test("month keys read as months", () => {
    expect(formatMonth("2026-07")).toBe("2026年7月");
    expect(formatMonth("week-31")).toBe("week-31");
  });
});
