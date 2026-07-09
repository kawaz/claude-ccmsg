// Integration: a real daemon spawned in a temp dir, exercised over UDS.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  connect,
  spawnDaemonProc,
  startTestDaemon,
  stopTestDaemon,
  waitConnectable,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

async function session(ctx: DaemonCtx, sid: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: `repo-${sid}`, ws: `ws-${sid}`, cwd: `/tmp/${sid}` });
  return c;
}
async function user(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  return c;
}

describe("wire protocol integration", () => {
  test(
    "mid is a per-room sequence assigned by the daemon",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ ok: true; room: string }>({
          op: "create_room",
          members: [],
        });
        const room = created.room;
        // consecutive posts get 1,2,3 — the daemon owns the sequence, clients never send mid
        const p1 = await a.request<{ mid: number }>({ op: "post", room, msg: "one" });
        const p2 = await a.request<{ mid: number }>({ op: "post", room, msg: "two" });
        const p3 = await a.request<{ mid: number }>({ op: "post", room, msg: "three" });
        expect([p1.mid, p2.mid, p3.mid]).toEqual([1, 2, 3]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "no echo back: an author never receives their own post, but co-members do",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const bPost = await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        const aSub = await session(ctx, "A");
        const bSub = await session(ctx, "B");
        await aSub.request({ op: "subscribe" });
        await bSub.request({ op: "subscribe" });

        await aPost.request({ op: "post", room, msg: "from A" }); // mid 1, from uid 1
        await bPost.request({ op: "post", room, msg: "from B" }); // mid 2, from uid 2

        // A's stream skips its own mid 1 (echo) and first sees B's mid 2
        const aFirst = await aSub.readEventUntil((ev) => ev.type === "msg");
        expect(aFirst.ev.mid).toBe(2);
        expect(aFirst.ev.from).toBe(2);

        // B's stream skips its own mid 2 and first sees A's mid 1
        const bFirst = await bSub.readEventUntil((ev) => ev.type === "msg");
        expect(bFirst.ev.mid).toBe(1);
        expect(bFirst.ev.from).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "to is a mention, not a visibility filter: every member is delivered",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const bPost = await session(ctx, "B"); // also registers B as a resolvable peer
        await session(ctx, "C"); // register C as a resolvable peer
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B", "C"],
        });
        const room = created.room;

        const bSub = await session(ctx, "B");
        const cSub = await session(ctx, "C");
        const aSub = await session(ctx, "A");
        await bSub.request({ op: "subscribe" });
        await cSub.request({ op: "subscribe" });
        await aSub.request({ op: "subscribe" });

        // A mentions only B (uid 2). C (uid 3) is NOT mentioned.
        await aPost.request({ op: "post", room, msg: "hey", to: [2] });

        // both the mentioned member (B) and the unmentioned member (C) receive it
        const bGot = await bSub.readEventUntil((ev) => ev.type === "msg");
        expect(bGot.ev.msg).toBe("hey");
        expect(bGot.ev.to).toEqual([2]);
        const cGot = await cSub.readEventUntil((ev) => ev.type === "msg");
        expect(cGot.ev.msg).toBe("hey");
        expect(cGot.ev.to).toEqual([2]); // C sees the mention marker but is still delivered

        // the author still gets no echo: after a co-member posts, A's first msg is that one
        await bPost.request({ op: "post", room, msg: "second" }); // mid 2 from B
        const aGot = await aSub.readEventUntil((ev) => ev.type === "msg");
        expect(aGot.ev.mid).toBe(2);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "create_room dedup: a second create within the window reuses the room and folds in the late msg",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        await session(ctx, "B");
        const first = await a.request<{ room: string; reused: boolean; mid?: number }>({
          op: "create_room",
          members: ["B"],
          msg: "first",
        });
        expect(first.reused).toBe(false);
        expect(first.mid).toBe(1);

        // same member set, well within the default 60s window -> reuse, not a new room
        const second = await a.request<{ room: string; reused: boolean; mid?: number }>({
          op: "create_room",
          members: ["B"],
          msg: "second",
        });
        expect(second.reused).toBe(true);
        expect(second.room).toBe(first.room);
        expect(second.mid).toBe(2); // the late create's msg was posted into the existing room

        // exactly one room exists, holding both messages
        const rooms = await a.request<{ rooms: unknown[] }>({ op: "rooms" });
        expect(rooms.rooms.length).toBe(1);
        const read = await a.request<{ msgs: { mid: number; msg: string }[] }>({
          op: "read",
          room: first.room,
          mids: "1-2",
        });
        expect(read.msgs.map((m) => m.msg)).toEqual(["first", "second"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "create_room past the window makes a new room instead of reusing",
    async () => {
      // shrink the dedup window to ~0 so a second create is always "outside" it,
      // proving the window boundary rather than waiting real seconds.
      const ctx = await startTestDaemon({ CCMSG_DEDUP_WINDOW_MS: "0" });
      try {
        const a = await session(ctx, "A");
        await session(ctx, "B");
        const first = await a.request<{ room: string; reused: boolean }>({
          op: "create_room",
          members: ["B"],
        });
        const second = await a.request<{ room: string; reused: boolean }>({
          op: "create_room",
          members: ["B"],
        });
        expect(second.reused).toBe(false);
        expect(second.room).not.toBe(first.room);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "next_room writes a next/prev link pair and notifies all members",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const oldRoom = created.room;

        const aSub = await session(ctx, "A");
        const bSub = await session(ctx, "B");
        await aSub.request({ op: "subscribe" });
        await bSub.request({ op: "subscribe" });

        const next = await aPost.request<{ room: string; mid?: number }>({
          op: "next_room",
          room: oldRoom,
          msg: "continued",
        });
        const newRoom = next.room;
        expect(newRoom).not.toBe(oldRoom);
        expect(next.mid).toBe(1); // the carried msg is the first post of the new room

        // old room subscribers see the `next` link pointing at the new room
        const aNext = await aSub.readEventUntil((ev) => ev.r === oldRoom && ev.type === "next");
        expect(aNext.ev.room).toBe(newRoom);

        // B (a member) is notified of the new room: its member events arrive on the new room's stream
        const bNewMember = await bSub.readEventUntil(
          (ev) => ev.r === newRoom && ev.type === "member" && ev.sid === "B",
        );
        expect(bNewMember.ev.uid).toBe(2);

        // the durable link pair is recorded on both sides (DR-0003 §2/§4)
        const oldRead = await aPost.request<{ msgs: unknown[] }>({
          op: "read",
          room: oldRoom,
          mids: "1-99",
        });
        void oldRead;
        const oldFile = fs.readFileSync(path.join(ctx.roomsDir, `${oldRoom}.jsonl`), "utf8");
        const newFile = fs.readFileSync(path.join(ctx.roomsDir, `${newRoom}.jsonl`), "utf8");
        expect(oldFile).toContain(`"type":"next","room":"${newRoom}"`);
        expect(newFile).toContain(`"type":"prev","room":"${oldRoom}"`);

        // next_room is dedup-exempt: a subsequent create_room for A+B does not reuse the new thread
        const create2 = await aPost.request<{ room: string; reused: boolean }>({
          op: "create_room",
          members: ["B"],
        });
        expect(create2.room).not.toBe(newRoom);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "join backlog is capped at N=50; older messages remain reachable via read",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await session(ctx, "B"); // ensure B is a resolvable peer/member
        for (let i = 1; i <= 55; i++) {
          await aPost.request({ op: "post", room, msg: `m${i}` }); // mids 1..55
        }

        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" }); // backlog: member state + last 50 msgs (mids 6..55)

        // post one more so we have a live terminator to read up to
        await aPost.request({ op: "post", room, msg: "m56" }); // mid 56, delivered live to B
        const { seen } = await bSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 56);
        const backlogMids = seen.filter((e) => e.type === "msg" && e.mid <= 55).map((e) => e.mid);
        expect(backlogMids.length).toBe(50);
        expect(Math.min(...backlogMids)).toBe(6); // mids 1..5 dropped from the join snapshot

        // the dropped-from-backlog messages are still fetchable with read
        const old = await bSub.request<{ msgs: { mid: number }[] }>({
          op: "read",
          room,
          mids: "1-5",
        });
        expect(old.msgs.map((m) => m.mid)).toEqual([1, 2, 3, 4, 5]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "subscribe since replays only the positional delta; mids stay contiguous for gap detection",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await session(ctx, "B");
        for (let i = 1; i <= 5; i++) await aPost.request({ op: "post", room, msg: `m${i}` }); // mids 1..5

        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe", since: { [room]: 3 } }); // want everything after mid 3

        await aPost.request({ op: "post", room, msg: "m6" }); // live terminator, mid 6
        const { seen } = await bSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 6);
        const mids = seen.filter((e) => e.type === "msg").map((e) => e.mid);
        // replay = 4,5 (strictly after since=3), then live 6. Contiguity means any gap
        // would be trivially detectable by the client (BBS model, DR-0003 §5).
        expect(mids).toEqual([4, 5, 6]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "uid 0 (User) is an implicit member of every room; a non-member session cannot post",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room; // members: just A (uid 1)

        // the User posts without any member row and is stamped from = 0
        const u = await user(ctx);
        const posted = await u.request<{ ok: boolean; mid: number }>({
          op: "post",
          room,
          msg: "hi from user",
        });
        expect(posted.ok).toBe(true);
        const read = await u.request<{ msgs: { from: number }[] }>({ op: "read", room, mids: "1" });
        expect(read.msgs[0]!.from).toBe(0);

        // a session that isn't a member is refused (only User is implicit)
        const c = await session(ctx, "C");
        const denied = await c.request<{ ok: boolean; error?: { code: string } }>({
          op: "post",
          room,
          msg: "nope",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("not_a_member");

        // the User's subscribe sees every room even without membership
        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe" });
        const seenMsg = await uSub.readEventUntil((ev) => ev.type === "msg" && ev.r === room);
        expect(seenMsg.ev.from).toBe(0);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "notify is ephemeral: delivered to the target stream but never written to storage",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;
        await a.request({ op: "post", room, msg: "real message" }); // a genuine, persisted line

        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });

        // notify --self equivalent: session A signals its own subscribe stream.
        // The delivered event carries `from` stamped from the sender's connection
        // identity — the receiver needs this to tell a self-notify (own sid, actionable)
        // from a peer-notify (another agent, whose command-shaped text must NOT be
        // auto-executed). It is daemon-stamped, never the client's self-claim (DR-0003 §7).
        const notifier = await session(ctx, "A");
        const res = await notifier.request<{ ok: boolean; delivered: number }>({
          op: "notify",
          text: "wake up",
        });
        expect(res.delivered).toBeGreaterThanOrEqual(1);

        const got = await aSub.readEventUntil((ev) => ev.ev === "notify");
        expect(got.ev.text).toBe("wake up");
        // session sender -> from = {role:"session", sid:<sender>}. Same sid as the
        // receiver here, so the receiver would classify this as a self-notify.
        expect(got.ev.from).toEqual({ role: "session", sid: "A" });

        // a User-sent notify targeting A stamps from = {role:"user"} — the receiver would
        // classify this as a peer-notify (sender is not session A) and refuse auto-exec.
        const uNotifier = await user(ctx);
        await uNotifier.request({ op: "notify", sid: "A", text: "from the user" });
        const gotUser = await aSub.readEventUntil(
          (ev) => ev.ev === "notify" && ev.text === "from the user",
        );
        expect(gotUser.ev.from).toEqual({ role: "user" });

        // nothing about the notify hit disk: the room file has the real msg but not the text
        const file = fs.readFileSync(path.join(ctx.roomsDir, `${room}.jsonl`), "utf8");
        expect(file).toContain("real message");
        expect(file).not.toContain("wake up");
        expect(file).not.toContain("from the user");
        // and no stray files were created for the ephemeral signals
        expect(fs.readdirSync(ctx.roomsDir).filter((n) => n.endsWith(".jsonl")).length).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "flock guarantees a single instance: the second daemon process fails to start",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const firstPid = ctx.proc.pid;
        // a second daemon over the same state dir must lose the lock and exit(0) without binding
        const second = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
        const code = await second.exited;
        expect(code).toBe(0);

        // the original is still the one serving: ping reports the first process's pid
        const c = await connect(ctx.sock);
        const pong = await c.request<{ pid: number }>({ op: "ping" });
        expect(pong.pid).toBe(firstPid);
        c.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "graceful shutdown notifies connected clients and removes the socket",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        await a.request({ op: "create_room", members: [] });
        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });

        const ctl = await connect(ctx.sock);
        const ack = await ctl.request<{ ok: boolean; stopping?: boolean }>({
          op: "shutdown",
          reason: "test",
        });
        expect(ack.ok).toBe(true);

        // connected clients get a restarting signal so sidecars know to reconnect (DR-0002 §4)
        const restart = await aSub.readEventUntil((ev) => ev.ev === "restarting");
        expect(restart.ev.reason).toBe("test");

        // the daemon exits cleanly and unlinks its socket
        const code = await ctx.proc.exited;
        expect(code).toBe(0);
        expect(fs.existsSync(ctx.sock)).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "mid is restored across a daemon restart (torn-tail-safe sequence recovery)",
    async () => {
      const base = await startTestDaemon();
      try {
        const a = await session(base, "A");
        const created = await a.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });
        await a.request({ op: "post", room, msg: "m2" });
        a.close();

        // hard restart: kill the process (not graceful), keep the data dir
        base.proc.kill();
        await base.proc.exited;
        const proc2 = spawnDaemonProc(base.stateDir, base.dataDir);
        await waitConnectable(base.sock);

        const a2 = await session(base, "A");
        const p3 = await a2.request<{ mid: number }>({ op: "post", room, msg: "m3" });
        expect(p3.mid).toBe(3); // sequence continued, not reset to 1
        const read = await a2.request<{ msgs: { msg: string }[] }>({
          op: "read",
          room,
          mids: "1-3",
        });
        expect(read.msgs.map((m) => m.msg)).toEqual(["m1", "m2", "m3"]);
        a2.close();

        // tidy the manually-spawned restart process
        const c = await connect(base.sock);
        await c.request({ op: "shutdown" });
        c.close();
        await proc2.exited;
      } finally {
        await stopTestDaemon(base);
      }
    },
    T,
  );
  test(
    "leave removes the member from presentMembers, live delivery, and the rooms listing",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        const aSub = await session(ctx, "A");
        const bLeave = await session(ctx, "B");
        await aSub.request({ op: "subscribe" });

        // leave is a member-only op: uid must resolve and must not be the implicit User (uid 0)
        const left = await bLeave.request<{ ok: boolean; room: string }>({ op: "leave", room });
        expect(left.ok).toBe(true);
        expect(left.room).toBe(room);

        // A's live stream sees the leave event (the leaver is still a recipient too, per
        // server.ts's "capture recipients before membership shrinks" comment, but we only
        // assert on A here since B closed its read loop by requesting leave synchronously)
        const aLeaveEv = await aSub.readEventUntil((ev) => ev.type === "leave");
        expect(aLeaveEv.ev.uid).toBe(2); // B was uid 2 (A=1, B=2 in member order)

        // presentMembers (via rooms listing) no longer lists B
        const rooms = await aPost.request<{ rooms: { id: string; members: { sid: string }[] }[] }>({
          op: "rooms",
        });
        const listed = rooms.rooms.find((r) => r.id === room)!;
        expect(listed.members.map((m) => m.sid)).toEqual(["A"]);

        // live delivery still works for the remaining room after a leave: use the User
        // (uid 0, implicit member of every room, DR-0003 §3) as a third-party observer
        // since A never sees its own post (echo rule).
        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe" });
        await aPost.request({ op: "post", room, msg: "after B left" });
        const uGot = await uSub.readEventUntil((ev) => ev.type === "msg" && ev.r === room);
        expect(uGot.ev.msg).toBe("after B left");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "leave then post: a former member is refused with not_a_member",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const bPost = await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;

        // B posts fine while still a member
        const ok1 = await bPost.request<{ ok: boolean }>({ op: "post", room, msg: "before leave" });
        expect(ok1.ok).toBe(true);

        const bLeave = await session(ctx, "B");
        const left = await bLeave.request<{ ok: boolean }>({ op: "leave", room });
        expect(left.ok).toBe(true);

        // the same B session (a fresh connection, same sid) is no longer a member: post is refused
        const bAfter = await session(ctx, "B");
        const denied = await bAfter.request<{ ok: boolean; error?: { code: string } }>({
          op: "post",
          room,
          msg: "after leave",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("not_a_member");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "leave on an unknown room or by a non-member errors cleanly",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] }); // A is the sole member
        const room = created.room;

        // unknown room -> room_not_found
        const missing = await aPost.request<{ ok: boolean; error?: { code: string } }>({
          op: "leave",
          room: "r-nope",
        });
        expect(missing.ok).toBe(false);
        expect(missing.error!.code).toBe("room_not_found");

        // a session that never joined this room -> not_a_member
        const c = await session(ctx, "C");
        const notMember = await c.request<{ ok: boolean; error?: { code: string } }>({
          op: "leave",
          room,
        });
        expect(notMember.ok).toBe(false);
        expect(notMember.error!.code).toBe("not_a_member");

        // the implicit User (uid 0) is never a real member row, so leave is refused too
        // (uid resolves to USER_UID, which the handler explicitly excludes)
        const u = await user(ctx);
        const userLeave = await u.request<{ ok: boolean; error?: { code: string } }>({
          op: "leave",
          room,
        });
        expect(userLeave.ok).toBe(false);
        expect(userLeave.error!.code).toBe("not_a_member");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "leave is persisted to the room's jsonl and survives a daemon restart",
    async () => {
      const base = await startTestDaemon();
      try {
        const aPost = await session(base, "A");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        const bLeave = await session(base, "B");
        const left = await bLeave.request<{ ok: boolean }>({ op: "leave", room });
        expect(left.ok).toBe(true);
        aPost.close();
        bLeave.close();

        // the leave line is on disk before restart
        const fileBefore = fs.readFileSync(path.join(base.roomsDir, `${room}.jsonl`), "utf8");
        expect(fileBefore).toContain('"type":"leave","uid":2');

        // hard restart (kill, not graceful shutdown) — membership must rebuild from the log
        base.proc.kill();
        await base.proc.exited;
        const proc2 = spawnDaemonProc(base.stateDir, base.dataDir);
        await waitConnectable(base.sock);

        const a2 = await session(base, "A");
        const rooms = await a2.request<{ rooms: { id: string; members: { sid: string }[] }[] }>({
          op: "rooms",
        });
        const listed = rooms.rooms.find((r) => r.id === room)!;
        // B stays left: replaying member+leave from the log yields only A as present
        expect(listed.members.map((m) => m.sid)).toEqual(["A"]);

        // and B (same sid, fresh connection) still can't post post-restart
        const b2 = await session(base, "B");
        const denied = await b2.request<{ ok: boolean; error?: { code: string } }>({
          op: "post",
          room,
          msg: "nope",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("not_a_member");

        const c = await connect(base.sock);
        await c.request({ op: "shutdown" });
        c.close();
        await proc2.exited;
      } finally {
        await stopTestDaemon(base);
      }
    },
    T,
  );
});

