// DR-0014 1on1 room + reply_via integration.
//
// Coverage layout (each `test` documents "何を保証するか" per §):
//   §2.1 create_room --kind 1on1 member-count validation, session role,
//        rooms-response kind badge
//   §2.4-2.5 reply_via wire hint composer: 6 documented patterns (normal / normal+to
//        / broadcast+u1 / broadcast+u1+to / 1on1+u1 / archived → none)
//   §2 storage: reply_via is per-recipient at delivery time, NEVER persisted in
//        the room jsonl (共通 event として保存すると受信者ごとに矛盾する)
//   §2 next_room kind inheritance for 1on1 (broadcast test already covers its side)
//   §2 kind persistence across daemon restart (KindEvent recovered as 1on1)
//
// Each test spawns a real daemon (helpers.startTestDaemon) and drives it via
// UDS, matching the broadcast integration test's harness — the wire contract
// is what actually ships, so mocking around storage/dispatch would let a
// per-recipient reply_via bug hide behind a "unit works" green.
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

/** Read events on `sub` up to the first msg the predicate accepts, returning
 * the intervening event stream too (mirrors broadcast.test.ts's helper). */
async function readMsg(
  sub: TestClient,
  pred: (ev: any) => boolean = () => true,
): Promise<{ ev: any; seen: any[] }> {
  return sub.readEventUntil((ev) => ev.type === "msg" && pred(ev));
}

