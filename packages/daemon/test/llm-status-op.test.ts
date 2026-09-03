// llm_status op contract: role guard, the unconfigured case the webui uses to
// hide the strip, the 2-phase ack → result-event exchange driven against a
// real local gateway, the hello capability the webui reads before asking, and
// the one thing this endpoint has that the other two do not — a 529 in the
// gateway's webhook making the daemon re-read and push the report.
import { afterAll, describe, expect, test } from "bun:test";
import { ErrorCode } from "@ccmsg/protocol";
import {
  broadcastLlmStatus,
  createStatusRefresher,
  handleRequest,
  recordLlmRequests,
  type Conn,
  type Daemon,
} from "../src/server.ts";
import { fetchLlmStatus, LlmStatusRefresher } from "../src/llm-status.ts";
import { LlmRequestCache } from "../src/llm-events.ts";

const GATEWAY_PORT = 18927;
const STATUS_BODY = {
  schema_version: 1,
  generated_at: 1788333834,
  overall: { severity: "warning", service_counts: { ok: 1, warning: 1 } },
  services: [
    {
      id: "anthropic",
      name: "Anthropic",
      severity: "warning",
      routes: ["claude-a"],
      official: { state: "degraded", components: [], incidents: [] },
      observed: { state: "reachable", observed_at: 1788333800 },
    },
    { id: "openai", name: "OpenAI", severity: "ok", routes: ["codex"] },
  ],
};

/** Every `refresh` the gateway was actually asked for, newest last. */
const received: (string | null)[] = [];

const gateway = Bun.serve({
  port: GATEWAY_PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/status") return new Response("no such endpoint", { status: 404 });
    received.push(url.searchParams.get("refresh"));
    return Response.json(STATUS_BODY);
  },
});
afterAll(() => {
  void gateway.stop(true);
});

const STATUS_URL = `http://127.0.0.1:${GATEWAY_PORT}/status`;

