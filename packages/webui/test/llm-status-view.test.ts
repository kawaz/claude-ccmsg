// Reading rules for the service status strip. What is pinned here is what a
// reader would get wrong if it changed: that the two signals keep their own
// words, that the row in trouble sorts to the top, and that the header badge
// stays silent for everything except a known problem — an always-lit badge is
// one nobody reads, and a badge lit by "unknown" is always lit.
import { describe, expect, test } from "bun:test";
import type { LlmStatusReport, LlmStatusService } from "@ccmsg/protocol";
import {
  countsSummary,
  formatStatusAge,
  headerBadge,
  observedLabel,
  officialLabel,
  serviceRows,
  severityLabel,
  severityTone,
} from "../src/client/llm-status-view.ts";

const NOW = 1_788_333_900_000;

function service(overrides: Partial<LlmStatusService> = {}): LlmStatusService {
  return {
    id: "anthropic",
    name: "Anthropic",
    severity: "ok",
    routes: ["claude-a"],
    ...overrides,
  };
}

function report(overrides: Partial<LlmStatusReport> = {}): LlmStatusReport {
  return {
    overall: { severity: "ok", service_counts: { ok: 1 } },
    services: [service()],
    ...overrides,
  };
}

describe("severity vocabulary", () => {
  test("maps each severity to its own tone and word", () => {
    expect(
      (["ok", "warning", "critical", "unknown"] as const).map((s) => [
        severityTone(s),
        severityLabel(s),
      ]),
    ).toEqual([
      ["ok", "正常"],
      ["warn", "注意"],
      ["bad", "障害"],
      ["unknown", "不明"],
    ]);
  });

  // The two signals must never read as one scale: "稼働中" is the provider's
  // claim, "疎通" is what this gateway's own traffic did.
  test("official and observed states have disjoint wording", () => {
    const official = (
      [
        "operational",
        "degraded",
        "partial_outage",
        "major_outage",
        "maintenance",
        "unknown",
      ] as const
    ).map(officialLabel);
    const observed = (["reachable", "failing", "unknown"] as const).map(observedLabel);
    expect(official).toEqual([
      "稼働中",
      "性能低下",
      "一部障害",
      "大規模障害",
      "メンテナンス",
      "不明",
    ]);
    expect(observed).toEqual(["疎通", "失敗", "未観測"]);
    // No word appears in both columns — not even for the two "we could not
    // find out" states, which is why the observed one says 未観測.
    expect(official.filter((word) => observed.includes(word))).toEqual([]);
  });
});

describe("formatStatusAge", () => {
  test("counts in the units an outage is read in", () => {
    expect(formatStatusAge(NOW / 1000 - 18, NOW)).toBe("18 秒前");
    expect(formatStatusAge(NOW / 1000 - 90, NOW)).toBe("1 分前");
    expect(formatStatusAge(NOW / 1000 - 7200, NOW)).toBe("2 時間前");
    expect(formatStatusAge(NOW / 1000 - 172_800, NOW)).toBe("2 日前");
  });

  // The column stays even with nothing in it, so a service with no reading
  // does not pull the rows around it out of line.
  test("is empty for an absent or unusable instant", () => {
    expect(formatStatusAge(undefined, NOW)).toBe("");
    expect(formatStatusAge(Number.NaN, NOW)).toBe("");
  });

  // A gateway a few seconds ahead of this browser must not read as "in the
  // future" or as a negative age.
  test("clamps a reading from a clock slightly ahead of ours", () => {
    expect(formatStatusAge(NOW / 1000 + 30, NOW)).toBe("0 秒前");
  });
});

