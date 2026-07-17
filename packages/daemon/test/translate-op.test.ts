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

/** Drive one request and resolve with the FIRST frame written back (for
 * translate that's the 2-phase ack, for validation errors the ErrorResponse).
 * Frames after the first stay in `conn.lines` via requestFrames below. */
function requestOnce(
  daemon: Daemon,
  identity: Conn["identity"],
  request: unknown,
): Promise<Record<string, any>> {
  return requestFrames(daemon, identity, request, 1).then((frames) => frames[0]!);
}

/** Drive one request against a registered conn and resolve once `count`
 * frames (replies AND events, in write order) have been captured — the
 * 2-phase translate op writes ack + result event to the same conn. */
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
    // Result events are only delivered to conns still registered in
    // daemon.connections (disconnect discard contract) — register like the
    // real transports do.
    daemon.connections.add(conn);
    handleRequest(daemon, conn, JSON.stringify(request));
  });
}

describe("translate op", () => {
  // 2-phase contract: the positional reply is an immediate ack echoing
  // request_id; the helper outcome (order-preserving results, per-item
  // failures included) arrives as the correlated ev:"translate_result" event.
  test("a user request acks immediately, then the result event preserves text order and per-item helper failures", async () => {
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

    const [ack, event] = await requestFrames(
      daemonWith(translator),
      { role: "user" },
      {
        op: "translate",
        request_id: "t-1",
        texts: ["first", "second"],
      },
      2,
    );
    expect(seen).toEqual([["first", "second"]]);
    expect(ack).toEqual({ ok: true, accepted: true, request_id: "t-1" });
    expect(event).toEqual({
      ev: "translate_result",
      request_id: "t-1",
      ok: true,
      results: [
        { ok: true, text: "一番" },
        { ok: false, error: "TranslationError.notInstalled" },
      ],
    });
  });

  // Correlation is impossible without a request_id, so its absence is a
  // synchronous invalid_args reply and the helper is never invoked.
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
      error: { code: "invalid_args", msg: "translate requires a non-empty string request_id" },
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
      { op: "translate", texts: ["secret"] },
    );
    expect(calls).toBe(0);
    expect(response).toEqual({
      ok: false,
      error: { code: "bad_request", msg: "op 'translate' requires user role" },
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
        texts: ["ok", 42],
      },
    );
    expect(calls).toBe(0);
    expect(response).toEqual({
      ok: false,
      error: { code: "invalid_args", msg: "translate requires a string[] texts" },
    });
  });

  // Capability failures surface AFTER the ack (they're only known once the
  // helper answers), so they ride the result event as ok:false — the webui's
  // probe reads translate_unavailable from there.
  test("host/helper unavailability is returned as an explicit error on the result event", async () => {
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

    const [ack, event] = await requestFrames(
      daemonWith(translator),
      { role: "user" },
      {
        op: "translate",
        request_id: "t-2",
        texts: [],
      },
      2,
    );
    expect(ack).toEqual({ ok: true, accepted: true, request_id: "t-2" });
    expect(event).toEqual({
      ev: "translate_result",
      request_id: "t-2",
      ok: false,
      error: {
        code: "translate_unavailable",
        msg: "host translation is available only on macOS",
      },
    });
  });
});
