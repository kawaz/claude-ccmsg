// Placing permission bubbles in the rendered group list (permit-merge.ts). A
// request for permission is not a transcript row, so its only anchor is
// wall-clock time.
import { describe, expect, test } from "bun:test";
import { defined } from "./helpers.ts";
import { permitSlots } from "../src/client/permit-merge.ts";
import type { FoldEntries, ParsedLine, TimelineGroup } from "../src/client/transcript-model.ts";

function turn(ts: string | null): ParsedLine {
  return { kind: "turn", ts, role: "user", segments: [] };
}

function entry(offset: number, line: ParsedLine): TimelineGroup {
  return { kind: "entry", offset, line };
}

function fold(...entries: FoldEntries): TimelineGroup {
  return { kind: "fold", entries };
}

function request(ts: string, n: number): { id: string; ts: string } {
  return { id: `p${n}`, ts };
}

const GROUPS: TimelineGroup[] = [
  entry(0, turn("2026-08-31T10:00:00.000Z")),
  fold({ offset: 10, line: turn("2026-08-31T10:05:00.000Z") }),
  entry(20, turn("2026-08-31T10:10:00.000Z")),
];

describe("permitSlots", () => {
  test("a request lands before the first group that is newer than it", () => {
    const slots = permitSlots(GROUPS, [request("2026-08-31T10:07:00.000Z", 1)]);
    expect(slots.map((s) => s.length)).toEqual([0, 0, 1, 0]);
  });

  test("a request newer than the whole window trails the transcript", () => {
    // The live case: the turn that asked has not been written to the jsonl yet.
    const slots = permitSlots(GROUPS, [request("2026-08-31T11:00:00.000Z", 2)]);
    expect(defined(slots[3], "slot 3").map((s) => s.id)).toEqual(["p2"]);
  });

  test("a request older than the window sits at the top rather than vanishing", () => {
    const slots = permitSlots(GROUPS, [request("2026-08-31T09:00:00.000Z", 3)]);
    expect(defined(slots[0], "slot 0").map((s) => s.id)).toEqual(["p3"]);
  });

  test("several requests in one slot keep chronological order", () => {
    const slots = permitSlots(GROUPS, [
      request("2026-08-31T10:08:00.000Z", 5),
      request("2026-08-31T10:06:00.000Z", 4),
    ]);
    expect(defined(slots[2], "slot 2").map((s) => s.id)).toEqual(["p4", "p5"]);
  });

  test("two requests sharing a stamp keep the order they came in", () => {
    const slots = permitSlots(GROUPS, [
      request("2026-08-31T10:06:00.000Z", 8),
      request("2026-08-31T10:06:00.000Z", 7),
    ]);
    expect(defined(slots[2], "slot 2").map((s) => s.id)).toEqual(["p8", "p7"]);
  });

  test("unstamped groups are transparent, not boundaries", () => {
    const groups: TimelineGroup[] = [
      entry(0, turn(null)),
      entry(10, turn("2026-08-31T10:00:00.000Z")),
    ];
    const slots = permitSlots(groups, [request("2026-08-31T09:59:00.000Z", 6)]);
    expect(slots.map((s) => s.length)).toEqual([0, 1, 0]);
  });

  test("no requests leaves one empty slot per group boundary", () => {
    expect(permitSlots(GROUPS, [])).toEqual([[], [], [], []]);
  });
});
