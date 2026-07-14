// DR-0016: per-room `seq` spanning every StorageEvent type — the subscribe
// reconnect cursor. Origin bug: a room whose log TAIL is a non-msg event
// (archive/title/...) got that tail re-delivered on every reconnect, because
// the old cursor (`since` = per-room max *mid*) only ever anchored on msg
// events (docs/issue/2026-07-15-subscribe-reconnect-nonmsg-redelivery.md —
// observed as 6-10+ duplicate archive deliveries waking idle agent sessions).
// These tests pin the seq cursor semantics end-to-end over a real daemon UDS.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Logger } from "../src/log.ts";
import { appendEvent, closeRoom, loadRoom } from "../src/storage.ts";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

async function session(ctx: DaemonCtx, sid: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: `repo-${sid}`, ws: `ws-${sid}`, cwd: `/tmp/${sid}` });
  return c;
}

/** Drain every already-queued line from a subscriber without blocking: post a
 * sentinel msg from a co-member and read until it arrives. Everything seen
 * before the sentinel is the complete backlog for the preceding subscribe. */
async function drainUntilSentinel(
  sub: TestClient,
  poster: TestClient,
  room: string,
  tag: string,
): Promise<any[]> {
  await poster.request({ op: "post", room, msg: `sentinel-${tag}` });
  const { seen } = await sub.readEventUntil(
    (ev) => ev.type === "msg" && ev.msg === `sentinel-${tag}`,
  );
  return seen.slice(0, -1); // everything before the sentinel
}

