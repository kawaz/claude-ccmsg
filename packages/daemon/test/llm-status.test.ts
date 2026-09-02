// llm_status proxy contract: the daemon fetches the gateway's upstream-service
// report on the webui's behalf and hands back a shape the screen can draw
// without inventing words. These tests pin the two things that decide whether
// an outage is readable — that an unfamiliar vocabulary degrades to "unknown"
// instead of reaching the UI as a state it has no colour for, and that a
// report the daemon cannot use fails as one actionable error — plus the
// debounce/single-flight that keeps a 529 storm from becoming a fetch storm.
import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import {
  fetchLlmStatus,
  LlmStatusRefresher,
  parseStatusPayload,
  statusUrlWithRefresh,
} from "../src/llm-status.ts";
import type { LlmGatewayDeps } from "../src/llm-gateway.ts";

/** The live endpoint's report, trimmed to one service per interesting shape:
 * a fetched source with an incident, a `link` placeholder that can only ever
 * be unknown, and a source whose own read failed. */
const UPSTREAM = {
  schema_version: 1,
  generated_at: 1788333834,
  overall: {
    severity: "critical",
    service_counts: { ok: 1, warning: 0, critical: 1, unknown: 1 },
  },
  services: [
    {
      id: "anthropic",
      name: "Anthropic",
      severity: "critical",
      routes: ["claude-a", "claude-b"],
      official: {
        state: "major_outage",
        source: "statuspage_v2",
        source_url: "https://status.claude.com/",
        observed_at: 1788333814,
        stale: false,
        components: [{ id: "k8w3", name: "Claude API", state: "partial_outage" }],
        incidents: [
          {
            id: "inc-1",
            name: "Elevated errors on the API",
            state: "investigating",
            impact: "major",
            url: "https://status.claude.com/incidents/inc-1",
            latest_update: "We are investigating elevated error rates.",
          },
        ],
      },
      observed: {
        state: "failing",
        observed_at: 1788333820,
        expires_at: 1788334120,
        last_success_at: 1788333000,
        last_failure: { at: 1788333820, kind: "upstream_http", status: 529 },
      },
    },
    {
      id: "aws",
      name: "AWS",
      severity: "unknown",
      routes: ["bedrock"],
      official: {
        state: "unknown",
        source: "link",
        source_url: "https://health.aws.amazon.com/health/status",
        observed_at: null,
        stale: false,
        components: [],
        incidents: [],
      },
      observed: { state: "unknown", observed_at: null },
    },
    {
      id: "openai",
      name: "OpenAI",
      severity: "ok",
      routes: ["codex"],
      official: {
        state: "unknown",
        source: "statuspage_v2",
        components: [],
        incidents: [],
        error: "invalid incidents: missing field `shortlink`",
      },
      observed: { state: "reachable", observed_at: 1788333570 },
    },
  ],
};

function okPayload(overrides: Record<string, unknown> = {}) {
  const result = parseStatusPayload({ ...UPSTREAM, ...overrides });
  if (!result.ok) throw new Error(`expected a usable report: ${result.msg}`);
  return result.data;
}

