// The relay's decisions, driven through injected deps so each verdict
// (deliver / drop) is observed directly rather than inferred from a daemon's
// side effects. The wiring itself is covered end-to-end in
// cache-keepalive-relay.test.ts.
import { describe, expect, test } from "bun:test";
import {
  isCacheKeepaliveItem,
  parseCacheKeepaliveEvent,
  relayCacheKeepalive,
  type CacheKeepaliveEvent,
} from "../src/cache-keepalive.ts";

const MARKER = "[llm-gateway cache keepalive nonce=n1]";

/** Wall clock the relay reads, pinned rather than real — a deadline test that
 * waited out a real one would either be slow or racy. */
function harness(options: { subscribed?: boolean } = {}) {
  const state = {
    subscribed: options.subscribed ?? true,
    now: 1_000_000,
    delivered: [] as { sid: string; text: string }[],
    logs: [] as string[],
  };
  const relay = (event: CacheKeepaliveEvent): void =>
    relayCacheKeepalive(event, {
      deliver: (sid: string, text: string) => {
        if (!state.subscribed) return 0;
        state.delivered.push({ sid, text });
        return 1;
      },
      log: { info: (msg: string) => state.logs.push(msg) },
      now: () => state.now,
    });
  return { relay, state };
}

/** Deadline `secondsAhead` from the harness's current clock. */
function event(now: number, secondsAhead: number, over: Partial<CacheKeepaliveEvent> = {}) {
  return {
    session_id: "S1",
    marker: MARKER,
    deadline: Math.floor(now / 1000) + secondsAhead,
    nonce: "n1",
    ...over,
  };
}

describe("parseCacheKeepaliveEvent", () => {
  const base = {
    type: "cache_keepalive",
    session_id: "S1",
    prefix: "484eda9c",
    nonce: "n1",
    deadline: 1_788_333_834,
    deadline_iso: "2026-09-03T00:00:00.000Z",
    marker: MARKER,
    ts: 1_788_333_774,
    ts_iso: "2026-09-03T00:00:00.000Z",
  };

  test("accepts the gateway's payload and keeps only what decides anything", () => {
    expect(parseCacheKeepaliveEvent(base)).toEqual({
      session_id: "S1",
      marker: MARKER,
      deadline: 1_788_333_834,
      nonce: "n1",
    });
  });

  test("rejects an item missing any field a decision depends on", () => {
    for (const missing of ["session_id", "marker", "deadline"] as const) {
      const broken: Record<string, unknown> = { ...base };
      delete broken[missing];
      expect(parseCacheKeepaliveEvent(broken)).toBeNull();
    }
    expect(parseCacheKeepaliveEvent({ ...base, session_id: "" })).toBeNull();
    expect(parseCacheKeepaliveEvent({ ...base, marker: "" })).toBeNull();
    expect(parseCacheKeepaliveEvent({ ...base, deadline: "soon" })).toBeNull();
  });

  test("a nonce-less item still parses — the nonce is only ever logged", () => {
    const { nonce: _drop, ...noNonce } = base;
    expect(parseCacheKeepaliveEvent(noNonce)?.nonce).toBe("");
  });

  test("isCacheKeepaliveItem admits a malformed keepalive, so it never falls through", () => {
    // The routing question ("is this claiming to be a keepalive?") has to be
    // answerable before validation: an item that answers yes and then fails to
    // parse must be dropped, not handed to the request-event parser, whose
    // fields it also happens to carry.
    const malformed = { type: "cache_keepalive", session_id: "S1", ts: base.ts };
    expect(isCacheKeepaliveItem(malformed)).toBe(true);
    expect(parseCacheKeepaliveEvent(malformed)).toBeNull();
    expect(isCacheKeepaliveItem({ ts: 1, session_id: "S1" })).toBe(false);
    expect(isCacheKeepaliveItem(null)).toBe(false);
    expect(isCacheKeepaliveItem([{ type: "cache_keepalive" }])).toBe(false);
  });
});

describe("relayCacheKeepalive", () => {
  test("a marker within its deadline goes straight to the session, verbatim", () => {
    const { relay, state } = harness();
    relay(event(state.now, 60));
    expect(state.delivered).toEqual([{ sid: "S1", text: MARKER }]);
  });

  test("nothing is added to or trimmed from the marker text", () => {
    // The gateway matches this string back on the request it is waiting for,
    // so any decoration would both break that match and risk pushing the
    // marker past a notification's truncation point.
    const { relay, state } = harness();
    const odd = "  [llm-gateway cache keepalive nonce=abc]\nsecond line  ";
    relay(event(state.now, 60, { marker: odd }));
    expect(state.delivered[0]?.text).toBe(odd);
  });

  test("a marker whose deadline has already passed is never delivered", () => {
    const { relay, state } = harness();
    relay(event(state.now, -1));
    expect(state.delivered).toEqual([]);
    expect(state.logs.some((l) => l.includes("deadline already passed"))).toBe(true);
  });

  test("a deadline landing exactly now is already too late", () => {
    const { relay, state } = harness();
    relay({ ...event(state.now, 0), deadline: state.now / 1000 });
    expect(state.delivered).toEqual([]);
  });

  test("a session with no subscribe stream is logged, not retried", () => {
    const { relay, state } = harness({ subscribed: false });
    relay(event(state.now, 60));
    expect(state.delivered).toEqual([]);
    expect(state.logs.some((l) => l.includes("not subscribed"))).toBe(true);
  });

  test("the log line names the nonce so two keepalives can be told apart", () => {
    const { relay, state } = harness();
    relay(event(state.now, 60, { nonce: "n-second" }));
    expect(state.logs.some((l) => l.includes("n-second") && l.includes("delivered"))).toBe(true);
  });
});
