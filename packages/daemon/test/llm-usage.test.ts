// llm_usage proxy contract: the daemon fetches the gateway's usage document
// on the webui's behalf (the endpoint sends no CORS headers) and hands back a
// normalized shape. These tests pin the two things the UI depends on — that
// quota windows are recognised by shape rather than by a hardcoded "5h"/"7d"
// allowlist, and that every upstream failure mode arrives as one actionable
// error rather than as a crash or a half-parsed body.
import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import {
  fetchLlmUsage,
  parseUsagePayload as parseUsageDocument,
  usageUrlWithRefresh,
} from "../src/llm-usage.ts";
import type { LlmGatewayDeps } from "../src/llm-gateway.ts";
import { throughJson } from "./helpers.ts";

function parseUsagePayload(document: unknown, base?: string) {
  return parseUsageDocument(throughJson(document), base);
}

/** The live endpoint's document, trimmed to one credential per support kind. */
const UPSTREAM = {
  generated_at: 1785450000000,
  credentials: [
    { name: "bedrock", type: "claude_bedrock", support: "not_applicable" },
    {
      name: "claude-kawazzz",
      type: "claude_oauth",
      support: "observed",
      snapshot: {
        observed_at: 1785449700000,
        "5h": {
          utilization: 0.13,
          status: "allowed",
          reset: 1785468600000,
        },
        "7d": {
          utilization: 0.87,
          status: "allowed_warning",
          reset: 1785640000000,
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

/** Why a usage document does not read. */
function refusal(document: unknown): string {
  const result = parseUsagePayload(document);
  if (result.ok) throw new Error("expected the document not to read");
  expect(result.code).toBe(ErrorCode.llm_usage_unavailable);
  return result.msg;
}

describe("parseUsagePayload", () => {
  test("passes through the live endpoint's document", () => {
    const data = unwrap(parseUsagePayload(UPSTREAM));
    expect(data.generated_at).toBe(1785450000000);
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
      reset: 1785468600000,
    });
    expect(snapshot?.observed_at).toBe(1785449700000);
    expect(snapshot?.overage).toEqual({ status: "rejected", disabled_reason: "out_of_credits" });
  });

  // The gateway's snapshot carries its windows under the two keys its contract
  // names (quota.rs Snapshot: "5h", "7d"); a key it does not send is not read,
  // and the document still reads.
  test("reads the gateway's two windows, and no other key", () => {
    const windows = unwrap(
      parseUsagePayload({
        credentials: [
          {
            name: "x",
            support: "observed",
            snapshot: {
              "30d": { utilization: 0.5, status: "allowed" },
              "7d": { utilization: 0.2, status: "allowed" },
            },
          },
        ],
      }),
    ).credentials[0]?.snapshot?.windows;
    expect(windows).toEqual({ "7d": { utilization: 0.2, status: "allowed" } });
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
    const credentials = unwrap(
      parseUsagePayload({ credentials: [{ name: "bare", support: "unobserved" }] }),
    ).credentials;
    expect(credentials).toEqual([{ name: "bare", support: "unobserved" }]);
    // `support` is always sent; a credential without it does not read.
    expect(refusal({ credentials: [{ name: "bare" }] })).toContain("credentials.0.support");
  });

  // An entry that does not read is not left out of the list: the document does
  // not read, naming the entry.
  test("an entry that does not read is named, not dropped", () => {
    expect(
      refusal({ credentials: [{ name: "kept", support: "observed" }, { support: "observed" }] }),
    ).toContain("credentials.1.name");
    expect(refusal({ credentials: ["nope"] })).toContain("credentials.0");
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
          observed_at: 1785449700000,
        }),
      ).toEqual({
        status: "relogin_required",
        reason: "run `llm-gateway login --type claude_oauth x`",
        observed_at: 1785449700000,
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

    test("an auth object with no status does not read", () => {
      for (const auth of [{ reason: "who knows" }, "relogin_required"]) {
        expect(
          refusal({
            credentials: [{ name: "x", type: "claude_oauth", support: "observed", auth }],
          }),
        ).toContain("credentials.0.auth");
      }
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
          resets_at: 1785661199688,
          is_active: true,
        },
        {
          kind: "weekly_scoped",
          percent: 80.0,
          severity: "warning",
          resets_at: 1785661199688,
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
        resets_at: 1785661199688,
        is_active: true,
      },
      {
        kind: "weekly_scoped",
        percent: 80,
        severity: "warning",
        resets_at: 1785661199688,
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

  test("an entry without the two fields a bar needs does not read, named", () => {
    for (const entry of [
      { percent: 10, severity: "normal" },
      { kind: "session", severity: "normal" },
      "nonsense",
      null,
    ]) {
      expect(
        refusal({
          credentials: [
            {
              name: "c",
              support: "observed",
              limits: [{ kind: "weekly_all", percent: 40, severity: "normal" }, entry],
            },
          ],
        }),
      ).toContain("credentials.0.limits.1");
    }
  });

  // The gateway may give no verdict; it stays absent rather than being given
  // one (the webui reads no verdict as nothing to announce).
  test("a missing severity stays absent", () => {
    const credential = withCredential({ limits: [{ kind: "session", percent: 5 }] });
    expect(credential?.limits?.[0]).toEqual({ kind: "session", percent: 5 });
  });

  // The common case on a gateway that does not send the field at all.
  test("absent or empty limits leave the key off entirely", () => {
    expect(withCredential({})?.limits).toBeUndefined();
    expect(withCredential({ limits: [] })?.limits).toBeUndefined();
  });

  test("limits that are not a list of limits do not read", () => {
    for (const limits of ["nope", [{ kind: "session" }]]) {
      expect(refusal({ credentials: [{ name: "c", support: "observed", limits }] })).toContain(
        "credentials.0.limits",
      );
    }
  });

  test("probe_error is carried alongside whatever reading survives", () => {
    const credential = withCredential({
      probe_error: "429 from upstream",
      snapshot: { observed_at: 1785449700000, "5h": { utilization: 0.2, status: "allowed" } },
    });
    expect(credential?.probe_error).toBe("429 from upstream");
    expect(credential?.snapshot?.windows["5h"]?.utilization).toBe(0.2);
  });

  test("probe_error is carried as stated, and one that is not text does not read", () => {
    expect(withCredential({})?.probe_error).toBeUndefined();
    expect(withCredential({ probe_error: "" })?.probe_error).toBe("");
    expect(
      refusal({ credentials: [{ name: "c", support: "observed", probe_error: 500 }] }),
    ).toContain("credentials.0.probe_error");
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
        // A provider whose short slot is a week long (observed 2026-10-11):
        // the stated period, not the key, says how long it is.
        "5h": { utilization: 0.5, status: "allowed", window_seconds: 604800 },
        "7d": { utilization: 0.1, status: "allowed", window_seconds: 18000 },
      },
    })?.snapshot?.windows;
    expect(windows?.["5h"]?.window_seconds).toBe(604800);
    expect(windows?.["7d"]?.window_seconds).toBe(18000);
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

  test("a non-numeric period does not read", () => {
    expect(
      refusal({
        credentials: [
          {
            name: "c",
            support: "observed",
            snapshot: { "5h": { utilization: 0.5, status: "allowed", window_seconds: "604800" } },
          },
        ],
      }),
    ).toContain("credentials.0.snapshot.5h.window_seconds");
    expect(
      refusal({
        credentials: [
          {
            name: "c",
            support: "observed",
            limits: [{ kind: "session", percent: 1, severity: "normal", window_seconds: null }],
          },
        ],
      }),
    ).toContain("credentials.0.limits.0.window_seconds");
  });
});