describe("serviceRows", () => {
  test("keeps the two signals in their own cells", () => {
    const [row] = serviceRows(
      report({
        services: [
          service({
            severity: "critical",
            official: {
              state: "operational",
              source_url: "https://status.example/",
              observed_at: NOW / 1000 - 20,
              stale: true,
              components: [],
              incidents: [{ name: "Elevated errors" }],
            },
            observed: {
              state: "failing",
              observed_at: NOW / 1000 - 5,
              last_failure: { at: NOW / 1000 - 5, kind: "upstream_http", status: 529 },
            },
          }),
        ],
      }),
      NOW,
    );
    // The case the endpoint exists for: the provider still says it is up
    // while every route here is getting 529.
    expect(row?.official?.label).toBe("稼働中");
    expect(row?.official?.stale).toBe(true);
    expect(row?.official?.age).toBe("20 秒前");
    expect(row?.official?.sourceUrl).toBe("https://status.example/");
    expect(row?.observed?.label).toBe("失敗");
    expect(row?.observed?.failure).toBe("HTTP 529");
    expect(row?.severityText).toBe("障害");
    expect(row?.tone).toBe("bad");
    expect(row?.incidents).toHaveLength(1);
  });

  // A transport error has no status code; naming the kind is all that is left
  // to say, and saying nothing would read as "no failure".
  test("falls back to the failure kind when there is no status code", () => {
    const [row] = serviceRows(
      report({
        services: [
          service({ observed: { state: "failing", last_failure: { kind: "transport" } } }),
        ],
      }),
      NOW,
    );
    expect(row?.observed?.failure).toBe("transport");
  });

  test("a service with neither signal still renders its severity", () => {
    const [row] = serviceRows(report({ services: [service({ severity: "unknown" })] }), NOW);
    expect(row?.official).toBeNull();
    expect(row?.observed).toBeNull();
    expect(row?.severityText).toBe("不明");
    expect(row?.tone).toBe("unknown");
  });

  // The strip is glanced at; the row about to matter must not be third.
  // "unknown" sorts below "ok" — not knowing is less urgent than a known
  // problem, which is also how the gateway's own roll-up treats it.
  test("sorts worst first, with unknown below ok", () => {
    const rows = serviceRows(
      report({
        services: [
          service({ id: "a", severity: "unknown" }),
          service({ id: "b", severity: "ok" }),
          service({ id: "c", severity: "critical" }),
          service({ id: "d", severity: "warning" }),
        ],
      }),
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["c", "d", "b", "a"]);
  });

  test("keeps the gateway's order among services of equal severity", () => {
    const rows = serviceRows(
      report({
        services: [
          service({ id: "second", severity: "ok" }),
          service({ id: "first", severity: "ok" }),
        ],
      }),
      NOW,
    );
    expect(rows.map((row) => row.id)).toEqual(["second", "first"]);
  });
});

describe("headerBadge", () => {
  test("announces only a known problem", () => {
    expect(headerBadge(null)).toBeNull();
    expect(headerBadge(report({ overall: { severity: "ok", service_counts: {} } }))).toBeNull();
    // The one the DR calls out explicitly: a provider that publishes no status
    // page must not paint the whole header. It stays grey inside the strip.
    expect(
      headerBadge(report({ overall: { severity: "unknown", service_counts: {} } })),
    ).toBeNull();
    expect(headerBadge(report({ overall: { severity: "warning", service_counts: {} } }))).toEqual({
      severity: "warning",
      tone: "warn",
      mark: "▲",
      label: "注意",
    });
    expect(
      headerBadge(report({ overall: { severity: "critical", service_counts: {} } }))?.tone,
    ).toBe("bad");
  });
});

describe("countsSummary", () => {
  // The breakdown the roll-up hides: "one critical among many ok" must not
  // read as "everything is down".
  test("lists what each severity holds, worst first", () => {
    expect(
      countsSummary(
        report({
          overall: {
            severity: "critical",
            service_counts: { ok: 2, warning: 0, critical: 1, unknown: 1 },
          },
        }),
      ),
    ).toBe("障害 1 / 正常 2 / 不明 1");
  });

  test("is silent about severities no service holds", () => {
    expect(countsSummary(report({ overall: { severity: "ok", service_counts: { ok: 3 } } }))).toBe(
      "正常 3",
    );
  });
});