describe("DR-0016 seq: assignment and delivery", () => {
  test(
    "every event type is delivered with a per-room 1-origin monotonic seq (live + backlog)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // Build a room whose log mixes several event types: member (create),
        // msg, title, archive. The seq must number them 1..N in file order —
        // one shared sequence across types, NOT a per-type counter (that's
        // exactly what mid was, and why non-msg events had no cursor).
        const a = await session(ctx, "A");
        const b = await session(ctx, "B");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
          msg: "hello",
        });
        const room = created.room;
        await a.request({ op: "set_title", room, title: "seq test" });
        await a.request({ op: "archive_room", room, archived: true });

        // Fresh subscriber with no cursor → join snapshot backlog. Every
        // delivered StorageEvent must carry a number seq, strictly increasing
        // in delivery order (delivery preserves file order).
        const sub = await connect(ctx.sock);
        await sub.hello({ role: "session", sid: "B" });
        await sub.request({ op: "subscribe" });
        const backlog = await drainUntilSentinel(sub, a, room, "t1");
        const roomEvents = backlog.filter((ev) => ev.r === room && typeof ev.type === "string");
        expect(roomEvents.length).toBeGreaterThanOrEqual(4); // 2 member + msg + title + archive
        const types = new Set(roomEvents.map((ev) => ev.type));
        expect(types.has("member")).toBe(true);
        expect(types.has("msg")).toBe(true);
        expect(types.has("title")).toBe(true);
        expect(types.has("archive")).toBe(true);
        for (const ev of roomEvents) expect(typeof ev.seq).toBe("number");
        const seqs = roomEvents.map((ev) => ev.seq as number);
        for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);

        // Live delivery too: the next event (another title change) arrives
        // with seq = previous max + 1 (same counter, no reset between backlog
        // and live paths).
        const maxSeq = Math.max(...seqs, 0);
        await a.request({ op: "set_title", room, title: "seq test 2" });
        const { ev: liveTitle } = await sub.readEventUntil(
          (ev) => ev.type === "title" && ev.title === "seq test 2",
        );
        expect((liveTitle as any).seq).toBeGreaterThan(maxSeq);
        sub.close();
        a.close();
        b.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("DR-0016 seq: reconnect cursor (the origin bug)", () => {
  test(
    "bug repro: a room whose log tail is a non-msg event is NOT re-delivered when since_seq covers it",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // Reproduce the field observation: last room activity is an archive
        // toggle (non-msg), then the subscriber reconnects. With the old mid
        // cursor the archive was replayed on EVERY reconnect (it sits after
        // the last msg). With since_seq pointing at (or past) the archive's
        // seq, the replay must be empty.
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
          msg: "m1",
        });
        const room = created.room;
        await a.request({ op: "archive_room", room, archived: true });

        // First connect: learn the archive event's seq (the log tail).
        const sub1 = await connect(ctx.sock);
        await sub1.hello({ role: "session", sid: "B" });
        await sub1.request({ op: "subscribe" });
        const { ev: archiveEv } = await sub1.readEventUntil(
          (ev) => ev.type === "archive" && ev.r === room,
        );
        const tailSeq = (archiveEv as any).seq as number;
        expect(typeof tailSeq).toBe("number");
        sub1.close();

        // Reconnect with since_seq = the tail's seq (client saw everything).
        // Expected replay for this room: nothing at all. A sentinel posted
        // AFTER the reconnect is the first thing that may arrive.
        const sub2 = await connect(ctx.sock);
        await sub2.hello({ role: "session", sid: "B" });
        await sub2.request({ op: "subscribe", since_seq: { [room]: tailSeq } });
        const replayed = await drainUntilSentinel(sub2, a, room, "t2");
        expect(replayed.filter((ev) => ev.r === room)).toEqual([]);
        sub2.close();
        a.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a non-msg event past the cursor is delivered exactly once, then covered by the advanced cursor",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // The complement of the repro above: the cursor stops at the last
        // *msg* (a client that upgraded mid-stream, or simply hadn't seen the
        // archive yet). The archive AFTER that point must be replayed —
        // dropping it would be the inverse bug (DR-0016 §3 rejected option C:
        // "skip non-msg on reconnect" loses events). Once seen and the cursor
        // advanced to the archive's seq, a further reconnect replays nothing.
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
          msg: "m1",
        });
        const room = created.room;

        // Learn the msg's seq first.
        const sub1 = await connect(ctx.sock);
        await sub1.hello({ role: "session", sid: "B" });
        await sub1.request({ op: "subscribe" });
        const { ev: msgEv } = await sub1.readEventUntil(
          (ev) => ev.type === "msg" && ev.r === room && ev.msg === "m1",
        );
        const msgSeq = (msgEv as any).seq as number;
        sub1.close();

        // Archive lands after the client went away.
        await a.request({ op: "archive_room", room, archived: true });

        // Reconnect with the cursor at the msg: the archive must arrive once.
        const sub2 = await connect(ctx.sock);
        await sub2.hello({ role: "session", sid: "B" });
        await sub2.request({ op: "subscribe", since_seq: { [room]: msgSeq } });
        const replayed = await drainUntilSentinel(sub2, a, room, "t3");
        const archives = replayed.filter((ev) => ev.r === room && ev.type === "archive");
        expect(archives.length).toBe(1);
        const archiveSeq = archives[0]!.seq as number;
        sub2.close();

        // Cursor advanced past the archive → clean reconnect, zero replay.
        const sub3 = await connect(ctx.sock);
        await sub3.hello({ role: "session", sid: "B" });
        await sub3.request({ op: "subscribe", since_seq: { [room]: archiveSeq } });
        const replayed2 = await drainUntilSentinel(sub3, a, room, "t4");
        // (the t3 sentinel msg sits between archive and t4 sentinel — it has
        // seq > archiveSeq, so exactly that one msg is a legitimate replay)
        const unexpected = replayed2.filter(
          (ev) => ev.r === room && !(ev.type === "msg" && ev.msg === "sentinel-t3"),
        );
        expect(unexpected).toEqual([]);
        sub3.close();
        a.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "old-client compat: `since` (mid cursor) still anchors replay after the last seen msg",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // A pre-DR-0016 client sends `since` (per-room max mid) and expects
        // the daemon to replay everything after that msg — including the
        // known duplicate-tail quirk. The mid branch must be untouched: this
        // is the compatibility half of DR-0016 §4 (old client × new daemon =
        // no regression).
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
          msg: "m1",
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m2" });

        const sub = await connect(ctx.sock);
        await sub.hello({ role: "session", sid: "B" });
        // mid cursor at m1 → replay must contain m2 (and not m1).
        await sub.request({ op: "subscribe", since: { [room]: 1 } });
        const replayed = await drainUntilSentinel(sub, a, room, "t5");
        const msgs = replayed.filter((ev) => ev.r === room && ev.type === "msg");
        expect(msgs.map((m) => m.msg)).toEqual(["m2"]);
        sub.close();
        a.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "since_seq input validation: negative / non-number fall back to the next cursor; huge value replays nothing",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // since_seq arrives from JSON.parse with no schema validation, so
        // hostile/broken values are reachable. DR-0016 §2.5: invalid (not a
        // finite non-negative number) = "no since_seq for this room" → here
        // (no `since` either) that means the join-snapshot path, i.e. the
        // full room state is replayed — duplicates over silent loss. A huge
        // but VALID value means "seen everything" → zero replay, and must not
        // hang or error the scan.
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
          msg: "m1",
        });
        const room = created.room;

        // negative → invalid → join snapshot (m1 present)
        const subNeg = await connect(ctx.sock);
        await subNeg.hello({ role: "session", sid: "B" });
        await subNeg.request({ op: "subscribe", since_seq: { [room]: -5 } });
        const negReplay = await drainUntilSentinel(subNeg, a, room, "neg");
        expect(negReplay.some((ev) => ev.r === room && ev.msg === "m1")).toBe(true);
        subNeg.close();

        // non-number (string) → invalid → join snapshot
        const subStr = await connect(ctx.sock);
        await subStr.hello({ role: "session", sid: "B" });
        await subStr.request({ op: "subscribe", since_seq: { [room]: "nope" } });
        const strReplay = await drainUntilSentinel(subStr, a, room, "str");
        expect(strReplay.some((ev) => ev.r === room && ev.msg === "m1")).toBe(true);
        subStr.close();

        // huge but valid → caught up → nothing from this room (except the
        // sentinel-neg/str msgs which are themselves ≤ the huge cursor, so
        // truly nothing).
        const subBig = await connect(ctx.sock);
        await subBig.hello({ role: "session", sid: "B" });
        await subBig.request({ op: "subscribe", since_seq: { [room]: 1e12 } });
        const bigReplay = await drainUntilSentinel(subBig, a, room, "big");
        expect(bigReplay.filter((ev) => ev.r === room)).toEqual([]);
        subBig.close();
        a.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("DR-0016 seq: legacy log backfill (storage unit)", () => {
  function tmpFile(): { file: string; log: Logger; cleanup: () => void } {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-seq-"));
    return {
      file: path.join(base, "r-test.jsonl"),
      log: new Logger(path.join(base, "daemon.log")),
      cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
    };
  }

  test("legacy rows (no seq on disk) are backfilled 1-origin in memory; new appends persist a continuing seq", () => {
    const { file, log, cleanup } = tmpFile();
    try {
      // Simulate a pre-DR-0016 log: rows written without seq. Disk must stay
      // untouched (append-only), but loadRoom has to present them AS IF they
      // always had seq 1..N — otherwise a reconnecting client with a seq
      // cursor would anchor wrongly against old rooms.
      const ts = new Date().toISOString();
      const legacy = [
        { type: "member", id: "a1", sid: "A", repo: "", ws: "", cwd: "", joined_at: ts },
        { type: "msg", mid: 1, from: "a1", ts, msg: "old" },
        { type: "archive", archived: true, ts },
      ];
      fs.writeFileSync(file, `${legacy.map((e) => JSON.stringify(e)).join("\n")}\n`);

      const room = loadRoom(file, "r-test", log);
      expect(room.events.map((e) => e.seq)).toEqual([1, 2, 3]);
      expect(room.lastSeq).toBe(3);

      // New append continues the sequence AND persists it in the line itself.
      appendEvent(room, { type: "msg", mid: 2, from: "a1", ts, msg: "new" });
      expect(room.events[3]!.seq).toBe(4);
      const diskLines = fs.readFileSync(file, "utf8").trim().split("\n");
      // legacy rows on disk still have no seq (never rewritten) …
      expect(JSON.parse(diskLines[0]!).seq).toBeUndefined();
      // … while the new row carries its persisted seq.
      expect(JSON.parse(diskLines[3]!).seq).toBe(4);

      // And a reload reconstructs the exact same numbering from the mix.
      closeRoom(room);
      const reloaded = loadRoom(file, "r-test", log);
      expect(reloaded.events.map((e) => e.seq)).toEqual([1, 2, 3, 4]);
      expect(reloaded.lastSeq).toBe(4);
      closeRoom(reloaded);
    } finally {
      cleanup();
    }
  });
});