describe("DR-0014 1on1 room creation", () => {
  // 何を保証するか (§2.1「members が空 or 複数だと error」): the daemon rejects
  // both extremes with the DR's new dedicated error code, so the 2-party
  // semantics is enforced at the wire boundary — a caller can't accidentally
  // open a 3-way "1on1" or a lonely 0-party priv room.
  test(
    "create_room --kind 1on1 rejects empty and multiple members",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        // Empty members
        const empty = await u.request<{ ok: false; error: { code: string } }>({
          op: "create_room",
          members: [],
          kind: "1on1",
        });
        expect(empty.ok).toBe(false);
        expect(empty.error.code).toBe("one_on_one_requires_single_member");

        // Multiple members
        const multi = await u.request<{ ok: false; error: { code: string } }>({
          op: "create_room",
          members: ["A", "B"],
          kind: "1on1",
        });
        expect(multi.ok).toBe(false);
        expect(multi.error.code).toBe("one_on_one_requires_single_member");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.1「members が 1 sid ちょうどで正常」): the happy path
  // opens a room, surfaces kind:"1on1" in the rooms response, and contains
  // exactly the single sid as its non-u1 member. u1 stays implicit (DR-0006).
  test(
    "create_room --kind 1on1 with a single member opens a 2-party room",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const res = await u.request<{ ok: true; room: string; reused: boolean }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
          title: "kuu 1on1 aaaa",
        });
        expect(res.ok).toBe(true);
        expect(res.reused).toBe(false);

        const rooms = await u.request<{
          rooms: { id: string; kind?: string; title?: string; members: { sid: string }[] }[];
        }>({ op: "rooms" });
        const r = rooms.rooms.find((x) => x.id === res.room)!;
        // §2.1 kind surfaced; title only for display
        expect(r.kind).toBe("1on1");
        expect(r.title).toBe("kuu 1on1 aaaa");
        expect(r.members.map((m) => m.sid)).toEqual(["A"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.1「agent post 制約なし」): 1on1 does NOT inherit
  // broadcast's u1-in-to rule — a session posting to its own 1on1 room can
  // omit `to` and also address only itself/u1 freely, since the 2 者確定
  // structure makes any post reach both parties.
  test(
    "1on1 room has NO broadcast-style agent post constraint",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });
        const room = res.room;

        // Agent post with NO `to` succeeds (would be rejected in a broadcast room)
        const noTo = await a.request<{ ok: true; mid: number }>({
          op: "post",
          room,
          msg: "hi",
        });
        expect(noTo.ok).toBe(true);

        // Agent post with `to: ["u1"]` also succeeds
        const withU1 = await a.request<{ ok: true; mid: number }>({
          op: "post",
          room,
          msg: "hi u1",
          to: ["u1"],
        });
        expect(withU1.ok).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2 next_room kind inheritance): 1on1 の次スレも 1on1 の
  // ままにする (broadcast の同じ挙動 §2.8 を 1on1 に一般化)。reply_via の
  // "tl" 分岐もそのまま新 room に適用されることを、u1 発の msg → recipient
  // の reply_via 値で確認する。
  test(
    "next_room from a 1on1 produces another 1on1 (kind inherited)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const parent = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });
        const nextRes = await a.request<{ ok: true; room: string }>({
          op: "next_room",
          room: parent.room,
        });
        const rooms = await u.request<{
          rooms: { id: string; kind?: string }[];
        }>({ op: "rooms" });
        expect(rooms.rooms.find((r) => r.id === nextRes.room)!.kind).toBe("1on1");

        // Sanity: reply_via "tl" still applies on the inherited room
        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });
        await u.request({ op: "post", room: nextRes.room, msg: "tl on inherited" });
        const { ev } = await readMsg(
          aSub,
          (m: any) => m.r === nextRes.room && m.msg === "tl on inherited",
        );
        expect(ev.reply_via).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (kind の永続化): the 1on1 KindEvent lands in the jsonl and
  // is recovered by scanRooms on daemon restart — so a 1on1 room stays 1on1
  // (reply_via = "tl" for u1 msgs keeps working) across a stop/start cycle.
  // Mirrors the broadcast persistence test — regression guard on the same
  // KindEvent-based recovery path.
  test(
    "1on1 kind persists across a daemon restart",
    async () => {
      const ctx = await startTestDaemon();
      try {
        let roomId: string;
        {
          const u = await user(ctx);
          const res = await u.request<{ room: string }>({
            op: "create_room",
            members: ["A"],
            kind: "1on1",
          });
          roomId = res.room;
          const raw = fs.readFileSync(`${ctx.roomsDir}/${roomId}.jsonl`, "utf8");
          expect(raw).toContain('"type":"kind"');
          expect(raw).toContain('"kind":"1on1"');
          u.close();
        }
        // Bounce daemon
        const c = await connect(ctx.sock);
        await c.request({ op: "shutdown" });
        c.close();
        await ctx.proc.exited;
        try {
          fs.unlinkSync(ctx.sock);
        } catch {
          // shutdown usually cleans it up; ignore if already gone
        }
        ctx.proc = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
        await waitConnectable(ctx.sock);

        // After restart, rooms surfaces kind:"1on1" AND reply_via still emits
        // "tl" for u1 posts — proves computeDerived recovered kind, not just
        // that the KindEvent is in the jsonl.
        const u2 = await user(ctx);
        const rooms = await u2.request<{
          rooms: { id: string; kind?: string }[];
        }>({ op: "rooms" });
        expect(rooms.rooms.find((r) => r.id === roomId)!.kind).toBe("1on1");

        const aAfter = await session(ctx, "A");
        await aAfter.request({ op: "subscribe" });
        await u2.request({ op: "post", room: roomId, msg: "after restart" });
        const { ev } = await readMsg(
          aAfter,
          (m: any) => m.r === roomId && m.msg === "after restart",
        );
        expect(ev.reply_via).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("DR-0014 reply_via wire hint", () => {
  // 何を保証するか (§2.4 pattern "r<id>"): normal room + `to`-less msg → the
  // hint is just the room id, telling the receiver "reply broadcasts back to
  // the room" (no priv target). Verified by having session A post a to-less
  // msg to a room where session B is a co-member; B's msg event carries the
  // room-only hint.
  test(
    "normal room + to-less msg → reply_via = 'r<id>'",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B"],
        });
        const room = res.room;

        await a.request({ op: "post", room, msg: "全員へ" });
        const { ev } = await readMsg(bSub, (m: any) => m.r === room && m.msg === "全員へ");
        expect(ev.reply_via).toBe(room);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 「通常 room + to あり → r<room-id> + (from + 元 to
  // - 受信者本人)、id 順連結」): the composer reconstructs the priv circle
  // minus the receiver. Setup: room has A (a1), B (a2), C (a3). A posts with
  // to:[B, C]. Two subscribers B and C should each see reply_via that
  // includes A + the OTHER peer but not themselves.
  test(
    "normal room + explicit `to` → reply_via = 'r<id>' + sender + peers - receiver",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const bSub = await session(ctx, "B");
        const cSub = await session(ctx, "C");
        await bSub.request({ op: "subscribe" });
        await cSub.request({ op: "subscribe" });
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B", "C"],
        });
        const room = res.room;

        // to=[a2, a3], from=a1; receiver=a2 → [a1, a3]; receiver=a3 → [a1, a2]
        await a.request({ op: "post", room, msg: "peer priv", to: ["a2", "a3"] });

        const bMsg = await readMsg(bSub, (m: any) => m.r === room && m.msg === "peer priv");
        expect(bMsg.ev.reply_via).toBe(`${room}a1a3`);

        const cMsg = await readMsg(cSub, (m: any) => m.r === room && m.msg === "peer priv");
        expect(cMsg.ev.reply_via).toBe(`${room}a1a2`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 「broadcast room + u1 発 + to なし → r<id>u1」):
  // u1's full-room broadcast prompts a u1-priv reply — that's exactly what
  // §2.4 the broadcast post constraint requires anyway, so encoding it in
  // reply_via saves each agent from pattern-matching room.kind at post time.
  test(
    "broadcast + u1 to-less → reply_via = 'r<id>u1'",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const room = res.room;

        await u.request({ op: "post", room, msg: "全員へ broadcast" });
        const { ev } = await readMsg(
          aSub,
          (m: any) => m.r === room && m.msg === "全員へ broadcast",
        );
        expect(ev.reply_via).toBe(`${room}u1`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 「broadcast + u1 発 + 個別 session 指定 → r<id>u1 +
  // 元 to のうち u1 と受信者を除外して id 順連結」): the composer always keeps
  // u1 in the hint (round-trip back to kawaz) and strips the receiver itself.
  // Setup: broadcast, active peers A/B/C. u1 posts with to:[a1, a2]. B (a2)
  // sees "r<id>u1a1", A (a1) sees "r<id>u1a2".
  test(
    "broadcast + u1 with explicit `to` → reply_via keeps u1 + peers - receiver",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const aSub = await session(ctx, "A");
        const bSub = await session(ctx, "B");
        await session(ctx, "C");
        await aSub.request({ op: "subscribe" });
        await bSub.request({ op: "subscribe" });
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const room = res.room;

        await u.request({ op: "post", room, msg: "selected peers", to: ["a1", "a2"] });

        const aMsg = await readMsg(aSub, (m: any) => m.r === room && m.msg === "selected peers");
        expect(aMsg.ev.reply_via).toBe(`${room}u1a2`);

        const bMsg = await readMsg(bSub, (m: any) => m.r === room && m.msg === "selected peers");
        expect(bMsg.ev.reply_via).toBe(`${room}u1a1`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 「1on1 + u1 発 → tl」): the special-cased hint tells
  // the receiving agent "reply on your session TL"; the webui SessionView
  // Timeline picks up the response via its existing u1-msg transcript path
  // (D-3, §2.7).
  test(
    "1on1 + u1 → reply_via = 'tl'",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });
        const room = res.room;

        await u.request({ op: "post", room, msg: "priv from u1" });
        const { ev } = await readMsg(aSub, (m: any) => m.r === room && m.msg === "priv from u1");
        expect(ev.reply_via).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 「archive 済み room からの msg → none」): once a
  // room is archived, EVERY subsequent msg carries reply_via = "none" so agents
  // don't reply into a room kawaz has already put down. Simplification from
  // §2.5's open question: "archive_ts 以降だけ" ではなく "archived 状態全体一律".
  test(
    "archived room → reply_via = 'none'",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B"],
        });
        const room = res.room;

        // Archive first, then post — the archive path here is straightforward
        // "the room is currently archived when the post lands", per the
        // §2.5 実装時判断 (全 msg 一律).
        await u.request({ op: "archive_room", room, archived: true });
        await a.request({ op: "post", room, msg: "post into archived" });

        const { ev } = await readMsg(
          bSub,
          (m: any) => m.r === room && m.msg === "post into archived",
        );
        expect(ev.reply_via).toBe("none");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 補足「reply_via は subscribe stream での配送 event に
  // 付く post-hoc field、jsonl storage の永続 event には書かない」): the room
  // jsonl must NOT contain reply_via anywhere on msg lines — that field is
  // per-recipient and would either freeze one recipient's view for everyone
  // else or bloat each line with a per-recipient map. Regression guard for
  // accidentally teeing the delivery hint into appendEvent.
  test(
    "reply_via is delivery-only, never persisted in the room jsonl",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B"],
        });
        const room = res.room;

        await u.request({ op: "post", room, msg: "from u1" });
        await a.request({ op: "post", room, msg: "from a" });
        // Consume so we're sure both msgs landed before we peek at the file
        await readMsg(bSub, (m: any) => m.r === room && m.msg === "from u1");
        await readMsg(bSub, (m: any) => m.r === room && m.msg === "from a");

        const raw = fs.readFileSync(`${ctx.roomsDir}/${room}.jsonl`, "utf8");
        expect(raw).not.toContain("reply_via");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (reply_via の since-replay 側): backlog delivery (subscribe
  // 経由の since replay 経路) でも reply_via が付くこと。deliver 経路と
  // sendBacklog 経路の両方で writeDelivered を通るので、両輪でカバーが
  // ないと reconnect 後の agent が hint を失う。
  test(
    "reply_via is injected in since-replay backlog too",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        // A never subscribed during the u1 post; it comes back later and
        // asks for since-replay from mid 0 → should receive the priv msg with
        // reply_via = "tl".
        await session(ctx, "A");
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });
        const room = res.room;
        await u.request({ op: "post", room, msg: "priv while offline" });

        // Later, A opens a new subscribe with since 0
        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe", since: { [room]: 0 } });
        const { ev } = await readMsg(
          aSub,
          (m: any) => m.r === room && m.msg === "priv while offline",
        );
        expect(ev.reply_via).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
