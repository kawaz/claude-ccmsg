// Where a fork cuts the resumed conversation (fork-point.ts). The rule under
// test is docs/findings/2026-08-11-checkpoint-rewind.md §6: `--resume-session-at`
// keeps the named record, so re-doing a user turn means naming the assistant
// record BEFORE it.
import { describe, expect, test } from "bun:test";
import { forkActionState, forkPointUuid, userNavKeyOffset } from "../src/client/fork-point.ts";
import type { ParsedLine } from "../src/client/transcript-model.ts";

function turn(role: "user" | "assistant", uuid?: string): ParsedLine {
  return { kind: "turn", ts: null, role, segments: [], ...(uuid ? { uuid } : {}) };
}

/** A two-round conversation: user/assistant, then a tool-result-ish user line,
 * then the second user prompt at offset 40. */
const LINES: ParsedLine[] = [
  turn("user", "u-1"),
  turn("assistant", "a-1"),
  turn("assistant", "a-2"),
  turn("user", "u-2"),
];
const OFFSETS = [0, 10, 20, 40];

describe("userNavKeyOffset", () => {
  test("reads the offset out of both nav key shapes", () => {
    expect(userNavKeyOffset("user:40")).toBe(40);
    expect(userNavKeyOffset("ccmsg:40:2")).toBe(40);
  });

  test("null for anything that isn't a nav key", () => {
    expect(userNavKeyOffset("search:40")).toBeNull();
    expect(userNavKeyOffset("user:")).toBeNull();
  });
});

describe("forkPointUuid", () => {
  // The cut point is the assistant record immediately before the turn, so the
  // forked session ends with that answer and the user turn is gone.
  test("returns the nearest preceding assistant record", () => {
    expect(forkPointUuid(LINES, OFFSETS, 40)).toBe("a-2");
  });

  // Nothing before the first user turn can be cut at — the fork would have no
  // conversation to resume.
  test("undefined at the first turn of the loaded window", () => {
    expect(forkPointUuid(LINES, OFFSETS, 0)).toBeUndefined();
  });

  // A record without a uuid cannot be named on the command line, so the search
  // keeps walking back to one that can.
  test("skips assistant records that carry no uuid", () => {
    const lines = [turn("assistant", "a-1"), turn("assistant"), turn("user", "u-2")];
    expect(forkPointUuid(lines, [0, 10, 20], 20)).toBe("a-1");
  });

  test("undefined for an offset outside the loaded window", () => {
    expect(forkPointUuid(LINES, OFFSETS, 999)).toBeUndefined();
  });
});

describe("forkActionState", () => {
  test("ready carries the resolved fork point", () => {
    expect(forkActionState("user:40", LINES, OFFSETS)).toEqual({ kind: "ready", resumeAt: "a-2" });
  });

  // The three not-ready cases stay distinct: the panel says something
  // different for each (pick a turn / load older).
  test("no-selection when nothing is selected", () => {
    expect(forkActionState(undefined, LINES, OFFSETS)).toEqual({ kind: "no-selection" });
  });

  test("no-fork-point when the selected turn has nothing before it", () => {
    expect(forkActionState("user:0", LINES, OFFSETS)).toEqual({ kind: "no-fork-point" });
  });
});
