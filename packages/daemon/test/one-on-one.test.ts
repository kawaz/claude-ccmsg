// DR-0014 1on1 room + DR-0017 reply instruction integration.
//
// Coverage layout (each `test` documents "何を保証するか" per §):
//   DR-0035 §2 create_room refuses kind "1on1" (no room is opened); an
//        existing 1on1 room comes from the say op, the only path that still
//        opens one
//   DR-0035 §2 an existing 1on1 room is read-only: post / reply / next_room
//        are refused for every role, a normal room is unaffected
//   DR-0017 addendum reply instruction: the peer-inject envelope's reply line
//        takes exactly 2 forms (ccmsg reply / none)
//   DR-0017 §2.3 storage: the reply instruction is computed at delivery time,
//        NEVER persisted in the room jsonl (archive で後から none に変わる live 状態依存の値)
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

const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SID_C = "cccccccc-0000-4000-8000-000000000003";

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

/** The error every write op gets on a 1on1 room (DR-0035 §2: read-only). */
function readOnlyError(room: string, op: string) {
  return {
    code: "invalid_args",
    msg: `${room} is a read-only 1on1 room and takes no ${op}; use a normal room instead`,
  };
}

/** The `type:"msg"` lines of a room's jsonl, read straight from storage so a
 * refused write is checked where it would have landed. */
function msgLines(ctx: DaemonCtx, room: string): unknown[] {
  return fs
    .readFileSync(`${ctx.roomsDir}/${room}.jsonl`, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as { type: string })
    .filter((e) => e.type === "msg");
}

const TS = "2026-01-01T00:00:00.000Z";

function memberRow(id: string, sid: string) {
  return { type: "member", id, sid, repo: "", ws: "", cwd: "", joined_at: TS };
}

/** Stop the daemon, optionally place a room file, and start it again so
 * scanRooms loads the room the same way it loads rooms left by a previous
 * run. */
