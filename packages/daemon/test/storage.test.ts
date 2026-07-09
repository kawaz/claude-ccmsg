import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Logger } from "../src/log.ts";
import {
  appendEvent,
  closeRoom,
  loadRoom,
  memberUidBySid,
  parseMidSelector,
  presentMembers,
  readMsgs,
} from "../src/storage.ts";

function tmpFile(): { file: string; log: Logger; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-s-"));
  return {
    file: path.join(base, "r-test.jsonl"),
    log: new Logger(path.join(base, "daemon.log")),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

describe("parseMidSelector", () => {
  // The read op accepts either a human range string or an explicit list. Both must
  // resolve to the same concrete mid set so `read r "10-12"` and `read r [10,11,12]`
  // are interchangeable (DR-0003 §6).
  test("range string expands inclusive endpoints and mixes with singletons", () => {
    expect([...parseMidSelector("10-12,15")].sort((a, b) => a - b)).toEqual([10, 11, 12, 15]);
  });
  test("explicit list keeps only integers", () => {
    expect([...parseMidSelector([1, 2, 5])].sort((a, b) => a - b)).toEqual([1, 2, 5]);
  });
  test("reversed / malformed ranges contribute nothing (no throw)", () => {
    // A backwards range (15-10) is meaningless; we drop it rather than error so a
    // sloppy selector still returns whatever valid parts it had.
    expect([...parseMidSelector("15-10,7")].sort((a, b) => a - b)).toEqual([7]);
  });
});

describe("loadRoom: torn tail recovery (DR-0002 §6)", () => {
  // A crash mid-write leaves an unterminated final line. On load the daemon must
  // quarantine that partial line to <file>.torn-<ts>, truncate it off, keep every
  // prior line usable, and restore lastMid from the surviving msg lines.
  test("quarantines a torn final line and restores mid from survivors", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const good =
        `${JSON.stringify({ type: "member", uid: 1, sid: "A", repo: "", ws: "", cwd: "", joined_at: "2026-07-03T00:00:00.000Z" })}\n` +
        `${JSON.stringify({ type: "msg", mid: 1, from: 1, ts: "2026-07-03T00:00:01.000Z", msg: "hi" })}\n` +
        `${JSON.stringify({ type: "msg", mid: 2, from: 1, ts: "2026-07-03T00:00:02.000Z", msg: "yo" })}\n`;
      // simulate a process killed partway through writing msg 3 (no trailing newline)
      const torn = `{"type":"msg","mid":3,"from":1,"ts":"2026-07-03T00:00:03.00`;
      fs.writeFileSync(file, good + torn);

      const room = loadRoom(file, "r-test", log);

      // survivors intact, torn line dropped
      expect(room.events.length).toBe(3);
      expect(room.lastMid).toBe(2);

      // the torn bytes were quarantined, not lost
      const dir = path.dirname(file);
      const tornFiles = fs.readdirSync(dir).filter((n) => n.includes(".torn-"));
      expect(tornFiles.length).toBe(1);
      expect(fs.readFileSync(path.join(dir, tornFiles[0]!), "utf8")).toBe(torn);

      // the live file no longer contains the torn fragment; a fresh append lands cleanly
      const after = fs.readFileSync(file, "utf8");
      expect(after.endsWith("\n")).toBe(true);
      expect(after.includes("00:00:03")).toBe(false);
    } finally {
      cleanup();
    }
  });

  // A final line that is valid JSON but missing its newline (write succeeded, newline
  // didn't) must be kept, and the file normalized so the next append doesn't glue onto it.
  test("normalizes a valid final line that lacks a trailing newline", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const line = JSON.stringify({
        type: "msg",
        mid: 1,
        from: 1,
        ts: "2026-07-03T00:00:01.000Z",
        msg: "hi",
      });
      fs.writeFileSync(file, `${line}`); // no newline
      const room = loadRoom(file, "r-test", log);
      expect(room.events.length).toBe(1);
      expect(room.lastMid).toBe(1);
      expect(fs.readFileSync(file, "utf8").endsWith("\n")).toBe(true);
    } finally {
      cleanup();
    }
  });
});

describe("loadRoom + appendEvent: mid continuity across reload", () => {
  // lastMid is authoritative from file contents (DR-0002 §6). After reloading a room,
  // the next assigned mid must continue the sequence, never restart at 1.
  test("mid continues after reload", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      let room = loadRoom(file, "r-test", log);
      appendEvent(room, {
        type: "member",
        uid: 1,
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: new Date().toISOString(),
      });
      appendEvent(room, {
        type: "msg",
        mid: room.lastMid + 1,
        from: 1,
        ts: new Date().toISOString(),
        msg: "a",
      });
      appendEvent(room, {
        type: "msg",
        mid: room.lastMid + 1,
        from: 1,
        ts: new Date().toISOString(),
        msg: "b",
      });
      expect(room.lastMid).toBe(2);
      closeRoom(room);

      room = loadRoom(file, "r-test", log);
      expect(room.lastMid).toBe(2);
      const nextMid = room.lastMid + 1;
      appendEvent(room, {
        type: "msg",
        mid: nextMid,
        from: 1,
        ts: new Date().toISOString(),
        msg: "c",
      });
      expect(nextMid).toBe(3);
      closeRoom(room);
    } finally {
      cleanup();
    }
  });
});

describe("membership derivation", () => {
  // Present membership = member events minus subsequent leave events. uid order is the
  // join order (DR-0003 §2). A left member disappears from the present set.
  test("leave removes a member; present set is uid-ordered", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const room = loadRoom(file, "r-test", log);
      const ts = new Date().toISOString();
      appendEvent(room, {
        type: "member",
        uid: 1,
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, {
        type: "member",
        uid: 2,
        sid: "B",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, {
        type: "member",
        uid: 3,
        sid: "C",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, { type: "leave", uid: 2, ts });
      const present = presentMembers(room);
      expect(present.map((m) => m.uid)).toEqual([1, 3]);
      const bySid = memberUidBySid(room);
      expect(bySid.get("A")).toBe(1);
      expect(bySid.has("B")).toBe(false);
      expect(bySid.get("C")).toBe(3);
      closeRoom(room);
    } finally {
      cleanup();
    }
  });
});

describe("readMsgs", () => {
  // read returns only msg events whose mid is in the requested set, ascending. Non-msg
  // events (member/title/...) are never returned by read.
  test("returns requested msgs sorted, ignoring non-msg events", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const room = loadRoom(file, "r-test", log);
      const ts = new Date().toISOString();
      appendEvent(room, {
        type: "member",
        uid: 1,
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      for (let i = 1; i <= 5; i++) {
        appendEvent(room, { type: "msg", mid: i, from: 1, ts, msg: `m${i}` });
      }
      const got = readMsgs(room, parseMidSelector("2-4"));
      expect(got.map((m) => m.mid)).toEqual([2, 3, 4]);
      expect(readMsgs(room, parseMidSelector("99")).length).toBe(0);
      closeRoom(room);
    } finally {
      cleanup();
    }
  });
});
