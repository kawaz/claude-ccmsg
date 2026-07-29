import { describe, expect, test } from "bun:test";
import {
  evictedSessionViewSids,
  skipInactiveSessionViewRender,
  touchSessionViewCache,
  type CachedSessionView,
} from "../src/client/session-view-cache.ts";

const entry = (sid: string, tab: CachedSessionView["tab"] = "timeline"): CachedSessionView => ({
  sid,
  tab,
  agent: null,
});

describe("hidden session view render bailout", () => {
  // Hidden DOM is retained solely for instant restoration. Store updates while
  // both renders are hidden must not rebuild it, while activation/deactivation
  // edges must render so visibility and catch-up effects change ownership.
  test("skips only inactive-to-inactive updates", () => {
    expect(skipInactiveSessionViewRender(false, false)).toBe(true);
    expect(skipInactiveSessionViewRender(false, true)).toBe(false);
    expect(skipInactiveSessionViewRender(true, false)).toBe(false);
    expect(skipInactiveSessionViewRender(true, true)).toBe(false);
  });
});

describe("session view LRU cache", () => {
  test("touching a new session appends it as most recently used", () => {
    expect(touchSessionViewCache([entry("s1")], entry("s2"), 3).map((item) => item.sid)).toEqual([
      "s1",
      "s2",
    ]);
  });

  test("revisiting a session updates its locator snapshot and moves it to the MRU end", () => {
    const next = touchSessionViewCache([entry("s1"), entry("s2")], entry("s1", "files"), 3);
    expect(next.map((item) => `${item.sid}:${item.tab}`)).toEqual(["s2:timeline", "s1:files"]);
  });

  test("the least recently used session is evicted when the DOM retention limit is exceeded", () => {
    const next = touchSessionViewCache([entry("s1"), entry("s2"), entry("s3")], entry("s4"), 3);
    expect(next.map((item) => item.sid)).toEqual(["s2", "s3", "s4"]);
  });

  test("a zero limit retains no session DOM", () => {
    expect(touchSessionViewCache([entry("s1")], entry("s2"), 0)).toEqual([]);
  });
});

describe("session view eviction", () => {
  test("reports the sessions the LRU pushed out", () => {
    const previous = [entry("s1"), entry("s2"), entry("s3")];
    const next = touchSessionViewCache(previous, entry("s4"), 3);
    expect(evictedSessionViewSids(previous, next)).toEqual(["s1"]);
  });

  test("reports nothing while the cache still has room", () => {
    const previous = [entry("s1")];
    expect(
      evictedSessionViewSids(previous, touchSessionViewCache(previous, entry("s2"), 3)),
    ).toEqual([]);
  });

  test("re-visiting a cached session evicts no one", () => {
    // s1 moves to the most-recent end rather than leaving the cache — its
    // transcript is still mounted and must not be dropped.
    const previous = [entry("s1"), entry("s2"), entry("s3")];
    expect(
      evictedSessionViewSids(previous, touchSessionViewCache(previous, entry("s1"), 3)),
    ).toEqual([]);
  });

  test("a shrunk limit reports every session it dropped", () => {
    const previous = [entry("s1"), entry("s2"), entry("s3")];
    expect(
      evictedSessionViewSids(previous, touchSessionViewCache(previous, entry("s4"), 1)),
    ).toEqual(["s1", "s2", "s3"]);
  });
});