async function restartWithRoom(ctx: DaemonCtx, id?: string, events?: object[]): Promise<void> {
  const c = await connect(ctx.sock);
  await c.request({ op: "shutdown" });
  c.close();
  await ctx.proc.exited;
  try {
    fs.unlinkSync(ctx.sock);
  } catch {
    // shutdown usually cleans it up; ignore if already gone
  }
  if (id !== undefined && events !== undefined) {
    fs.mkdirSync(ctx.roomsDir, { recursive: true });
    fs.writeFileSync(
      `${ctx.roomsDir}/${id}.jsonl`,
      events.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
  }
  ctx.proc = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
  await waitConnectable(ctx.sock);
}

describe("DR-0014 1on1 room: creation and read-only (DR-0035 §2)", () => {
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
        const a = await session(ctx, SID_A);
        const before = fs.existsSync(ctx.roomsDir) ? fs.readdirSync(ctx.roomsDir).length : 0;
        const attempts: [TestClient, Record<string, unknown>][] = [
          [u, { members: [SID_A] }],
          [u, { members: [SID_A], msg: "u1 opens the priv thread" }],
          [a, { members: [SID_A] }],
          [a, { members: [SID_A], msg: "session initial" }],
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
          members: [SID_A],
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

  // 何を保証するか (DR-0035 §2 読み取り専用): 既存の 1on1 room への post は
  // user role からも session role からも invalid_args で拒否され、jsonl に
  // msg が 1 行も増えない。人がセッションへ書く経路は session_input なので、
  // 1on1 room は say の記録と既存の msg を読むだけの場所になる。
  test(
    "post to a 1on1 room is refused for the user and the session and appends nothing",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, SID_A);
        const room = await oneOnOneOf(a);
        for (const c of [u, a]) {
          const res = await c.request<{ ok: false; error: { code: string; msg: string } }>({
            op: "post",
            room,
            msg: "into a read-only room",
          });
          expect(res.ok).toBe(false);
          expect(res.error).toEqual(readOnlyError(room, "post"));
        }
        expect(msgLines(ctx, room)).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (DR-0035 §2 読み取り専用、reply 側): 以前に msg が入った
  // 1on1 room でも、その msg への reply は役割を問わず invalid_args で拒否
  // する。msg を持つ 1on1 room は API では作れないので、u1 と a1 の msg を
  // 持つ room を storage に置いて daemon に読み込ませる。
  test(
    "reply in a 1on1 room is refused for both roles, even to a msg it already holds",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await restartWithRoom(ctx, "r1", [
          { type: "kind", kind: "1on1", ts: TS },
          memberRow("a1", SID_A),
          { type: "msg", mid: 1, from: "u1", ts: TS, msg: "old question" },
          { type: "msg", mid: 2, from: "a1", ts: TS, msg: "old answer" },
        ]);
        const u = await user(ctx);
        const a = await session(ctx, SID_A);
        const attempts: [TestClient, number][] = [
          [a, 1],
          [u, 2],
        ];
        for (const [c, mid] of attempts) {
          const res = await c.request<{ ok: false; error: { code: string; msg: string } }>({
            op: "reply",
            room: "r1",
            mid,
            msg: "late reply",
          });
          expect(res.ok).toBe(false);
          expect(res.error).toEqual(readOnlyError("r1", "reply"));
        }
        expect(msgLines(ctx, "r1")).toHaveLength(2);
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
        const a = await session(ctx, SID_A);
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: [SID_A],
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

  // 何を保証するか (DR-0013 §2.10): session 発の初期 --msg 付き broadcast
  // create は明示的に許可されている (u1 集約通信の opener を許す)。1on1 の
  // 拒否を broadcast に波及させていないことを固定する。
  test(
    "session-authored create_room --kind broadcast with --msg is still allowed (§2.10)",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, SID_A);
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

  // 何を保証するか (DR-0035 §2 読み取り専用、next_room 側): 1on1 room に
  // 次スレは無い。user role / session role、初期 --msg の有無のどの組でも
  // invalid_args で拒否し、新しい room を作らず、元 room に next リンクも
  // 書かない (次スレの 1on1 が書き込み経路として復活しない)。
  test(
    "next_room on a 1on1 room is refused for both roles and opens no room",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, SID_A);
        const parent = await oneOnOneOf(a);
        const attempts: [TestClient, Record<string, unknown>][] = [
          [u, {}],
          [u, { msg: "u1 opens the next thread" }],
          [a, {}],
          [a, { msg: "session initial on next" }],
        ];
        for (const [c, extra] of attempts) {
          const res = await c.request<{ ok: false; error: { code: string; msg: string } }>({
            op: "next_room",
            room: parent,
            ...extra,
          });
          expect(res.ok).toBe(false);
          expect(res.error).toEqual(readOnlyError(parent, "next_room"));
        }
        const rooms = await u.request<{ rooms: { id: string }[] }>({ op: "rooms" });
        expect(rooms.rooms.map((r) => r.id)).toEqual([parent]);
        const raw = fs.readFileSync(`${ctx.roomsDir}/${parent}.jsonl`, "utf8");
        expect(raw).not.toContain('"type":"next"');
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
  // 何を保証するか (kind の永続化): the 1on1 KindEvent lands in the jsonl and
  // is recovered by scanRooms on daemon restart — so a 1on1 room stays 1on1
  // (and therefore read-only) across a stop/start cycle. Mirrors the broadcast
  // persistence test — regression guard on the same KindEvent-based recovery
  // path.
  test(
    "1on1 kind persists across a daemon restart",
    async () => {
      const ctx = await startTestDaemon();
      try {
        let roomId: string;
        {
          const a = await session(ctx, SID_A);
          roomId = await oneOnOneOf(a);
          const raw = fs.readFileSync(`${ctx.roomsDir}/${roomId}.jsonl`, "utf8");
          expect(raw).toContain('"type":"kind"');
          expect(raw).toContain('"kind":"1on1"');
          a.close();
        }
        await restartWithRoom(ctx);

        // After restart, rooms surfaces kind:"1on1" AND a post is still
        // refused as a read-only 1on1 room — proves computeDerived recovered
        // kind, not just that the KindEvent is in the jsonl.
        const u2 = await user(ctx);
        const rooms = await u2.request<{
          rooms: { id: string; kind?: string }[];
        }>({ op: "rooms" });
        expect(rooms.rooms.find((r) => r.id === roomId)!.kind).toBe("1on1");

        const res = await u2.request<{ ok: false; error: { code: string; msg: string } }>({
          op: "post",
          room: roomId,
          msg: "after restart",
        });
        expect(res.error).toEqual(readOnlyError(roomId, "post"));
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
        const a = await session(ctx, SID_A);
        const b = await receiver(ctx, SID_B);
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: [SID_A, SID_B],
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
        const a = await session(ctx, SID_A);
        const b = await receiver(ctx, SID_B);
        const c = await receiver(ctx, SID_C);
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: [SID_A, SID_B, SID_C],
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
        const a = await receiver(ctx, SID_A);
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
        const a = await receiver(ctx, SID_A);
        const b = await receiver(ctx, SID_B);
        await session(ctx, SID_C);
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

  // 何を保証するか (DR-0017 §2.3 「none」): once a room is archived, EVERY
  // subsequent msg arrives with no reply line so agents don't reply into a
  // room kawaz has already put down (archive 済み room の惰性 msg の静穏化)。
  test(
    "archived room → the envelope carries no reply line",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, SID_A);
        const b = await receiver(ctx, SID_B);
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: [SID_A, SID_B],
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
        const a = await session(ctx, SID_A);
        const b = await receiver(ctx, SID_B);
        const res = await u.request<{ room: string }>({
          op: "create_room",
          members: [SID_A, SID_B],
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
