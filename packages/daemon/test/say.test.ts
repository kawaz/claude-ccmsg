// `ccmsg say` の観測イベント (kawaz r244 m5-m6) の wire 契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - say op が「呼び出し元セッション自身の 1on1 room」を解決 / 新規作成する
//   - say / say_read は user role にだけ配信される (session の subscribe に
//     流さない = kawaz 「セッションへの echo は不要、コンテキストの無駄」)
//   - 未読集合 (rooms 応答の say_unread_seqs) が say で増え say_read で減る
//   - role gate: say は session 限定、say_read は user 限定
//   - 再起動後も say / say_read が jsonl から復元される (未読が消えない)
//
// 実 daemon を UDS 越しに叩く (one-on-one.test.ts と同じ harness): 配信経路の
// 抑制ルールは storage 単体テストでは踏めないので、出荷する線の上で確かめる。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import type { ResponseOf } from "@ccmsg/protocol";
import {
  connect,
  spawnDaemonProc,
  startTestDaemon,
  stopTestDaemon,
  waitConnectable,
  type DaemonCtx,
  type TestClient,
  isKind,
} from "./helpers.ts";

const SID_SAY_1 = "5a900000-0000-4000-8000-000000000001";
const SID_SAY_2 = "5a900000-0000-4000-8000-000000000002";
const SID_SAY_3 = "5a900000-0000-4000-8000-000000000003";
const SID_SAY_4 = "5a900000-0000-4000-8000-000000000004";
const SID_SAY_5 = "5a900000-0000-4000-8000-000000000005";
const SID_SAY_6 = "5a900000-0000-4000-8000-000000000006";
const SID_SAY_7 = "5a900000-0000-4000-8000-000000000007";
const SID_SAY_8 = "5a900000-0000-4000-8000-000000000008";

const T = 15000;

async function session(ctx: DaemonCtx, sid: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: `repo-${sid}`, ws: "main", cwd: `/tmp/${sid}` });
  return c;
}

async function user(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  return c;
}

async function roomsOf(c: TestClient): Promise<ResponseOf<"rooms">["rooms"]> {
  const res = await c.requestOk({ op: "rooms" });
  return res.rooms;
}

async function roomOf(c: TestClient, id: string): Promise<ResponseOf<"rooms">["rooms"][number]> {
  const room = (await roomsOf(c)).find((r) => r.id === id);
  if (room === undefined) throw new Error(`no room ${id}`);
  return room;
}

