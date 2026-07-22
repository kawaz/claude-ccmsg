// DR-0013 broadcast room integration: auto-populate, subscribe filter, agent
// post constraint, --members warning, next_room kind inheritance, initial msg
// exemption, archive on broadcast, kind persistence across daemon restart.
//
// Each test spawns a real daemon in a temp dir (helpers.ts's startTestDaemon)
// and drives it through UDS — the same harness integration.test.ts uses, so
// the wire-level protocol contract stays exercised end-to-end rather than
// mocking the storage/dispatch seam.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
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

/** Read events on `sub` up to (and including) the first msg with `pred(ev)`
 * true. Returns the intervening event stream too, so a test can assert both
 * "we got the msg we wanted" AND "we did NOT see a broadcast member/leave in
 * between" (§2.3 stream-filter contract). Bun's test-level timeout backs the
 * wait, so an event that never arrives fails the test — no local timeout knob
 * is needed. */
async function readUntilMsg(sub: TestClient, pred: (ev: any) => boolean = () => true) {
  return sub.readEventUntil((ev) => ev.type === "msg" && pred(ev));
}

describe("DR-0013 broadcast room", () => {
  // 何を保証するか (§2.9): agent that creates a broadcast room with an explicit
  // --members list gets `warning` in the response body AND the actual member
  // list ignores that explicit list — auto-populate is the sole population
  // source. The warning field is what surfaces in the CLI's stderr echo
  // (cli/src/index.ts's output() helper).
  test(
    "broadcast create_room ignores explicit --members and returns a warning",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // A pre-registers so it's an active peer at broadcast create time
        await session(ctx, "A");
        const creator = await user(ctx);
        const res = await creator.request<{
          ok: true;
          room: string;
          reused: boolean;
          warning?: string;
        }>({
          op: "create_room",
          members: ["X", "Y"], // explicit list — should be ignored
          kind: "broadcast",
          title: "dev broadcast",
        });
        expect(res.ok).toBe(true);
        expect(res.warning).toBe(
          "--members is ignored for broadcast rooms (members are auto-populated)",
        );
        const rooms = await creator.request<{
          rooms: { id: string; kind?: string; members: { sid: string }[] }[];
        }>({ op: "rooms" });
        const room = rooms.rooms.find((r) => r.id === res.room)!;
        // §2.1 rooms response surfaces kind so the CLI/webui can badge
        expect(room.kind).toBe("broadcast");
        // Only the active peer A (auto-populated) is a member — X/Y from the
        // explicit list are dropped along with the warning.
        expect(room.members.map((m) => m.sid)).toEqual(["A"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.2 「broadcast room 作成時に既に active な session も
  // 同一契機で自動 join する」): every currently-connected session at create
  // time lands in the initial member list, sorted by sid so a1/a2/... is
  // deterministic. u1 stays implicit (no row) per DR-0006 §2.
  test(
    "broadcast create_room snapshots every active session as initial members",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await session(ctx, "A");
        await session(ctx, "B");
        await session(ctx, "C");
        const creator = await user(ctx);
        const res = await creator.request<{ ok: true; room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const rooms = await creator.request<{
          rooms: { id: string; members: { id: string; sid: string }[] }[];
        }>({ op: "rooms" });
        const room = rooms.rooms.find((r) => r.id === res.room)!;
        expect(room.members.map((m) => m.sid)).toEqual(["A", "B", "C"]);
        expect(room.members.map((m) => m.id)).toEqual(["a1", "a2", "a3"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.2 「hello 到達 → その session を全 broadcast room に
  // 自動 join」+ §2.3 「subscribe stream には配信しない」): a session that
  // hellos AFTER broadcast creation is added to every existing broadcast room
  // via the auto-populate hook. The added MemberEvent must NOT appear on any
  // existing subscriber's stream — the sender A here sends the first msg on
  // the new broadcast so the test can positively confirm "the first thing A
  // saw was that msg, not the intervening member/leave event".
  test(
    "post-creation hello auto-joins every broadcast room; the join is NOT streamed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // A is an early peer + subscribes so we can drain its stream later
        const aPost = await session(ctx, "A");
        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });
        // u1 creates a broadcast; A is initial member (a1)
        const creator = await user(ctx);
        const res = await creator.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const room = res.room;
        // B hellos AFTER the broadcast was created → auto-join
        await session(ctx, "B");
        // The broadcast now has a1=A and a2=B (sids sorted deterministically
        // via auto-populate; nextAgentMemberId picks the next free `a`).
        const rooms = await creator.request<{
          rooms: { id: string; members: { id: string; sid: string }[] }[];
        }>({ op: "rooms" });
        const roomMembers = rooms.rooms.find((r) => r.id === room)!.members;
        expect(roomMembers.some((m) => m.sid === "B")).toBe(true);
        // A sends a post so we have a positive marker to read towards. Include
        // u1 in `to` since A is an agent — see the constraint test below.
        await aPost.request({ op: "post", room, msg: "hi", to: ["u1"] });
        // A subscribed BEFORE B joined; A should NOT see a member ev for B on
        // its stream (§2.3 suppresses broadcast member/leave from live and
        // backlog alike). What we DO see first (skipping the initial snapshot
        // that already populated a1=A) is msg mid=1 (A's own post is echo-
        // suppressed — so the FIRST msg we see would be someone else's; A
        // has no co-broadcaster to receive from here, so instead we assert
        // NO member ev for B appeared in the initial snapshot either).
        // Drain what's available up to the msg from another poster? A is the
        // only poster, so echo suppression means A won't see its own mid=1
        // either. Instead, use u1's stream: u1 subscribes, then A posts, we
        // assert u1's next event after the snapshot is the msg (no member
        // interleave), which is the observable proof.
        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe" });
        // Second post to guarantee u1 has a fresh msg to read past its own
        // backlog. Same u1-in-to rule for A.
        await aPost.request({ op: "post", room, msg: "hi2", to: ["u1"] });
        const seen = await readUntilMsg(uSub, (ev) => ev.msg === "hi2");
        // Nothing in u1's stream between subscribe and receiving hi2 should
        // be a broadcast member/leave event (§2.3). u1 sees rooms other than
        // the broadcast one, but any member events THERE are unrelated to A/B
        // and don't reference the broadcast room's id — filter to broadcast-
        // room events only.
        const broadcastLifecycle = seen.seen.filter(
          (ev: any) => ev.r === room && (ev.type === "member" || ev.type === "leave"),
        );
        expect(broadcastLifecycle).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.4 「role:"session" (agent) からの post は `to` に "u1"
  // を含めることを必須」): an agent's post with no `to` at all is rejected
  // with the DR's new dedicated error code. This is the one place the
  // broadcast contract shows up on the receiving side of a `post` request,
  // so it needs its own test — otherwise a regression in the u1-in-to check
  // would silently degrade to "agent broadcasts fall back to full-room
  // delivery", exactly the failure mode §2.4 was written to prevent.
  test(
    "agent post without u1 in to is rejected with broadcast_agent_target_required",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const creator = await user(ctx);
        const res = await creator.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const room = res.room;

        // No `to` at all
        const rNo = await aPost.request<{
          ok: false;
          error: { code: string; msg: string };
        }>({ op: "post", room, msg: "no to" });
        expect(rNo.ok).toBe(false);
        expect(rNo.error.code).toBe("broadcast_agent_target_required");

        // `to` with only another agent, no u1
        const rNoU1 = await aPost.request<{ ok: false; error: { code: string } }>({
          op: "post",
          room,
          msg: "peer only",
          to: ["a2"],
        });
        expect(rNoU1.ok).toBe(false);
        expect(rNoU1.error.code).toBe("broadcast_agent_target_required");

        // u1 alone succeeds
        const rOk = await aPost.request<{ ok: true; mid: number }>({
          op: "post",
          room,
          msg: "hi u1",
          to: ["u1"],
        });
        expect(rOk.ok).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 「u1 (User) post には制約なし」): the u1-in-to rule
  // is scoped to role:"session"; a role:"user" (webui backend) post to a
  // broadcast room follows exactly the DR-0011 to-filter semantics — omit for
  // full-room delivery, single member for 1:1, list for a set. Regression
  // guard for accidentally over-scoping the u1-required check to all posters.
  test(
    "user (u1) post to a broadcast has no u1-in-to constraint",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await session(ctx, "A");
        await session(ctx, "B");
        const creator = await user(ctx);
        const res = await creator.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const room = res.room;
        // Omit to (full-room)
        const r1 = await creator.request<{ ok: true }>({
          op: "post",
          room,
          msg: "全員へ",
        });
        expect(r1.ok).toBe(true);
        // to: ["a1"] individual
        const r2 = await creator.request<{ ok: true }>({
          op: "post",
          room,
          msg: "to a1",
          to: ["a1"],
        });
        expect(r2.ok).toBe(true);
        // to: ["a1","a2"] multi
        const r3 = await creator.request<{ ok: true }>({
          op: "post",
          room,
          msg: "to both",
          to: ["a1", "a2"],
        });
        expect(r3.ok).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.10 「初期 msg は u1 発の post とみなして受け入れる」):
  // create_room{kind:"broadcast", msg}'s initial msg does NOT go through the
  // §2.4 agent-must-target-u1 rule even when the caller is a session — the
  // DR explicitly carves this out ("u1 発話に対して「u1 宛必須」を課すのは
  // 意味論的におかしい"). Regression guard so a future refactor that unifies
  // "post" and "create_room's initial msg" through the same check doesn't
  // accidentally start rejecting a session-caller's opener.
  test(
    "broadcast create_room initial msg is exempt from the agent-must-target-u1 rule",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        // A (a session) opens a broadcast with an initial msg — the u1-in-to
        // rule would apply to a plain `post` from A, but §2.10 excludes it
        // from the create_room's own initial msg. `to` omitted deliberately.
        const res = await a.request<{ ok: true; room: string; mid?: number }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
          msg: "opening",
        });
        expect(res.ok).toBe(true);
        expect(res.mid).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.8 「next_room で作られる新 room は kind を継承」):
  // spawning the next thread of a broadcast keeps the auto-populate + post
  // constraint on the new room too. Verified via the observable effects: the
  // new room's kind is broadcast in `rooms` AND an agent posting to it
  // without u1-in-to gets the same rejection as the original.
  test(
    "next_room from a broadcast produces another broadcast (kind inherited)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aPost = await session(ctx, "A");
        const creator = await user(ctx);
        const parent = await creator.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        // next_room is issued by a member session (A is a1 in the parent)
        const nextRes = await aPost.request<{ ok: true; room: string }>({
          op: "next_room",
          room: parent.room,
        });
        const nextRoom = nextRes.room;
        const rooms = await creator.request<{ rooms: { id: string; kind?: string }[] }>({
          op: "rooms",
        });
        expect(rooms.rooms.find((r) => r.id === nextRoom)!.kind).toBe("broadcast");
        // §2.4 constraint applies to the new room too
        const rej = await aPost.request<{ ok: false; error: { code: string } }>({
          op: "post",
          room: nextRoom,
          msg: "no to",
        });
        expect(rej.ok).toBe(false);
        expect(rej.error.code).toBe("broadcast_agent_target_required");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.8 「archive_room は broadcast room に対しても通常 room と
  // 同じ挙動」): archiving a broadcast toggles its archived flag and delivers
  // the ArchiveEvent to subscribers just like a normal-kind room. Non-msg
  // storage events (title/archive/link) are NOT part of §2.3's suppression
  // list — only member/leave — so subscribers must still see the archive
  // toggle.
  test(
    "archive_room works on broadcast rooms (still emits ArchiveEvent to the stream)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await session(ctx, "A");
        const creator = await user(ctx);
        const res = await creator.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const room = res.room;

        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe" });

        const arch = await creator.request<{ ok: true; archived: boolean }>({
          op: "archive_room",
          room,
          archived: true,
        });
        expect(arch.archived).toBe(true);

        // u1's stream sees the archive event on the broadcast room
        const got = await uSub.readEventUntil((ev: any) => ev.type === "archive" && ev.r === room);
        expect((got.ev as any).archived).toBe(true);

        const rooms = await creator.request<{
          rooms: { id: string; archived?: boolean }[];
        }>({ op: "rooms" });
        expect(rooms.rooms.find((r) => r.id === room)!.archived).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.2 「disconnect (session 終了) → 全 broadcast room から
  // 自動 leave」+ §2.3 stream suppression): when a session closes its last
  // conn, the daemon appends LeaveEvents to every broadcast room the sid was
  // in, but doesn't stream those to subscribers. Observable proof: the next
  // `rooms` snapshot shows the sid dropped, AND a subscribed u1 sees no
  // leave event before its next post-close signal (a fresh archive toggle,
  // which is NOT suppressed).
  test(
    "session disconnect auto-leaves every broadcast; the leave is NOT streamed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        await session(ctx, "B");
        const creator = await user(ctx);
        const res = await creator.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const room = res.room;

        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe" });

        // A closes — its sole conn disappears, sessions.delete(sid=A) fires,
        // leaveAllBroadcasts appends the LeaveEvent (in-jsonl but not
        // streamed).
        a.close();
        // Give the daemon a chance to observe the close event and process
        // detachSession → leaveAllBroadcasts. connectable-based sync would be
        // overkill here; the follow-up archive toggle below provides a
        // deterministic barrier: it must land AFTER the daemon has fully
        // processed A's close (both operate on daemon.sessions/daemon.rooms
        // through the same request queue).
        await new Promise((r) => setTimeout(r, 50));

        // Post-close snapshot: A dropped from the broadcast member list
        const rooms = await creator.request<{
          rooms: { id: string; members: { sid: string }[] }[];
        }>({ op: "rooms" });
        const members = rooms.rooms.find((r) => r.id === room)!.members;
        expect(members.map((m) => m.sid)).toEqual(["B"]);

        // Nothing streamed in the meantime that mentions the broadcast leave.
        // Send a fresh archive toggle as the "next synchronous stream marker"
        // — u1's stream should reach the archive event with NO intervening
        // leave-type event referencing this broadcast room.
        await creator.request({ op: "archive_room", room, archived: true });
        const got = await uSub.readEventUntil((ev: any) => ev.type === "archive" && ev.r === room);
        const leaveInBetween = got.seen.filter((ev: any) => ev.r === room && ev.type === "leave");
        expect(leaveInBetween).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (kind の永続化): the KindEvent lands in the jsonl and is
  // recovered by scanRooms on daemon restart — so a broadcast room stays
  // broadcast (auto-populate keeps running, u1-in-to keeps enforced) across
  // a `daemon stop` / restart cycle. Regression guard for the persistence
  // strategy: storing kind as a separate event is meaningless if computeDerived
  // ignores it or scanRooms drops the events, so we exercise the whole path.
  test(
    "kind persists across a daemon restart (KindEvent recovered by scanRooms)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await session(ctx, "A");
        {
          const creator = await user(ctx);
          const res = await creator.request<{ room: string }>({
            op: "create_room",
            members: [],
            kind: "broadcast",
          });
          // sanity: file exists on disk
          const file = `${ctx.roomsDir}/${res.room}.jsonl`;
          expect(fs.existsSync(file)).toBe(true);
          const raw = fs.readFileSync(file, "utf8");
          // KindEvent line is present (line-oriented match, not JSON parse:
          // storage is append-only jsonl, so grep is the natural verifier)
          expect(raw).toContain('"type":"kind"');
          expect(raw).toContain('"kind":"broadcast"');
          creator.close();
        }
        // Bounce the daemon: stop it, spawn a fresh process on the same
        // paths — helpers.startTestDaemon's makeEnv isn't reusable in-place,
        // so we drive the underlying spawnDaemonProc / waitConnectable
        // directly. The socket file was cleaned up by graceful shutdown.
        const c = await connect(ctx.sock);
        await c.request({ op: "shutdown" });
        c.close();
        await ctx.proc.exited;
        try {
          fs.unlinkSync(ctx.sock);
        } catch {
          // shutdown usually cleans it up; ignore if already gone
        }
        const proc2 = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
        // helpers waitConnectable + graceful shutdown swap
        ctx.proc = proc2;
        await waitConnectable(ctx.sock);

        // After restart, rooms reports the room as broadcast still
        const c2 = await user(ctx);
        const rooms = await c2.request<{
          rooms: { id: string; kind?: string }[];
        }>({ op: "rooms" });
        const bcast = rooms.rooms.find((r) => r.kind === "broadcast");
        expect(bcast).toBeDefined();

        // And the u1-in-to constraint still applies — proves computeDerived
        // set room.kind = "broadcast", not just that the KindEvent is in the
        // jsonl.
        const aAfter = await session(ctx, "A");
        const rej = await aAfter.request<{ ok: false; error: { code: string } }>({
          op: "post",
          room: bcast!.id,
          msg: "no to",
        });
        expect(rej.ok).toBe(false);
        expect(rej.error.code).toBe("broadcast_agent_target_required");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (data quality): daemon restart で同一 sid が re-hello しても、
  // 既に自分の member 行を持っている broadcast room の jsonl に MemberEvent を
  // 二重追記しない。isSuppressedForBroadcastStream が subscriber からは見えなく
  // していても、jsonl そのものは source of truth なので毎回 restart する度に
  // 重複行が蓄積するのはデータ品質バグ (issue
  // 2026-07-22-joinallbroadcasts-duplicate-member-rows)。
  test(
    "restart + re-hello does not append duplicate member rows to broadcast jsonl",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // First run: A hellos, broadcast room is created and auto-populates A.
        await session(ctx, "A");
        {
          const creator = await user(ctx);
          const res = await creator.request<{ room: string }>({
            op: "create_room",
            members: [],
            kind: "broadcast",
          });
          creator.close();
          const file = `${ctx.roomsDir}/${res.room}.jsonl`;
          const before = fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter((l) => l.includes('"type":"member"') && l.includes('"sid":"A"'));
          expect(before.length).toBe(1);

          // Bounce the daemon on the same paths.
          const c = await connect(ctx.sock);
          await c.request({ op: "shutdown" });
          c.close();
          await ctx.proc.exited;
          try {
            fs.unlinkSync(ctx.sock);
          } catch {}
          const proc2 = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
          ctx.proc = proc2;
          await waitConnectable(ctx.sock);

          // A re-hellos three restart cycles in a row (fresh daemon in-memory
          // sessions map ⇒ isNewEntry=true, which historically walked
          // joinAllBroadcasts and appended a NEW MemberEvent every restart
          // cycle).
          for (let i = 0; i < 3; i++) {
            await session(ctx, "A");
            await Bun.sleep(50);
            const c2 = await connect(ctx.sock);
            await c2.request({ op: "shutdown" });
            c2.close();
            await ctx.proc.exited;
            try {
              fs.unlinkSync(ctx.sock);
            } catch {}
            ctx.proc = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
            await waitConnectable(ctx.sock);
          }
          // Final re-hello and read
          await session(ctx, "A");
          await Bun.sleep(50);
          const after = fs
            .readFileSync(file, "utf8")
            .split("\n")
            .filter((l) => l.includes('"type":"member"') && l.includes('"sid":"A"'));
          expect(after.length).toBe(1);
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (data quality, real production path): 同一 sid が
  // disconnect (leaveAllBroadcasts → LeaveEvent) してから re-hello しても、
  // broadcast room jsonl に MemberEvent を二重追記しない。実運用の r*.jsonl で
  // 大量に観測された蓄積経路は「daemon restart」ではなく「短命 CLI 接続 or
  // subscribe drop で detachSession → leave が書かれた後の re-hello」。
  // guard は memberIdBySid ベースだが、broadcast 特別扱いで leave を無視する
  // ので、かつて join した sid は永続的に「member 扱い」となり join guard が
  // 発動する (issue 2026-07-22-joinallbroadcasts-duplicate-member-rows)。
  test(
    "disconnect + re-hello does not append duplicate member rows to broadcast jsonl",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // Session A joins, broadcast is created (A auto-populates as a1).
        const a1 = await session(ctx, "A");
        const creator = await user(ctx);
        const res = await creator.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const file = `${ctx.roomsDir}/${res.room}.jsonl`;
        const initial = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.includes('"type":"member"') && l.includes('"sid":"A"'));
        expect(initial.length).toBe(1);

        // Drive several disconnect + rehello cycles — the exact live shape of
        // the production dup source (transient ccmsg CLI calls that hello,
        // do work, then close; each cycle detachSession → leaveAllBroadcasts
        // → LeaveEvent, then the next hello historically triggered a new
        // MemberEvent append).
        a1.close();
        for (let i = 0; i < 4; i++) {
          // let the daemon observe the previous close (detachSession →
          // leaveAllBroadcasts is synchronous inside removeConn)
          await Bun.sleep(30);
          const c = await session(ctx, "A");
          await Bun.sleep(10);
          c.close();
        }
        await Bun.sleep(50);

        const after = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.includes('"type":"member"') && l.includes('"sid":"A"'));
        // Sanity: leaves were actually written (that's the whole point of the
        // guard — without leaves, memberIdBySid would still show A present and
        // there'd be no bug to fix). Multiple leave rows for a1 prove we hit
        // the "sid was removed from presentMembers" path that the old guard
        // failed to handle.
        const leaves = fs
          .readFileSync(file, "utf8")
          .split("\n")
          .filter((l) => l.includes('"type":"leave"'));
        expect(leaves.length).toBeGreaterThan(0);
        // Core assertion: still only ONE member row for sid=A even after all
        // the leave/rehello churn.
        expect(after.length).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
