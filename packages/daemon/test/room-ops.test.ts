// The ops that read the room logs left on disk (DR-0036 §2): `rooms`,
// `room_history` and `read`. They answer the user role only (the webui's room
// view and the Timeline), read the log files as they are on each request, and
// name no file outside the rooms dir.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { StorageEvent } from "@ccmsg/protocol";
import type { Conn, Daemon } from "../src/server.ts";
import { requestError, requestOk, stubDaemon } from "./drive-request.ts";
import { memberRow, msgRow, roomLog } from "../../protocol/test/transcript-rows.ts";

const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const TS = "2026-07-01T00:00:00.000Z";

const USER: Conn["identity"] = { role: "user" };
const SESSION: Conn["identity"] = { role: "session", sid: SID_A, repo: "r", ws: "w", cwd: "" };

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

/** A daemon over a disposable data dir whose rooms dir holds `logs`, by
 * room id. */
function daemonWith(logs: Readonly<Record<string, readonly StorageEvent[]>>): Daemon {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-room-ops-"));
  roots.push(root);
  const daemon = stubDaemon({}, root);
  fs.mkdirSync(daemon.paths.roomsDir, { recursive: true });
  for (const [id, events] of Object.entries(logs)) {
    fs.writeFileSync(path.join(daemon.paths.roomsDir, `${id}.jsonl`), roomLog(events));
  }
  return daemon;
}

const R1: readonly StorageEvent[] = [
  { type: "title", title: "first", ts: TS, seq: 1 },
  memberRow("a1", SID_A, { seq: 2 }),
  memberRow("a2", SID_B, { seq: 3 }),
  msgRow(1, "a1", "hello", { seq: 4 }),
  { type: "leave", id: "a2", ts: TS, seq: 5 },
  msgRow(2, "u1", "answer", { to: ["a1"], reply_to: "r1m1", seq: 6 }),
  { type: "archive", archived: true, ts: TS, seq: 7 },
  { type: "say", sid: SID_A, text: "spoken", ts: TS, seq: 8 },
  { type: "say_read", ref: 8, ts: TS, seq: 9 },
];

describe("rooms", () => {
  test("lists every room log in room number order, as the room list shows it", async () => {
    const daemon = daemonWith({
      r10: [memberRow("a1", SID_B), msgRow(4, "a1", "late", { ts: "2026-07-02T00:00:00.000Z" })],
      r1: R1,
      r2: [{ type: "kind", kind: "1on1", ts: TS }],
    });
    const res = await requestOk(daemon, USER, { request_id: "q1", op: "rooms" });
    expect(res.rooms).toEqual([
      {
        id: "r1",
        title: "first",
        members: [memberRow("a1", SID_A, { seq: 2 })],
        last_mid: 2,
        last_ts: TS,
        archived: true,
      },
      { id: "r2", members: [], last_mid: 0, last_ts: TS, kind: "1on1" },
      {
        id: "r10",
        members: [memberRow("a1", SID_B)],
        last_mid: 4,
        last_ts: "2026-07-02T00:00:00.000Z",
      },
    ]);
  });

  test("no rooms dir is no rooms", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-room-ops-"));
    roots.push(root);
    expect(await requestOk(stubDaemon({}, root), USER, { request_id: "q1", op: "rooms" })).toEqual({
      ok: true,
      rooms: [],
    });
  });
});

describe("room_history", () => {
  test("answers every event of the log in file order, msgs and the rest alike", async () => {
    const daemon = daemonWith({ r1: R1 });
    expect(
      await requestOk(daemon, USER, { request_id: "q1", op: "room_history", room: "r1" }),
    ).toEqual({
      ok: true,
      room: "r1",
      events: [...R1],
    });
  });

  test("reads the file again once it has changed", async () => {
    const daemon = daemonWith({ r1: [memberRow("a1", SID_A)] });
    const first = await requestOk(daemon, USER, {
      request_id: "q1",
      op: "room_history",
      room: "r1",
    });
    expect(first.events).toEqual([memberRow("a1", SID_A)]);
    fs.appendFileSync(
      path.join(daemon.paths.roomsDir, "r1.jsonl"),
      roomLog([msgRow(1, "a1", "added")]),
    );
    const second = await requestOk(daemon, USER, {
      request_id: "q1",
      op: "room_history",
      room: "r1",
    });
    expect(second.events).toEqual([memberRow("a1", SID_A), msgRow(1, "a1", "added")]);
  });
});

describe("read", () => {
  test("answers the msgs the selector names, by mid", async () => {
    const daemon = daemonWith({ r1: R1 });
    const res = await requestOk(daemon, USER, {
      request_id: "q1",
      op: "read",
      room: "r1",
      mids: "2,1",
    });
    expect(res).toEqual({
      ok: true,
      room: "r1",
      msgs: [
        msgRow(1, "a1", "hello", { seq: 4 }),
        msgRow(2, "u1", "answer", { to: ["a1"], reply_to: "r1m1", seq: 6 }),
      ],
    });
    expect(
      (await requestOk(daemon, USER, { request_id: "q1", op: "read", room: "r1", mids: [2, 99] }))
        .msgs,
    ).toEqual([msgRow(2, "u1", "answer", { to: ["a1"], reply_to: "r1m1", seq: 6 })]);
  });
});

describe("the room ops' refusals", () => {
  const OPS = [
    { request_id: "q1", op: "rooms" },
    { request_id: "q1", op: "room_history", room: "r1" },
    { request_id: "q1", op: "read", room: "r1", mids: "1" },
  ] as const;

  // The room logs are the webui's to read (DR-0036 §3): a session reads none.
  test("a session is refused, naming the user role", async () => {
    const daemon = daemonWith({ r1: R1 });
    for (const request of OPS) {
      expect((await requestError(daemon, SESSION, request)).error).toEqual({
        code: "bad_request",
        msg: `op '${request.op}' requires user role`,
      });
    }
  });

  test("a connection without hello is told to hello first", async () => {
    const daemon = daemonWith({ r1: R1 });
    for (const request of OPS) {
      expect((await requestError(daemon, null, request)).error.code).toBe("hello_required");
    }
  });

  test("a room with no log is room_not_found", async () => {
    const daemon = daemonWith({ r1: R1 });
    for (const request of [
      { request_id: "q1", op: "room_history", room: "r2" },
      { request_id: "q1", op: "read", room: "r2", mids: "1" },
    ] as const) {
      expect((await requestError(daemon, USER, request)).error).toEqual({
        code: "room_not_found",
        msg: "no such room: r2",
      });
    }
  });

  // A room id names `rooms/<id>.jsonl` only in the `r<N>` shape, so a request
  // cannot reach a file beside or above the rooms dir.
  test("an id outside the r<N> shape is room_not_found, even when such a file exists", async () => {
    const daemon = daemonWith({ r1: R1 });
    fs.writeFileSync(path.join(daemon.paths.dataDir, "x.jsonl"), roomLog(R1));
    fs.writeFileSync(path.join(daemon.paths.roomsDir, "foo.jsonl"), roomLog(R1));
    for (const room of ["../x", "foo", "r1/../r1", "R1", ""]) {
      expect({
        room,
        code: (await requestError(daemon, USER, { request_id: "q1", op: "room_history", room }))
          .error.code,
      }).toEqual({
        room,
        code: "room_not_found",
      });
      expect({
        room,
        code: (await requestError(daemon, USER, { request_id: "q1", op: "read", room, mids: "1" }))
          .error.code,
      }).toEqual({
        room,
        code: "room_not_found",
      });
    }
  });
});
