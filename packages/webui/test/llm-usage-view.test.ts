// Usage screen presentation math. The load-bearing claim is the elapsed
// percentage: upstream never sends it, so it is reconstructed from the window
// key ("5h") and the reset timestamp, and the pace warning is only as
// trustworthy as that reconstruction.
import { describe, expect, test } from "bun:test";
import type { LlmUsageSnapshot } from "@ccmsg/protocol";
import {
  formatAge,
  formatPercent,
  formatRemaining,
  parseWindowDurationMs,
  snapshotAge,
  sortedWindows,
  supportDescription,
  windowProgress,
} from "../src/client/llm-usage-view.ts";

const NOW = Date.parse("2026-07-31T00:00:00Z");
const HOUR = 3_600_000;
const MINUTE = 60_000;

/** reset timestamp (epoch seconds) that is `ms` from NOW. */
function resetIn(ms: number): number {
  return (NOW + ms) / 1000;
}

describe("parseWindowDurationMs", () => {
  test("reads the units the gateway uses", () => {
    expect(parseWindowDurationMs("5h")).toBe(5 * HOUR);
    expect(parseWindowDurationMs("7d")).toBe(7 * 24 * HOUR);
    expect(parseWindowDurationMs("30m")).toBe(30 * MINUTE);
    expect(parseWindowDurationMs("2w")).toBe(14 * 24 * HOUR);
  });

  test("refuses keys it cannot interpret rather than guessing", () => {
    for (const key of ["", "h", "5", "5y", "0h", "-1h", "5 h", "5hh", "1.5h"]) {
      expect(parseWindowDurationMs(key)).toBeNull();
    }
  });
});

describe("formatRemaining", () => {
  test("uses hours+minutes below a day", () => {
    expect(formatRemaining(89 * MINUTE)).toBe("1h29m");
    expect(formatRemaining(49 * MINUTE)).toBe("0h49m");
    expect(formatRemaining(23 * HOUR + 59 * MINUTE)).toBe("23h59m");
  });

  test("uses days+hours at a day and above", () => {
    expect(formatRemaining(24 * HOUR)).toBe("01d00h");
    expect(formatRemaining(2 * 24 * HOUR + 2 * HOUR)).toBe("02d02h");
  });

  // A reset that has already passed means the snapshot is old, not that time
  // ran backwards; the row still has to render.
  test("clamps a reset that is already in the past", () => {
    expect(formatRemaining(-5 * HOUR)).toBe("0h00m");
  });
});

describe("formatAge", () => {
  test("stays silent while the reading is fresh", () => {
    expect(formatAge(0)).toBeNull();
    expect(formatAge(59_000)).toBeNull();
  });

  test("scales the unit with the age", () => {
    expect(formatAge(5 * MINUTE)).toBe("5 分前");
    expect(formatAge(3 * HOUR)).toBe("3 時間前");
    expect(formatAge(50 * HOUR)).toBe("2 日前");
  });
});

