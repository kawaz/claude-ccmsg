// llm_keepalive_pause op contract: the session id posted to the gateway's
// pause endpoint, the unconfigured case the webui uses to hide the control,
// the gateway's failures, the role guard, the hello capability, and the
// session's request events read as paused (cache_paused) from then until the
// session's next request.
import { afterAll, describe, expect, test } from "bun:test";
import {
  ErrorCode,
  jsonText,
  parseWith,
  PROTOCOL_VERSION,
  type JsonValue,
  type ResponseOf,
} from "@ccmsg/protocol";
import * as v from "valibot";
import { recordLlmRequests, type Conn, type Daemon } from "../src/server.ts";
import { requestError, requestOk, stubDaemon } from "./drive-request.ts";
import { isKind, streamItemOf, type StreamItem } from "./helpers.ts";

const SID = "aaaaaaaa-0000-4000-8000-000000000001";

/** The body the gateway's pause endpoint reads. Strict: the daemon posts the
 * session id and nothing else. */
const PauseBodyTextSchema = jsonText(v.strictObject({ session_id: v.string() }));

/** Every session id the gateway was asked to pause, newest last. */
const posted: string[] = [];

const gateway = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/llm-gateway/keepalive/pause" && req.method === "POST") {
      const body = parseWith(PauseBodyTextSchema, await req.text());
      if (!body.ok) return new Response(body.failure.summary, { status: 400 });
      posted.push(body.value.session_id);
      return Response.json({ session_id: body.value.session_id, paused: true });
    }
    if (url.pathname === "/wrong-session") {
      return Response.json({ session_id: "someone-else", paused: true });
    }
    return new Response("no such endpoint", { status: 404 });
  },
});
afterAll(() => {
  void gateway.stop(true);
});

const PAUSE_URL = `http://127.0.0.1:${String(gateway.port)}/llm-gateway/keepalive/pause`;

function daemonWith(url?: string): Daemon {
  return stubDaemon({ config: url ? { llm_keepalive_pause_url: url } : {} });
}

const USER: Conn["identity"] = { role: "user" };
const SESSION: Conn["identity"] = { role: "session", sid: "s1", repo: "r", ws: "w", cwd: "" };

/** A request event of `sid`'s main series, as the gateway posts it, with the
 * keepalive chain it projects. */
function requestEvent(ts: number): JsonValue {
  return {
    type: "request",
    session_id: SID,
    ts,
    model: "claude-fable-5",
    prefix: "p1",
    origin: "main",
    cache_expires_at: ts + 60 * 60 * 1000,
    cache_since: ts,
    cache_count: 0,
    next_keepalive_at: ts + 55 * 60 * 1000,
    cache_until: ts + 9 * 60 * 60 * 1000,
  };
}

/** The llm_requests frames the user subscriber of `daemon` is sent. */
function watch(daemon: Daemon): StreamItem[] {
  const pushed: StreamItem[] = [];
  daemon.subscribers.add({
    identity: USER,
    subscribed: true,
    write(line) {
      pushed.push(streamItemOf(line));
    },
  });
  return pushed;
}

function pausedOf(frames: StreamItem[]): (boolean | undefined)[] {
  return frames
    .filter(isKind("llm_requests"))
    .flatMap((frame) => frame.requests.map((request) => request.cache_paused));
}

describe("llm_keepalive_pause op", () => {
  test("posts the session id to the gateway and answers ok", async () => {
    const reply = await requestOk(daemonWith(PAUSE_URL), USER, {
      op: "llm_keepalive_pause",
      request_id: "q1",
      sid: SID,
    });
    expect(reply.ok).toBe(true);
    expect(posted.at(-1)).toBe(SID);
  });

  // The gateway emits nothing on a pause, and the session's last event still
  // projects the chain it will no longer send: the daemon marks that event
  // paused and pushes it, until the session's next request.
  test("serves the session's request events as paused until its next request", async () => {
    const daemon = daemonWith(PAUSE_URL);
    const before = Date.now() - 1000;
    recordLlmRequests(daemon, [requestEvent(before)], daemon.log);
    const pushed = watch(daemon);
    await requestOk(daemon, USER, { op: "llm_keepalive_pause", request_id: "q2", sid: SID });
    expect(pausedOf(pushed)).toEqual([true]);

    recordLlmRequests(daemon, [requestEvent(Date.now() + 1000)], daemon.log);
    expect(pausedOf(pushed)).toEqual([true, undefined]);
  });

  test("replies llm_keepalive_pause_not_configured when no URL is configured", async () => {
    const reply = await requestError(daemonWith(), USER, {
      op: "llm_keepalive_pause",
      request_id: "q3",
      sid: SID,
    });
    expect(reply.error.code).toBe(ErrorCode.llm_keepalive_pause_not_configured);
  });

  test("a gateway that fails or answers for another session is llm_keepalive_pause_unavailable", async () => {
    const base = `http://127.0.0.1:${String(gateway.port)}`;
    for (const url of [`${base}/typo`, `${base}/wrong-session`]) {
      const daemon = daemonWith(url);
      const pushed = watch(daemon);
      const reply = await requestError(daemon, USER, {
        op: "llm_keepalive_pause",
        request_id: "q4",
        sid: SID,
      });
      expect(reply.error.code).toBe(ErrorCode.llm_keepalive_pause_unavailable);
      expect(pushed).toEqual([]);
    }
  });

  test("refuses a session-role caller before reaching the gateway", async () => {
    const asked = posted.length;
    const reply = await requestError(daemonWith(PAUSE_URL), SESSION, {
      op: "llm_keepalive_pause",
      request_id: "q5",
      sid: SID,
    });
    expect(reply.error.code).toBe(ErrorCode.bad_request);
    expect(posted.length).toBe(asked);
  });
});

describe("hello llm_keepalive_pause_available", () => {
  async function helloWith(
    daemon: Daemon,
    identity: { role: "user" } | { role: "session"; sid: string; repo: string; ws: string },
  ): Promise<ResponseOf<"hello">> {
    return requestOk(daemon, null, {
      op: "hello",
      protocol: PROTOCOL_VERSION,
      request_id: "hello-1",
      ...identity,
    });
  }

  test("announces the capability to a user-role hello only when configured", async () => {
    expect(
      (await helloWith(daemonWith(PAUSE_URL), { role: "user" })).llm_keepalive_pause_available,
    ).toBe(true);
    expect(
      (await helloWith(daemonWith(), { role: "user" })).llm_keepalive_pause_available,
    ).toBeUndefined();
    const session = await helloWith(daemonWith(PAUSE_URL), {
      role: "session",
      sid: "99999999-0000-4000-8000-000000000009",
      repo: "r",
      ws: "w",
    });
    expect(session.llm_keepalive_pause_available).toBeUndefined();
  });
});
