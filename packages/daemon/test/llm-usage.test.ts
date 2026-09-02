// llm_usage proxy contract: the daemon fetches the gateway's usage document
// on the webui's behalf (the endpoint sends no CORS headers) and hands back a
// normalized shape. These tests pin the two things the UI depends on — that
// quota windows are recognised by shape rather than by a hardcoded "5h"/"7d"
// allowlist, and that every upstream failure mode arrives as one actionable
// error rather than as a crash or a half-parsed body.
import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import { fetchLlmUsage, parseUsagePayload, usageUrlWithRefresh } from "../src/llm-usage.ts";
import type { LlmGatewayDeps } from "../src/llm-gateway.ts";

/** The live endpoint's document, trimmed to one credential per support kind. */
const UPSTREAM = {
  generated_at: 1785450000,
  generated_at_iso: "2026-07-31T00:00:00Z",
  credentials: [
    { name: "bedrock", type: "claude_bedrock", support: "not_applicable" },
    {
      name: "claude-kawazzz",
      type: "claude_oauth",
      support: "observed",
      snapshot: {
        observed_at: 1785449700,
        observed_at_iso: "2026-07-30T23:55:00Z",
        "5h": {
          utilization: 0.13,
          status: "allowed",
          reset: 1785468600,
          reset_iso: "2026-07-31T05:10:00Z",
        },
        "7d": {
          utilization: 0.87,
          status: "allowed_warning",
          reset: 1785640000,
          reset_iso: "2026-08-02T04:46:40Z",
        },
        overage: { status: "rejected", disabled_reason: "out_of_credits" },
      },
    },
    { name: "cpa", type: "relay", support: "upstream_dependent" },
  ],
};

function jsonDeps(body: unknown, init: ResponseInit = {}): LlmGatewayDeps {
  return {
    fetch: () => Promise.resolve(new Response(JSON.stringify(body), init)),
  };
}

