import { describe, expect, test } from "bun:test";
import { lineDiff } from "../src/client/inline-file-model.ts";

describe("lineDiff", () => {
  test("keeps common lines and marks one replacement as delete/add", () => {
    expect(lineDiff("a\nold\nz\n", "a\nnew\nz\n")).toEqual([
      { kind: "same", text: "a" },
      { kind: "delete", text: "old" },
      { kind: "add", text: "new" },
      { kind: "same", text: "z" },
    ]);
  });

  test("handles empty old and new content", () => {
    expect(lineDiff("", "a\n")).toEqual([{ kind: "add", text: "a" }]);
    expect(lineDiff("a\n", "")).toEqual([{ kind: "delete", text: "a" }]);
  });
});
