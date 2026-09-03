// llm_stats op contract: role guard, the unconfigured case the webui uses to
// hide the section, the window's validation boundary, and the correlated
// reply driven against a real local gateway (the op wires
// production fetch, so a stub deps object would not exercise the wiring under
// test).
import { afterAll, describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import { handleRequest, type Conn, type Daemon } from "../src/server.ts";

const GATEWAY_PORT = 18941;

/** Every `days` the gateway was actually asked for, newest last. Recorded on
 * the server rather than echoed in the body because the daemon normalizes the
 * document and drops fields outside the protocol shape — the observation has
 * to live where the request landed. */
const received: (string | null)[] = [];

/** Routes: /stats answers a one-day document, anything else 404s — the
 * failure a mistyped `llm_stats_url` produces in practice. */
const gateway = Bun.serve({
  port: GATEWAY_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/stats") return new Response("no such endpoint", { status: 404 });
    received.push(url.searchParams.get("days"));
    return Response.json({
      generated_at: 1785552299,
      days: {
        "2026-07-31": {
          credentials: { "claude-a": { "claude-opus-5": { requests: 3, usd: 1.25 } } },
          total_usd: 1.25,
        },
      },
    });
  },
});
afterAll(() => {
  void gateway.stop(true);
});

function daemonWith(llmStatsUrl?: string): Daemon {
  return {
    config: llmStatsUrl ? { llm_stats_url: llmStatsUrl } : {},
    sessions: new Map(),
    connections: new Set<Conn>(),
    log: { error() {} },
  } as unknown as Daemon;
}

/** Drive one request and resolve once `count` frames (replies AND events, in
 * write order) have been written back — same harness as llm-usage-op. */
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

const URL_OK = `http://127.0.0.1:${GATEWAY_PORT}/stats`;
const USER: Conn["identity"] = { role: "user", id: "u1" } as Conn["identity"];
const SESSION: Conn["identity"] = {
  role: "session",
  sid: "s1",
  repo: "r",
  ws: "w",
} as Conn["identity"];

describe("llm_stats op", () => {
  test("delivers the gateway document as the reply", async () => {
    const [reply] = await requestFrames(
      daemonWith(URL_OK),
      USER,
      { op: "llm_stats", request_id: "q1", days: 30 },
      1,
    );
    expect(reply?.ok).toBe(true);
    expect(reply?.generated_at).toBe(1785552299);
    expect(reply?.days["2026-07-31"].total_usd).toBe(1.25);
  });

  // The whole point of the parameter: a window chosen in the UI has to reach
  // the gateway, not just the daemon.
  test("passes the caller's window through to the gateway", async () => {
    const [reply] = await requestFrames(
      daemonWith(URL_OK),
      USER,
      { op: "llm_stats", request_id: "q2", days: 7 },
      1,
    );
    expect(reply?.ok).toBe(true);
    expect(received.at(-1)).toBe("7");
  });

  test("omitting the window leaves the gateway's own default in place", async () => {
    const [reply] = await requestFrames(
      daemonWith(URL_OK),
      USER,
      { op: "llm_stats", request_id: "q3" },
      1,
    );
    expect(reply?.ok).toBe(true);
    expect(received.at(-1)).toBeNull();
  });

  // Rejected without reaching the gateway: an out-of-range window is the
  // client's bug, and dressing it as a gateway error would send
  // whoever debugs it to the wrong machine.
  test("refuses an out-of-range window without reaching the gateway", async () => {
    const before = received.length;
    for (const days of [0, 36_525, 1.5, "30"]) {
      const [reply] = await requestFrames(
        daemonWith(URL_OK),
        USER,
        { op: "llm_stats", request_id: "q4", days },
        1,
      );
      expect(reply?.ok).toBe(false);
      expect(reply?.error.code).toBe(ErrorCode.invalid_args);
    }
    expect(received.length).toBe(before);
  });

  test("a failing gateway settles the request as an error event", async () => {
    const [reply] = await requestFrames(
      daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/typo`),
      USER,
      { op: "llm_stats", request_id: "q5", days: 7 },
      1,
    );
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.llm_stats_unavailable);
  });

  // The signal the webui uses to hide the spend section, and the reason it is
  // a distinct code from llm_stats_unavailable.
  test("replies llm_stats_not_configured when no URL is configured", async () => {
    const [reply] = await requestFrames(
      daemonWith(),
      USER,
      { op: "llm_stats", request_id: "q6" },
      1,
    );
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.llm_stats_not_configured);
  });

  test("refuses a session-role caller before reaching the gateway", async () => {
    const [reply] = await requestFrames(
      daemonWith(URL_OK),
      SESSION,
      { op: "llm_stats", request_id: "q7" },
      1,
    );
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
  });

  test("refuses a request with no request_id (every op needs one to be answered)", async () => {
    const [reply] = await requestFrames(daemonWith(URL_OK), USER, { op: "llm_stats" }, 1);
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
  });
});
