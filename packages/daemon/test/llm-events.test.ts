// SSE parsing, the per-session cache, and the reconnect loop of the gateway
// request-event subscription (llm-events.ts). The transport is exercised
// against a local fake gateway rather than a stubbed stream: the failure this
// feature is most likely to hit in practice is "the gateway went away and came
// back", which only a real connect/close cycle reproduces.
import { afterAll, describe, expect, test } from "bun:test";
import { LLM_PROMPT_CACHE_TTL_MS } from "@ccmsg/protocol";
import {
  LlmRequestCache,
  SseParser,
  backoffDelayMs,
  parseLlmRequestEvent,
  startLlmEventClient,
} from "../src/llm-events.ts";

const T = 15000;
const SILENT = { info() {}, error() {} };

describe("SseParser", () => {
  test("dispatches one event per blank line, with event and data", () => {
    const p = new SseParser();
    expect(p.feed('event: request\ndata: {"a":1}\n\n')).toEqual([
      { event: "request", data: '{"a":1}' },
    ]);
  });

  test("a frame split across chunks dispatches once, whole", () => {
    const p = new SseParser();
    // Split mid-field name, mid-value, and just before the dispatching blank
    // line — the three boundaries a real socket read can land on.
    expect(p.feed("eve")).toEqual([]);
    expect(p.feed('nt: request\ndata: {"ts":1,')).toEqual([]);
    expect(p.feed('"session_id":"s"}\n')).toEqual([]);
    expect(p.feed("\n")).toEqual([{ event: "request", data: '{"ts":1,"session_id":"s"}' }]);
  });

  test("multiple events in one chunk come back in order", () => {
    const p = new SseParser();
    const events = p.feed("event: request\ndata: 1\n\nevent: request\ndata: 2\n\n");
    expect(events.map((e) => e.data)).toEqual(["1", "2"]);
  });

  test("comment lines (the gateway's keepalive) yield nothing", () => {
    const p = new SseParser();
    expect(p.feed(": keepalive\n\n")).toEqual([]);
    // ...and do not disturb a following real event.
    expect(p.feed(": ping\nevent: request\ndata: x\n\n")).toEqual([
      { event: "request", data: "x" },
    ]);
  });

  test("CRLF terminators parse like LF", () => {
    const p = new SseParser();
    expect(p.feed("event: request\r\ndata: x\r\n\r\n")).toEqual([{ event: "request", data: "x" }]);
  });

  test("multi-line data joins with newlines, and event defaults to message", () => {
    const p = new SseParser();
    expect(p.feed("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
  });

  test("a value with no leading space keeps every character after the colon", () => {
    const p = new SseParser();
    expect(p.feed('event:request\ndata:{"k":"v"}\n\n')).toEqual([
      { event: "request", data: '{"k":"v"}' },
    ]);
  });
});

describe("parseLlmRequestEvent", () => {
  test("keeps the fields the countdown and its tooltip need", () => {
    const info = parseLlmRequestEvent(
      JSON.stringify({
        ts: 1785564745,
        ts_iso: "2026-08-01T06:12:25Z",
        session_id: "f13ba456",
        ns: "personal",
        model: "claude-fable-5",
        credential: "claude-zunsystem",
        status: 200,
        prefix: "484eda9c",
      }),
    );
    expect(info).toEqual({
      ts: 1785564745,
      session_id: "f13ba456",
      prefix: "484eda9c",
      ns: "personal",
      model: "claude-fable-5",
      credential: "claude-zunsystem",
      status: 200,
    });
  });

  test("drops what cannot be attached to a session row or placed in time", () => {
    // session_id: null is the gateway's own shape for a client that sent no
    // session header — the single most common event this must ignore.
    expect(parseLlmRequestEvent(JSON.stringify({ ts: 1, session_id: null }))).toBeNull();
    expect(parseLlmRequestEvent(JSON.stringify({ ts: 1, session_id: "" }))).toBeNull();
    expect(parseLlmRequestEvent(JSON.stringify({ session_id: "s" }))).toBeNull();
    expect(parseLlmRequestEvent(JSON.stringify({ ts: "now", session_id: "s" }))).toBeNull();
    expect(parseLlmRequestEvent("not json")).toBeNull();
    expect(parseLlmRequestEvent("[1,2]")).toBeNull();
  });

  test("an event from a pre-prefix gateway lands in the unnamed series", () => {
    // Gateways before v0.13.0 report no prefix. "" keeps them working as one
    // series per session, which is what ccmsg did before prefixes existed.
    const info = parseLlmRequestEvent(JSON.stringify({ ts: 1, session_id: "s" }));
    expect(info).toEqual({ ts: 1, session_id: "s", prefix: "" });
    // A malformed prefix degrades the same way rather than dropping a usable
    // timestamp on the floor.
    expect(parseLlmRequestEvent(JSON.stringify({ ts: 1, session_id: "s", prefix: 7 }))).toEqual({
      ts: 1,
      session_id: "s",
      prefix: "",
    });
  });
});

describe("LlmRequestCache", () => {
  const NOW = 2_000_000_000_000;
  const sec = (ms: number): number => (NOW - ms) / 1000;
  /** A session's own series and one of its subagents': same sid, different
   * system prompt, therefore different cache entries upstream. */
  const MAIN = "484eda9c";
  const SUB = "9c31aa02";

  test("keeps the latest request per series", () => {
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(60_000), session_id: "a", prefix: MAIN });
    cache.record({ ts: sec(10_000), session_id: "a", prefix: MAIN });
    expect(cache.snapshot(NOW)).toEqual([
      { ts: sec(10_000), session_id: "a", prefix: MAIN, main: true },
    ]);
  });

  test("an out-of-order (older) event never rewinds the countdown", () => {
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(10_000), session_id: "a", prefix: MAIN });
    cache.record({ ts: sec(60_000), session_id: "a", prefix: MAIN });
    expect(cache.snapshot(NOW)[0]?.ts).toBe(sec(10_000));
  });

  // The whole point of the (sid, prefix) key: a subagent's traffic must not
  // touch the session's own window, or the ring would restart every time a
  // subagent ran while the session itself sat idle.
  test("a subagent's request is a separate series and leaves main's ts alone", () => {
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(200_000), session_id: "a", prefix: MAIN });
    cache.record({ ts: sec(1_000), session_id: "a", prefix: SUB });
    const snapshot = cache.snapshot(NOW);
    expect(snapshot).toHaveLength(2);
    expect(snapshot.find((r) => r.main)).toEqual({
      ts: sec(200_000),
      session_id: "a",
      prefix: MAIN,
      main: true,
    });
    expect(snapshot.find((r) => !r.main)?.prefix).toBe(SUB);
  });

  test("the first series seen for a session becomes its main one", () => {
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(1_000), session_id: "a", prefix: SUB });
    cache.record({ ts: sec(500), session_id: "a", prefix: MAIN });
    // With nothing yet distinguishing them, arrival order is the only
    // evidence available.
    expect(cache.snapshot(NOW).find((r) => r.main)?.prefix).toBe(SUB);
  });

  test("a live main is not displaced by later series from the same session", () => {
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(1_000), session_id: "a", prefix: MAIN });
    for (let i = 0; i < 5; i++) {
      cache.record({ ts: sec(500 - i), session_id: "a", prefix: SUB });
    }
    expect(cache.snapshot(NOW).find((r) => r.main)?.prefix).toBe(MAIN);
  });

  test("main is re-learned once the incumbent series goes cold", () => {
    // A session whose system prompt changes gets a new prefix. If main stayed
    // pinned to the dead one, that session's ring would never move again.
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(LLM_PROMPT_CACHE_TTL_MS + 1_000), session_id: "a", prefix: MAIN });
    cache.record({ ts: sec(1_000), session_id: "a", prefix: SUB });
    expect(cache.snapshot(NOW)).toEqual([
      { ts: sec(1_000), session_id: "a", prefix: SUB, main: true },
    ]);
  });

  // Observed upstream: a main series' system prompt carries cwd + git status,
  // so it cannot appear under a second session — but subagent prompts do,
  // verbatim. Seeing one prefix under two sessions is therefore proof it is a
  // subagent's, and it is the signal that corrects a bad early guess.
  describe("a prefix seen under two sessions", () => {
    test("keeps each session's window separate", () => {
      const cache = new LlmRequestCache();
      cache.record({ ts: sec(200_000), session_id: "a", prefix: SUB });
      cache.record({ ts: sec(1_000), session_id: "b", prefix: SUB });
      const snapshot = cache.snapshot(NOW);
      expect(snapshot).toHaveLength(2);
      expect(snapshot.map((r) => r.ts)).toEqual([sec(200_000), sec(1_000)]);
    });

    test("is demoted out of main, in both sessions", () => {
      const cache = new LlmRequestCache();
      cache.record({ ts: sec(200_000), session_id: "a", prefix: SUB });
      // Until it recurs, session a has no reason to doubt it.
      expect(cache.snapshot(NOW).find((r) => r.main)?.prefix).toBe(SUB);
      cache.record({ ts: sec(1_000), session_id: "b", prefix: SUB });
      // Now it is provably a subagent's, and neither session claims it.
      expect(cache.snapshot(NOW).some((r) => r.main)).toBe(false);
    });

    test("hands main to the session's own series once one appears", () => {
      const cache = new LlmRequestCache();
      // Daemon started mid-subagent: the first thing it saw was subagent
      // traffic, which it took for session a's main series.
      cache.record({ ts: sec(200_000), session_id: "a", prefix: SUB });
      cache.record({ ts: sec(190_000), session_id: "b", prefix: SUB });
      cache.record({ ts: sec(1_000), session_id: "a", prefix: MAIN });
      const snapshot = cache.snapshot(NOW);
      // MAIN arrived last, but SUB is disqualified, so MAIN takes the slot
      // even though the arrival-order rule alone would have kept SUB.
      expect(snapshot.find((r) => r.main)).toEqual({
        ts: sec(1_000),
        session_id: "a",
        prefix: MAIN,
        main: true,
      });
      expect(snapshot.filter((r) => r.main)).toHaveLength(1);
    });
  });

  test("events without a prefix collapse into one series per session", () => {
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(60_000), session_id: "a", prefix: "" });
    cache.record({ ts: sec(10_000), session_id: "a", prefix: "" });
    expect(cache.snapshot(NOW)).toEqual([
      { ts: sec(10_000), session_id: "a", prefix: "", main: true },
    ]);
  });

  test("the empty prefix is never treated as shared across sessions", () => {
    // Every session on a pre-v0.13.0 gateway reports "", so the sharing rule
    // would disqualify all of them and no session would ever get a ring.
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(1_000), session_id: "a", prefix: "" });
    cache.record({ ts: sec(1_000), session_id: "b", prefix: "" });
    expect(cache.snapshot(NOW).every((r) => r.main)).toBe(true);
  });

  test("snapshot drops entries past the TTL and keeps the rest", () => {
    const cache = new LlmRequestCache();
    cache.record({ ts: sec(LLM_PROMPT_CACHE_TTL_MS + 1000), session_id: "expired", prefix: MAIN });
    cache.record({ ts: sec(LLM_PROMPT_CACHE_TTL_MS - 1000), session_id: "live", prefix: MAIN });
    expect(cache.snapshot(NOW).map((r) => r.session_id)).toEqual(["live"]);
    // The expired entry is pruned, not merely filtered: a later snapshot taken
    // at a time when it would look live again must not resurrect it.
    expect(cache.snapshot(NOW - LLM_PROMPT_CACHE_TTL_MS).map((r) => r.session_id)).toEqual([
      "live",
    ]);
  });

  test("a clock-skewed future timestamp cannot grow the cache without bound", () => {
    const cache = new LlmRequestCache();
    const future = NOW / 1000 + 86_400;
    for (let i = 0; i < 600; i++) {
      cache.record({ ts: future, session_id: `s${i}`, prefix: `p${i}` });
    }
    const snapshot = cache.snapshot(NOW);
    expect(snapshot.length).toBe(500);
    // Eviction drops the least-recently-seen series, so the newest survive.
    expect(snapshot.at(-1)?.session_id).toBe("s599");
  });
});

