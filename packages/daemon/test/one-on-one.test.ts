// DR-0014 1on1 room + DR-0017 reply instruction integration.
//
// Coverage layout (each `test` documents "何を保証するか" per §):
//   DR-0035 §2 create_room refuses kind "1on1" (no room is opened); an
//        existing 1on1 room comes from the say op, the only path that still
//        opens one
//   DR-0017 addendum reply instruction: the peer-inject envelope's reply line
//        takes exactly 3 forms (ccmsg reply / normal assistant response / none)
//   DR-0017 §2.3 storage: the reply instruction is computed at delivery time,
//        NEVER persisted in the room jsonl (archive で後から none に変わる live 状態依存の値)
//   1on1 response rail on an existing 1on1 room: session post rejected, u1
//        post allowed (the webui Room screen still posts into it), normal room
//        unaffected
//   DR-0014 §2 next_room kind inheritance for 1on1 (broadcast test already covers its side)
//   DR-0014 §2 kind persistence across daemon restart (KindEvent recovered as 1on1)
//
// Each test spawns a real daemon (helpers.startTestDaemon) and drives it via
// UDS, matching the broadcast integration test's harness, and receives room
// messages on a fake harness's peer socket (peer-harness.ts) — the delivered
// envelope is what actually ships, so mocking around storage/dispatch would
// let a delivery-path reply-line bug hide behind a "unit works" green.
import { afterEach, describe, expect, test } from "bun:test";
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
import { fakeHarness, parseEnvelope, replyWith, sessionWithConfig } from "./peer-harness.ts";

const T = 15000;

const disposers: (() => void)[] = [];
afterEach(() => {
  for (const f of disposers.splice(0)) f();
});

/** A session-role connection for `sid` whose room messages land on a fake
 * harness; `next()` resolves with the next envelope's inner text and attrs. */
async function receiver(ctx: DaemonCtx, sid: string) {
  const h = fakeHarness(sid);
  disposers.push(() => h.dispose());
  const conn = await sessionWithConfig(ctx, sid, h.configDir);
  return { conn, next: async () => parseEnvelope(await h.nextContent()) };
}

const ASSISTANT_RESPONSE = "Reply in your normal assistant response.";

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

/** The 1on1 room of the session behind `conn`. The say op is the only path
 * that still opens a 1on1 room, so it stands in for "an existing 1on1 room". */
async function oneOnOneOf(conn: TestClient): Promise<string> {
  const res = await conn.request<{ ok: true; room: string }>({ op: "say", text: "hello" });
  expect(res.ok).toBe(true);
  return res.room;
}

