import { describe, expect, test } from "bun:test";
import { touchSessionViewCache, type CachedSessionView } from "../src/client/session-view-cache.ts";

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
});
