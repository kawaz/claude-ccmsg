// llm_stats proxy contract: the daemon fetches the gateway's spend document
// on the webui's behalf (the endpoint sends no CORS headers) and hands back a
// normalized shape. These pin what the UI depends on — that the caller's
// window reaches the gateway as its `days` parameter, that a partial day
// degrades instead of disappearing, and that every upstream failure arrives
// as one actionable error rather than as a crash or a half-parsed body.
import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import {
  fetchLlmStats,
  isValidDays,
  parseStatsPayload,
  statsUrlWithDays,
} from "../src/llm-stats.ts";
import type { LlmGatewayDeps } from "../src/llm-gateway.ts";

/** The live endpoint's document, trimmed to two credentials on one day —
 * including the "-" bucket the gateway uses for unattributed traffic. */
const UPSTREAM = {
  generated_at: 1785552299,
  generated_at_iso: "2026-08-01T02:44:59Z",
  days: {
    "2026-07-31": {
      credentials: {
        "-": {
          "gpt-5.6-sol": {
            requests: 259,
            input_tokens: 2780800,
            output_tokens: 69863,
            cache_creation_input_tokens: 0,
            cache_read_input_tokens: 53148672,
            usd: 42.574226,
          },
        },
        "claude-kawazzz": {
          "claude-opus-5": { requests: 1605, usd: 290.447535 },
        },
      },
      total_usd: 1548.119857,
    },
  },
};

function jsonDeps(body: unknown, init: ResponseInit = {}): LlmGatewayDeps {
  return { fetch: () => Promise.resolve(new Response(JSON.stringify(body), init)) };
}

function unwrap(result: ReturnType<typeof parseStatsPayload>) {
  if (!result.ok) throw new Error(`expected ok, got ${result.msg}`);
  return result.data;
}

describe("statsUrlWithDays", () => {
  test("adds the window as a query parameter", () => {
    expect(statsUrlWithDays("https://gw.example/stats", 30)).toBe(
      "https://gw.example/stats?days=30",
    );
  });

  // The operator may well paste the URL they were reading in a browser, which
  // already carries a window; the caller's choice has to win rather than
  // arrive alongside a conflicting second value.
  test("overrides a window already present on the configured URL", () => {
    expect(statsUrlWithDays("https://gw.example/stats?days=7", 90)).toBe(
      "https://gw.example/stats?days=90",
    );
  });

  test("keeps other query parameters", () => {
    expect(statsUrlWithDays("https://gw.example/stats?tz=UTC", 7)).toBe(
      "https://gw.example/stats?tz=UTC&days=7",
    );
  });

  test("leaves the URL untouched when no window is named", () => {
    expect(statsUrlWithDays("https://gw.example/stats?days=7")).toBe(
      "https://gw.example/stats?days=7",
    );
  });
});

describe("isValidDays", () => {
  test("accepts the bounds and what lies between them", () => {
    expect(isValidDays(1)).toBe(true);
    expect(isValidDays(30)).toBe(true);
    expect(isValidDays(397)).toBe(true);
    // The webui's widest view asks for exactly this; it has to pass.
    expect(isValidDays(36_524)).toBe(true);
  });

  test("rejects out-of-range, fractional and non-numeric windows", () => {
    expect(isValidDays(0)).toBe(false);
    expect(isValidDays(36_525)).toBe(false);
    expect(isValidDays(1.5)).toBe(false);
    expect(isValidDays(Number.NaN)).toBe(false);
    expect(isValidDays("30")).toBe(false);
    expect(isValidDays(undefined)).toBe(false);
  });
});