describe("backoffDelayMs", () => {
  test("doubles from 1s and stops at 30s", () => {
    expect([0, 1, 2, 3, 4, 5, 6].map(backoffDelayMs)).toEqual([
      1000, 2000, 4000, 8000, 16000, 30000, 30000,
    ]);
  });
});

// A fake gateway whose stream can be cut on demand, so the reconnect path is
// driven by an actual dropped connection.
const PORT = 18961;
let openStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
let connects = 0;
const gateway = Bun.serve({
  port: PORT,
  fetch(req) {
    const url = new URL(req.url);
    if (url.pathname !== "/events") return new Response("no such endpoint", { status: 404 });
    connects += 1;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        openStreams.push(controller);
        controller.enqueue(new TextEncoder().encode(": hello\n\n"));
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
afterAll(() => {
  void gateway.stop(true);
});

function emit(payload: unknown): void {
  const frame = `event: request\ndata: ${JSON.stringify(payload)}\n\n`;
  for (const c of openStreams) c.enqueue(new TextEncoder().encode(frame));
}

function cutStreams(): void {
  for (const c of openStreams) {
    try {
      c.close();
    } catch {
      // already closed
    }
  }
  openStreams = [];
}

/** Resolve once `pred` holds, driven by the client's own callback — no sleep
 * guessing at how long a delivery takes. */
function until<T>(received: T[], pred: (items: T[]) => boolean): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (pred(received)) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

describe("startLlmEventClient", () => {
  test(
    "delivers request events from a live stream",
    async () => {
      const got: string[] = [];
      const client = startLlmEventClient({
        url: `http://127.0.0.1:${PORT}/events`,
        log: SILENT,
        onRequest: (info) => got.push(info.session_id),
      });
      try {
        await until(openStreams, (s) => s.length > 0);
        emit({ ts: 1, session_id: "a" });
        emit({ ts: 2, session_id: null }); // unattributable: dropped, not delivered
        emit({ ts: 3, session_id: "b" });
        await until(got, (g) => g.length === 2);
        expect(got).toEqual(["a", "b"]);
      } finally {
        client.stop();
        cutStreams();
      }
    },
    T,
  );

  test(
    "reconnects after the gateway drops the stream",
    async () => {
      const got: string[] = [];
      const before = connects;
      const client = startLlmEventClient({
        url: `http://127.0.0.1:${PORT}/events`,
        log: SILENT,
        onRequest: (info) => got.push(info.session_id),
        // Collapse the wait: the schedule itself is covered by the
        // backoffDelayMs test, and this one is about the loop resuming.
        delayMs: () => 5,
      });
      try {
        await until(openStreams, (s) => s.length > 0);
        emit({ ts: 1, session_id: "before" });
        await until(got, (g) => g.length === 1);
        cutStreams();
        await until([], () => connects >= before + 2);
        emit({ ts: 2, session_id: "after" });
        await until(got, (g) => g.length === 2);
        expect(got).toEqual(["before", "after"]);
      } finally {
        client.stop();
        cutStreams();
      }
    },
    T,
  );

  test(
    "silence past the idle budget is treated as a dead connection and reconnected",
    async () => {
      // The gateway keepalives every 20s, so 40s of nothing means the socket
      // is gone — and a half-open socket never raises an error on its own,
      // which is why this timeout is the only thing that would ever notice.
      const got: string[] = [];
      const errors: string[] = [];
      const before = connects;
      const client = startLlmEventClient({
        url: `http://127.0.0.1:${PORT}/events`,
        log: { info() {}, error: (m) => errors.push(m) },
        onRequest: (info) => got.push(info.session_id),
        delayMs: () => 5,
        // The fake gateway holds its stream open and silent after the initial
        // comment, which is precisely the half-open case, at test speed.
        idleTimeoutMs: 60,
      });
      try {
        await until([], () => connects >= before + 2);
        expect(errors.some((e) => e.includes("no data for 60ms"))).toBe(true);
        // The reconnected stream is live: an event on it still gets through.
        emit({ ts: 1, session_id: "after-idle" });
        await until(got, (g) => g.includes("after-idle"));
      } finally {
        client.stop();
        cutStreams();
      }
    },
    T,
  );

  test(
    "an unreachable gateway retries instead of throwing, and stop() ends it",
    async () => {
      const errors: string[] = [];
      const client = startLlmEventClient({
        url: `http://127.0.0.1:${PORT}/typo`, // 404s: same loop as a refused connection
        log: { info() {}, error: (m) => errors.push(m) },
        onRequest: () => {},
        delayMs: () => 5,
      });
      await until(errors, (e) => e.length >= 2);
      expect(errors[0]).toContain("HTTP 404");
      client.stop();
      const seen = errors.length;
      // stop() must actually end the loop: no further retry lines after a
      // window several retry intervals wide.
      await new Promise((r) => setTimeout(r, 100));
      expect(errors.length).toBe(seen);
    },
    T,
  );
});
