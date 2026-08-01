// Validation of the request events the LLM gateway posts, and the per-series
// cache they feed (llm-events.ts). The transport that carries them in is
// webhook.ts's concern and is tested there.
import { describe, expect, test } from "bun:test";
import { LLM_PROMPT_CACHE_TTL_MS } from "@ccmsg/protocol";
import { LlmRequestCache, parseLlmRequestEvent } from "../src/llm-events.ts";

describe("parseLlmRequestEvent", () => {
  test("keeps the fields the countdown and its tooltip need", () => {
    const info = parseLlmRequestEvent({
      ts: 1785564745,
      ts_iso: "2026-08-01T06:12:25Z",
      session_id: "f13ba456",
      ns: "personal",
      model: "claude-fable-5",
      credential: "claude-zunsystem",
      status: 200,
      prefix: "484eda9c",
    });
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
    expect(parseLlmRequestEvent({ ts: 1, session_id: null })).toBeNull();
    expect(parseLlmRequestEvent({ ts: 1, session_id: "" })).toBeNull();
    expect(parseLlmRequestEvent({ session_id: "s" })).toBeNull();
    expect(parseLlmRequestEvent({ ts: "now", session_id: "s" })).toBeNull();
    // A posted batch can contain anything at all once a producer has a bug.
    expect(parseLlmRequestEvent("not an object")).toBeNull();
    expect(parseLlmRequestEvent([1, 2])).toBeNull();
    expect(parseLlmRequestEvent(null)).toBeNull();
  });

  test("an event from a pre-prefix gateway lands in the unnamed series", () => {
    // Gateways before v0.13.0 report no prefix. "" keeps them working as one
    // series per session, which is what ccmsg did before prefixes existed.
    const info = parseLlmRequestEvent({ ts: 1, session_id: "s" });
    expect(info).toEqual({ ts: 1, session_id: "s", prefix: "" });
    // A malformed prefix degrades the same way rather than dropping a usable
    // timestamp on the floor.
    expect(parseLlmRequestEvent({ ts: 1, session_id: "s", prefix: 7 })).toEqual({
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

    test("loses main to the session's own series", () => {
      const cache = new LlmRequestCache();
      cache.record({ ts: sec(200_000), session_id: "a", prefix: SUB });
      cache.record({ ts: sec(1_000), session_id: "a", prefix: MAIN });
      // Arrival order alone would keep SUB (seen first).
      expect(cache.snapshot(NOW).find((r) => r.main)?.prefix).toBe(SUB);
      // Seeing SUB under a second session proves it is a subagent's, so a's
      // own series takes over even though it arrived later.
      cache.record({ ts: sec(190_000), session_id: "b", prefix: SUB });
      const snapshot = cache.snapshot(NOW);
      expect(snapshot.filter((r) => r.session_id === "a" && r.main)).toEqual([
        { ts: sec(1_000), session_id: "a", prefix: MAIN, main: true },
      ]);
    });

    // The sharing rule's blind spot: two sessions on the same cwd of the same
    // repo build the same leading system block, so their real main series
    // share a prefix. Disqualifying both would leave both rings dark forever.
    test("still counts as main when it is all the session has", () => {
      const cache = new LlmRequestCache();
      cache.record({ ts: sec(200_000), session_id: "a", prefix: SUB });
      cache.record({ ts: sec(1_000), session_id: "b", prefix: SUB });
      const snapshot = cache.snapshot(NOW);
      expect(snapshot.every((r) => r.main)).toBe(true);
      // Each session falls back to its OWN latest request, not the other's.
      expect(snapshot.find((r) => r.session_id === "a")?.ts).toBe(sec(200_000));
      expect(snapshot.find((r) => r.session_id === "b")?.ts).toBe(sec(1_000));
    });

    test("the fallback picks the session's most recent series", () => {
      const cache = new LlmRequestCache();
      const other = "11112222";
      // Both of a's series are shared with b, so neither survives the
      // sharing filter and the tiebreak is recency, not arrival order.
      cache.record({ ts: sec(200_000), session_id: "a", prefix: SUB });
      cache.record({ ts: sec(1_000), session_id: "a", prefix: other });
      cache.record({ ts: sec(150_000), session_id: "b", prefix: SUB });
      cache.record({ ts: sec(150_000), session_id: "b", prefix: other });
      const mains = cache.snapshot(NOW).filter((r) => r.session_id === "a" && r.main);
      expect(mains).toEqual([{ ts: sec(1_000), session_id: "a", prefix: other, main: true }]);
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

  // Both gateway processes (stable and unstable) may report the same call, so
  // the same event can arrive twice and nothing upstream dedups it. This rule
  // is what makes the redelivery harmless.
  test("a redelivered event changes nothing", () => {
    const cache = new LlmRequestCache();
    const event = { ts: sec(10_000), session_id: "a", prefix: MAIN };
    cache.record(event);
    cache.record({ ...event });
    expect(cache.snapshot(NOW)).toEqual([
      { ts: sec(10_000), session_id: "a", prefix: MAIN, main: true },
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