function daemonWith(llmStatusUrl?: string): Daemon {
  return {
    config: llmStatusUrl ? { llm_status_url: llmStatusUrl } : {},
    sessions: new Map(),
    connections: new Set<Conn>(),
    subscribers: new Set<Conn>(),
    llmRequests: new LlmRequestCache(),
    llmStatusRefresher: null,
    log: { error() {}, info() {} },
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

const USER: Conn["identity"] = { role: "user", id: "u1" } as Conn["identity"];
const SESSION: Conn["identity"] = {
  role: "session",
  sid: "s1",
  repo: "r",
  ws: "w",
} as Conn["identity"];

describe("llm_status op", () => {
  test("acks, then delivers the gateway report on the result event", async () => {
    const [ack, event] = await requestFrames(
      daemonWith(STATUS_URL),
      USER,
      { op: "llm_status", request_id: "q1" },
      2,
    );
    expect(ack).toEqual({ ok: true, accepted: true, request_id: "q1" });
    expect(event?.ev).toBe("llm_status_result");
    expect(event?.request_id).toBe("q1");
    expect(event?.ok).toBe(true);
    expect(event?.overall.severity).toBe("warning");
    expect(event?.services.map((s: { id: string }) => s.id)).toEqual(["anthropic", "openai"]);
  });

  test("a failing gateway settles the request as an error event", async () => {
    const [, event] = await requestFrames(
      daemonWith(`http://127.0.0.1:${GATEWAY_PORT}/typo`),
      USER,
      { op: "llm_status", request_id: "q2" },
      2,
    );
    expect(event?.ev).toBe("llm_status_result");
    expect(event?.ok).toBe(false);
    expect(event?.error.code).toBe(ErrorCode.llm_status_unavailable);
  });

  // The signal the webui uses to hide the strip, and the reason it is a
  // distinct code from llm_status_unavailable.
  test("replies llm_status_not_configured when no URL is configured", async () => {
    const [reply] = await requestFrames(
      daemonWith(),
      USER,
      { op: "llm_status", request_id: "q3" },
      1,
    );
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.llm_status_not_configured);
  });

  test("passes a refresh through, and only when asked for explicitly", async () => {
    const daemon = daemonWith(STATUS_URL);
    await requestFrames(daemon, USER, { op: "llm_status", request_id: "r1", refresh: true }, 2);
    expect(received.at(-1)).toBe("true");
    for (const refresh of ["true", 1, null]) {
      await requestFrames(daemon, USER, { op: "llm_status", request_id: "r2", refresh }, 2);
      expect(received.at(-1)).toBeNull();
    }
  });

  test("refuses a session-role caller before reaching the gateway", async () => {
    const [reply] = await requestFrames(
      daemonWith(STATUS_URL),
      SESSION,
      { op: "llm_status", request_id: "q4" },
      1,
    );
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
  });

  test("refuses a request with no request_id (every op needs one to be answered)", async () => {
    const [reply] = await requestFrames(daemonWith(STATUS_URL), USER, { op: "llm_status" }, 1);
    expect(reply?.ok).toBe(false);
    expect(reply?.error.code).toBe(ErrorCode.bad_request);
  });
});

describe("hello llm_status_available", () => {
  async function helloWith(daemon: Daemon, identity: unknown): Promise<Record<string, any>> {
    const [reply] = await requestFrames(
      daemon,
      null as Conn["identity"],
      {
        op: "hello",
        request_id: "hello-1",
        ...(identity as object),
      },
      1,
    );
    return reply ?? {};
  }

  test("announces the capability to a user-role hello", async () => {
    const reply = await helloWith(daemonWith(STATUS_URL), { role: "user", id: "u9" });
    expect(reply.ok).toBe(true);
    expect(reply.llm_status_available).toBe(true);
  });

  // Absent rather than false: the webui hides the strip entirely, exactly as
  // it does for a daemon with no usage endpoint.
  test("omits it when no status endpoint is configured", async () => {
    const reply = await helloWith(daemonWith(), { role: "user", id: "u9" });
    expect(reply.llm_status_available).toBeUndefined();
  });

  test("omits it for a session-role hello", async () => {
    const reply = await helloWith(daemonWith(STATUS_URL), {
      role: "session",
      sid: "s9",
      repo: "r",
      ws: "w",
    });
    expect(reply.llm_status_available).toBeUndefined();
  });
});

describe("529 in a gateway webhook event", () => {
  /** A daemon whose refresher reads the real endpoint and pushes through the
   * daemon's own broadcast, with one user subscriber and one session
   * subscriber watching what arrives. Only the debounce differs from
   * createStatusRefresher's wiring (zero here; the timer itself is covered in
   * llm-status.test.ts), and the last test in this block pins that wiring. */
  function pushHarness(): {
    daemon: Daemon;
    /** Resolves with the pushed frames once the user subscriber has been sent
     * `count` of them. Event-driven rather than timed: the read is a real
     * round trip to the gateway above, and a sleep long enough to cover it
     * would still be a guess. */
    frames: (count: number) => Promise<Record<string, any>[]>;
    /** Frames the session-role subscriber was sent (must stay empty). */
    sessionFrames: Record<string, any>[];
  } {
    const daemon = daemonWith(STATUS_URL);
    const pushed: Record<string, any>[] = [];
    const sessionFrames: Record<string, any>[] = [];
    let want = 0;
    let resolve: ((frames: Record<string, any>[]) => void) | null = null;
    const settleIfReady = (): void => {
      if (resolve && pushed.length >= want) {
        resolve(pushed);
        resolve = null;
      }
    };
    daemon.subscribers.add({
      identity: USER,
      subscribed: true,
      write(line) {
        pushed.push(JSON.parse(line));
        settleIfReady();
      },
    } as Conn);
    daemon.subscribers.add({
      identity: SESSION,
      subscribed: true,
      write(line) {
        sessionFrames.push(JSON.parse(line));
      },
    } as Conn);
    // The debounce itself is covered in llm-status.test.ts; here it only gets
    // in the way of observing the wiring.
    daemon.llmStatusRefresher = new LlmStatusRefresher({
      fetch: () => fetchLlmStatus(STATUS_URL),
      onReport: (report) => broadcastLlmStatus(daemon, report),
      debounceMs: 0,
    });
    return {
      daemon,
      frames: (count) =>
        new Promise((res) => {
          want = count;
          resolve = res;
          settleIfReady();
        }),
      sessionFrames,
    };
  }

  const log = { info() {}, error() {} } as never;

  test("re-reads the status endpoint and pushes the report to user subscribers", async () => {
    const h = pushHarness();
    recordLlmRequests(
      h.daemon,
      [{ ts: 1788333834, session_id: "s1", prefix: "p", status: 529 }],
      log,
    );
    // ev:"llm_requests" for the folded event, then ev:"llm_status" for the
    // re-read it triggered.
    const frames = await h.frames(2);
    const status = frames.filter((frame) => frame.ev === "llm_status");
    expect(status).toHaveLength(1);
    expect(status[0]?.report.overall.severity).toBe("warning");
    expect(status[0]?.report.services).toHaveLength(2);
    // Same posture as ev:"llm_requests": which providers are up is a webui
    // concern, and a session-role subscriber has nowhere to show it.
    expect(h.sessionFrames).toEqual([]);
    // The re-read is a plain read: the gateway refreshes its own sources on
    // the same 529, so asking it to refresh again would only wait on fetches
    // already under way.
    expect(received.at(-1)).toBeNull();
  });

  // An event the parser drops (no session id) is still evidence the upstream
  // is failing, which is what the trigger is about.
  test("triggers on a 529 whose event carries no session id", async () => {
    const h = pushHarness();
    recordLlmRequests(h.daemon, [{ ts: 1788333834, session_id: null, status: 529 }], log);
    const frames = await h.frames(1);
    expect(frames.filter((frame) => frame.ev === "llm_status")).toHaveLength(1);
  });

  // 401/403/429 are credential problems and a plain 200 is business as usual;
  // neither says anything about the provider's health (gateway DR-0021 §2).
  test("does not trigger on statuses that are not upstream overload", async () => {
    const h = pushHarness();
    recordLlmRequests(
      h.daemon,
      [200, 401, 429, 500].map((status) => ({
        ts: 1788333834,
        session_id: "s1",
        prefix: "p",
        status,
      })),
      log,
    );
    // One ev:"llm_requests" for the fold. Anything after it would be a status
    // push, and awaiting a second frame is how this test would notice one.
    const frames = await h.frames(1);
    expect(frames.map((frame) => frame.ev)).toEqual(["llm_requests"]);
    // A round trip to the gateway above would have completed by now had one
    // been started; the op tests in this file are the proof of that latency.
    await requestFrames(h.daemon, USER, { op: "llm_status", request_id: "probe" }, 2);
    expect(frames.filter((frame) => frame.ev === "llm_status")).toHaveLength(0);
  });

  test("stays off entirely when no status endpoint is configured", () => {
    expect(createStatusRefresher(daemonWith())).toBeNull();
    expect(createStatusRefresher(daemonWith(STATUS_URL))).not.toBeNull();
  });
});
