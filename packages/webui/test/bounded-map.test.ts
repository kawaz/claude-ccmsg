import { describe, expect, test } from "bun:test";
import { setBounded } from "../src/client/bounded-map.ts";

const keysOf = (map: Map<string, number>) => [...map.keys()];

describe("bounded map", () => {
  test("keeps entries until the limit is exceeded", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    expect(keysOf(map)).toEqual(["a", "b"]);
  });

  test("drops the least recently written entry first", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "c", 3, 2);
    expect(keysOf(map)).toEqual(["b", "c"]);
  });

  test("rewriting a key refreshes its recency", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "a", 9, 2);
    setBounded(map, "c", 3, 2);
    // "b" is now the stale one even though "a" was inserted first.
    expect(keysOf(map)).toEqual(["a", "c"]);
    expect(map.get("a")).toBe(9);
  });

  test("a rewrite at the limit evicts nothing", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 2);
    setBounded(map, "b", 2, 2);
    setBounded(map, "b", 3, 2);
    expect(keysOf(map)).toEqual(["a", "b"]);
  });

  test("a limit below one leaves the map empty", () => {
    const map = new Map<string, number>();
    setBounded(map, "a", 1, 0);
    expect(map.size).toBe(0);
  });
});