describe("windowProgress", () => {
  // The CLI's own example: 13% used, 49 minutes left on a 5h window, so 84%
  // of the window has gone by — comfortably under pace.
  test("derives elapsed from the window key and the reset time", () => {
    const progress = windowProgress(
      "5h",
      { utilization: 0.13, status: "allowed", reset: resetIn(49 * MINUTE) },
      NOW,
    );
    expect(progress.remainingMs).toBe(49 * MINUTE);
    expect(formatPercent(progress.elapsed ?? 0)).toBe("84%");
    expect(progress.overPace).toBe(false);
    expect(progress.tone).toBe("ok");
  });

  test("flags utilization running ahead of the clock", () => {
    const progress = windowProgress(
      "7d",
      { utilization: 0.95, status: "allowed", reset: resetIn(2 * 24 * HOUR) },
      NOW,
    );
    expect(formatPercent(progress.elapsed ?? 0)).toBe("71%");
    expect(progress.overPace).toBe(true);
    expect(progress.tone).toBe("warn");
  });

  // Bursty usage sits slightly ahead of the clock all the time; a warning
  // there would fire constantly and stop carrying information.
  test("tolerates a small lead over the clock", () => {
    const barely = windowProgress(
      "5h",
      { utilization: 0.54, status: "allowed", reset: resetIn(2.5 * HOUR) },
      NOW,
    );
    expect(barely.elapsed).toBe(0.5);
    expect(barely.overPace).toBe(false);
    expect(barely.tone).toBe("ok");

    const clear = windowProgress(
      "5h",
      { utilization: 0.7, status: "allowed", reset: resetIn(2.5 * HOUR) },
      NOW,
    );
    expect(clear.overPace).toBe(true);
  });

  test("upstream's own verdict outranks the pace calculation", () => {
    const warned = windowProgress(
      "5h",
      { utilization: 0.02, status: "allowed_warning", reset: resetIn(4 * HOUR) },
      NOW,
    );
    expect(warned.overPace).toBe(false);
    expect(warned.tone).toBe("warn");

    const rejected = windowProgress(
      "5h",
      { utilization: 1, status: "rejected", reset: resetIn(HOUR) },
      NOW,
    );
    expect(rejected.tone).toBe("bad");
  });

  // Without both the key's duration and a reset there is nothing to compare
  // utilization against, so no pace verdict is invented.
  test("offers no pace verdict when elapsed cannot be derived", () => {
    const noReset = windowProgress("5h", { utilization: 0.9, status: "allowed" }, NOW);
    expect(noReset.elapsed).toBeNull();
    expect(noReset.remainingMs).toBeNull();
    expect(noReset.overPace).toBe(false);
    expect(noReset.tone).toBe("ok");

    const oddKey = windowProgress(
      "rolling",
      { utilization: 0.9, status: "allowed", reset: resetIn(HOUR) },
      NOW,
    );
    expect(oddKey.elapsed).toBeNull();
    expect(oddKey.remainingMs).toBe(HOUR);
    expect(oddKey.overPace).toBe(false);
  });

  test("clamps elapsed into 0..1 for a reset outside the window", () => {
    const past = windowProgress(
      "5h",
      { utilization: 0.5, status: "allowed", reset: resetIn(-HOUR) },
      NOW,
    );
    expect(past.elapsed).toBe(1);
    const far = windowProgress(
      "5h",
      { utilization: 0.5, status: "allowed", reset: resetIn(9 * HOUR) },
      NOW,
    );
    expect(far.elapsed).toBe(0);
  });
});

describe("sortedWindows", () => {
  const snapshot = (windows: LlmUsageSnapshot["windows"]): LlmUsageSnapshot => ({ windows });

  test("orders windows shortest-first regardless of upstream key order", () => {
    const keys = sortedWindows(
      snapshot({
        "7d": { utilization: 0.8, status: "allowed" },
        "30m": { utilization: 0.1, status: "allowed" },
        "5h": { utilization: 0.2, status: "allowed" },
      }),
      NOW,
    ).map((w) => w.key);
    expect(keys).toEqual(["30m", "5h", "7d"]);
  });

  test("appends windows whose length cannot be placed on the scale", () => {
    const keys = sortedWindows(
      snapshot({
        rolling: { utilization: 0.1, status: "allowed" },
        "5h": { utilization: 0.2, status: "allowed" },
        lifetime: { utilization: 0.3, status: "allowed" },
      }),
      NOW,
    ).map((w) => w.key);
    expect(keys).toEqual(["5h", "lifetime", "rolling"]);
  });

  test("an empty snapshot yields no rows", () => {
    expect(sortedWindows(snapshot({}), NOW)).toEqual([]);
  });
});

describe("snapshotAge", () => {
  test("reports the age of a lagging observation", () => {
    expect(snapshotAge({ windows: {}, observed_at: (NOW - 5 * MINUTE) / 1000 }, NOW)).toBe(
      "5 分前",
    );
  });

  test("stays silent when fresh or when upstream sent no observation time", () => {
    expect(snapshotAge({ windows: {}, observed_at: NOW / 1000 }, NOW)).toBeNull();
    expect(snapshotAge({ windows: {} }, NOW)).toBeNull();
  });

  // A clock skew that puts the observation in the future must not produce a
  // negative age or a bogus "0 分前".
  test("treats a future observation as fresh", () => {
    expect(snapshotAge({ windows: {}, observed_at: (NOW + 10 * MINUTE) / 1000 }, NOW)).toBeNull();
  });
});

describe("supportDescription", () => {
  test("explains each support value, including ones it has not seen", () => {
    expect(supportDescription("observed")).toContain("観測");
    expect(supportDescription("not_applicable")).toContain("クオータの概念がない");
    expect(supportDescription("upstream_dependent")).toContain("上流");
    expect(supportDescription("something_new")).toContain("不明");
  });
});