describe("error handling & boundaries", () => {
  test(
    "read of an empty room returns no messages; unknown rooms and bad input error cleanly",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({ op: "create_room", members: [] });

        // empty room: valid, just zero messages
        const empty = await a.request<{ ok: boolean; msgs: unknown[] }>({
          op: "read",
          room: created.room,
          mids: "1-5",
        });
        expect(empty.ok).toBe(true);
        expect(empty.msgs.length).toBe(0);

        // unknown room on read and post
        const readMiss = await a.request<{ ok: boolean; error?: { code: string } }>({
          op: "read",
          room: "r-nope",
          mids: "1",
        });
        expect(readMiss.error!.code).toBe("room_not_found");
        const postMiss = await a.request<{ ok: boolean; error?: { code: string } }>({
          op: "post",
          room: "r-nope",
          msg: "x",
        });
        expect(postMiss.error!.code).toBe("room_not_found");

        // malformed request line -> bad_request (not a crash)
        const c = await connect(ctx.sock);
        c.writeRaw("this is not json\n");
        const bad = await c.readEvent<{ ok: boolean; error?: { code: string } }>();
        expect(bad!.error!.code).toBe("bad_request");
        // a JSON object without an op is also bad_request
        c.writeRaw(`${JSON.stringify({ foo: 1 })}\n`);
        const noop = await c.readEvent<{ ok: boolean; error?: { code: string } }>();
        expect(noop!.error!.code).toBe("bad_request");
        c.close();

        // identity-bearing op before hello -> hello_required
        const d = await connect(ctx.sock);
        const early = await d.request<{ ok: boolean; error?: { code: string } }>({
          op: "post",
          room: created.room,
          msg: "x",
        });
        expect(early.error!.code).toBe("hello_required");
        d.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
