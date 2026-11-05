import { describe, expect, test } from "bun:test";
import {
  sessionViewMountOrder,
  touchSessionViewCache,
  type CachedSessionView,
} from "../src/client/session-view-cache.ts";

const entry = (sid: string, tab: CachedSessionView["tab"] = "timeline"): CachedSessionView => ({
  sid,
  tab,
  agent: null,
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

  // App holds the cache in state and touches it on every render: an unchanged
  // cache has to come back as the same array, or that render would set state
  // again on every pass.
  test("showing the most recent session again hands back the same cache", () => {
    const cache = [entry("s1"), entry("s2")];
    expect(touchSessionViewCache(cache, entry("s2"), 3)).toBe(cache);
    expect(touchSessionViewCache(cache, entry("s2", "files"), 3)).not.toBe(cache);
    expect(touchSessionViewCache(cache, { ...entry("s2"), agent: { agentId: "a1" } }, 3)).not.toBe(
      cache,
    );
    const empty: CachedSessionView[] = [];
    expect(touchSessionViewCache(empty, entry("s1"), 0)).toBe(empty);
  });
});

describe("session view mount order", () => {
  test("is by sid, whatever order the sessions were used in", () => {
    const cache = [entry("s3"), entry("s1"), entry("s2")];
    expect(sessionViewMountOrder(cache).map((item) => item.sid)).toEqual(["s1", "s2", "s3"]);
    expect(cache.map((item) => item.sid)).toEqual(["s3", "s1", "s2"]);
  });

  test("showing a kept session again leaves the mount order as it was", () => {
    const cache = [entry("s1"), entry("s2"), entry("s3")];
    const revisited = touchSessionViewCache(cache, entry("s1"), 3);
    expect(revisited.map((item) => item.sid)).toEqual(["s2", "s3", "s1"]);
    expect(sessionViewMountOrder(revisited).map((item) => item.sid)).toEqual(["s1", "s2", "s3"]);
  });
});
