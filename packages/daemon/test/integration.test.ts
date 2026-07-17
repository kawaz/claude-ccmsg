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

        await aPost.request({ op: "post", room, msg: "from A" }); // mid 1, from a1
        await bPost.request({ op: "post", room, msg: "from B" }); // mid 2, from a2

        // A's stream skips its own mid 1 (echo) and first sees B's mid 2
        const aFirst = await aSub.readEventUntil((ev) => ev.type === "msg");
        expect(aFirst.ev.mid).toBe(2);
        expect(aFirst.ev.from).toBe("a2");

        // B's stream skips its own mid 2 and first sees A's mid 1
        const bFirst = await bSub.readEventUntil((ev) => ev.type === "msg");
        expect(bFirst.ev.mid).toBe(1);
        expect(bFirst.ev.from).toBe("a1");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // DR-0011 changed `to` from a mention (attention marker, full-room delivery) to a
  // delivery filter: a `to`-bearing msg is now live-delivered only to the listed
  // members, the sender, and the admin User (u1, exempt). This replaces the prior
  // "to is a mention, not a visibility filter: every member is delivered" test, which
  // asserted the opposite (pre-DR-0011) behavior.
  test(
    "to is a delivery filter (DR-0011): only to-listed members, the sender, and admin (u1) are delivered live; excluded members still see the mid gap and can `read`/`rooms` it",
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
        const uSub = await user(ctx);
        await bSub.request({ op: "subscribe" });
        await cSub.request({ op: "subscribe" });
        await aSub.request({ op: "subscribe" });
        await uSub.request({ op: "subscribe" });

        // A sends to only B (a2). C (a3) is excluded from live delivery.
        await aPost.request({ op: "post", room, msg: "hey", to: ["a2"] }); // mid 1

        // the listed member (B) is delivered
        const bGot = await bSub.readEventUntil((ev) => ev.type === "msg");
        expect(bGot.ev.mid).toBe(1);
        expect(bGot.ev.msg).toBe("hey");
        expect(bGot.ev.to).toEqual(["a2"]);

        // admin User (u1) is delivered too — exempt from the filter (DR-0011 §1: the
        // webui is an observation surface, no agent-style context cost for the User).
        const uGot = await uSub.readEventUntil((ev) => ev.type === "msg");
        expect(uGot.ev.mid).toBe(1);

        // C is excluded: a follow-up to-less broadcast (mid 2) is C's FIRST seen msg,
        // proving mid 1 never reached C's stream (events arrive in mid order).
        await bPost.request({ op: "post", room, msg: "broadcast" }); // mid 2, no `to`
        const cGot = await cSub.readEventUntil((ev) => ev.type === "msg");
        expect(cGot.ev.mid).toBe(2);

        // echo suppression (DR-0003 §5) is unchanged by the `to` filter: A's own
        // to-filtered mid 1 is never echoed back; A's first seen msg is B's mid 2.
        const aGot = await aSub.readEventUntil((ev) => ev.type === "msg");
        expect(aGot.ev.mid).toBe(2);

        // storage/read/rooms stay unfiltered (DR-0011 §1-3): C can still pull the
        // skipped mid on request, and the mid gap is visible in `rooms.last_mid`.
        const read = await cSub.request<{ msgs: { mid: number; msg: string }[] }>({
          op: "read",
          room,
          mids: "1",
        });
        expect(read.msgs[0]!.msg).toBe("hey");
        const rooms = await cSub.request<{ rooms: { id: string; last_mid: number }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)!.last_mid).toBe(2);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "to-less msg still delivers to every member (DR-0011: filter only applies when `to` is present)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        await session(ctx, "B"); // register B as a resolvable peer
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });

        await aPost.request({ op: "post", room, msg: "broadcast to all" }); // mid 1, no `to`
        const bGot = await bSub.readEventUntil((ev) => ev.type === "msg");
        expect(bGot.ev.mid).toBe(1);
        expect(bGot.ev.to).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "since replay applies the same to-filter as live delivery (DR-0011 §1-2)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B", "C"],
        });
        const room = created.room;
        await session(ctx, "C");

        // B (a2) is the `to` target throughout; C (a3) never is.
        await aPost.request({ op: "post", room, msg: "m1", to: ["a2"] }); // mid 1, excludes C
        await aPost.request({ op: "post", room, msg: "m2" }); // mid 2, everyone
        await aPost.request({ op: "post", room, msg: "m3", to: ["a2"] }); // mid 3, excludes C

        // C reconnects with since=0 (full replay of everything after mid 0) — the
        // replay path must skip mids 1 and 3 exactly like live delivery would.
        const cSub = await session(ctx, "C");
        await cSub.request({ op: "subscribe", since: { [room]: 0 } });

        await aPost.request({ op: "post", room, msg: "m4" }); // live terminator, mid 4
        const { seen } = await cSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 4);
        const mids = seen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(mids).toEqual([2, 4]); // mid 1, 3 filtered out of the replay

        // meanwhile B (the `to` target) replaying the same since=0 sees every mid,
        // unfiltered — the request's `subscribe` ack arrives first, then the replayed
        // backlog streams as further lines on the same connection.
        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe", since: { [room]: 0 } });
        await aPost.request({ op: "post", room, msg: "m5" }); // live terminator, mid 5
        const { seen: bSeen } = await bSub.readEventUntil(
          (ev) => ev.type === "msg" && ev.mid === 5,
        );
        const bMids = bSeen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(bMids).toEqual([1, 2, 3, 4, 5]); // B (the to-target) sees every mid, unfiltered
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "join-snapshot (subscribe without `since`) applies the same to-filter as live/replay (DR-0011 §1-2)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B", "C"],
        });
        const room = created.room;
        await session(ctx, "C");

        // both posted before anyone subscribes, so the join snapshot (not live delivery
        // or since-replay) is what has to apply the filter here.
        await aPost.request({ op: "post", room, msg: "m1", to: ["a2"] }); // mid 1, excludes C
        await aPost.request({ op: "post", room, msg: "m2" }); // mid 2, everyone

        // C subscribes with no `since`, `backlog: true` — first-time join snapshot path
        // (sendBacklog's non-sinceMid branch, opted into explicitly per issue
        // 2026-07-17-subscribe-no-backlog-default), distinct from the sinceMid replay
        // branch covered above.
        const cSub = await session(ctx, "C");
        await cSub.request({ op: "subscribe", backlog: true });
        const { seen: cSeen } = await cSub.readEventUntil(
          (ev) => ev.type === "msg" && ev.mid === 2,
        );
        const cMids = cSeen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(cMids).toEqual([2]); // mid 1 filtered out of C's join snapshot

        // admin User (u1) is exempt in the join snapshot too, same as live/replay.
        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe", backlog: true });
        const { seen: uSeen } = await uSub.readEventUntil(
          (ev) => ev.type === "msg" && ev.mid === 2,
        );
        const uMids = uSeen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(uMids).toEqual([1, 2]); // u1 sees both
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "member/leave/title/next/prev events ignore the to-filter and always reach every subscriber (DR-0011: msg-only)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B", "C"],
        });
        const room = created.room;
        await session(ctx, "B");
        await session(ctx, "C");

        const cSub = await session(ctx, "C");
        await cSub.request({ op: "subscribe" });

        // even though C is never a `to` target below, a title change is a non-msg
        // event and must still reach C in full.
        await aPost.request({ op: "set_title", room, title: "renamed" });
        const titleGot = await cSub.readEventUntil((ev) => ev.type === "title");
        expect(titleGot.ev.title).toBe("renamed");
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
        expect(bNewMember.ev.id).toBe("a2");

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
        // `backlog: true`: member state + last 50 msgs (mids 6..55) — opted in per issue
        // 2026-07-17-subscribe-no-backlog-default (bare default sends only room_cursors).
        await bSub.request({ op: "subscribe", backlog: true });

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
    // kawaz 2026-07-12: "ユーザ向けはコンテキストとか気にする必要ないのでないなら
    // 全部流し直して" — the DEFAULT_JOIN_BACKLOG=50 cap exists to bound an agent
    // session's context cost, so it stays for session-role joins but is lifted
    // entirely for user-role joins (the webui). Both roles subscribe to the SAME
    // 55-msg room here so the two outcomes are directly comparable.
    "user role の join snapshot は 50 件 cap を受けず全 msg が届く (session role は従来通り 50 cap)",
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
        const u = await user(ctx);
        // `backlog: true` on both (issue 2026-07-17-subscribe-no-backlog-default: bare
        // default sends only room_cursors, not a join snapshot).
        await bSub.request({ op: "subscribe", backlog: true }); // session role: capped join snapshot (mids 6..55)
        await u.request({ op: "subscribe", backlog: true }); // user role (admin): uncapped join snapshot (mids 1..55)

        // post one more so both subscribers have a live terminator to read up to
        await aPost.request({ op: "post", room, msg: "m56" }); // mid 56
        const { seen: bSeen } = await bSub.readEventUntil(
          (ev) => ev.type === "msg" && ev.mid === 56,
        );
        const { seen: uSeen } = await u.readEventUntil((ev) => ev.type === "msg" && ev.mid === 56);

        const bMids = bSeen
          .filter((e: { type: string; mid?: number }) => e.type === "msg" && e.mid! <= 55)
          .map((e: { mid: number }) => e.mid);
        const uMids = uSeen
          .filter((e: { type: string; mid?: number }) => e.type === "msg" && e.mid! <= 55)
          .map((e: { mid: number }) => e.mid);

        expect(bMids.length).toBe(50); // session role: unchanged DEFAULT_JOIN_BACKLOG cap
        expect(Math.min(...bMids)).toBe(6);
        expect(uMids.length).toBe(55); // user role: no cap, every msg replayed
        expect(Math.min(...uMids)).toBe(1);
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
    "id u1 (User) is an implicit member of every room; a non-member session cannot post",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room; // members: just A (a1)

        // the User posts without any member row and is stamped from = "u1"
        const u = await user(ctx);
        const posted = await u.request<{ ok: boolean; mid: number }>({
          op: "post",
          room,
          msg: "hi from user",
        });
        expect(posted.ok).toBe(true);
        const read = await u.request<{ msgs: { from: string }[] }>({ op: "read", room, mids: "1" });
        expect(read.msgs[0]!.from).toBe("u1");

        // a session that isn't a member is refused (only User is implicit)
        const c = await session(ctx, "C");
        const denied = await c.request<{ ok: boolean; error?: { code: string } }>({
          op: "post",
          room,
          msg: "nope",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("not_a_member");

        // the User's subscribe sees every room even without membership. `backlog: true`
        // opts into the join snapshot (issue 2026-07-17-subscribe-no-backlog-default).
        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe", backlog: true });
        const seenMsg = await uSub.readEventUntil((ev) => ev.type === "msg" && ev.r === room);
        expect(seenMsg.ev.from).toBe("u1");
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
    "ping reports provenance: exe is this bun executable, script is this daemon's entry file",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await connect(ctx.sock);
        const pong = await c.request<{ ok: true; exe?: string; script?: string }>({ op: "ping" });
        // exe: the running daemon subprocess's own bun executable — same
        // interpreter this test harness spawned it with (process.execPath),
        // not a hardcoded guess at a bun install location.
        expect(pong.exe).toBe(process.execPath);
        // script: the daemon's entry file — real fs path, ends in the entry
        // module's own filename (index.ts, per spawnDaemonProc's argv).
        expect(pong.script).toBeTruthy();
        expect(pong.script?.endsWith("index.ts")).toBe(true);
        expect(fs.existsSync(pong.script as string)).toBe(true);
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

        // leave is a member-only op: id must resolve and must not be the implicit User (u1)
        const left = await bLeave.request<{ ok: boolean; room: string }>({ op: "leave", room });
        expect(left.ok).toBe(true);
        expect(left.room).toBe(room);

        // A's live stream sees the leave event (the leaver is still a recipient too, per
        // server.ts's "capture recipients before membership shrinks" comment, but we only
        // assert on A here since B closed its read loop by requesting leave synchronously)
        const aLeaveEv = await aSub.readEventUntil((ev) => ev.type === "leave");
        expect(aLeaveEv.ev.id).toBe("a2"); // B was a2 (A=a1, B=a2 in member order)

        // presentMembers (via rooms listing) no longer lists B
        const rooms = await aPost.request<{ rooms: { id: string; members: { sid: string }[] }[] }>({
          op: "rooms",
        });
        const listed = rooms.rooms.find((r) => r.id === room)!;
        expect(listed.members.map((m) => m.sid)).toEqual(["A"]);

        // live delivery still works for the remaining room after a leave: use the User
        // (u1, implicit member of every room, DR-0003 §3) as a third-party observer
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

        // the implicit User (u1) is never a real member row, so leave is refused too
        // (id resolves to ADMIN_ID, which the handler explicitly excludes)
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
        expect(fileBefore).toContain('"type":"leave","id":"a2"');

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
  test(
    "set_title: a member session renames the room, broadcasts the title, and rooms reflects it",
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

        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });

        const renamed = await aPost.request<{ ok: boolean; room: string; title: string }>({
          op: "set_title",
          room,
          title: "new title",
        });
        expect(renamed.ok).toBe(true);
        expect(renamed.room).toBe(room);
        expect(renamed.title).toBe("new title");

        // broadcast: a co-member subscriber sees the title event live (title events go
        // to everyone incl. the actor, unlike msg's echo suppression)
        const got = await bSub.readEventUntil((ev) => ev.type === "title" && ev.r === room);
        expect(got.ev.title).toBe("new title");

        // rooms listing reflects the latest title (last-title-wins, same rule as
        // create_room/next_room titles)
        const rooms = await aPost.request<{ rooms: { id: string; title?: string }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.title).toBe("new title");

        // durable: the title line landed on disk
        const file = fs.readFileSync(path.join(ctx.roomsDir, `${room}.jsonl`), "utf8");
        expect(file).toContain('"type":"title","title":"new title"');
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "set_title: the admin User can also rename any room (implicit member of every room)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;

        const u = await user(ctx);
        const renamed = await u.request<{ ok: boolean; title: string }>({
          op: "set_title",
          room,
          title: "admin renamed",
        });
        expect(renamed.ok).toBe(true);
        expect(renamed.title).toBe("admin renamed");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "set_title: a non-member session is refused with not_a_member",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] }); // A is the sole member
        const room = created.room;

        const c = await session(ctx, "C");
        const denied = await c.request<{ ok: boolean; error?: { code: string } }>({
          op: "set_title",
          room,
          title: "hijacked",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("not_a_member");

        // the room's title is untouched
        const rooms = await aPost.request<{ rooms: { id: string; title?: string }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.title).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "set_title: empty or whitespace-only title is rejected with invalid_args",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;

        const empty = await aPost.request<{ ok: boolean; error?: { code: string } }>({
          op: "set_title",
          room,
          title: "",
        });
        expect(empty.ok).toBe(false);
        expect(empty.error!.code).toBe("invalid_args");

        const whitespace = await aPost.request<{ ok: boolean; error?: { code: string } }>({
          op: "set_title",
          room,
          title: "   ",
        });
        expect(whitespace.ok).toBe(false);
        expect(whitespace.error!.code).toBe("invalid_args");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "set_title: an unknown room errors with room_not_found",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const denied = await a.request<{ ok: boolean; error?: { code: string } }>({
          op: "set_title",
          room: "r-nope",
          title: "x",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("room_not_found");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "set_title: title is trimmed before length-checking and storing",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;

        // leading/trailing whitespace is stripped, not just checked for
        // non-emptiness: the trimmed value is what's echoed back and stored.
        const renamed = await aPost.request<{ ok: boolean; title: string }>({
          op: "set_title",
          room,
          title: " x ",
        });
        expect(renamed.ok).toBe(true);
        expect(renamed.title).toBe("x");

        const rooms = await aPost.request<{ rooms: { id: string; title?: string }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.title).toBe("x");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "set_title: title at SET_TITLE_MAX_LEN (200 UTF-16 code units) is accepted, 201 is rejected",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;

        // boundary: exactly 200 chars is the documented limit (`SET_TITLE_MAX_LEN`,
        // same UTF-16 code-unit unit as the client's <input maxLength={200}>).
        const ok200 = await aPost.request<{ ok: boolean; title: string }>({
          op: "set_title",
          room,
          title: "a".repeat(200),
        });
        expect(ok200.ok).toBe(true);
        expect(ok200.title.length).toBe(200);

        // one char over the boundary is rejected.
        const over = await aPost.request<{ ok: boolean; error?: { code: string } }>({
          op: "set_title",
          room,
          title: "a".repeat(201),
        });
        expect(over.ok).toBe(false);
        expect(over.error!.code).toBe("invalid_args");

        // the rejected attempt didn't clobber the previously-accepted title.
        const rooms = await aPost.request<{ rooms: { id: string; title?: string }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.title).toBe("a".repeat(200));
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "archive_room: a member session toggles archived, broadcasts an archive event, and rooms reflects it; re-asserting the same value is a no-op (no extra append/broadcast)",
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

        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });

        // set archived: true
        const archived = await aPost.request<{ ok: boolean; room: string; archived: boolean }>({
          op: "archive_room",
          room,
          archived: true,
        });
        expect(archived.ok).toBe(true);
        expect(archived.archived).toBe(true);

        // broadcast: an archive event goes to every subscriber incl. the actor
        // (same non-msg broadcast rule as title/leave/member).
        const got = await bSub.readEventUntil((ev) => ev.type === "archive" && ev.r === room);
        expect(got.ev.archived).toBe(true);

        // rooms reflects the flag
        const roomsAfterSet = await aPost.request<{ rooms: { id: string; archived?: boolean }[] }>({
          op: "rooms",
        });
        expect(roomsAfterSet.rooms.find((r) => r.id === room)?.archived).toBe(true);

        // durable: the archive line landed on disk
        const file = fs.readFileSync(path.join(ctx.roomsDir, `${room}.jsonl`), "utf8");
        expect(file).toContain('"type":"archive","archived":true');

        // re-asserting the same value (true -> true) is an idempotent no-op: it
        // succeeds but appends/broadcasts nothing (DR-0012 toggle semantics).
        const reassert = await aPost.request<{ ok: boolean; archived: boolean }>({
          op: "archive_room",
          room,
          archived: true,
        });
        expect(reassert.ok).toBe(true);
        expect(reassert.archived).toBe(true);
        // confirm no-op by checking no second archive line was appended
        const fileAfterReassert = fs.readFileSync(path.join(ctx.roomsDir, `${room}.jsonl`), "utf8");
        expect((fileAfterReassert.match(/"type":"archive"/g) ?? []).length).toBe(1);

        // unset archived: false
        const unarchived = await aPost.request<{ ok: boolean; archived: boolean }>({
          op: "archive_room",
          room,
          archived: false,
        });
        expect(unarchived.ok).toBe(true);
        expect(unarchived.archived).toBe(false);
        const gotUnset = await bSub.readEventUntil(
          (ev) => ev.type === "archive" && ev.r === room && ev.archived === false,
        );
        expect(gotUnset.ev.archived).toBe(false);

        // rooms omits the field once unarchived (false = field absent, RoomSummary contract)
        const roomsAfterUnset = await aPost.request<{
          rooms: { id: string; archived?: boolean }[];
        }>({ op: "rooms" });
        expect(roomsAfterUnset.rooms.find((r) => r.id === room)?.archived).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "archive_room: the admin User can also toggle any room (implicit member of every room)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;

        const u = await user(ctx);
        const archived = await u.request<{ ok: boolean; archived: boolean }>({
          op: "archive_room",
          room,
          archived: true,
        });
        expect(archived.ok).toBe(true);
        expect(archived.archived).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "archive_room: a non-member session is refused with not_a_member",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] }); // A is the sole member
        const room = created.room;

        const c = await session(ctx, "C");
        const denied = await c.request<{ ok: boolean; error?: { code: string } }>({
          op: "archive_room",
          room,
          archived: true,
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("not_a_member");

        const rooms = await aPost.request<{ rooms: { id: string; archived?: boolean }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.archived).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "kick: the admin User force-leaves a member, broadcasts the same LeaveEvent a voluntary leave would, and rooms reflects it",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const bPost = await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room; // A=a1, B=a2

        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });

        const u = await user(ctx);
        const kicked = await u.request<{ ok: boolean; room: string; id: string }>({
          op: "kick",
          room,
          id: "a2",
        });
        expect(kicked.ok).toBe(true);
        expect(kicked.room).toBe(room);
        expect(kicked.id).toBe("a2");

        // broadcast: a remaining member sees the leave event live, identical shape to
        // a voluntary leave (type/id/ts only, no kick-specific marker on the wire).
        const got = await aSub.readEventUntil((ev) => ev.type === "leave" && ev.r === room);
        expect(got.ev.id).toBe("a2");

        // rooms no longer lists the kicked member
        const rooms = await aPost.request<{ rooms: { id: string; members: { id: string }[] }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.members.map((m) => m.id)).toEqual(["a1"]);

        // durable: the leave line landed on disk
        const file = fs.readFileSync(path.join(ctx.roomsDir, `${room}.jsonl`), "utf8");
        expect(file).toContain('"type":"leave","id":"a2"');

        // kicked-out session is no longer a member: further posts are refused
        const afterKick = await bPost.request<{ ok: boolean; error?: { code: string } }>({
          op: "post",
          room,
          msg: "still here?",
        });
        expect(afterKick.ok).toBe(false);
        expect(afterKick.error!.code).toBe("not_a_member");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "kick: a member session (non-admin) is refused — kick is admin-User-only, unlike leave",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room; // A=a1, B=a2

        const denied = await aPost.request<{ ok: boolean; error?: { code: string } }>({
          op: "kick",
          room,
          id: "a2",
        });
        expect(denied.ok).toBe(false);
        // straight permission rejection, not not_a_member (same pattern as the other
        // user-role-only ops, e.g. "agents"/"transcript_subscribe").
        expect(denied.error!.code).toBe("bad_request");

        // B is still a member — the rejected kick didn't touch membership
        const rooms = await aPost.request<{ rooms: { id: string; members: { id: string }[] }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.members.map((m) => m.id)).toEqual([
          "a1",
          "a2",
        ]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "kick: a non-member id is rejected with invalid_args, including the implicit admin (u1) itself",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] }); // A=a1 only
        const room = created.room;

        const u = await user(ctx);

        // an id that was never a member of this room
        const unknownId = await u.request<{ ok: boolean; error?: { code: string } }>({
          op: "kick",
          room,
          id: "a99",
        });
        expect(unknownId.ok).toBe(false);
        expect(unknownId.error!.code).toBe("invalid_args");

        // the implicit admin (u1) has no member row and is never kickable, even by
        // itself: naturally falls out of the presentIds check as invalid_args.
        const selfKick = await u.request<{ ok: boolean; error?: { code: string } }>({
          op: "kick",
          room,
          id: "u1",
        });
        expect(selfKick.ok).toBe(false);
        expect(selfKick.error!.code).toBe("invalid_args");

        // membership untouched by either rejected attempt
        const rooms = await aPost.request<{ rooms: { id: string; members: { id: string }[] }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === room)?.members.map((m) => m.id)).toEqual(["a1"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "kick: a kicked member can be re-invited (kick is not a ban, DR-0012)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const bPost = await session(ctx, "B");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room; // A=a1, B=a2

        const u = await user(ctx);
        const kicked = await u.request<{ ok: boolean }>({ op: "kick", room, id: "a2" });
        expect(kicked.ok).toBe(true);

        // B, still connected, can be re-invited — no re-join restriction (kawaz
        // 2026-07-12: 「再joinを制限までは今のとこ不要」).
        const reinvited = await aPost.request<{ ok: boolean; id: string; already: boolean }>({
          op: "invite",
          room,
          sid: "B",
        });
        expect(reinvited.ok).toBe(true);
        expect(reinvited.already).toBe(false);

        // B can post again post-reinvite
        const posted = await bPost.request<{ ok: boolean }>({ op: "post", room, msg: "back" });
        expect(posted.ok).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "kick: an unknown room errors with room_not_found",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const denied = await u.request<{ ok: boolean; error?: { code: string } }>({
          op: "kick",
          room: "r-nope",
          id: "a1",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("room_not_found");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "invite: a member session adds a connected, non-member session and it's live-broadcast to existing subscribers",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] }); // A only (a1)
        const room = created.room;

        // B must be a currently connected session (invite reads the live registry,
        // same as create_room's `members`) but is NOT yet a member of the room.
        await session(ctx, "B");

        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });

        const invited = await aPost.request<{
          ok: boolean;
          room: string;
          id: string;
          already: boolean;
        }>({ op: "invite", room, sid: "B" });
        expect(invited.ok).toBe(true);
        expect(invited.room).toBe(room);
        expect(invited.already).toBe(false);
        expect(invited.id).toBe("a2"); // next free agent-namespace id after A's a1

        // broadcast: an existing subscriber sees the new MemberEvent live (member
        // events go to everyone incl. the actor, same as title/leave — DR-0011 §1 only
        // filters `msg`). aSub's subscribe backlog snapshot already delivered A's own
        // member row (a1), so filter specifically for the invited id.
        const got = await aSub.readEventUntil(
          (ev) => ev.type === "member" && ev.r === room && ev.id === "a2",
        );
        expect(got.ev.sid).toBe("B");

        // B is now a resolvable member and can post
        const bPost = await session(ctx, "B");
        const posted = await bPost.request<{ ok: boolean; mid: number }>({
          op: "post",
          room,
          msg: "hi, I'm in",
        });
        expect(posted.ok).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "invite: an already-subscribed target gets the full room snapshot (title/members/backlog), not just the bare MemberEvent line",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] }); // A only (a1)
        const room = created.room;
        await aPost.request({ op: "set_title", room, title: "pre-invite title" });
        await aPost.request({ op: "post", room, msg: "hello before you joined" }); // mid 1

        // B connects and subscribes BEFORE being invited — while not yet a member, its
        // initial subscribe snapshot must skip this room entirely (subscriberSeesRoom is
        // false), so anything it later sees for `room` has to come from the invite path.
        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });

        await aPost.request({ op: "invite", room, sid: "B" });

        // the snapshot arrives as an ordered burst (member A, title, msg mid 1, member
        // B) — wait for the LAST one (B's own member row) and inspect everything seen
        // along the way, rather than chaining separate readEventUntil calls (which
        // would each discard earlier events and deadlock on the second wait).
        const { seen } = await bSub.readEventUntil((ev) => ev.type === "member" && ev.sid === "B");

        // B must have received the pre-existing msg (mid 1) as part of its post-invite
        // snapshot — a plain live-broadcast of the invite's own MemberEvent (the prior
        // behavior) could never carry it, since mid 1 predates B's membership.
        const hello = seen.find((ev) => ev.type === "msg" && ev.msg === "hello before you joined");
        expect(hello?.mid).toBe(1);

        // the room title (set before B joined) is also part of the snapshot.
        const title = seen.find((ev) => ev.type === "title");
        expect(title?.title).toBe("pre-invite title");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "invite: the admin User can also invite (implicit member of every room)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;
        await session(ctx, "B");

        const u = await user(ctx);
        const invited = await u.request<{ ok: boolean; id: string; already: boolean }>({
          op: "invite",
          room,
          sid: "B",
        });
        expect(invited.ok).toBe(true);
        expect(invited.already).toBe(false);
        expect(invited.id).toBe("a2");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "invite: a non-member session is refused with not_a_member",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] }); // A is the sole member
        const room = created.room;
        await session(ctx, "B");

        const c = await session(ctx, "C"); // C is connected but not a member of `room`
        const denied = await c.request<{ ok: boolean; error?: { code: string } }>({
          op: "invite",
          room,
          sid: "B",
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
    "invite: an unconnected sid errors with session_not_found",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({ op: "create_room", members: [] });
        const room = created.room;

        const denied = await aPost.request<{ ok: boolean; error?: { code: string } }>({
          op: "invite",
          room,
          sid: "ghost-not-connected",
        });
        expect(denied.ok).toBe(false);
        expect(denied.error!.code).toBe("session_not_found");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "invite: inviting an already-member session is a no-op, returning already:true and the existing id",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created = await aPost.request<{ room: string }>({
          op: "create_room",
          members: ["B"], // B is already a member (a2) from room creation
        });
        const room = created.room;
        await session(ctx, "B");

        const invited = await aPost.request<{ ok: boolean; id: string; already: boolean }>({
          op: "invite",
          room,
          sid: "B",
        });
        expect(invited.ok).toBe(true);
        expect(invited.already).toBe(true);
        expect(invited.id).toBe("a2");

        // no new member line was appended: rooms still lists exactly A and B
        const rooms = await aPost.request<{ rooms: { id: string; members: { id: string }[] }[] }>({
          op: "rooms",
        });
        const ids = rooms.rooms.find((r) => r.id === room)!.members.map((m) => m.id);
        expect(ids.sort()).toEqual(["a1", "a2"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "invite marks the room dedup-ineligible, so a later create_room with the original sids doesn't fold a stranger back in",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const created1 = await aPost.request<{ room: string; reused: boolean }>({
          op: "create_room",
          members: ["B"],
        });
        const room1 = created1.room;
        expect(created1.reused).toBe(false);
        await session(ctx, "B");
        await session(ctx, "C");

        // C joins room1 via invite — NOT part of room1's original dedupKey ("A,B").
        await aPost.request({ op: "invite", room: room1, sid: "C" });

        // within the dedup window, A calls create_room with the exact same sid set
        // ["A","B"] again. Pre-fix, dedupKey/dedupEligible are untouched by invite, so
        // this would fold into room1 — dropping the initial msg into a room C can see,
        // even though C was never part of this create_room call.
        const created2 = await aPost.request<{ room: string; reused: boolean }>({
          op: "create_room",
          members: ["B"],
          msg: "fresh start",
        });
        expect(created2.reused).toBe(false);
        expect(created2.room).not.toBe(room1);

        const rooms = await aPost.request<{
          rooms: { id: string; members: { id: string }[] }[];
        }>({ op: "rooms" });
        const room2Members = rooms.rooms
          .find((r) => r.id === created2.room)!
          .members.map((m) => m.id);
        expect(room2Members.sort()).toEqual(["a1", "a2"]); // A, B only — no C
      } finally {
        await stopTestDaemon(ctx);
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
