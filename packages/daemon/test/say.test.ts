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
  await c.hello({ role: "session", sid, repo: `repo-${sid}`, ws: "main", cwd: `/tmp/${sid}` });
  return c;
}

async function user(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  return c;
}

async function roomsOf(c: TestClient): Promise<any[]> {
  const res = await c.request<{ ok: true; rooms: any[] }>({ op: "rooms" });
  return res.rooms;
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
        const s = await session(ctx, "sid-say-1");
        const first = await s.request<any>({ op: "say", text: "hello" });
        expect(first.ok).toBe(true);
        expect(first.created).toBe(true);
        expect(typeof first.seq).toBe("number");

        const second = await s.request<any>({ op: "say", text: "again" });
        expect(second.created).toBe(false);
        expect(second.room).toBe(first.room);
        expect(second.seq).toBeGreaterThan(first.seq);

        const u = await user(ctx);
        const rooms = await roomsOf(u);
        const mine = rooms.filter((r) => r.kind === "1on1");
        expect(mine).toHaveLength(1);
        expect(mine[0].id).toBe(first.room);
        // webui の auto-create と同じ `<repo> 1on1 <sid8>` 形。どちらが先に
        // 作っても sidebar の見え方が変わらないことの保証。
        expect(mine[0].title).toBe("repo-sid-say-1 1on1 sid-say-");
        expect(mine[0].members.map((m: any) => m.sid)).toEqual(["sid-say-1"]);
        expect(mine[0].say_unread_seqs).toEqual([first.seq, second.seq]);
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: webui が既に 1on1 room を開いていれば say はそこへ入る
  // (別の room に分岐しない)。「今開いている会話の続き」として読めることが
  // 1on1 に置く理由なので、ここが割れると設計目的を失う。
  test(
    "reuses a 1on1 room the webui created for this sid",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, "sid-say-2");
        const u = await user(ctx);
        const created = await u.request<any>({
          op: "create_room",
          members: ["sid-say-2"],
          kind: "1on1",
          title: "webui made this",
        });
        expect(created.ok).toBe(true);

        const said = await s.request<any>({ op: "say", text: "yo" });
        expect(said.created).toBe(false);
        expect(said.room).toBe(created.room);
        // 既存 room の title は say が上書きしない。
        const rooms = await roomsOf(u);
        expect(rooms.find((r) => r.id === created.room).title).toBe("webui made this");
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
        const speaker = await session(ctx, "sid-say-3");
        await speaker.request({ op: "subscribe" });
        const u = await user(ctx);
        await u.request({ op: "subscribe" });

        const said = await speaker.request<any>({ op: "say", text: "listen up" });
        const { ev } = await u.readEventUntil((e) => e.type === "say");
        expect(ev).toMatchObject({
          type: "say",
          r: said.room,
          sid: "sid-say-3",
          text: "listen up",
          seq: said.seq,
        });

        // 話者側の stream に say が無いことを、順序の確定した round trip の後で
        // 確認する (pendingEvents は「今そこに無い」しか言えないため)。
        await speaker.request({ op: "ping" });
        const speakerEvents = await speaker.pendingEvents<any>();
        expect(speakerEvents.filter((e) => e.type === "say")).toEqual([]);
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
        const speaker = await session(ctx, "sid-say-4");
        const said = await speaker.request<any>({ op: "say", text: "before subscribing" });

        // 話者は room の member なので room_history を引ける。それでも say は無い。
        await speaker.request({ op: "subscribe", backlog: true });
        await speaker.request({ op: "room_history", room: said.room });
        const events = await speaker.pendingEvents<any>();
        expect(events.filter((e) => e.type === "say")).toEqual([]);
        // member イベントは通常どおり見えている = 抑制が say に限定されている。
        expect(events.some((e) => e.type === "member")).toBe(true);

        const u = await user(ctx);
        await u.request({ op: "subscribe", backlog: true });
        // subscribe replies before writing its snapshot, so order the stream
        // with a round trip before asserting on what did (not) arrive.
        await u.request({ op: "ping" });
        const userEvents = await u.pendingEvents<any>();
        expect(userEvents.filter((e) => e.type === "say" && e.seq === said.seq)).toHaveLength(1);
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
        const s = await session(ctx, "sid-say-5");
        const a = await s.request<any>({ op: "say", text: "one" });
        const b = await s.request<any>({ op: "say", text: "two" });
        const u = await user(ctx);
        await u.request({ op: "subscribe" });

        const ack = await u.request<any>({ op: "say_read", room: a.room, seq: a.seq });
        expect(ack).toMatchObject({ ok: true, room: a.room, ref: a.seq });
        const { ev } = await u.readEventUntil((e) => e.type === "say_read");
        expect(ev).toMatchObject({ type: "say_read", r: a.room, ref: a.seq });

        expect((await roomsOf(u)).find((r) => r.id === a.room).say_unread_seqs).toEqual([b.seq]);
        await u.request({ op: "say_read", room: a.room, seq: a.seq });
        expect((await roomsOf(u)).find((r) => r.id === a.room).say_unread_seqs).toEqual([b.seq]);

        await u.request({ op: "say_read", room: b.room, seq: b.seq });
        // 全部読んだ room はフィールドごと消える (「未読 0」は不在で表す契約)。
        expect((await roomsOf(u)).find((r) => r.id === a.room).say_unread_seqs).toBeUndefined();
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
        const s = await session(ctx, "sid-say-6");
        const said = await s.request<any>({ op: "say", text: "hi" });
        const u = await user(ctx);
        const res = await u.request<any>({ op: "say_read", room: said.room, seq: 9999 });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("invalid_args");
        const missing = await u.request<any>({ op: "say_read", room: "r9999", seq: 1 });
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
        const s = await session(ctx, "sid-say-7");
        const said = await s.request<any>({ op: "say", text: "hi" });
        const u = await user(ctx);

        const userSay = await u.request<any>({ op: "say", text: "nope" });
        expect(userSay.error.code).toBe("bad_request");
        const sessionAck = await s.request<any>({
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
        const s = await session(ctx, "sid-say-8");
        const a = await s.request<any>({ op: "say", text: "kept" });
        const b = await s.request<any>({ op: "say", text: "acked" });
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
        const room = (await roomsOf(u2)).find((r) => r.id === a.room);
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
