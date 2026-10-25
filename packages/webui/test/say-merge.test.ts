// Placing say bubbles in the rendered group list (say-merge.ts). A say is
// never echoed into the transcript, so its only anchor is wall-clock time.
import { describe, expect, test } from "bun:test";
import { defined } from "./helpers.ts";
import type { SayRecord } from "@ccmsg/protocol";
import { sayReadTargets, saySlots } from "../src/client/say-merge.ts";
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

function say(ts: string, n: number): SayRecord {
  return { id: `i/${n}`, sid: "s1", text: `say ${n}`, ts, read: false };
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
    expect(defined(slots[3], "slot 3").map((s) => s.id)).toEqual(["i/2"]);
  });

  test("a say older than the window sits at the top rather than vanishing", () => {
    const slots = saySlots(GROUPS, [say("2026-08-31T09:00:00.000Z", 3)]);
    expect(defined(slots[0], "slot 0").map((s) => s.id)).toEqual(["i/3"]);
  });

  test("several says in one slot keep chronological order", () => {
    const slots = saySlots(GROUPS, [
      say("2026-08-31T10:08:00.000Z", 5),
      say("2026-08-31T10:06:00.000Z", 4),
    ]);
    expect(defined(slots[2], "slot 2").map((s) => s.id)).toEqual(["i/4", "i/5"]);
  });

  test("two says sharing a stamp keep the order they came in", () => {
    const slots = saySlots(GROUPS, [
      say("2026-08-31T10:06:00.000Z", 8),
      say("2026-08-31T10:06:00.000Z", 7),
    ]);
    expect(defined(slots[2], "slot 2").map((s) => s.id)).toEqual(["i/8", "i/7"]);
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

describe("sayReadTargets", () => {
  const read = (record: SayRecord): SayRecord => ({ ...record, read: true });
  // 届いた順と時刻順が逆の記録を混ぜて、「最新」が TL の描く順で決まることも見る。
  const SAYS: SayRecord[] = [
    say("2026-08-31T10:01:00.000Z", 1),
    say("2026-08-31T10:03:00.000Z", 3),
    say("2026-08-31T10:02:00.000Z", 2),
  ];

  test("the newest unread say's button acks every unread one", () => {
    expect(sayReadTargets(SAYS, "i/3")).toEqual(["i/1", "i/2", "i/3"]);
  });

  test("an older say's button acks that say alone", () => {
    expect(sayReadTargets(SAYS, "i/1")).toEqual(["i/1"]);
    expect(sayReadTargets(SAYS, "i/2")).toEqual(["i/2"]);
  });

  test("read says are left out, and the newest unread one is newest among the unread", () => {
    const says = [
      read(defined(SAYS[0], "i/1")),
      defined(SAYS[2], "i/2"),
      read(defined(SAYS[1], "i/3")),
    ];
    expect(sayReadTargets(says, "i/2")).toEqual(["i/2"]);
  });

  test("a lone unread say acks itself", () => {
    expect(sayReadTargets([say("2026-08-31T10:01:00.000Z", 1)], "i/1")).toEqual(["i/1"]);
  });
});
