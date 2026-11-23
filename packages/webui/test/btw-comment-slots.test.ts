// The btw comments of a session's records as the Timeline places them
// (btw-slots.ts placedBtws, DR-0062 §12): a question with its answers, at the
// point it was sent (else where it was written); the unsent ones only for the
// 💬 filter, and none taken back. Then where each stands among the Timeline's
// items (anchoredSlots): after the item holding the row it was sent at, else
// at its time inside the loaded window, else nowhere until older pages bring
// its place in.
import { describe, expect, test } from "bun:test";
import type { BtwAnswer, CommentRecord, UserComment } from "@ccmsg/protocol";
import { anchoredSlots, placedBtws, type PlacedBtw } from "../src/client/btw-slots.ts";
import type { FoldEntries, ParsedLine, TimelineGroup } from "../src/client/transcript-model.ts";

function question(cid: string, patch: Partial<UserComment> = {}): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid,
    session_id: "s1",
    anchor: { kind: "timing" },
    body: cid,
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: "w" },
    sent: { at: "2030-01-01T00:00:01.000Z", after_uuid: "s" },
    updated_at: "v",
    btw: true,
    status: "sent",
    ...patch,
  };
}

function answer(cid: string, to: string): BtwAnswer {
  return {
    kind: "comment",
    author: "btw",
    cid,
    session_id: "s1",
    anchor: { kind: "comment", cid: to },
    body: "",
    written: { at: "2030-01-01T00:00:01.000Z" },
    updated_at: "v",
    status: "failed",
  };
}

describe("placedBtws", () => {
  const records: CommentRecord[] = [
    question("c0001"),
    answer("c0002", "c0001"),
    answer("c0003", "c0001"),
    question("c0004", { status: "draft", sent: undefined }),
    question("c0005", { status: "deleted" }),
    question("c0006", { btw: false }),
  ];

  test("a question sent with its answers in order, at the point it was sent", () => {
    expect(
      placedBtws(records, false).map((p) => [p.question.cid, p.answers.map((a) => a.cid), p.after]),
    ).toEqual([["c0001", ["c0002", "c0003"], "s"]]);
  });

  test("with the unsent ones, a draft stands where it was written", () => {
    expect(placedBtws(records, true).map((p) => [p.question.cid, p.after])).toEqual([
      ["c0001", "s"],
      ["c0004", "w"],
    ]);
  });
});

function turn(ts: string, uuid: string): ParsedLine {
  return { kind: "turn", ts, uuid, role: "user", segments: [] };
}

function entry(offset: number, line: ParsedLine): TimelineGroup {
  return { kind: "entry", offset, line };
}

function fold(...entries: FoldEntries): TimelineGroup {
  return { kind: "fold", entries };
}

// The loaded window: a prompt at 10:00, a fold holding a prompt at 10:05 and a
// meta row at 10:06, and a prompt at 10:10. Slot `i` is what stands right
// before group `i`, so a btw after group `i` is in slot `i + 1`.
const GROUPS: TimelineGroup[] = [
  entry(0, turn("2026-11-22T10:00:00.000Z", "u-1")),
  fold(
    { offset: 10, line: turn("2026-11-22T10:05:00.000Z", "u-2") },
    {
      offset: 20,
      line: {
        kind: "meta",
        ts: "2026-11-22T10:06:00.000Z",
        uuid: "m-3",
        type: "system",
        summary: "",
        raw: "",
      },
    },
  ),
  entry(30, turn("2026-11-22T10:10:00.000Z", "u-4")),
];

/** A btw question sent at `at`, after the row `after` (none when undefined). */
function sentAt(cid: string, at: string, after?: string): UserComment {
  return question(cid, { sent: { at, ...(after !== undefined ? { after_uuid: after } : {}) } });
}

/** The btw comments' cids in each slot, placed as the Timeline places them:
 * by the point they were sent at, the window starting at the transcript's
 * first byte or not (`atStart`). */
function slotsOf(records: readonly CommentRecord[], atStart = false): string[][] {
  return anchoredSlots(
    GROUPS,
    placedBtws(records, false),
    (placed: PlacedBtw) => placed.after,
    (placed: PlacedBtw) => placed.ts,
    atStart,
  ).map((slot) => slot.map((placed) => placed.question.cid));
}

describe("a btw comment's place among the Timeline's items", () => {
  // The fork read the conversation up to the row the btw was sent at, so the
  // btw stands right after the item holding that row: a row folded inside a
  // fold, or a meta row, places it after the fold (the item that holds it).
  test("right after the item holding the row it was sent at, a fold's inner row and a meta row included", () => {
    expect(
      slotsOf([
        sentAt("a", "2026-11-22T12:00:00.000Z", "u-1"),
        sentAt("b", "2026-11-22T12:00:00.000Z", "m-3"),
        sentAt("c", "2026-11-22T12:00:00.000Z", "u-4"),
      ]),
    ).toEqual([[], ["a"], ["b"], ["c"]]);
  });

  // The row decides, not the time: a btw sent long after the row (the
  // session idle in between) still stands after it, not at the end.
  test("sent long after its row, it still stands right after that row's item", () => {
    expect(slotsOf([sentAt("late", "2026-11-23T00:00:00.000Z", "u-2")])).toEqual([
      [],
      [],
      ["late"],
      [],
    ]);
  });

  // Several sent at the same row stand in the order they were sent, whatever
  // order the records come in.
  test("several at one row, in the order sent", () => {
    expect(
      slotsOf([
        sentAt("y", "2026-11-22T12:00:02.000Z", "u-1"),
        sentAt("x", "2026-11-22T12:00:01.000Z", "u-1"),
      ])[1],
    ).toEqual(["x", "y"]);
  });

  // The row is not in the loaded window (taken out of the transcript, e.g.
  // compacted away) but the time is inside it: the btw stands at its time.
  test("a row the window does not hold, with a time inside the window: at its time", () => {
    expect(slotsOf([sentAt("gone", "2026-11-22T10:07:00.000Z", "compacted")])).toEqual([
      [],
      [],
      ["gone"],
      [],
    ]);
  });

  // Older than a window that does not start at the transcript's first byte,
  // its place is in a page not read yet: drawing it at the top would put it
  // before rows that come after it once the older page is read. So it waits.
  // From the first byte nothing is older than the window: it is at the top.
  test("older than a window that does not start at the file's start: not placed until its place is read", () => {
    const old = sentAt("old", "2026-11-22T09:00:00.000Z", "u-0");
    expect(slotsOf([old], false).flat()).toEqual([]);
    expect(slotsOf([old], true)).toEqual([["old"], [], [], []]);
  });

  // Sent before the transcript had any row, a btw names no row: its time
  // places it.
  test("sent at no row, it is placed by its time", () => {
    expect(slotsOf([sentAt("first", "2026-11-22T09:00:00.000Z")], true)).toEqual([
      ["first"],
      [],
      [],
      [],
    ]);
  });
});