describe("DR-0014 1on1 room creation", () => {
  // 何を保証するか (DR-0035 §2): create_room は kind "1on1" を受け付けず、
  // invalid_args で拒否して room を作らない。人がセッションへ書く経路は
  // session_input に移ったので、user role からも session role からも、初期
  // --msg の有無にかかわらず同じく拒否される。
  test(
    "create_room kind 1on1 is refused with invalid_args and opens no room",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const before = fs.existsSync(ctx.roomsDir) ? fs.readdirSync(ctx.roomsDir).length : 0;
        const attempts: [TestClient, Record<string, unknown>][] = [
          [u, { members: ["A"] }],
          [u, { members: ["A"], msg: "u1 opens the priv thread" }],
          [a, { members: ["A"] }],
          [a, { members: ["A"], msg: "session initial" }],
        ];
        for (const [c, extra] of attempts) {
          const res = await c.request<{ ok: false; error: { code: string; msg: string } }>({
            op: "create_room",
            kind: "1on1",
            ...extra,
          });
          expect(res.ok).toBe(false);
          expect(res.error).toEqual({
            code: "invalid_args",
            msg: "create_room cannot open a 1on1 room; omit kind for a normal room",
          });
        }
        const after = fs.existsSync(ctx.roomsDir) ? fs.readdirSync(ctx.roomsDir).length : 0;
        expect(after).toBe(before);
        const rooms = await u.request<{ rooms: unknown[] }>({ op: "rooms" });
        expect(rooms.rooms).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: 知らない kind は黙って normal room にせず invalid_args で
  // 拒否する (typo で意図と違う room が立たない)。
  test(
    "create_room with an unknown kind is refused with invalid_args",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const res = await u.request<{ ok: false; error: { code: string; msg: string } }>({
          op: "create_room",
          members: ["A"],
          kind: "group",
        });
        expect(res.ok).toBe(false);
        expect(res.error).toEqual({
          code: "invalid_args",
          msg: 'create_room kind must be "normal" or "broadcast"',
        });
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
        const a = await session(ctx, "A");
        const room = await oneOnOneOf(a);

        const res = await a.request<{
          ok: false;
          error: { code: string; msg: string };
        }>({
          op: "post",
          room,
          msg: "this belongs in TL",
        });
        expect(res.ok).toBe(false);
        expect(res.error).toEqual({
          code: "reply_via_tl",
          msg:
            `this 1on1 room is routed "tl": respond via your normal assistant output ` +
            `(transcript) — do not post/reply into ${room}`,
        });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (webui 経路の非対象化): 同じ 1on1 room でも u1 の post は
  // session への新規メッセージなので許可する。webui の Room 画面は既存の
  // 1on1 room にも Composer を出すので、role 判定を落として room kind だけで
  // 拒否するとその経路を壊す。その境界を固定する。
  test(
    "user post to a 1on1 room remains allowed",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const room = await oneOnOneOf(a);

        const res = await u.request<{ ok: true; mid: number }>({
          op: "post",
          room,
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
  // ままにする (broadcast の同じ挙動 §2.8 を 1on1 に一般化)。返信指示の
  // "tl" 分岐 (DR-0017 §2.3) もそのまま新 room に適用されることを、u1 発の
  // msg → recipient に届く封筒の返信行で確認する。
  test(
    "next_room from a 1on1 produces another 1on1 (kind inherited)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const { conn: a, next } = await receiver(ctx, "A");
        const parent = await oneOnOneOf(a);
        const nextRes = await a.request<{ ok: true; room: string }>({
          op: "next_room",
          room: parent,
        });
        const rooms = await u.request<{
          rooms: { id: string; kind?: string }[];
        }>({ op: "rooms" });
        expect(rooms.rooms.find((r) => r.id === nextRes.room)!.kind).toBe("1on1");

        // Sanity: the assistant-response instruction still applies on the inherited room
        const posted = await u.request<{ mid: number }>({
          op: "post",
          room: nextRes.room,
          msg: "tl on inherited",
        });
        const env = await next();
        expect(env.attrs["ccmsg-mid"]).toBe(`${nextRes.room}m${posted.mid}`);
        expect(env.body).toBe(`tl on inherited\n\n${ASSISTANT_RESPONSE}`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0013 §2.10): session 発の初期 --msg 付き broadcast
  // create は明示的に許可されている (u1 集約通信の opener を許す)。1on1 の
  // 拒否を broadcast に波及させていないことを固定する。
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
  // 付いていたら post ガードと同じ理由で拒否する。エラー文言は既存 old room
  // の id 付き (post ガード同型) になる。
  test(
    "session-authored next_room from a 1on1 with --msg is refused",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const parent = { room: await oneOnOneOf(a) };
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
        const a = await session(ctx, "A");
        const parent = { room: await oneOnOneOf(a) };
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
        const a = await session(ctx, "A");
        const parent = { room: await oneOnOneOf(a) };
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
  // (the envelope directs the normal assistant response for u1 msgs) across a stop/start cycle.
  // Mirrors the broadcast persistence test — regression guard on the same
  // KindEvent-based recovery path.
  test(
    "1on1 kind persists across a daemon restart",
    async () => {
      const ctx = await startTestDaemon();
      try {
        let roomId: string;
        {
          const a = await session(ctx, "A");
          roomId = await oneOnOneOf(a);
          const raw = fs.readFileSync(`${ctx.roomsDir}/${roomId}.jsonl`, "utf8");
          expect(raw).toContain('"type":"kind"');
          expect(raw).toContain('"kind":"1on1"');
          a.close();
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

        // After restart, rooms surfaces kind:"1on1" AND the envelope still
        // directs the assistant response for u1 posts — proves computeDerived
        // recovered kind, not just that the KindEvent is in the jsonl.
        const u2 = await user(ctx);
        const rooms = await u2.request<{
          rooms: { id: string; kind?: string }[];
        }>({ op: "rooms" });
        expect(rooms.rooms.find((r) => r.id === roomId)!.kind).toBe("1on1");

        const { next } = await receiver(ctx, "A");
        await u2.request({ op: "post", room: roomId, msg: "after restart" });
        expect((await next()).body).toBe(`after restart\n\n${ASSISTANT_RESPONSE}`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("DR-0017 reply instruction in the peer-inject envelope", () => {
  // 何を保証するか (DR-0017 §2.3 の rNmN 形): normal room の msg は「その
  // msg 自身の room+mid」が返信先になる — 受信者は ccmsg reply <mid> <text>
  // と打つだけで、宛先構成 (元 from + 元 to − 自分 + u1) は daemon の reply
  // op が行う。
  test(
    "normal room + to-less msg → the reply line names the exact ccmsg reply command",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const b = await receiver(ctx, "B");
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B"],
        });
        const room = res.room;

        const posted = await a.request<{ mid: number }>({ op: "post", room, msg: "全員へ" });
        const env = await b.next();
        expect(env.attrs["ccmsg-mid"]).toBe(`${room}m${posted.mid}`);
        expect(env.body).toBe(`全員へ\n\n${replyWith(`${room}m${posted.mid}`)}`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3「routing 記法の廃止」): `to` 付き msg でも
  // 返信行は受信者に依らず同一の rNmN 形。宛先計算は reply op が担うため、
  // 返信行は「どの msg への返信か」だけを示す。B と C が同じ行を受け取る
  // ことが per-recipient 計算が無いことの直接の証拠。
  test(
    "normal room + explicit `to` → the reply line is the same command for every recipient",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const b = await receiver(ctx, "B");
        const c = await receiver(ctx, "C");
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
        const want = `peer priv\n\n${replyWith(`${room}m${posted.mid}`)}`;
        expect((await b.next()).body).toBe(want);
        expect((await c.next()).body).toBe(want);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 × DR-0013): broadcast room の u1 msg も
  // 特別扱いなしの rNmN 形。reply op の構成 (元 from=u1 + u1 常含み) が
  // broadcast の「agent post は u1 宛必須」制約 (DR-0013 §2.4) を構成上
  // 自動で満たすため、返信行で u1 を明示する必要はない。
  test(
    "broadcast + u1 to-less → the reply line names the exact ccmsg reply command",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await receiver(ctx, "A");
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
        expect((await a.next()).body).toBe(
          `全員へ broadcast\n\n${replyWith(`${room}m${posted.mid}`)}`,
        );
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 × DR-0013、to 付き): u1 が個別 session を
  // 選んで broadcast した場合も返信行は全受信者共通の rNmN。元 to の再構成
  // (u1 + 他 peer − 自分) は reply op が担うため、A と B が同じ行を受け取る。
  test(
    "broadcast + u1 with explicit `to` → same reply command for every recipient",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await receiver(ctx, "A");
        const b = await receiver(ctx, "B");
        await session(ctx, "C");
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
        const want = `selected peers\n\n${replyWith(`${room}m${posted.mid}`)}`;
        expect((await a.next()).body).toBe(want);
        expect((await b.next()).body).toBe(want);
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
    "1on1 + u1 → the reply line directs the normal assistant response",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await receiver(ctx, "A");
        const room = await oneOnOneOf(a.conn);

        await u.request({ op: "post", room, msg: "priv from u1" });
        expect((await a.next()).body).toBe(`priv from u1\n\n${ASSISTANT_RESPONSE}`);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 「none」): once a room is archived, EVERY
  // subsequent msg arrives with no reply line so agents don't reply into a
  // room kawaz has already put down (archive 済み room の惰性 msg の静穏化)。
  test(
    "archived room → the envelope carries no reply line",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const b = await receiver(ctx, "B");
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

        expect((await b.next()).body).toBe("post into archived");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0017 §2.3 補足「返信指示は配送時に決める、jsonl には
  // 書かない」): the route depends on live room state (archive flips it to
  // "none" for later deliveries), so a post-time snapshot would go stale.
  // Regression guard for accidentally teeing the delivery instruction into
  // appendEvent.
  test(
    "the reply instruction is delivery-only, never persisted in the room jsonl",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const b = await receiver(ctx, "B");
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B"],
        });
        const room = res.room;

        await u.request({ op: "post", room, msg: "from u1" });
        await a.request({ op: "post", room, msg: "from a" });
        // Both msgs were delivered (with their reply lines) before the file is
        // read. Each post's injection runs on its own, so arrival order is free.
        const bodies = [(await b.next()).body, (await b.next()).body].sort();
        expect(bodies[0]).toStartWith("from a\n\nReply with: ");
        expect(bodies[1]).toStartWith("from u1\n\nReply with: ");

        const raw = fs.readFileSync(`${ctx.roomsDir}/${room}.jsonl`, "utf8");
        expect(raw).not.toContain("Reply with");
        expect(raw).not.toContain("reply_via");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
