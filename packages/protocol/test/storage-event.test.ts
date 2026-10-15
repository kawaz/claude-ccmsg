// The events of a room log (DR-0036 §2), as the schemas say them (DR-0038):
// each kind of row reads back whole — nothing left out — whether it comes from
// a log file or in a `room_history` reply, and one whose fields are not of
// their types is a failure.
import { describe, expect, test } from "bun:test";
import { parseWith } from "../src/parse.ts";
import { StorageEventSchema, type StorageEvent } from "../src/storage-event.ts";

const SID = "11111111-2222-4333-8444-555555555555";

/** As it travels: what JSON.stringify writes, decoded. */
const wire = <T>(value: T): unknown => JSON.parse(JSON.stringify(value));

/** Each storage event, by `type`. */
const STORED: {
  readonly [T in StorageEvent["type"]]: readonly Extract<StorageEvent, { type: T }>[];
} = {
  member: [
    {
      type: "member",
      id: "u2",
      sid: SID,
      repo: "kawaz/x",
      ws: "main",
      cwd: "/w",
      joined_at: "t",
      role: "guest",
      seq: 1,
    },
  ],
  leave: [{ type: "leave", id: "a1", ts: "t", seq: 2 }],
  msg: [
    { type: "msg", mid: 1, from: "u1", ts: "t", msg: "hi", seq: 3 },
    {
      type: "msg",
      mid: 2,
      from: "a1",
      to: ["u1"],
      reply_to: "r1m1",
      ts: "t",
      msg: "yo",
      seq: 4,
    },
  ],
  next: [{ type: "next", room: "r2", ts: "t", seq: 5 }],
  prev: [{ type: "prev", room: "r1", ts: "t", seq: 1 }],
  title: [{ type: "title", title: "t", ts: "t", seq: 6 }],
  archive: [{ type: "archive", archived: false, ts: "t", seq: 7 }],
  kind: [
    { type: "kind", kind: "broadcast", ts: "t", seq: 1 },
    { type: "kind", kind: "1on1", ts: "t" },
  ],
  say: [{ type: "say", sid: SID, text: "hello", ts: "t", seq: 2 }],
  say_read: [{ type: "say_read", ref: 2, ts: "t", seq: 3 }],
};

describe("StorageEventSchema", () => {
  for (const [type, samples] of Object.entries(STORED)) {
    test(`${type}: a row reads back whole`, () => {
      expect(samples.length).toBeGreaterThan(0);
      for (const sample of samples) {
        expect(parseWith(StorageEventSchema, wire(sample))).toEqual({ ok: true, value: sample });
      }
    });
  }

  test("a field of another type names the field", () => {
    const read = parseWith(StorageEventSchema, {
      type: "msg",
      mid: "1",
      from: "u1",
      ts: "t",
      msg: "m",
    });
    expect(read.ok).toBe(false);
    if (read.ok) return;
    expect(read.failure.issues.map((i) => i.path)).toEqual(["mid"]);
  });

  test("a type no storage event has is a failure", () => {
    expect(parseWith(StorageEventSchema, { type: "link", ts: "t" }).ok).toBe(false);
  });
});