describe("parseStatusPayload", () => {
  test("passes the gateway's verdicts through untouched", () => {
    const report = okPayload();
    expect(report.schema_version).toBe(1);
    expect(report.generated_at).toBe(1788333834);
    expect(report.overall).toEqual({
      severity: "critical",
      service_counts: { ok: 1, warning: 0, critical: 1, unknown: 1 },
    });
    expect(report.services.map((s) => [s.id, s.severity])).toEqual([
      ["anthropic", "critical"],
      ["aws", "unknown"],
      ["openai", "ok"],
    ]);
  });

  // The whole point of the endpoint: what the provider says and what this
  // gateway saw stay separable all the way to the screen.
  test("keeps the official and observed signals apart", () => {
    const [anthropic] = okPayload().services;
    expect(anthropic?.official?.state).toBe("major_outage");
    expect(anthropic?.official?.components).toEqual([
      { id: "k8w3", name: "Claude API", state: "partial_outage" },
    ]);
    expect(anthropic?.official?.incidents[0]?.latest_update).toBe(
      "We are investigating elevated error rates.",
    );
    expect(anthropic?.observed).toEqual({
      state: "failing",
      observed_at: 1788333820,
      expires_at: 1788334120,
      last_success_at: 1788333000,
      last_failure: { at: 1788333820, kind: "upstream_http", status: 529 },
    });
  });

  // A source that could not be read keeps its last state beside the error
  // rather than being replaced by it.
  test("keeps a source's error alongside the state it last had", () => {
    const openai = okPayload().services[2];
    expect(openai?.official?.state).toBe("unknown");
    expect(openai?.official?.error).toContain("shortlink");
    expect(openai?.observed?.state).toBe("reachable");
  });

  // Forward compatibility (gateway DR-0021 §7): a vocabulary this build does
  // not know must arrive as "unknown", never as the raw word.
  test("normalizes unknown severity and states to unknown", () => {
    const report = okPayload({
      overall: { severity: "apocalyptic", service_counts: { ok: "many" } },
      services: [
        {
          id: "x",
          name: "X",
          severity: "meltdown",
          routes: ["r"],
          official: { state: "on_fire", components: [], incidents: [] },
          observed: { state: "flaky" },
        },
      ],
    });
    expect(report.overall.severity).toBe("unknown");
    // A non-numeric count is dropped rather than coerced: the strip sums these.
    expect(report.overall.service_counts).toEqual({});
    expect(report.services[0]?.severity).toBe("unknown");
    expect(report.services[0]?.official?.state).toBe("unknown");
    expect(report.services[0]?.observed?.state).toBe("unknown");
  });

  test("a newer schema_version is still parsed, not rejected", () => {
    const report = okPayload({ schema_version: 7 });
    expect(report.schema_version).toBe(7);
    expect(report.services).toHaveLength(3);
  });

  // Everything but the identifiers degrades to absent; the row still renders
  // its severity, which is what the strip is read for.
  test("a service with only an id and a severity still renders", () => {
    const report = okPayload({ services: [{ id: "bare", severity: "warning" }] });
    expect(report.services[0]).toEqual({
      id: "bare",
      name: "bare",
      severity: "warning",
      routes: [],
    });
  });

  test("drops entries that cannot be keyed or labelled", () => {
    const report = okPayload({
      services: [
        "not an object",
        { name: "no id" },
        {
          id: "keeps-going",
          severity: "ok",
          routes: ["a", 7, ""],
          official: {
            state: "operational",
            components: [{ state: "operational" }, { name: "kept", state: "operational" }],
            incidents: [{ state: "investigating" }, { name: "kept incident" }],
          },
        },
      ],
    });
    expect(report.services).toHaveLength(1);
    expect(report.services[0]?.routes).toEqual(["a"]);
    expect(report.services[0]?.official?.components).toEqual([
      { name: "kept", state: "operational" },
    ]);
    expect(report.services[0]?.official?.incidents).toEqual([{ name: "kept incident" }]);
  });

  // A report with no roll-up is reported as unknown rather than recomputed:
  // the gateway owns the rule, and a second one here would drift from the CLI.
  test("a missing overall reads as unknown with no counts", () => {
    const report = okPayload({ overall: undefined });
    expect(report.overall).toEqual({ severity: "unknown", service_counts: {} });
  });

  test("rejects a body that is not a report", () => {
    for (const body of [null, [], { services: {} }, { overall: {} }]) {
      const result = parseStatusPayload(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(ErrorCode.llm_status_unavailable);
    }
  });
});

describe("statusUrlWithRefresh", () => {
  test("asks for a re-read only when told to", () => {
    expect(statusUrlWithRefresh("http://gw/status")).toBe("http://gw/status");
    expect(statusUrlWithRefresh("http://gw/status", true)).toBe("http://gw/status?refresh=true");
  });

  // A configured URL that already carries the parameter must not end up
  // sending two conflicting ones.
  test("overrides a refresh already present in the configured URL", () => {
    expect(statusUrlWithRefresh("http://gw/status?refresh=false", true)).toBe(
      "http://gw/status?refresh=true",
    );
  });
});

function deps(fetch: LlmGatewayDeps["fetch"]): LlmGatewayDeps {
  return { fetch };
}

describe("fetchLlmStatus", () => {
  test("normalizes a live document", async () => {
    const result = await fetchLlmStatus(
      "http://gw/status",
      false,
      deps(() => Promise.resolve(Response.json(UPSTREAM))),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.services).toHaveLength(3);
  });

  // Every upstream failure collapses to one code: the operator's next step is
  // the same whether the gateway refused, timed out, or answered with HTML.
  test("collapses every upstream failure to llm_status_unavailable", async () => {
    const failures: Array<[string, LlmGatewayDeps["fetch"]]> = [
      ["refused", () => Promise.reject(new Error("ECONNREFUSED"))],
      ["non-2xx", () => Promise.resolve(new Response("nope", { status: 502 }))],
      ["not JSON", () => Promise.resolve(new Response("<html>", { status: 200 }))],
      ["wrong shape", () => Promise.resolve(Response.json({ hello: true }))],
    ];
    for (const [label, fetch] of failures) {
      const result = await fetchLlmStatus("http://gw/status", false, deps(fetch));
      expect(result.ok, label).toBe(false);
      if (!result.ok) expect(result.code, label).toBe(ErrorCode.llm_status_unavailable);
    }
  });

  test("reports an unusable configured URL rather than throwing", async () => {
    const result = await fetchLlmStatus(
      "not a url",
      true,
      deps(() => Promise.reject(new Error("never called"))),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.msg).toContain("unusable");
  });

  test("passes the refresh through to the gateway", async () => {
    const asked: string[] = [];
    await fetchLlmStatus(
      "http://gw/status",
      true,
      deps((url) => {
        asked.push(url);
        return Promise.resolve(Response.json(UPSTREAM));
      }),
    );
    expect(asked).toEqual(["http://gw/status?refresh=true"]);
  });
});

/** Drive the refresher on controlled time: the timer is the thing under test,
 * so a real one would make these tests wait five seconds to learn nothing. */
function refresherHarness(fetchImpl: () => Promise<ReturnType<typeof parseStatusPayload>>) {
  const timers: Array<() => void> = [];
  const reports: unknown[] = [];
  const errors: string[] = [];
  const refresher = new LlmStatusRefresher({
    fetch: fetchImpl,
    onReport: (report) => reports.push(report),
    onError: (msg) => errors.push(msg),
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimer: () => {},
  });
  /** Fire every timer armed so far, in order. */
  const tick = (): void => {
    const due = timers.splice(0, timers.length);
    for (const fn of due) fn();
  };
  return { refresher, tick, timers, reports, errors };
}

describe("LlmStatusRefresher", () => {
  // An outage arrives as a burst — every route of the service, plus retries.
  // One read after the burst is the useful one.
  test("collapses a burst of triggers into one read", async () => {
    let calls = 0;
    const h = refresherHarness(() => {
      calls += 1;
      return Promise.resolve(parseStatusPayload(UPSTREAM));
    });
    for (let i = 0; i < 20; i += 1) h.refresher.trigger();
    expect(h.timers).toHaveLength(1);
    h.tick();
    await Promise.resolve();
    expect(calls).toBe(1);
    expect(h.reports).toHaveLength(1);
  });

  // The second guard, and not implied by the first: the next burst can land
  // while a slow read from the previous one is still open.
  test("does not start a second read while one is in flight, and re-arms after it", async () => {
    let calls = 0;
    /** Reads that have started and not yet been allowed to finish. */
    const open: Array<() => void> = [];
    const h = refresherHarness(() => {
      calls += 1;
      return new Promise((resolve) => {
        open.push(() => resolve(parseStatusPayload(UPSTREAM)));
      });
    });
    h.refresher.trigger();
    h.tick();
    expect(calls).toBe(1);
    // A new burst during the flight: debounced, then folded into the flight.
    h.refresher.trigger();
    h.tick();
    expect(calls).toBe(1);
    open.shift()?.();
    await Promise.resolve();
    await Promise.resolve();
    // The trigger that arrived mid-flight is not lost — it re-armed the timer.
    expect(h.timers).toHaveLength(1);
    h.tick();
    await Promise.resolve();
    expect(calls).toBe(2);
  });

  // Clients are holding the last good report; replacing it with "the gateway
  // did not answer" would lose the outage the trigger was about.
  test("a failed read is logged, not pushed", async () => {
    const h = refresherHarness(() =>
      Promise.resolve({
        ok: false as const,
        code: ErrorCode.llm_status_unavailable,
        msg: "status endpoint returned HTTP 502",
      }),
    );
    h.refresher.trigger();
    h.tick();
    await Promise.resolve();
    expect(h.reports).toHaveLength(0);
    expect(h.errors).toEqual(["status endpoint returned HTTP 502"]);
  });

  test("a thrown read settles instead of wedging the single flight", async () => {
    let calls = 0;
    const h = refresherHarness(() => {
      calls += 1;
      return Promise.reject(new Error("boom"));
    });
    h.refresher.trigger();
    h.tick();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.errors[0]).toContain("boom");
    h.refresher.trigger();
    h.tick();
    await Promise.resolve();
    expect(calls).toBe(2);
  });
});
