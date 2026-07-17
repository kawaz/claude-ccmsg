// DR-0014 1on1 room + DR-0017 reply_hint integration.
//
// Coverage layout (each `test` documents "何を保証するか" per §):
//   DR-0014 §2.1 create_room --kind 1on1 member-count validation, session role,
//        rooms-response kind badge
//   DR-0017 §2.3 reply_hint composer: exactly 3 shapes (r<N>m<M> / tl / none)
//   DR-0017 §2.3 storage: reply_hint is a delivery-time field, NEVER persisted
//        in the room jsonl (archive で後から none に変わる live 状態依存の値)
//   1on1 response rail: session post rejected, u1 post allowed, normal room unaffected
//   DR-0014 §2 next_room kind inheritance for 1on1 (broadcast test already covers its side)
//   DR-0014 §2 kind persistence across daemon restart (KindEvent recovered as 1on1)
//
// Each test spawns a real daemon (helpers.startTestDaemon) and drives it via
// UDS, matching the broadcast integration test's harness — the wire contract
// is what actually ships, so mocking around storage/dispatch would let a
// delivery-path reply_hint bug hide behind a "unit works" green.
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

  // 何を保証するか (1on1 の返信レール): session が自分の 1on1 room へ
  // post する経路は常に拒否する。元 msg との対応や未応答状態は追跡せず、TL
  // (通常の assistant transcript 出力) へ誘導することで post による返信逸脱を
  // room kind だけで封じる。
  test(
    "agent post to its 1on1 room is rejected with transcript guidance",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });

        const res = await a.request<{
          ok: false;
          error: { code: string; msg: string };
        }>({
          op: "post",
          room: created.room,
          msg: "this belongs in TL",
        });
        expect(res.ok).toBe(false);
        expect(res.error).toEqual({
          code: "reply_via_tl",
          msg:
            `this 1on1 room is routed "tl": respond via your normal assistant output ` +
            `(transcript) — do not post/reply into ${created.room}`,
        });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (webui 経路の非対象化): 同じ 1on1 room でも u1 の post は
  // session への新規メッセージなので許可する。role 判定を落として room kind
  // だけで拒否すると webui の主経路を壊すため、その境界を固定する。
  test(
    "user post to a 1on1 room remains allowed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        await session(ctx, "A");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });

        const res = await u.request<{ ok: true; mid: number }>({
          op: "post",
          room: created.room,
          msg: "question from webui",
        });
        expect(res.ok).toBe(true);
        expect(res.mid).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (通常 room の非回帰): session の post 自体は新規の声かけに
  // 必要な正当経路であり、拒否対象は kind="1on1" だけ。normal room まで拒否
  // しないことを wire 経路で固定する。
  test(
    "agent post to a normal room remains allowed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
        });

        const res = await a.request<{ ok: true; mid: number }>({
          op: "post",
          room: created.room,
          msg: "new message",
        });
        expect(res.ok).toBe(true);
        expect(res.mid).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2 next_room kind inheritance): 1on1 の次スレも 1on1 の
  // ままにする (broadcast の同じ挙動 §2.8 を 1on1 に一般化)。reply_hint の
  // "tl" 分岐 (DR-0017 §2.3) もそのまま新 room に適用されることを、u1 発の
  // msg → recipient の reply_hint 値で確認する。
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

        // Sanity: reply_hint "tl" still applies on the inherited room
        const aSub = await session(ctx, "A");
        await aSub.request({ op: "subscribe" });
        await u.request({ op: "post", room: nextRes.room, msg: "tl on inherited" });
        const { ev } = await readMsg(
          aSub,
          (m: any) => m.r === nextRes.room && m.msg === "tl on inherited",
        );
        expect(ev.reply_hint).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (RL-Q1、kawaz r26 mid=103、「混ぜない」裁定): session 発の
  // create_room --kind 1on1 に初期 --msg が付いていたら post ガード (§2.5) と
  // 同じ理由で reply_via_tl エラーで拒否する。1on1 の返信レールは TL であって
  // room msg 経路ではないため、session 発の初期声かけは transcript に出す。
  // room 作成自体を潰すので、roomsDir に副作用が残らないことも同時に確認する。
  test(
    "session-authored create_room --kind 1on1 with --msg is refused",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const before = fs.existsSync(ctx.roomsDir) ? fs.readdirSync(ctx.roomsDir).length : 0;
        const res = await a.request<{
          ok: false;
          error: { code: string; msg: string };
        }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
          msg: "session initial",
        });
        expect(res.ok).toBe(false);
        expect(res.error).toEqual({
          code: "reply_via_tl",
          msg:
            `this 1on1 room is routed "tl": respond via your normal assistant output ` +
            `(transcript) — do not attach --msg on a session-initiated 1on1 create_room/next_room`,
        });
        // 副作用ゼロ: roomsDir に新規 jsonl が積まれていないこと。
        const after = fs.existsSync(ctx.roomsDir) ? fs.readdirSync(ctx.roomsDir).length : 0;
        expect(after).toBe(before);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (RL-Q1 の裏側): session 発でも --msg なしの create_room
  // --kind 1on1 は正当な操作 (2 者 room を張るだけ)。room 作成そのものを
  // 潰していないことを固定する。
  test(
    "session-authored create_room --kind 1on1 without --msg is allowed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const res = await a.request<{ ok: true; room: string; reused: boolean }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });
        expect(res.ok).toBe(true);
        expect(res.reused).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (RL-Q1 の webui 経路の非対象化): 同じ 1on1 でも u1
  // (webui) 発の初期 --msg は「session に呼びかけを届ける」正当な用途。
  // role 判定を落として一律拒否すると webui の主経路を壊すため、その境界を
  // 明示的に固定する (post ガードの u1 許可と同型)。
  test(
    "user-authored create_room --kind 1on1 with --msg remains allowed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        await session(ctx, "A");
        const res = await u.request<{ ok: true; room: string; mid?: number }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
          msg: "u1 opens the priv thread",
        });
        expect(res.ok).toBe(true);
        expect(res.mid).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (RL-Q1 の broadcast 例外の非回帰、DR-0013 §2.10): 1on1 と
  // 同じ「session 発の初期 --msg」でも、broadcast は §2.10 で明示的に許可されて
  // いる (u1 集約通信の opener を許す)。1on1 側の拒否を broadcast に波及させて
  // いないことを固定する。
  test(
    "session-authored create_room --kind broadcast with --msg is still allowed (§2.10)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const res = await a.request<{ ok: true; room: string; mid?: number }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
          msg: "broadcast opener",
        });
        expect(res.ok).toBe(true);
        expect(res.mid).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (RL-Q1 の next_room 側): 1on1 の次スレも 1on1 kind を継承
  // する (§2 kind inheritance) ので、session 発の next_room に --msg が
  // 付いていたら create_room 側と同じく拒否する。既存 old room が指定される
  // ため、エラー文言側は room id 付き (post ガード同型) になる。
  test(
    "session-authored next_room from a 1on1 with --msg is refused",
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
        const res = await a.request<{
          ok: false;
          error: { code: string; msg: string };
        }>({
          op: "next_room",
          room: parent.room,
          msg: "session initial on next",
        });
        expect(res.ok).toBe(false);
        expect(res.error).toEqual({
          code: "reply_via_tl",
          msg:
            `this 1on1 room is routed "tl": respond via your normal assistant output ` +
            `(transcript) — do not post/reply into ${parent.room}`,
        });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (RL-Q1 の裏側 next_room): 1on1 の次スレを立てる操作自体は
  // 正当。--msg を付けなければ session 発でも通す (既存の kind inheritance
  // テストは u1 経路寄りなので、session 発が --msg なしで通ることを別枠で
  // 固定する)。
  test(
    "session-authored next_room from a 1on1 without --msg is allowed",
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
        const res = await a.request<{ ok: true; room: string; mid?: number }>({
          op: "next_room",
          room: parent.room,
        });
        expect(res.ok).toBe(true);
        expect(res.mid).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (RL-Q1 の webui 経路の非対象化 next_room): u1 発の
  // next_room + --msg は webui の主経路 (「今の priv を畳んで次を始める」の
  // opener) — 1on1 next_room の拒否対象が role で分離されていることを固定。
  test(
    "user-authored next_room from a 1on1 with --msg remains allowed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        await session(ctx, "A");
        const parent = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
          kind: "1on1",
        });
        const res = await u.request<{ ok: true; room: string; mid?: number }>({
          op: "next_room",
          room: parent.room,
          msg: "u1 opens the next priv thread",
        });
        expect(res.ok).toBe(true);
        expect(res.mid).toBe(1);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (kind の永続化): the 1on1 KindEvent lands in the jsonl and
  // is recovered by scanRooms on daemon restart — so a 1on1 room stays 1on1
  // (reply_hint = "tl" for u1 msgs keeps working) across a stop/start cycle.
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

        // After restart, rooms surfaces kind:"1on1" AND reply_hint still emits
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
        expect(ev.reply_hint).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("DR-0017 reply_hint wire hint", () => {
  // 何を保証するか (DR-0017 §2.3 の rNmN 形): normal room の msg は「その
  // msg 自身の room+mid」が hint になる — 受信者は ccmsg reply <hint> <text>
  // と打つだけで、宛先構成 (元 from + 元 to − 自分 + u1) は daemon の reply
  // op が行う。旧 DR-0014 の routing 記法 (r<id> 単独 / to 連結) が消えて
  // いることの回帰 guard も兼ねる。
  test(
    "normal room + to-less msg → reply_hint = 'r<N>m<M>' (the msg itself)",
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

        const posted = await a.request<{ mid: number }>({ op: "post", room, msg: "全員へ" });
        const { ev } = await readMsg(bSub, (m: any) => m.r === room && m.msg === "全員へ");
        expect(ev.reply_hint).toBe(`${room}m${posted.mid}`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3「routing 記法の廃止」): `to` 付き msg でも
  // hint は受信者に依らず同一の rNmN 形。旧仕様は受信者ごとに異なる連結値
  // (r<id>a1a3 等) を配っていたが、宛先計算が reply op に移ったため hint は
  // 「どの msg への返信か」だけを示す。B と C が同じ値を受け取ることが
  // per-recipient 計算の消滅の直接の証拠。
  test(
    "normal room + explicit `to` → reply_hint is the same 'r<N>m<M>' for every recipient",
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

        const posted = await a.request<{ mid: number }>({
          op: "post",
          room,
          msg: "peer priv",
          to: ["a2", "a3"],
        });
        const want = `${room}m${posted.mid}`;

        const bMsg = await readMsg(bSub, (m: any) => m.r === room && m.msg === "peer priv");
        expect(bMsg.ev.reply_hint).toBe(want);

        const cMsg = await readMsg(cSub, (m: any) => m.r === room && m.msg === "peer priv");
        expect(cMsg.ev.reply_hint).toBe(want);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 × DR-0013): broadcast room の u1 msg も
  // 特別扱いなしの rNmN 形。reply op の構成 (元 from=u1 + u1 常含み) が
  // broadcast の「agent post は u1 宛必須」制約 (DR-0013 §2.4) を構成上
  // 自動で満たすため、hint 側での u1 明示 (旧 r<id>u1) は不要になった。
  test(
    "broadcast + u1 to-less → reply_hint = 'r<N>m<M>'",
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

        const posted = await u.request<{ mid: number }>({
          op: "post",
          room,
          msg: "全員へ broadcast",
        });
        const { ev } = await readMsg(
          aSub,
          (m: any) => m.r === room && m.msg === "全員へ broadcast",
        );
        expect(ev.reply_hint).toBe(`${room}m${posted.mid}`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 × DR-0013、to 付き): u1 が個別 session を
  // 選んで broadcast した場合も hint は全受信者共通の rNmN。元 to の再構成
  // (u1 + 他 peer − 自分) は reply op が担うため、A と B が同じ hint を
  // 受け取る (per-recipient 差分の消滅)。
  test(
    "broadcast + u1 with explicit `to` → same 'r<N>m<M>' hint for every recipient",
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

        const posted = await u.request<{ mid: number }>({
          op: "post",
          room,
          msg: "selected peers",
          to: ["a1", "a2"],
        });
        const want = `${room}m${posted.mid}`;

        const aMsg = await readMsg(aSub, (m: any) => m.r === room && m.msg === "selected peers");
        expect(aMsg.ev.reply_hint).toBe(want);

        const bMsg = await readMsg(bSub, (m: any) => m.r === room && m.msg === "selected peers");
        expect(bMsg.ev.reply_hint).toBe(want);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 「tl」、DR-0014 §2.5 から継承): 1on1 room の
  // u1 msg だけは rNmN でなく "tl" — 返信は room への post/reply ではなく
  // 受信 agent 自身の transcript 出力で行い、webui SessionView Timeline が
  // それを拾う。
  test(
    "1on1 + u1 → reply_hint = 'tl'",
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
        expect(ev.reply_hint).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 「none」): once a room is archived, EVERY
  // subsequent msg carries reply_hint = "none" so agents don't reply into a
  // room kawaz has already put down (archive 済み room の惰性 msg の静穏化)。
  test(
    "archived room → reply_hint = 'none'",
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
        expect(ev.reply_hint).toBe("none");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 補足「reply_hint は配送時 field、jsonl には
  // 書かない」): the room jsonl must NOT contain reply_hint on msg lines —
  // the route depends on live room state (archive flips it to "none"
  // retroactively for later replays), so a post-time snapshot would go
  // stale. Regression guard for accidentally teeing the delivery hint into
  // appendEvent.
  test(
    "reply_hint is delivery-only, never persisted in the room jsonl",
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
        expect(raw).not.toContain("reply_hint");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (reply_hint の since-replay 側): backlog delivery (subscribe
  // 経由の since replay 経路) でも reply_hint が付くこと。deliver 経路と
  // sendBacklog 経路の両方で writeDelivered を通るので、両輪でカバーが
  // ないと reconnect 後の agent が hint を失う。
  test(
    "reply_hint is injected in since-replay backlog too",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        // A never subscribed during the u1 post; it comes back later and
        // asks for since-replay from mid 0 → should receive the priv msg with
        // reply_hint = "tl".
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
        expect(ev.reply_hint).toBe("tl");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
