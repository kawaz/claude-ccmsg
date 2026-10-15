// The room logs left on disk, read on request (DR-0036 §2): which files are
// rooms, what a log reads as when part of it does not, and what the room list
// and `read` derive from a log. Nothing here writes a log, so the reader must
// leave every file as it found it.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StorageEvent } from "@ccmsg/protocol";
import {
  createRoomReader,
  midRanges,
  presentMembers,
  readMsgs,
  roomSummary,
  type RoomLog,
} from "../src/room-reader.ts";
import { defined } from "./helpers.ts";
import { memberRow, msgRow, roomLog } from "../../protocol/test/transcript-rows.ts";

const TS = "2026-07-03T00:00:00.000Z";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A disposable rooms dir holding `files` (name -> content). */
function roomsDir(files: Readonly<Record<string, string>> = {}): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-room-reader-"));
  roots.push(root);
  const dir = path.join(root, "rooms");
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), content);
  }
  return dir;
}

/** Every file in `dir` with its content, for asserting nothing was written. */
function snapshot(dir: string): Record<string, string> {
  return Object.fromEntries(
    fs.readdirSync(dir).map((name) => [name, fs.readFileSync(path.join(dir, name), "utf8")]),
  );
}

function log(events: readonly StorageEvent[]): RoomLog {
  return { id: "r1", events };
}

describe("presentMembers", () => {
  // Present membership = member events minus later leave events (DR-0006).
  test("a member who left is not present", () => {
    const present = presentMembers([
      memberRow("a1", "A"),
      memberRow("a2", "B"),
      memberRow("a3", "C"),
      { type: "leave", id: "a2", ts: TS },
    ]);
    expect(present.map((m) => [m.id, m.sid])).toEqual([
      ["a1", "A"],
      ["a3", "C"],
    ]);
  });

  test("a member who left and joined again is present, as the later row says", () => {
    const present = presentMembers([
      memberRow("a1", "A", { cwd: "/first" }),
      { type: "leave", id: "a1", ts: TS },
      memberRow("a1", "A", { cwd: "/again" }),
    ]);
    expect(present).toEqual([memberRow("a1", "A", { cwd: "/again" })]);
  });

  // id order: the u namespace before the a namespace, each by its number
  // (not by the order of joining, nor as strings: a10 after a9).
  test("present members are in id order", () => {
    const present = presentMembers([
      memberRow("a10", "D"),
      memberRow("a9", "C"),
      memberRow("u2", "B", { role: "guest" }),
      memberRow("a1", "A"),
    ]);
    expect(present.map((m) => m.id)).toEqual(["u2", "a1", "a9", "a10"]);
  });
});

describe("roomSummary", () => {
  test("title, kind and archived are the last of their rows; last_mid is the highest mid", () => {
    const summary = roomSummary(
      log([
        { type: "title", title: "first", ts: TS },
        { type: "kind", kind: "broadcast", ts: TS },
        memberRow("a1", "A"),
        msgRow(2, "a1", "two"),
        msgRow(1, "a1", "one"),
        { type: "title", title: "renamed", ts: TS },
        { type: "archive", archived: true, ts: TS },
        { type: "archive", archived: false, ts: "2026-07-04T00:00:00.000Z" },
      ]),
    );
    expect(summary).toEqual({
      id: "r1",
      title: "renamed",
      members: [memberRow("a1", "A")],
      last_mid: 2,
      last_ts: "2026-07-04T00:00:00.000Z",
      kind: "broadcast",
    });
  });

  test("an archived room says so; last_ts of a member row is when it joined", () => {
    const summary = roomSummary(
      log([
        { type: "archive", archived: true, ts: TS },
        memberRow("a1", "A", { joined_at: "2026-07-05T00:00:00.000Z" }),
      ]),
    );
    expect(summary).toMatchObject({ archived: true, last_ts: "2026-07-05T00:00:00.000Z" });
  });

  test("an empty log is an untitled normal room with no members, no msgs and no last_ts", () => {
    expect(roomSummary(log([]))).toEqual({ id: "r1", members: [], last_mid: 0, last_ts: null });
  });
});

