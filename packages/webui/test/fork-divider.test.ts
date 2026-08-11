// Placing the fork seam in the rendered group list (fork-divider.ts). The
// daemon names the last COPIED record, so the divider belongs before the group
// that follows it — everything below is history this session made itself.
import { describe, expect, test } from "bun:test";
import { forkDividerGroupIndex } from "../src/client/fork-divider.ts";
import type { ParsedLine, TimelineGroup } from "../src/client/transcript-model.ts";

function turn(role: "user" | "assistant", uuid: string): ParsedLine {
  return { kind: "turn", ts: null, role, segments: [], uuid };
}

function entry(offset: number, line: ParsedLine): TimelineGroup {
  return { kind: "entry", offset, line };
}

function fold(...lines: { offset: number; line: ParsedLine }[]): TimelineGroup {
  return { kind: "fold", entries: lines };
}

const GROUPS: TimelineGroup[] = [
  entry(0, turn("user", "u-1")),
  entry(10, turn("assistant", "a-1")),
  entry(20, turn("user", "u-2")),
];

describe("forkDividerGroupIndex", () => {
  test("the seam goes before the first group of new history", () => {
    expect(forkDividerGroupIndex(GROUPS, "a-1")).toBe(2);
  });

  test("no boundary uuid yet (still resolving, or no seam) draws nothing", () => {
    expect(forkDividerGroupIndex(GROUPS, undefined)).toBeNull();
  });

  test("a boundary outside the loaded window draws nothing", () => {
    // Paging older is what brings it in; guessing a position from a uuid this
    // window has never seen would put the rule in an arbitrary place.
    expect(forkDividerGroupIndex(GROUPS, "u-0")).toBeNull();
  });

  test("a boundary on the last group draws nothing", () => {
    // A rule under the whole transcript separates nothing.
    expect(forkDividerGroupIndex(GROUPS, "u-2")).toBeNull();
  });

  test("a boundary folded into a tool run still places the seam", () => {
    // The last copied record is often a meta/tool row rather than a prompt, and
    // groupTimelineLines sends those into a fold group.
    const groups: TimelineGroup[] = [
      entry(0, turn("user", "u-1")),
      fold(
        { offset: 10, line: turn("assistant", "a-1") },
        { offset: 20, line: turn("user", "t-1") },
      ),
      entry(30, turn("user", "u-2")),
    ];
    expect(forkDividerGroupIndex(groups, "t-1")).toBe(2);
  });

  test("a broken line carries no uuid to match", () => {
    const groups: TimelineGroup[] = [
      { kind: "entry", offset: 0, line: { kind: "broken", raw: "{", error: "bad" } },
      entry(10, turn("user", "u-1")),
    ];
    expect(forkDividerGroupIndex(groups, "u-1")).toBeNull();
  });

  test("an empty window draws nothing", () => {
    expect(forkDividerGroupIndex([], "a-1")).toBeNull();
  });
});
