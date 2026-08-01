// llm_usage proxy contract: the daemon fetches the gateway's usage document
// on the webui's behalf (the endpoint sends no CORS headers) and hands back a
// normalized shape. These tests pin the two things the UI depends on — that
// quota windows are recognised by shape rather than by a hardcoded "5h"/"7d"
// allowlist, and that every upstream failure mode arrives as one actionable
// error rather than as a crash or a half-parsed body.
import { describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import { fetchLlmUsage, parseUsagePayload } from "../src/llm-usage.ts";
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
    const result = await fetchLlmUsage("https://gw.example/usage", jsonDeps(UPSTREAM));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.data.credentials).toHaveLength(3);
  });

  test("requests the configured URL", async () => {
    const seen: string[] = [];
    await fetchLlmUsage("https://gw.example/llm-gateway/usage", {
      fetch: (url) => {
        seen.push(url);
        return Promise.resolve(new Response(JSON.stringify(UPSTREAM)));
      },
    });
    expect(seen).toEqual(["https://gw.example/llm-gateway/usage"]);
  });

  test("reports a non-2xx status", async () => {
    const result = await fetchLlmUsage("https://gw.example/usage", jsonDeps({}, { status: 502 }));
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_usage_unavailable,
      msg: "usage endpoint returned HTTP 502",
    });
  });

  test("reports a body that is not JSON", async () => {
    const result = await fetchLlmUsage("https://gw.example/usage", {
      fetch: () => Promise.resolve(new Response("<html>login</html>")),
    });
    expect(result).toEqual({
      ok: false,
      code: ErrorCode.llm_usage_unavailable,
      msg: "usage endpoint returned invalid JSON",
    });
  });

  test("reports an unreachable gateway instead of throwing", async () => {
    const result = await fetchLlmUsage("https://gw.example/usage", {
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
    const result = await fetchLlmUsage("https://gw.example/usage", {
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