describe("say op", () => {
  // 何を保証するか: 呼び出し元は room を名指ししない。daemon が「u1 + 自分」の
  // 1on1 room を作り、2 回目以降は同じ room に積む — セッションごとに 1 本の
  // 発話履歴になる (呼ぶたびに room が増えない)。
  test(
    "creates the caller's 1on1 room once, then reuses it",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_1);
        const first = await s.requestOk({ op: "say", text: "hello" });
        expect(first.ok).toBe(true);
        expect(first.created).toBe(true);
        expect(typeof first.seq).toBe("number");

        const second = await s.requestOk({ op: "say", text: "again" });
        expect(second.created).toBe(false);
        expect(second.room).toBe(first.room);
        expect(second.seq).toBeGreaterThan(first.seq);

        const u = await user(ctx);
        const rooms = await roomsOf(u);
        const mine = rooms.filter((r) => r.kind === "1on1");
        expect(mine).toHaveLength(1);
        expect(mine[0].id).toBe(first.room);
        // 既存の 1on1 room と同じ `<repo> 1on1 <sid8>` 形で、sidebar の見え方を
        // 揃える。
        expect(mine[0].title).toBe("repo-5a900000-0000-4000-8000-000000000001 1on1 5a900000");
        expect(mine[0].members.map((m: any) => m.sid)).toEqual([SID_SAY_1]);
        expect(mine[0].say_unread_seqs).toEqual([first.seq, second.seq]);
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: そのセッションの 1on1 room が既に storage にあれば say は
  // そこへ入る (別の room に分岐しない)。「今までの会話の続き」として読める
  // ことが 1on1 に置く理由なので、ここが割れると設計目的を失う。create_room
  // では 1on1 room を開けないので、既存の room は storage に置いた jsonl を
  // daemon の起動で読み込ませて用意する。
  test(
    "reuses an existing 1on1 room loaded from storage",
    async () => {
      const ctx = await startTestDaemon();
      try {
        // Stop the daemon, place the room file, start it again so scanRooms
        // loads the room the same way it loads rooms left by a previous run.
        const c = await connect(ctx.sock);
        await c.request({ op: "shutdown" });
        c.close();
        await ctx.proc.exited;
        try {
          fs.unlinkSync(ctx.sock);
        } catch {
          // shutdown usually cleans it up
        }
        const ts = "2026-01-01T00:00:00.000Z";
        fs.mkdirSync(ctx.roomsDir, { recursive: true });
        fs.writeFileSync(
          `${ctx.roomsDir}/r1.jsonl`,
          [
            { type: "kind", kind: "1on1", ts },
            { type: "title", title: "existing 1on1", ts },
            {
              type: "member",
              id: "a1",
              sid: SID_SAY_2,
              repo: "",
              ws: "",
              cwd: "",
              joined_at: ts,
            },
          ]
            .map((e) => `${JSON.stringify(e)}\n`)
            .join(""),
        );
        ctx.proc = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
        await waitConnectable(ctx.sock);

        const s = await session(ctx, SID_SAY_2);
        const u = await user(ctx);
        const said = await s.requestOk({ op: "say", text: "yo" });
        expect(said.created).toBe(false);
        expect(said.room).toBe("r1");
        // 既存 room の title は say が上書きしない。
        expect((await roomOf(u, "r1")).title).toBe("existing 1on1");
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (kawaz r244 m6「webui とかが知りたいだけなのでセッションへの
  // echo は不要」): user の subscribe には say が届き、session の subscribe には
  // 届かない。喋った本人にも、他のエージェントにも流さない。
  test(
    "delivers say to user subscribers only",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const speaker = await session(ctx, SID_SAY_3);
        await speaker.request({ op: "subscribe" });
        const u = await user(ctx);
        await u.request({ op: "subscribe" });

        const said = await speaker.requestOk({ op: "say", text: "listen up" });
        const { ev } = await u.readEventUntil("say");
        expect(ev).toMatchObject({
          type: "say",
          r: said.room,
          sid: SID_SAY_3,
          text: "listen up",
          seq: said.seq,
        });

        // 話者側の stream に say が無いことを、順序の確定した round trip の後で
        // 確認する (pendingEvents は「今そこに無い」しか言えないため)。
        await speaker.request({ op: "ping" });
        const speakerEvents = await speaker.pendingEvents();
        expect(speakerEvents.filter(isKind("say"))).toEqual([]);
        u.close();
        speaker.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: 後から subscribe / room_history でさかのぼった session にも
  // say は復元されない。live だけ抑制して replay で漏れる、が起きない。
  test(
    "never replays say into a session's backlog or room_history",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const speaker = await session(ctx, SID_SAY_4);
        const said = await speaker.requestOk({ op: "say", text: "before subscribing" });

        // 話者は room の member なので room_history を引ける。それでも say は無い。
        await speaker.request({ op: "subscribe", backlog: true });
        await speaker.request({ op: "room_history", room: said.room });
        const events = await speaker.pendingEvents();
        expect(events.filter(isKind("say"))).toEqual([]);
        // member イベントは通常どおり見えている = 抑制が say に限定されている。
        expect(events.some(isKind("member"))).toBe(true);

        const u = await user(ctx);
        await u.request({ op: "subscribe", backlog: true });
        // subscribe replies before writing its snapshot, so order the stream
        // with a round trip before asserting on what did (not) arrive.
        await u.request({ op: "ping" });
        const userEvents = await u.pendingEvents();
        expect(userEvents.filter(isKind("say")).filter((e) => e.seq === said.seq)).toHaveLength(1);
        u.close();
        speaker.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("say_read op", () => {
  // 何を保証するか: 既読は未読集合から当該 seq だけを外す (他は残る)。同じ seq
  // への二重 ack が数を壊さないことも含む — ボタン連打は普通に起きる。
  test(
    "acks one say, leaving the others unread and staying idempotent",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_5);
        const a = await s.requestOk({ op: "say", text: "one" });
        const b = await s.requestOk({ op: "say", text: "two" });
        const u = await user(ctx);
        await u.request({ op: "subscribe" });

        const ack = await u.request({ op: "say_read", room: a.room, seq: a.seq });
        expect(ack).toMatchObject({ ok: true, room: a.room, ref: a.seq });
        const { ev } = await u.readEventUntil("say_read");
        expect(ev).toMatchObject({ type: "say_read", r: a.room, ref: a.seq });

        expect((await roomOf(u, a.room)).say_unread_seqs).toEqual([b.seq]);
        await u.request({ op: "say_read", room: a.room, seq: a.seq });
        expect((await roomOf(u, a.room)).say_unread_seqs).toEqual([b.seq]);

        await u.request({ op: "say_read", room: b.room, seq: b.seq });
        // 全部読んだ room はフィールドごと消える (「未読 0」は不在で表す契約)。
        expect((await roomOf(u, a.room)).say_unread_seqs).toBeUndefined();
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: 存在しない seq の ack は黙って成功しない。成功を返すと
  // 「既読にしたのにバッジが減らない」という追いにくい形で壊れる。
  test(
    "rejects an ack for a seq that is not a say event",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_6);
        const said = await s.requestOk({ op: "say", text: "hi" });
        const u = await user(ctx);
        const res = await u.requestError({ op: "say_read", room: said.room, seq: 9999 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
        const missing = await u.requestError({ op: "say_read", room: "r9999", seq: 1 });
        expect(missing.error.code).toBe("room_not_found");
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("say role gates", () => {
  // 何を保証するか: say は session 限定 (u1 が「喋った」記録を作れてしまうと
  // どのセッションが鳴らしたかの答えが濁る)、say_read は user 限定 (未読は
  // kawaz が見たかどうかの数で、喋った側が自分で消す数ではない)。
  test(
    "say requires session role and say_read requires user role",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_7);
        const said = await s.requestOk({ op: "say", text: "hi" });
        const u = await user(ctx);

        const userSay = await u.requestError({ op: "say", text: "nope" });
        expect(userSay.error.code).toBe("bad_request");
        const sessionAck = await s.requestError({
          op: "say_read",
          room: said.room,
          seq: said.seq,
        });
        expect(sessionAck.error.code).toBe("bad_request");
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("say persistence", () => {
  // 何を保証するか: say / say_read は room jsonl の永続イベントで、daemon を
  // 入れ替えても未読状態が残る。未読は「kawaz がまだ見ていない」の記録なので、
  // 再起動で消えるとマーカーとして信用できなくなる。
  test(
    "say and say_read survive a daemon restart",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_8);
        const a = await s.requestOk({ op: "say", text: "kept" });
        const b = await s.requestOk({ op: "say", text: "acked" });
        const u = await user(ctx);
        await u.request({ op: "say_read", room: b.room, seq: b.seq });
        u.close();
        s.close();

        // Bounce the daemon in place (stopTestDaemon also removes the data
        // dir, which would make "recovered from disk" vacuously true).
        const c = await connect(ctx.sock);
        await c.request({ op: "shutdown" });
        c.close();
        await ctx.proc.exited;
        try {
          fs.unlinkSync(ctx.sock);
        } catch {
          // shutdown usually cleans it up
        }
        ctx.proc = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
        await waitConnectable(ctx.sock);

        const u2 = await user(ctx);
        const room = await roomOf(u2, a.room);
        expect(room.kind).toBe("1on1");
        expect(room.say_unread_seqs).toEqual([a.seq]);
        u2.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
