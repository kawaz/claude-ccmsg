import { describe, expect, test } from "bun:test";
import { reindexStableSelection } from "../src/client/user-nav.ts";

describe("reindexStableSelection", () => {
  test("keeps the selected key when older items are prepended", () => {
    expect(reindexStableSelection(2, ["a", "b", "c"], ["older-1", "older-2", "a", "b", "c"])).toBe(
      4,
    );
  });

  test("keeps the index when items are appended after the selection", () => {
    expect(reindexStableSelection(2, ["a", "b"], ["a", "b", "c"])).toBe(2);
  });

  test("defers to caller policy when the selected key is unavailable", () => {
    expect(reindexStableSelection(0, ["a"], ["a", "b"])).toBeNull();
    expect(reindexStableSelection(1, ["a"], ["replacement"])).toBeNull();
  });
});
