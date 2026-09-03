import { describe, expect, test } from "bun:test";
import { handleRequest, type Conn, type Daemon } from "../src/server.ts";
import type { TranslateService } from "../src/translate-helper.ts";

function daemonWith(translator: TranslateService): Daemon {
  const daemon = {
    translator,
    sessions: new Map(),
    connections: new Set<Conn>(),
    log: { error() {} },
  } as unknown as Daemon;
  return daemon;
}

/** Drive one request and resolve with the single frame written back. */
function requestOnce(
  daemon: Daemon,
  identity: Conn["identity"],
  request: unknown,
): Promise<Record<string, any>> {
  return requestFrames(daemon, identity, request, 1).then((frames) => frames[0]!);
}

/** Drive one request against a registered conn and resolve once `count`
 * frames (in write order) have been captured. */
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
    // Register like the real transports do.
    daemon.connections.add(conn);
    handleRequest(daemon, conn, JSON.stringify(request));
  });
}

describe("translate op", () => {
  // One correlated reply carries the whole helper outcome: order-preserving
  // results, per-item failures included.
  test("a user request is answered with one reply preserving text order and per-item helper failures", async () => {
    const seen: string[][] = [];
    const translator: TranslateService = {
      async translate(texts) {
        seen.push(texts);
        return {
          ok: true,
          results: [
            { ok: true, text: "一番" },
            { ok: false, error: "TranslationError.notInstalled" },
          ],
        };
      },
      stop() {},
    };

    const [reply] = await requestFrames(
      daemonWith(translator),
      { role: "user" },
      {
        op: "translate",
        request_id: "t-1",
        texts: ["first", "second"],
      },
      1,
    );
    expect(seen).toEqual([["first", "second"]]);
    expect(reply).toEqual({
      request_id: "t-1",
      ok: true,
      results: [
        { ok: true, text: "一番" },
        { ok: false, error: "TranslationError.notInstalled" },
      ],
    });
  });

  // A request with no request_id is refused before dispatch (nothing could
  // pair with the reply), so the helper is never invoked.
  test("a missing request_id is rejected before the helper is touched", async () => {
    let calls = 0;
    const translator: TranslateService = {
      async translate() {
        calls++;
        return { ok: true, results: [] };
      },
      stop() {},
    };

    const response = await requestOnce(
      daemonWith(translator),
      { role: "user" },
      { op: "translate", texts: ["x"] },
    );
    expect(calls).toBe(0);
    expect(response).toEqual({
      ok: false,
      error: { code: "bad_request", msg: "op 'translate' requires a non-empty string request_id" },
    });
  });

  test("session-role callers are rejected before the helper is touched", async () => {
    let calls = 0;
    const translator: TranslateService = {
      async translate() {
        calls++;
        return { ok: true, results: [] };
      },
      stop() {},
    };

    const response = await requestOnce(
      daemonWith(translator),
      { role: "session", sid: "s1", repo: "", ws: "", cwd: "" },
      { op: "translate", request_id: "q1", texts: ["secret"] },
    );
    expect(calls).toBe(0);
    expect(response).toEqual({
      ok: false,
      error: { code: "bad_request", msg: "op 'translate' requires user role" },
      request_id: "q1",
    });
  });

  test("non-string batches are rejected as invalid arguments", async () => {
    let calls = 0;
    const translator: TranslateService = {
      async translate() {
        calls++;
        return { ok: true, results: [] };
      },
      stop() {},
    };

    const response = await requestOnce(
      daemonWith(translator),
      { role: "user" },
      {
        op: "translate",
        request_id: "q1",
        texts: ["ok", 42],
      },
    );
    expect(calls).toBe(0);
    expect(response).toEqual({
      ok: false,
      error: { code: "invalid_args", msg: "translate requires a string[] texts" },
      request_id: "q1",
    });
  });

  // Capability failures are only known once the helper answers, so they come
  // back as the reply's ok:false — the webui's probe reads
  // translate_unavailable from there.
  test("host/helper unavailability is returned as an explicit error reply", async () => {
    const translator: TranslateService = {
      async translate() {
        return {
          ok: false,
          code: "translate_unavailable",
          msg: "host translation is available only on macOS",
        };
      },
      stop() {},
    };

    const [reply] = await requestFrames(
      daemonWith(translator),
      { role: "user" },
      {
        op: "translate",
        request_id: "t-2",
        texts: [],
      },
      1,
    );
    expect(reply).toEqual({
      request_id: "t-2",
      ok: false,
      error: {
        code: "translate_unavailable",
        msg: "host translation is available only on macOS",
      },
    });
  });
});