describe("readMsgs", () => {
  // read answers only msg events whose mid the selector names, by mid; the
  // log's other events are never part of it.
  test("answers the named msgs by mid, leaving the other events out", () => {
    const events: StorageEvent[] = [
      memberRow("a1", "A"),
      msgRow(3, "a1", "m3"),
      msgRow(1, "a1", "m1"),
      { type: "title", title: "t", ts: TS },
      msgRow(2, "a1", "m2"),
      msgRow(5, "a1", "m5"),
    ];
    expect(readMsgs(log(events), "1-3").map((m) => m.mid)).toEqual([1, 2, 3]);
    expect(readMsgs(log(events), [5, 1]).map((m) => m.mid)).toEqual([1, 5]);
    expect(readMsgs(log(events), "99")).toEqual([]);
  });

  test("a range wider than the log answers what the log has", () => {
    const events = [msgRow(1, "a1", "m1"), msgRow(7, "a1", "m7")];
    expect(readMsgs(log(events), "0-9007199254740991").map((m) => m.mid)).toEqual([1, 7]);
  });
});

describe("midRanges", () => {
  // `read r "10-12"` and `read r [10,11,12]` name the same msgs (DR-0003 §6).
  test("a range string is inclusive and mixes with single mids", () => {
    expect(midRanges("10-12,15")).toEqual([
      [10, 12],
      [15, 15],
    ]);
    expect(midRanges(" 4 , 6-7 ")).toEqual([
      [4, 4],
      [6, 7],
    ]);
  });

  test("a list names its integers", () => {
    expect(midRanges([1, 2, 5])).toEqual([
      [1, 1],
      [2, 2],
      [5, 5],
    ]);
    expect(midRanges([1, 2.5, Number.NaN, 3])).toEqual([
      [1, 1],
      [3, 3],
    ]);
  });

  // A sloppy selector still answers whatever valid parts it had.
  test("a backwards, non-integer or empty part names nothing", () => {
    expect(midRanges("15-10,7")).toEqual([[7, 7]]);
    expect(midRanges("a,3-x,,1.5,8")).toEqual([[8, 8]]);
    expect(midRanges("")).toEqual([]);
  });

  // A range is kept as its two ends, so a wide one costs no more than a
  // narrow one.
  test("a wide range stays one range", () => {
    expect(midRanges("1-9007199254740991")).toEqual([[1, 9007199254740991]]);
  });
});

