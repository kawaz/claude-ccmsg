// Placing say bubbles in the rendered group list (say-merge.ts). A say is
// never echoed into the transcript, so its only anchor is wall-clock time.
import { describe, expect, test } from "bun:test";
import type { SayEvent } from "@ccmsg/protocol";
import { saySlots } from "../src/client/say-merge.ts";
import type { ParsedLine, TimelineGroup } from "../src/client/transcript-model.ts";

function turn(ts: string | null): ParsedLine {
  return { kind: "turn", ts, role: "user", segments: [] };
}

function entry(offset: number, line: ParsedLine): TimelineGroup {
  return { kind: "entry", offset, line };
}

function fold(...lines: { offset: number; line: ParsedLine }[]): TimelineGroup {
  return { kind: "fold", entries: lines };
}

function say(ts: string, seq: number): SayEvent {
  return { type: "say", sid: "s1", text: `say ${seq}`, ts, seq };
}

const GROUPS: TimelineGroup[] = [
  entry(0, turn("2026-08-31T10:00:00.000Z")),
  fold({ offset: 10, line: turn("2026-08-31T10:05:00.000Z") }),
  entry(20, turn("2026-08-31T10:10:00.000Z")),
];

describe("saySlots", () => {
  test("a say lands before the first group that is newer than it", () => {
    const slots = saySlots(GROUPS, [say("2026-08-31T10:07:00.000Z", 1)]);
    expect(slots.map((s) => s.length)).toEqual([0, 0, 1, 0]);
  });

  test("a say newer than the whole window trails the transcript", () => {
    // The live case: the turn that spoke has not been written to the jsonl yet.
    const slots = saySlots(GROUPS, [say("2026-08-31T11:00:00.000Z", 2)]);
    expect(slots[3]!.map((s) => s.seq)).toEqual([2]);
  });

  test("a say older than the window sits at the top rather than vanishing", () => {
    const slots = saySlots(GROUPS, [say("2026-08-31T09:00:00.000Z", 3)]);
    expect(slots[0]!.map((s) => s.seq)).toEqual([3]);
  });

  test("several says in one slot keep chronological order", () => {
    const slots = saySlots(GROUPS, [
      say("2026-08-31T10:08:00.000Z", 5),
      say("2026-08-31T10:06:00.000Z", 4),
    ]);
    expect(slots[2]!.map((s) => s.seq)).toEqual([4, 5]);
  });

  test("unstamped groups are transparent, not boundaries", () => {
    const groups: TimelineGroup[] = [
      entry(0, turn(null)),
      entry(10, turn("2026-08-31T10:00:00.000Z")),
    ];
    const slots = saySlots(groups, [say("2026-08-31T09:59:00.000Z", 6)]);
    expect(slots.map((s) => s.length)).toEqual([0, 1, 0]);
  });

  test("no says leaves one empty slot per group boundary", () => {
    expect(saySlots(GROUPS, [])).toEqual([[], [], [], []]);
  });
});
