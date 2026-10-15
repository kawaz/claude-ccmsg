// A line from the daemon, as a client reads it (DR-0038): read once by the
// union of a push and a reply; a reply read as the answer to the op its asker
// names; anything else a failure.
import { describe, expect, test } from "bun:test";
import { type DaemonFrame, readDaemonFrame } from "../src/frame.ts";
import type { ErrorResponse } from "../src/response.ts";

const SID = "11111111-2222-4333-8444-555555555555";

const line = (value: object): string => JSON.stringify(value);

type ReplyFrame = Extract<DaemonFrame, { kind: "reply" }>;

function replyFrame(text: string): ReplyFrame {
  const frame = readDaemonFrame(text);
  if (frame.kind !== "reply") throw new Error(`expected a reply, got ${frame.kind}`);
  return frame;
}

describe("readDaemonFrame: replies", () => {
  test("a line with ok is a reply, named by its request id", () => {
    const frame = replyFrame(line({ ok: true, room: "r1", msgs: [], request_id: "q7" }));
    expect(frame.requestId).toBe("q7");
  });

  test("read as its op's answer, the reply leaves out the envelope", () => {
    const frame = replyFrame(line({ ok: true, room: "r1", msgs: [], request_id: "q7" }));
    expect(frame.reply("read")).toEqual({ ok: true, value: { ok: true, room: "r1", msgs: [] } });
  });

  test("an ok:false reply reads as the error, whatever the op", () => {
    const error: ErrorResponse = {
      ok: false,
      error: { code: "room_not_found", msg: "no such room: r9" },
    };
    const frame = replyFrame(line({ ...error, request_id: "q8" }));
    expect(frame.reply("read")).toEqual({ ok: true, value: error });
    expect(frame.reply("session_status")).toEqual({ ok: true, value: error });
  });

  test("a reply that is not the op's answer is a failure", () => {
    const frame = replyFrame(line({ ok: true, subscribed: true, request_id: "q1" }));
    expect(frame.reply("subscribe").ok).toBe(true);
    const asRead = frame.reply("read");
    expect(asRead.ok).toBe(false);
    if (asRead.ok) return;
    expect(asRead.failure.issues.map((i) => i.path)).toEqual(["room", "msgs"]);
  });

  test("an error reply without its error is a failure", () => {
    expect(replyFrame(line({ ok: false, request_id: "q1" })).reply("ping").ok).toBe(false);
  });

  test("a reply that names no request is still a reply", () => {
    const frame = replyFrame(line({ ok: false, error: { code: "bad_request", msg: "m" } }));
    expect(frame.requestId).toBeUndefined();
    expect(frame.reply("hello").ok).toBe(true);
  });
});

describe("readDaemonFrame: events", () => {
  test("a push", () => {
    expect(readDaemonFrame(line({ ev: "subscribe_superseded", sid: SID }))).toEqual({
      kind: "event",
      event: { ev: "subscribe_superseded", sid: SID },
    });
  });
});

describe("readDaemonFrame: a line that is neither", () => {
  const invalid = (text: string): string => {
    const frame = readDaemonFrame(text);
    if (frame.kind !== "invalid") throw new Error(`expected invalid, got ${frame.kind}`);
    return frame.failure.summary;
  };

  for (const text of ["", "{", "not json", '{"ok":true,}']) {
    test(`${JSON.stringify(text)} is not JSON`, () => {
      expect(invalid(text)).toStartWith("Invalid JSON");
    });
  }

  const shapes: readonly (object | number | string | null)[] = [
    { ev: "new_thing" },
    { type: "new_thing", r: "r1" },
    // a room's event, which the stream does not carry (DR-0036 §2)
    { type: "title", r: "r1", title: "t", ts: "t", seq: 4 },
    { ok: "yes" },
    { ok: true, request_id: 1 },
    {},
    [1],
    1,
    "x",
    null,
  ];
  for (const value of shapes) {
    test(`${JSON.stringify(value)} is a failure`, () => {
      expect(invalid(JSON.stringify(value)).length).toBeGreaterThan(0);
    });
  }
});
