// Usage screen presentation math. The load-bearing claim is the elapsed
// percentage: upstream never sends it, so it is reconstructed from the window
// key ("5h") and the reset timestamp, and the pace warning is only as
// trustworthy as that reconstruction.
import { describe, expect, test } from "bun:test";
import type { LlmUsageCredential, LlmUsageLimit, LlmUsageSnapshot } from "@ccmsg/protocol";
import {
  formatAge,
  formatPercent,
  formatRemaining,
  limitKindDurationMs,
  limitLabel,
  limitProgress,
  parseWindowDurationMs,
  probeRecordOf,
  probeView,
  severityTone,
  snapshotAge,
  sortedLimits,
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

// ---------------------------------------------------------------------------
// Provider limits. These arrive beside the quota windows in a different unit
// (0..100, not 0..1) with their own verdict vocabulary, and get normalized
// onto the same bar — so the unit conversion and the verdict mapping are the
// two things worth pinning.

const DAY = 24 * HOUR;

/** RFC3339 instant `ms` from NOW, the way upstream sends resets_at. */
function resetsAtIn(ms: number): string {
  return new Date(NOW + ms).toISOString();
}

function limit(over: Partial<LlmUsageLimit> = {}): LlmUsageLimit {
  return { kind: "weekly_all", percent: 50, severity: "normal", ...over };
}

describe("limitKindDurationMs", () => {
  test("knows the periods upstream names", () => {
    expect(limitKindDurationMs("session")).toBe(5 * HOUR);
    expect(limitKindDurationMs("weekly_all")).toBe(7 * DAY);
    expect(limitKindDurationMs("weekly_scoped")).toBe(7 * DAY);
  });

  // A kind the gateway adds later must render as consumption alone rather
  // than against a guessed clock.
  test("declines to guess an unfamiliar kind", () => {
    expect(limitKindDurationMs("monthly_all")).toBeNull();
    expect(limitKindDurationMs("")).toBeNull();
  });
});

describe("severityTone", () => {
  test("maps upstream's words onto the screen's three tones", () => {
    expect(severityTone("normal")).toBe("ok");
    expect(severityTone("warning")).toBe("warn");
    expect(severityTone("critical")).toBe("bad");
  });

  // Colouring an unrecognised severity red would invent a problem the reading
  // does not state.
  test("an unknown severity is not alarming", () => {
    expect(severityTone("catastrophic")).toBe("ok");
  });
});

describe("limitProgress", () => {
  // The unit trap: percent is 0..100 while every bar here is drawn from a
  // 0..1 fraction. Getting this wrong renders a 47% limit as a full bar.
  test("converts percent to the fraction the bars are drawn from", () => {
    expect(limitProgress(limit({ percent: 47 }), NOW).utilization).toBeCloseTo(0.47, 10);
    expect(limitProgress(limit({ percent: 100 }), NOW).utilization).toBe(1);
    expect(limitProgress(limit({ percent: 0 }), NOW).utilization).toBe(0);
  });

  test("derives the elapsed fraction from resets_at and the kind's period", () => {
    // Two days left of a seven-day period: five sevenths elapsed.
    const progress = limitProgress(
      limit({ kind: "weekly_all", resets_at: resetsAtIn(2 * DAY) }),
      NOW,
    );
    expect(progress.remainingMs).toBe(2 * DAY);
    expect(progress.elapsed).toBeCloseTo(5 / 7, 10);
  });

  test("without resets_at there is no clock to compare against", () => {
    const progress = limitProgress(limit(), NOW);
    expect(progress.remainingMs).toBeNull();
    expect(progress.elapsed).toBeNull();
    expect(progress.overPace).toBe(false);
  });

  test("an unparseable resets_at degrades like a missing one", () => {
    expect(limitProgress(limit({ resets_at: "not a date" }), NOW).remainingMs).toBeNull();
  });

  // A stale reading whose reset has already passed must not show negative
  // time remaining.
  test("a reset already in the past clamps to zero", () => {
    expect(limitProgress(limit({ resets_at: resetsAtIn(-HOUR) }), NOW).remainingMs).toBe(0);
  });

  test("consumption well ahead of the clock raises a normal limit to a warning", () => {
    // One day into a seven-day period, 80% spent.
    const progress = limitProgress(limit({ percent: 80, resets_at: resetsAtIn(6 * DAY) }), NOW);
    expect(progress.elapsed).toBeCloseTo(1 / 7, 10);
    expect(progress.overPace).toBe(true);
    expect(progress.tone).toBe("warn");
  });

  // Upstream's own verdict is the stronger statement; a pace reading can lift
  // a normal limit but must never talk a critical one down.
  test("the pace reading cannot soften upstream's verdict", () => {
    const progress = limitProgress(
      limit({ percent: 10, severity: "critical", resets_at: resetsAtIn(DAY) }),
      NOW,
    );
    expect(progress.overPace).toBe(false);
    expect(progress.tone).toBe("bad");
  });

  test("is_active is carried as a marker, absent meaning not active", () => {
    expect(limitProgress(limit({ is_active: true }), NOW).isActive).toBe(true);
    expect(limitProgress(limit(), NOW).isActive).toBe(false);
  });

  test("severity and model are passed through untranslated", () => {
    const progress = limitProgress(
      limit({ kind: "weekly_scoped", severity: "warning", model: "Fable" }),
      NOW,
    );
    expect(progress.key).toBe("weekly_scoped");
    expect(progress.severity).toBe("warning");
    expect(progress.model).toBe("Fable");
  });
});

describe("sortedLimits", () => {
  test("shortest period first, unknown kinds last", () => {
    const rows = sortedLimits(
      [limit({ kind: "monthly_all" }), limit({ kind: "weekly_all" }), limit({ kind: "session" })],
      NOW,
    );
    expect(rows.map((row) => row.key)).toEqual(["session", "weekly_all", "monthly_all"]);
  });

  // Several scoped limits share one kind; keeping upstream's order groups
  // them with the total they are carved out of.
  test("ties keep upstream's order", () => {
    const rows = sortedLimits(
      [
        limit({ kind: "weekly_scoped", model: "Fable" }),
        limit({ kind: "weekly_scoped", model: "Opus" }),
      ],
      NOW,
    );
    expect(rows.map((row) => row.model)).toEqual(["Fable", "Opus"]);
  });

  test("no limits is a normal state, not an error", () => {
    expect(sortedLimits([], NOW)).toEqual([]);
  });
});

describe("limitLabel", () => {
  test("names the model a scoped limit applies to", () => {
    expect(limitLabel(limitProgress(limit({ kind: "weekly_scoped", model: "Fable" }), NOW))).toBe(
      "weekly_scoped (Fable)",
    );
  });

  // Upstream's vocabulary is not translated — these are the words the
  // gateway's own output uses.
  test("an unscoped limit is its kind verbatim", () => {
    expect(limitLabel(limitProgress(limit({ kind: "weekly_all" }), NOW))).toBe("weekly_all");
    expect(limitLabel(limitProgress(limit({ kind: "brand_new_kind" }), NOW))).toBe(
      "brand_new_kind",
    );
  });
});

// ---------------------------------------------------------------------------
// Retaining what a probe found. Only a `?refresh=true` response carries limits
// and probe_error; every automatic read is served from the gateway's cache and
// says nothing about either. Without retention the limits would appear for one
// tick after the manual refresh and vanish at the next poll.

const MINUTE_MS = 60_000;

function credential(over: Partial<LlmUsageCredential> = {}): LlmUsageCredential {
  return { name: "c", support: "observed", ...over };
}

const LIMITS: LlmUsageLimit[] = [{ kind: "weekly_all", percent: 100, severity: "critical" }];

describe("probeRecordOf", () => {
  test("captures limits with the observation time that dates them", () => {
    expect(
      probeRecordOf(
        credential({ limits: LIMITS, snapshot: { windows: {}, observed_at: NOW / 1000 } }),
      ),
    ).toEqual({ limits: LIMITS, observedAt: NOW / 1000 });
  });

  test("captures a probe failure even with no limits to go with it", () => {
    expect(probeRecordOf(credential({ probe_error: "429" }))).toEqual({
      limits: [],
      probeError: "429",
    });
  });

  // The shape of every cached read: nothing to retain, and nothing that
  // should overwrite what an earlier probe found.
  test("a response with neither field yields no record", () => {
    expect(probeRecordOf(credential())).toBeNull();
    expect(probeRecordOf(credential({ limits: [] }))).toBeNull();
    expect(probeRecordOf(credential({ snapshot: { windows: {} } }))).toBeNull();
  });
});

describe("probeView", () => {
  test("a response carrying its own limits is shown as current", () => {
    const view = probeView(credential({ limits: LIMITS }), undefined, NOW);
    expect(view.limits).toEqual(LIMITS);
    expect(view.retainedAge).toBeNull();
  });

  // The case the whole mechanism exists for: the poll that follows a manual
  // refresh must not blank the limits it just fetched.
  test("a cached response falls back to the last probe, dated", () => {
    const view = probeView(
      credential(),
      { limits: LIMITS, observedAt: (NOW - 20 * MINUTE_MS) / 1000 },
      NOW,
    );
    expect(view.limits).toEqual(LIMITS);
    expect(view.retainedAge).toBe("20 分前");
  });

  test("a retained probe failure survives the cached reads after it", () => {
    const view = probeView(
      credential(),
      { limits: [], probeError: "429", observedAt: (NOW - 2 * 60 * MINUTE_MS) / 1000 },
      NOW,
    );
    expect(view.probeError).toBe("429");
    expect(view.retainedAge).toBe("2 時間前");
  });

  // A live reading must never be labelled with someone else's timestamp.
  test("a live response is not dated by the retained record it replaces", () => {
    const view = probeView(
      credential({ limits: LIMITS }),
      { limits: [], probeError: "old", observedAt: (NOW - 60 * MINUTE_MS) / 1000 },
      NOW,
    );
    expect(view.probeError).toBeNull();
    expect(view.retainedAge).toBeNull();
  });

  test("a probe too recent to date is labelled as just now", () => {
    expect(
      probeView(credential(), { limits: LIMITS, observedAt: NOW / 1000 }, NOW).retainedAge,
    ).toBe("直前");
  });

  test("nothing probed yet shows nothing, without an age on the emptiness", () => {
    const view = probeView(credential(), undefined, NOW);
    expect(view).toEqual({ limits: [], probeError: null, retainedAge: null });
  });
});
