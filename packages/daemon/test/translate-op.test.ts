import { describe, expect, test } from "bun:test";
import { handleRequest, type Conn, type Daemon } from "../src/server.ts";
import type { TranslateService } from "../src/translate-helper.ts";

function daemonWith(translator: TranslateService): Daemon {
  return {
    translator,
    sessions: new Map(),
    log: { error() {} },
  } as unknown as Daemon;
}

function requestOnce(
  daemon: Daemon,
  identity: Conn["identity"],
  request: unknown,
): Promise<Record<string, any>> {
  return new Promise((resolve) => {
    const conn: Conn = {
      identity,
      subscribed: false,
      write(line) {
        resolve(JSON.parse(line));
      },
    };
    handleRequest(daemon, conn, JSON.stringify(request));
  });
}

describe("translate op", () => {
  test("a user request preserves text order and per-item helper failures", async () => {
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

    const response = await requestOnce(
      daemonWith(translator),
      { role: "user" },
      {
        op: "translate",
        texts: ["first", "second"],
      },
    );
    expect(seen).toEqual([["first", "second"]]);
    expect(response).toEqual({
      ok: true,
      results: [
        { ok: true, text: "一番" },
        { ok: false, error: "TranslationError.notInstalled" },
      ],
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

  test("host/helper unavailability is returned as an explicit protocol error", async () => {
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

    const response = await requestOnce(
      daemonWith(translator),
      { role: "user" },
      {
        op: "translate",
        texts: [],
      },
    );
    expect(response).toEqual({
      ok: false,
      error: {
        code: "translate_unavailable",
        msg: "host translation is available only on macOS",
      },
    });
  });
});