describe("parseStatsPayload", () => {
  test("passes through the live endpoint's document", () => {
    const data = unwrap(parseStatsPayload(UPSTREAM));
    expect(data.generated_at).toBe(1785552299);
    expect(data.generated_at_iso).toBe("2026-08-01T02:44:59Z");
    const day = data.days["2026-07-31"];
    expect(day?.total_usd).toBe(1548.119857);
    expect(Object.keys(day?.credentials ?? {})).toEqual(["-", "claude-kawazzz"]);
    expect(day?.credentials["-"]?.["gpt-5.6-sol"]).toEqual({
      requests: 259,
      input_tokens: 2780800,
      output_tokens: 69863,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 53148672,
      usd: 42.574226,
    });
  });

  // The UI sums these counters, so a string that slipped through upstream
  // must not become part of a total as NaN.
  test("drops non-numeric counters instead of coercing them", () => {
    const data = unwrap(
      parseStatsPayload({
        days: { "2026-07-31": { credentials: { c: { m: { usd: "1.5", requests: 3 } } } } },
      }),
    );
    expect(data.days["2026-07-31"]?.credentials.c?.m).toEqual({ requests: 3 });
  });

  test("a day with an unusable credentials field still keeps its total", () => {
    const data = unwrap(
      parseStatsPayload({ days: { "2026-07-31": { credentials: 7, total_usd: 12 } } }),
    );
    expect(data.days["2026-07-31"]).toEqual({ credentials: {}, total_usd: 12 });
  });

  test("a day the gateway sent as a non-object is dropped, the rest survive", () => {
    const data = unwrap(
      parseStatsPayload({
        days: { "2026-07-30": null, "2026-07-31": { credentials: {}, total_usd: 1 } },
      }),
    );
    expect(Object.keys(data.days)).toEqual(["2026-07-31"]);
  });

  test("a body with no days object is the one shape the UI cannot work around", () => {
    expect(parseStatsPayload({ credentials: [] })).toEqual({
      ok: false,
      code: ErrorCode.llm_stats_unavailable,
      msg: "stats endpoint returned no days object",
    });
    expect(parseStatsPayload("<html>").ok).toBe(false);
  });
});

describe("fetchLlmStats", () => {
  test("requests the configured URL carrying the caller's window", async () => {
    const seen: string[] = [];
    const result = await fetchLlmStats("https://gw.example/stats", 14, {
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve(new Response(JSON.stringify(UPSTREAM)));
      },
    });
    expect(seen).toEqual(["https://gw.example/stats?days=14"]);
    expect(result.ok).toBe(true);
  });

  test("a non-2xx status names the status in the message", async () => {
    const result = await fetchLlmStats(
      "https://gw.example/stats",
      7,
      jsonDeps({}, { status: 502 }),
    );
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_stats_unavailable,
      msg: "stats endpoint returned HTTP 502",
    });
  });

  test("a body that is not JSON reports as such rather than throwing", async () => {
    const result = await fetchLlmStats("https://gw.example/stats", 7, {
      fetch: () => Promise.resolve(new Response("<html>nope</html>")),
    });
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_stats_unavailable,
      msg: "stats endpoint returned invalid JSON",
    });
  });

  test("an unreachable gateway settles rather than rejecting", async () => {
    const result = await fetchLlmStats("https://gw.example/stats", 7, {
      fetch: () => Promise.reject(new Error("ECONNREFUSED")),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.msg).toContain("stats endpoint unreachable");
  });

  test("a gateway that never answers times out with the budget in the message", async () => {
    const result = await fetchLlmStats(
      "https://gw.example/stats",
      7,
      {
        fetch: (_url, init) =>
          new Promise((_, reject) =>
            init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
          ),
      },
      20,
    );
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_stats_unavailable,
      msg: "stats endpoint did not respond within 20ms",
    });
  });

  test("a URL that cannot carry a window fails without a request", async () => {
    let called = false;
    const result = await fetchLlmStats("not-a-url", 7, {
      fetch: () => {
        called = true;
        return Promise.resolve(new Response("{}"));
      },
    });
    expect(called).toBe(false);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe(ErrorCode.llm_stats_unavailable);
  });

  // A misconfigured URL pointing at something enormous must not be buffered
  // into daemon memory before the size is noticed.
  test("an oversized body is refused rather than buffered", async () => {
    const huge = "x".repeat(1024 * 1024);
    const result = await fetchLlmStats("https://gw.example/stats", 7, {
      fetch: () =>
        Promise.resolve(
          new Response(
            new ReadableStream({
              pull(controller) {
                controller.enqueue(new TextEncoder().encode(huge));
              },
            }),
          ),
        ),
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.msg).toContain("exceeds");
  });
});
