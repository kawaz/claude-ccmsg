import { describe, expect, test } from "bun:test";
import type { Conn, Daemon } from "../src/server.ts";
import { requestFrames, requestOnce } from "./drive-request.ts";
import type { TranslateService } from "../src/translate-helper.ts";

function daemonWith(translator: TranslateService): Daemon {
  const daemon = {
    translator,
    sessions: new Map(),
    connections: new Set<Conn>(),
    log: { error() {}, warn() {} },
  } as unknown as Daemon;
  return daemon;
}

describe("translate op", () => {
  // One correlated reply carries the whole helper outcome: order-preserving
  // results, per-item failures included.
  test("a user request is answered with one reply preserving text order and per-item helper failures", async () => {
    const seen: (readonly string[])[] = [];
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
      error: {
        code: "bad_request",
        msg: 'request_id: Invalid key: Expected "request_id" but received undefined',
      },
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

  test("a batch that is not of strings is refused under its request_id", async () => {
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
      error: {
        code: "invalid_args",
        msg: "texts.1: Invalid type: Expected string but received 42",
      },
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
