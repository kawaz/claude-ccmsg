// llm_usage op contract: role guard, the unconfigured case the webui uses to
// hide the feature, and the 2-phase ack → result-event exchange driven
// against a real local gateway (the op wires production fetch, so a stub deps
// object would not exercise the wiring under test).
import { afterAll, describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import { handleRequest, type Conn, type Daemon } from "../src/server.ts";

const GATEWAY_PORT = 18921;
const USAGE_BODY = {
  generated_at: 1785450000,
  credentials: [
    { name: "bedrock", type: "claude_bedrock", support: "not_applicable" },
    {
      name: "oauth",
      type: "claude_oauth",
      support: "observed",
      snapshot: {
        observed_at: 1785449700,
        "5h": { utilization: 0.13, status: "allowed", reset: 1785468600 },
      },
    },
  ],
};

/** Every `refresh` the gateway was actually asked for, newest last — recorded
 * server-side because the daemon normalizes the document and would not carry
 * an echo back. */
const received: (string | null)[] = [];

/** Routes: /usage answers the document, anything else 404s (the failure path
 * a mistyped `llm_usage_url` produces in practice). Like the real gateway,
 * `limits` are served only to a probe. */
const gateway = Bun.serve({
  port: GATEWAY_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/usage") return new Response("no such endpoint", { status: 404 });
    const refresh = url.searchParams.get("refresh");
    received.push(refresh);
    if (refresh !== "true") return Response.json(USAGE_BODY);
    return Response.json({
      ...USAGE_BODY,
      credentials: USAGE_BODY.credentials.map((credential) =>
        credential.name === "oauth"
          ? {
              ...credential,
              limits: [{ kind: "weekly_all", percent: 100, severity: "critical" }],
            }
          : credential,
      ),
    });
  },
});
afterAll(() => {
  void gateway.stop(true);
});

function daemonWith(llmUsageUrl?: string): Daemon {
  return {
    config: llmUsageUrl ? { llm_usage_url: llmUsageUrl } : {},
    sessions: new Map(),
    connections: new Set<Conn>(),
    log: { error() {} },
  } as unknown as Daemon;
}

/** Drive one request and resolve once `count` frames (replies AND events, in
 * write order) have been written back — same harness as translate-op. */
function requestFrames(
  daemon: Daemon,
  identity: Conn["identity"],
  request: unknown,
  count: number,
): Promise<Record<string, any>[]> {
  return new Promise((resolve) => {
    const frames: Record<string, any>[] = [];
    const conn: Conn = {
      identity,
      subscribed: false,
      write(line) {
        frames.push(JSON.parse(line));
        if (frames.length === count) resolve(frames);
      },
    };
    daemon.connections.add(conn);
    handleRequest(daemon, conn, JSON.stringify(request));
  });
}

const USER: Conn["identity"] = { role: "user", id: "u1" } as Conn["identity"];
const SESSION: Conn["identity"] = {
  role: "session",
  sid: "s1",
  repo: "r",
  ws: "w",
} as Conn["identity"];

describe("llm_usage op", () => {
  test("acks, then delivers the gateway document on the result event", async () => {
    const daemon = daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/usage`);
    const [ack, event] = await requestFrames(
      daemon,
      USER,
      { op: "llm_usage", request_id: "q1" },
      2,
    );
    expect(ack).toEqual({ ok: true, accepted: true, request_id: "q1" });
    expect(event?.ev).toBe("llm_usage_result");
    expect(event?.request_id).toBe("q1");
    expect(event?.ok).toBe(true);
    expect(event?.generated_at).toBe(1785450000);
    expect(event?.credentials).toHaveLength(2);
    expect(event?.credentials[1].snapshot.windows["5h"].utilization).toBe(0.13);
  });

  // The gateway is reachable but the path is wrong: the failure has to reach
  // the client as a result event, not as a hang.
  test("a failing gateway settles the request as an error event", async () => {
    const daemon = daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/typo`);
    const [, event] = await requestFrames(daemon, USER, { op: "llm_usage", request_id: "q2" }, 2);
    expect(event?.ev).toBe("llm_usage_result");
    expect(event?.ok).toBe(false);
    expect(event?.error.code).toBe(ErrorCode.llm_usage_unavailable);
  });

  // The signal the webui uses to hide the usage screen entirely, and the
  // reason it is a distinct code from llm_usage_unavailable.
  test("replies llm_usage_not_configured when no URL is configured", async () => {
    const [reply] = await requestFrames(
      daemonWith(),
      USER,
      { op: "llm_usage", request_id: "q3" },
      1,
    );
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.llm_usage_not_configured);
  });

  // Only a probe response carries limits, so the flag has to reach the
  // gateway — and must not be sent when the client did not ask for one.
  test("passes a refresh through to the gateway and surfaces its limits", async () => {
    const daemon = daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/usage`);
    const [, event] = await requestFrames(
      daemon,
      USER,
      { op: "llm_usage", request_id: "r1", refresh: true },
      2,
    );
    expect(received.at(-1)).toBe("true");
    expect(event?.ok).toBe(true);
    expect(event?.credentials[1].limits).toEqual([
      { kind: "weekly_all", percent: 100, severity: "critical" },
    ]);
  });

  test("a request without the flag reads the cache and gets no limits", async () => {
    const daemon = daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/usage`);
    const [, event] = await requestFrames(daemon, USER, { op: "llm_usage", request_id: "r2" }, 2);
    expect(received.at(-1)).toBeNull();
    expect(event?.credentials[1].limits).toBeUndefined();
  });

  // Anything other than an explicit `true` is a plain read: a probe spends
  // upstream rate limit, so it must never happen by accident.
  test("a non-true refresh value does not trigger a probe", async () => {
    const daemon = daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/usage`);
    for (const refresh of ["true", 1, null]) {
      await requestFrames(daemon, USER, { op: "llm_usage", request_id: "r3", refresh }, 2);
      expect(received.at(-1)).toBeNull();
    }
  });

  test("refuses a session-role caller before reaching the gateway", async () => {
    const daemon = daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/usage`);
    const [reply] = await requestFrames(daemon, SESSION, { op: "llm_usage", request_id: "q4" }, 1);
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
  });

  test("refuses a request with no request_id (every op needs one to be answered)", async () => {
    const daemon = daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/usage`);
    const [reply] = await requestFrames(daemon, USER, { op: "llm_usage" }, 1);
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
  });
});