function unwrap(result: ReturnType<typeof parseUsagePayload>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.msg}`);
  return result.data;
}

describe("parseUsagePayload", () => {
  test("passes through the live endpoint's document", () => {
    const data = unwrap(parseUsagePayload(UPSTREAM));
    expect(data.generated_at).toBe(1785450000);
    expect(data.generated_at_iso).toBe("2026-07-31T00:00:00Z");
    expect(data.credentials.map((c) => c.name)).toEqual(["bedrock", "claude-kawazzz", "cpa"]);
    expect(data.credentials[0]).toEqual({
      name: "bedrock",
      type: "claude_bedrock",
      support: "not_applicable",
    });
  });

  test("collects quota windows under their upstream keys", () => {
    const snapshot = unwrap(parseUsagePayload(UPSTREAM)).credentials[1]?.snapshot;
    expect(Object.keys(snapshot?.windows ?? {})).toEqual(["5h", "7d"]);
    expect(snapshot?.windows["5h"]).toEqual({
      utilization: 0.13,
      status: "allowed",
      reset: 1785468600,
      reset_iso: "2026-07-31T05:10:00Z",
    });
    expect(snapshot?.observed_at).toBe(1785449700);
    expect(snapshot?.overage).toEqual({ status: "rejected", disabled_reason: "out_of_credits" });
  });

  // The point of shape-based detection: a gateway that starts reporting a
  // third window needs no daemon change to reach the UI.
  test("accepts a window key the daemon has never heard of", () => {
    const windows = unwrap(
      parseUsagePayload({
        credentials: [
          {
            name: "x",
            support: "observed",
            snapshot: { "30d": { utilization: 0.5, status: "allowed" } },
          },
        ],
      }),
    ).credentials[0]?.snapshot?.windows;
    expect(windows).toEqual({ "30d": { utilization: 0.5, status: "allowed" } });
  });

  // ...and its converse: a non-window sibling key is dropped rather than
  // rendered as a bar with no numbers in it.
  test("drops snapshot keys that are not window-shaped", () => {
    const snapshot = unwrap(
      parseUsagePayload({
        credentials: [
          {
            name: "x",
            support: "observed",
            snapshot: {
              observed_at: 1,
              region: "us-east-1",
              plan: { tier: "max" },
              "5h": { utilization: 0.1, status: "allowed" },
            },
          },
        ],
      }),
    ).credentials[0]?.snapshot;
    expect(Object.keys(snapshot?.windows ?? {})).toEqual(["5h"]);
  });

  test("keeps a credential whose optional fields are all absent", () => {
    const credentials = unwrap(parseUsagePayload({ credentials: [{ name: "bare" }] })).credentials;
    expect(credentials).toEqual([{ name: "bare", support: "unknown" }]);
  });

  test("drops entries with no usable name", () => {
    const credentials = unwrap(
      parseUsagePayload({ credentials: [{ type: "relay" }, "nope", null, { name: "kept" }] }),
    ).credentials;
    expect(credentials.map((c) => c.name)).toEqual(["kept"]);
  });

  // `expired` is how the gateway says a reading predates its own reset. It
  // travels as a flag rather than being inferred from `reset` vs the clock:
  // only the gateway knows when it took the reading.
  test("carries a window's expired flag, and only when it is set", () => {
    const windows = unwrap(
      parseUsagePayload({
        credentials: [
          {
            name: "x",
            support: "observed",
            snapshot: {
              "5h": { utilization: 0.1, status: "allowed" },
              "7d": { utilization: 1.01, status: "rejected", expired: true },
            },
          },
        ],
      }),
    ).credentials[0]?.snapshot?.windows;
    expect(windows?.["5h"]).toEqual({ utilization: 0.1, status: "allowed" });
    expect(windows?.["7d"]).toEqual({ utilization: 1.01, status: "rejected", expired: true });
  });

  describe("auth", () => {
    const withAuth = (auth: unknown, base?: string) =>
      unwrap(
        parseUsagePayload(
          { credentials: [{ name: "x", type: "claude_oauth", support: "observed", auth }] },
          base,
        ),
      ).credentials[0]?.auth;

    test("passes the gateway's state through", () => {
      expect(
        withAuth({
          status: "relogin_required",
          reason: "run `llm-gateway login --type claude_oauth x`",
          observed_at: 1785449700,
          observed_at_iso: "2026-07-30T23:55:00Z",
        }),
      ).toEqual({
        status: "relogin_required",
        reason: "run `llm-gateway login --type claude_oauth x`",
        observed_at: 1785449700,
        observed_at_iso: "2026-07-30T23:55:00Z",
      });
    });

    // The gateway does not know the origin it is published under, so it sends
    // a path; the address the daemon fetched from is the one thing known to
    // reach the gateway, so that is what the path is resolved against.
    test("resolves login_path against the usage endpoint", () => {
      expect(
        withAuth(
          { status: "relogin_required", login_path: "/llm-gateway/login/x/start" },
          "https://gw.example/llm-gateway/usage",
        )?.login_url,
      ).toBe("https://gw.example/llm-gateway/login/x/start");
    });

    test("drops a login_path that would point off the gateway's origin", () => {
      expect(
        withAuth(
          { status: "relogin_required", login_path: "https://elsewhere.example/steal" },
          "https://gw.example/llm-gateway/usage",
        )?.login_url,
      ).toBeUndefined();
    });

    // Every gateway older than the one that introduced login_path, and every
    // credential whose re-login is a CLI-only affair.
    test("omits login_url when the gateway sends no path", () => {
      expect(withAuth({ status: "degraded" }, "https://gw.example/llm-gateway/usage")).toEqual({
        status: "degraded",
      });
    });

    test("drops an auth object with no status", () => {
      expect(withAuth({ reason: "who knows" })).toBeUndefined();
      expect(withAuth("relogin_required")).toBeUndefined();
    });
  });

  test("rejects a body with no credentials array", () => {
    for (const body of [{}, { credentials: {} }, [], "text", null]) {
      const result = parseUsagePayload(body);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(ErrorCode.llm_usage_unavailable);
    }
  });
});

describe("fetchLlmUsage", () => {
  test("returns the parsed document on success", async () => {
    const result = await fetchLlmUsage("https://gw.example/usage", false, jsonDeps(UPSTREAM));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.credentials).toHaveLength(3);
  });

  test("requests the configured URL", async () => {
    const seen: string[] = [];
    await fetchLlmUsage("https://gw.example/llm-gateway/usage", false, {
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve(new Response(JSON.stringify(UPSTREAM)));
      },
    });
    expect(seen).toEqual(["https://gw.example/llm-gateway/usage"]);
  });

  // The probe variant of the URL carries `?refresh=true`; a login link built
  // from it would ask the gateway to probe every provider on the way to the
  // login page.
  test("resolves login links against the configured URL, not the probe variant", async () => {
    const result = await fetchLlmUsage(
      "https://gw.example/llm-gateway/usage",
      true,
      jsonDeps({
        credentials: [
          {
            name: "x",
            type: "claude_oauth",
            support: "observed",
            auth: { status: "relogin_required", login_path: "/llm-gateway/login/x/start" },
          },
        ],
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.data.credentials[0]?.auth?.login_url).toBe(
        "https://gw.example/llm-gateway/login/x/start",
      );
    }
  });

  test("reports a non-2xx status", async () => {
    const result = await fetchLlmUsage(
      "https://gw.example/usage",
      false,
      jsonDeps({}, { status: 502 }),
    );
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_usage_unavailable,
      msg: "usage endpoint returned HTTP 502",
    });
  });

  test("reports a body that is not JSON", async () => {
    const result = await fetchLlmUsage("https://gw.example/usage", false, {
      fetch: () => Promise.resolve(new Response("<html>login</html>")),
    });
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_usage_unavailable,
      msg: "usage endpoint returned invalid JSON",
    });
  });

  test("reports an unreachable gateway instead of throwing", async () => {
    const result = await fetchLlmUsage("https://gw.example/usage", false, {
      fetch: () => Promise.reject(new TypeError("Unable to connect")),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.llm_usage_unavailable);
      expect(result.msg).toContain("unreachable");
    }
  });

  // A gateway that accepts the connection and then never answers is the
  // failure the abort signal exists for; without it the op would hang until
  // the client gave up, with no error to show.
  test("reports a timeout when the gateway never answers", async () => {
    const result = await fetchLlmUsage(
      "https://gw.example/usage",
      false,
      { fetch: (_url, init) => hangUntilAborted(init?.signal ?? null) },
      20,
    );
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_usage_unavailable,
      msg: "usage endpoint did not respond within 20ms",
    });
  });

  test("refuses a response larger than the buffering ceiling", async () => {
    const chunk = new Uint8Array(256 * 1024);
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(chunk);
      },
    });
    const result = await fetchLlmUsage("https://gw.example/usage", false, {
      fetch: () => Promise.resolve(new Response(body)),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe(ErrorCode.llm_usage_unavailable);
      expect(result.msg).toContain("exceeds");
    }
  });
});

/** Stand in for a gateway that accepts the connection and stays silent: the
 * promise settles only when the caller's own timeout fires. */
function hangUntilAborted(signal: AbortSignal | null): Promise<Response> {
  return new Promise((_resolve, reject) => {
    if (!signal) return;
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
}

// Provider limits and probe failures (llm-gateway v0.10.0). Same shape-based
// posture as the quota windows: upstream owns the vocabulary, an entry that
// cannot be drawn is dropped, and absence is a normal state rather than an
// error — every credential on an older gateway sends none.
describe("parseUsagePayload limits", () => {
  function withCredential(over: Record<string, unknown>) {
    return unwrap(parseUsagePayload({ credentials: [{ name: "c", support: "observed", ...over }] }))
      .credentials[0];
  }

  test("passes through a limits array in upstream's order and vocabulary", () => {
    const credential = withCredential({
      limits: [
        { kind: "session", percent: 0.0, severity: "normal", is_active: false },
        {
          kind: "weekly_all",
          percent: 100.0,
          severity: "critical",
          resets_at: "2026-08-02T08:59:59.688201+00:00",
          is_active: true,
        },
        {
          kind: "weekly_scoped",
          percent: 80.0,
          severity: "warning",
          resets_at: "2026-08-02T08:59:59.688429+00:00",
          model: "Fable",
          is_active: false,
        },
      ],
    });
    expect(credential?.limits).toEqual([
      { kind: "session", percent: 0, severity: "normal", is_active: false },
      {
        kind: "weekly_all",
        percent: 100,
        severity: "critical",
        resets_at: "2026-08-02T08:59:59.688201+00:00",
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        percent: 80,
        severity: "warning",
        resets_at: "2026-08-02T08:59:59.688429+00:00",
        model: "Fable",
        is_active: false,
      },
    ]);
  });

  // A kind the gateway adds later has to reach the UI as itself; flattening
  // it into a known one would misreport which ceiling is being hit.
  test("an unfamiliar kind survives untouched", () => {
    const credential = withCredential({
      limits: [{ kind: "monthly_all", percent: 12.5, severity: "brand_new" }],
    });
    expect(credential?.limits).toEqual([
      { kind: "monthly_all", percent: 12.5, severity: "brand_new" },
    ]);
  });

  test("an entry without the two fields a bar needs is dropped, the rest survive", () => {
    const credential = withCredential({
      limits: [
        { percent: 10, severity: "normal" },
        { kind: "session", severity: "normal" },
        "nonsense",
        null,
        { kind: "weekly_all", percent: 40, severity: "normal" },
      ],
    });
    expect(credential?.limits).toEqual([{ kind: "weekly_all", percent: 40, severity: "normal" }]);
  });

  test("a missing severity degrades to unknown rather than claiming health", () => {
    const credential = withCredential({ limits: [{ kind: "session", percent: 5 }] });
    expect(credential?.limits?.[0]?.severity).toBe("unknown");
  });

  // The common case on a gateway that does not send the field at all.
  test("absent or unusable limits leave the key off entirely", () => {
    expect(withCredential({})?.limits).toBeUndefined();
    expect(withCredential({ limits: [] })?.limits).toBeUndefined();
    expect(withCredential({ limits: "nope" })?.limits).toBeUndefined();
    expect(withCredential({ limits: [{ kind: "session" }] })?.limits).toBeUndefined();
  });

  test("probe_error is carried alongside whatever reading survives", () => {
    const credential = withCredential({
      probe_error: "429 from upstream",
      snapshot: { observed_at: 1785449700, "5h": { utilization: 0.2, status: "allowed" } },
    });
    expect(credential?.probe_error).toBe("429 from upstream");
    expect(credential?.snapshot?.windows["5h"]?.utilization).toBe(0.2);
  });

  test("an empty or non-string probe_error is treated as no failure", () => {
    expect(withCredential({ probe_error: "" })?.probe_error).toBeUndefined();
    expect(withCredential({ probe_error: 500 })?.probe_error).toBeUndefined();
    expect(withCredential({})?.probe_error).toBeUndefined();
  });
});

// The refresh flag. Only a probe response carries limits and probe_error, and
// a probe can spend upstream rate limit — so which request gets the flag is a
// correctness question, not a convenience one.
describe("usageUrlWithRefresh", () => {
  test("asks for a probe only when told to", () => {
    expect(usageUrlWithRefresh("https://gw.example/usage", true)).toBe(
      "https://gw.example/usage?refresh=true",
    );
    expect(usageUrlWithRefresh("https://gw.example/usage", false)).toBe("https://gw.example/usage");
    expect(usageUrlWithRefresh("https://gw.example/usage")).toBe("https://gw.example/usage");
  });

  test("keeps other query parameters and overrides a preset refresh", () => {
    expect(usageUrlWithRefresh("https://gw.example/usage?tz=UTC", true)).toBe(
      "https://gw.example/usage?tz=UTC&refresh=true",
    );
    expect(usageUrlWithRefresh("https://gw.example/usage?refresh=false", true)).toBe(
      "https://gw.example/usage?refresh=true",
    );
  });
});

describe("fetchLlmUsage refresh", () => {
  function recordingDeps(body: unknown) {
    const seen: string[] = [];
    return {
      seen,
      deps: {
        fetch: (url: string) => {
          seen.push(url);
          return Promise.resolve(new Response(JSON.stringify(body)));
        },
      },
    };
  }

  test("a refresh reaches the gateway as ?refresh=true", async () => {
    const { seen, deps } = recordingDeps(UPSTREAM);
    await fetchLlmUsage("https://gw.example/usage", true, deps);
    expect(seen).toEqual(["https://gw.example/usage?refresh=true"]);
  });

  // The polling path must never probe: it would spend upstream rate limit on
  // every tick of a screen nobody is looking at.
  test("a plain read leaves the URL untouched", async () => {
    const { seen, deps } = recordingDeps(UPSTREAM);
    await fetchLlmUsage("https://gw.example/usage", false, deps);
    expect(seen).toEqual(["https://gw.example/usage"]);
  });

  test("a URL that cannot carry the flag fails without a request", async () => {
    let called = false;
    const result = await fetchLlmUsage("not-a-url", true, {
      fetch: () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
  });
});

// The period a window or limit covers, stated by the provider rather than
// inferred downstream from a key like "primary" that means a different length
// for each of them.
describe("parseUsagePayload window_seconds", () => {
  function credential(over: Record<string, unknown>) {
    return unwrap(parseUsagePayload({ credentials: [{ name: "c", support: "observed", ...over }] }))
      .credentials[0];
  }

  test("passes a window's stated period through", () => {
    const windows = credential({
      snapshot: {
        primary: { utilization: 0.5, status: "allowed", window_seconds: 604800 },
        secondary: { utilization: 0.1, status: "allowed", window_seconds: 18000 },
      },
    })?.snapshot?.windows;
    expect(windows?.primary?.window_seconds).toBe(604800);
    expect(windows?.secondary?.window_seconds).toBe(18000);
  });

  test("passes a limit's stated period through", () => {
    expect(
      credential({ limits: [{ kind: "monthly_all", percent: 12.5, window_seconds: 2592000 }] })
        ?.limits?.[0]?.window_seconds,
    ).toBe(2592000);
  });

  // A gateway too old to send the field is the common case, and an absent key
  // has to stay absent: a zero would read as a period of no length.
  test("leaves the key off entirely when upstream sends none", () => {
    const c = credential({
      snapshot: { "5h": { utilization: 0.5, status: "allowed" } },
      limits: [{ kind: "session", percent: 1, severity: "normal" }],
    });
    expect(c?.snapshot?.windows["5h"]).not.toHaveProperty("window_seconds");
    expect(c?.limits?.[0]).not.toHaveProperty("window_seconds");
  });

  test("a non-numeric period is dropped rather than carried as junk", () => {
    const c = credential({
      snapshot: { "5h": { utilization: 0.5, status: "allowed", window_seconds: "604800" } },
      limits: [{ kind: "session", percent: 1, severity: "normal", window_seconds: null }],
    });
    expect(c?.snapshot?.windows["5h"]).not.toHaveProperty("window_seconds");
    expect(c?.limits?.[0]).not.toHaveProperty("window_seconds");
  });
});
