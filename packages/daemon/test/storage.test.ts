import { describe, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Logger } from "../src/log.ts";
import {
  appendEvent,
  closeRoom,
  loadRoom,
  memberIdBySid,
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
        `${JSON.stringify({ type: "member", id: "a1", sid: "A", repo: "", ws: "", cwd: "", joined_at: "2026-07-03T00:00:00.000Z" })}\n` +
        `${JSON.stringify({ type: "msg", mid: 1, from: "a1", ts: "2026-07-03T00:00:01.000Z", msg: "hi" })}\n` +
        `${JSON.stringify({ type: "msg", mid: 2, from: "a1", ts: "2026-07-03T00:00:02.000Z", msg: "yo" })}\n`;
      // simulate a process killed partway through writing msg 3 (no trailing newline)
      const torn = `{"type":"msg","mid":3,"from":"a1","ts":"2026-07-03T00:00:03.00`;
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
        from: "a1",
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
        id: "a1",
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: new Date().toISOString(),
      });
      appendEvent(room, {
        type: "msg",
        mid: room.lastMid + 1,
        from: "a1",
        ts: new Date().toISOString(),
        msg: "a",
      });
      appendEvent(room, {
        type: "msg",
        mid: room.lastMid + 1,
        from: "a1",
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
        from: "a1",
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

describe("appendEvent: write-failure atomicity (docs/issue/2026-07-10-storage-append-atomicity.md)", () => {
  // If fs.writeSync throws (disk full / EIO), the in-memory mirror (events /
  // lastMid / title / next / prev) must not have moved ahead of what's durably
  // on disk. Otherwise a daemon that survives the failure (no restart) could
  // hand out a `mid` that was never actually persisted, and a later real
  // append would reuse that same mid (duplicate mid assignment). Disk-first
  // ordering in appendEvent (write before mutating room state) is what
  // guarantees this.
  test("writeSync failure throws and leaves in-memory state untouched", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const room = loadRoom(file, "r-test", log);
      const ts = new Date().toISOString();
      appendEvent(room, {
        type: "member",
        id: "a1",
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, { type: "msg", mid: room.lastMid + 1, from: "a1", ts, msg: "ok" });

      // snapshot state right before the simulated disk failure
      const eventsBefore = [...room.events];
      const lastMidBefore = room.lastMid;
      const lastSeqBefore = room.lastSeq;

      const spy = spyOn(fs, "writeSync").mockImplementation(() => {
        throw new Error("ENOSPC: no space left on device");
      });
      try {
        expect(() =>
          appendEvent(room, { type: "msg", mid: room.lastMid + 1, from: "a1", ts, msg: "lost" }),
        ).toThrow();
      } finally {
        spy.mockRestore();
      }

      // in-memory mirror must be byte-for-byte identical to the pre-failure snapshot:
      // no extra event pushed, lastMid/lastSeq not advanced past what's on disk.
      // (seq is stamped onto the event object BEFORE the write — the one
      // pre-write mutation appendEvent makes — but the room's own high-water
      // mark must not move: a stale stamp on a never-persisted event is
      // harmless, an advanced lastSeq would burn a hole in the sequence.)
      expect(room.events).toEqual(eventsBefore);
      expect(room.lastMid).toBe(lastMidBefore);
      expect(room.lastSeq).toBe(lastSeqBefore);

      // the daemon keeps running after the failure (no restart): a subsequent
      // successful append must continue from the real (unadvanced) lastMid,
      // not skip a "lost" mid or collide with one already assigned. Same for
      // seq: the retry reuses the failed attempt's number, leaving no gap.
      const nextMid = room.lastMid + 1;
      appendEvent(room, { type: "msg", mid: nextMid, from: "a1", ts, msg: "recovered" });
      expect(nextMid).toBe(lastMidBefore + 1);
      expect(room.lastMid).toBe(lastMidBefore + 1);
      expect(room.lastSeq).toBe(lastSeqBefore + 1);
      closeRoom(room);
    } finally {
      cleanup();
    }
  });

  // POSIX write(2) can return having written fewer bytes than requested without
  // throwing (e.g. disk fills up mid-write) — a "short write". appendEvent must
  // treat that the same as a thrown error: throw before touching in-memory state,
  // never advance room.events/lastMid past what's actually durable on disk.
  test("short write (fewer bytes written than requested, no throw) is treated as a failure", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const room = loadRoom(file, "r-test", log);
      const ts = new Date().toISOString();
      appendEvent(room, {
        type: "member",
        id: "a1",
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, { type: "msg", mid: room.lastMid + 1, from: "a1", ts, msg: "ok" });

      const eventsBefore = [...room.events];
      const lastMidBefore = room.lastMid;

      // Simulate write(2) reporting a partial write (returns a byte count
      // smaller than the buffer) instead of throwing.
      const spy = spyOn(fs, "writeSync").mockImplementation(() => 1);
      try {
        expect(() =>
          appendEvent(room, { type: "msg", mid: room.lastMid + 1, from: "a1", ts, msg: "lost" }),
        ).toThrow();
      } finally {
        spy.mockRestore();
      }

      // Same invariant as the throwing-write case: in-memory mirror must not
      // have moved ahead of disk.
      expect(room.events).toEqual(eventsBefore);
      expect(room.lastMid).toBe(lastMidBefore);

      const nextMid = room.lastMid + 1;
      appendEvent(room, { type: "msg", mid: nextMid, from: "a1", ts, msg: "recovered" });
      expect(nextMid).toBe(lastMidBefore + 1);
      expect(room.lastMid).toBe(lastMidBefore + 1);
      closeRoom(room);
    } finally {
      cleanup();
    }
  });
});

describe("membership derivation", () => {
  // Present membership = member events minus subsequent leave events. id order is the
  // join order within a namespace, u before a (DR-0006). A left member disappears
  // from the present set.
  test("leave removes a member; present set is id-ordered", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const room = loadRoom(file, "r-test", log);
      const ts = new Date().toISOString();
      appendEvent(room, {
        type: "member",
        id: "a1",
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, {
        type: "member",
        id: "a2",
        sid: "B",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, {
        type: "member",
        id: "a3",
        sid: "C",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, { type: "leave", id: "a2", ts });
      const present = presentMembers(room);
      expect(present.map((m) => m.id)).toEqual(["a1", "a3"]);
      const bySid = memberIdBySid(room);
      expect(bySid.get("A")).toBe("a1");
      expect(bySid.has("B")).toBe(false);
      expect(bySid.get("C")).toBe("a3");
      closeRoom(room);
    } finally {
      cleanup();
    }
  });

  // u-namespace (guest) members sort before a-namespace (agent) members regardless
  // of join order, and each namespace's numeric suffix orders within itself.
  test("present set sorts u-namespace before a-namespace", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      const room = loadRoom(file, "r-test", log);
      const ts = new Date().toISOString();
      appendEvent(room, {
        type: "member",
        id: "a1",
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      appendEvent(room, {
        type: "member",
        id: "u2",
        sid: "B",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
        role: "guest",
      });
      const present = presentMembers(room);
      expect(present.map((m) => m.id)).toEqual(["u2", "a1"]);
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
        id: "a1",
        sid: "A",
        repo: "",
        ws: "",
        cwd: "",
        joined_at: ts,
      });
      for (let i = 1; i <= 5; i++) {
        appendEvent(room, { type: "msg", mid: i, from: "a1", ts, msg: `m${i}` });
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