describe("createRoomReader", () => {
  const MEMBER = memberRow("a1", "A");
  const MSG1 = msgRow(1, "a1", "hi");
  const MSG2 = msgRow(2, "a1", "yo");

  // A crash mid-append leaves an unterminated last line (DR-0002 §6). What
  // came before it reads; the cut line is left out without a word, and the
  // file stays as it is: nothing writes to a room log.
  test("a torn last line is left out, and the dir is left as it was", async () => {
    const torn = `{"type":"msg","mid":3,"from":"a1","ts":"2026-07-03T00:00:03.00`;
    const dir = roomsDir({ "r1.jsonl": roomLog([MEMBER, MSG1, MSG2]) + torn });
    const before = snapshot(dir);
    const warned: string[] = [];
    const reader = createRoomReader(dir, (line) => warned.push(line));

    expect(await reader.room("r1")).toEqual({ id: "r1", events: [MEMBER, MSG1, MSG2] });
    expect(warned).toEqual([]);
    expect(snapshot(dir)).toEqual(before);
  });

  test("a valid last line without its newline reads", async () => {
    const dir = roomsDir({ "r1.jsonl": roomLog([MEMBER]) + JSON.stringify(MSG1) });
    const before = snapshot(dir);
    expect(await createRoomReader(dir).room("r1")).toEqual({ id: "r1", events: [MEMBER, MSG1] });
    expect(snapshot(dir)).toEqual(before);
  });

  // A line in the middle that does not read is not a crash's doing in an
  // append-only log, so it is worth a line in the daemon's log.
  test("an unreadable line before the last is left out and warned of", async () => {
    const dir = roomsDir({
      "r1.jsonl": `${roomLog([MEMBER])}not json\n${JSON.stringify({ type: "msg", mid: "x" })}\n${roomLog([MSG1])}`,
    });
    const before = snapshot(dir);
    const warned: string[] = [];
    const reader = createRoomReader(dir, (line) => warned.push(line));

    expect(await reader.room("r1")).toEqual({ id: "r1", events: [MEMBER, MSG1] });
    expect(warned).toHaveLength(2);
    expect(warned.every((line) => line.startsWith("room r1: skipping unreadable line"))).toBe(true);
    expect(defined(warned[0], "the first warning")).toContain("not json");
    expect(snapshot(dir)).toEqual(before);
  });

  // The parse is reused while the file stays the same, and redone once it
  // changes: the warning of a bad line is heard once per change of the file.
  test("an unchanged file is not parsed again; a changed one is", async () => {
    const dir = roomsDir({ "r1.jsonl": `${roomLog([MEMBER])}bad\n` });
    const warned: string[] = [];
    const reader = createRoomReader(dir, (line) => warned.push(line));

    expect((await reader.room("r1"))?.events).toEqual([MEMBER]);
    expect((await reader.room("r1"))?.events).toEqual([MEMBER]);
    expect(await reader.list()).toEqual([{ id: "r1", events: [MEMBER] }]);
    expect(warned).toHaveLength(1);

    fs.appendFileSync(path.join(dir, "r1.jsonl"), roomLog([MSG1]));
    expect((await reader.room("r1"))?.events).toEqual([MEMBER, MSG1]);
    expect(warned).toHaveLength(2);
  });

  test("a log that is gone is no room", async () => {
    const dir = roomsDir({ "r1.jsonl": roomLog([MEMBER]) });
    const reader = createRoomReader(dir);
    expect(await reader.room("r1")).toEqual({ id: "r1", events: [MEMBER] });
    fs.rmSync(path.join(dir, "r1.jsonl"));
    expect(await reader.room("r1")).toBeUndefined();
    expect(await reader.list()).toEqual([]);
  });

  // An id names `<rooms dir>/<id>.jsonl` only in the `r<N>` shape, so no id a
  // request carries reaches a file beside or above the rooms dir.
  test("an id outside the r<N> shape is no room, even when such a file exists", async () => {
    const dir = roomsDir({ "foo.jsonl": roomLog([MEMBER]), "r1.jsonl": roomLog([MEMBER]) });
    fs.writeFileSync(path.join(path.dirname(dir), "x.jsonl"), roomLog([MEMBER]));
    const reader = createRoomReader(dir);
    for (const id of ["../x", "foo", "r1/../r1", "r1.jsonl", "R1", "r", "", "r01", "r0"]) {
      expect({ id, room: await reader.room(id) }).toEqual({ id, room: undefined });
    }
    expect(await reader.room("r404")).toBeUndefined();
  });

  test("list answers every r<N>.jsonl in room number order and nothing else", async () => {
    const dir = roomsDir({
      "r10.jsonl": roomLog([MSG2]),
      "r2.jsonl": roomLog([MSG1]),
      "r1.jsonl": "",
      "foo.jsonl": roomLog([MEMBER]),
      "r3.json": roomLog([MEMBER]),
      "r4.jsonl.torn-1": roomLog([MEMBER]),
      "r01.jsonl": roomLog([MEMBER]),
      "notes.txt": "x",
    });
    expect(await createRoomReader(dir).list()).toEqual([
      { id: "r1", events: [] },
      { id: "r2", events: [MSG1] },
      { id: "r10", events: [MSG2] },
    ]);
  });

  // One log that cannot be read (here a directory named like one) is left out
  // and warned of; it does not take the other rooms down with it.
  test("a log that cannot be read is left out of the list and warned of", async () => {
    const dir = roomsDir({ "r1.jsonl": roomLog([MSG1]), "r3.jsonl": roomLog([MSG2]) });
    fs.mkdirSync(path.join(dir, "r2.jsonl"));
    const warned: string[] = [];
    const reader = createRoomReader(dir, (line) => warned.push(line));

    expect(await reader.list()).toEqual([
      { id: "r1", events: [MSG1] },
      { id: "r3", events: [MSG2] },
    ]);
    expect(await reader.room("r2")).toBeUndefined();
    expect(warned.length).toBeGreaterThan(0);
    expect(warned.every((line) => line.startsWith("room r2: log unreadable"))).toBe(true);
  });

  test("no rooms dir is no rooms", async () => {
    const dir = path.join(roomsDir(), "absent");
    const reader = createRoomReader(dir);
    expect(await reader.list()).toEqual([]);
    expect(await reader.room("r1")).toBeUndefined();
  });
});
