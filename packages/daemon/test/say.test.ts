// `ccmsg say` の記録 (kawaz r244 m5-m6、DR-0036 §3) の wire 契約。
//
// 何を保証するか (各 test の doc comment 参照):
//   - say op は daemon のメモリに記録し、room storage に何も書かない
//     (room を作らず、既存の 1on1 room にも行を足さない)
//   - 記録は ev:"says" (全件) で user role にだけ届く。subscribe 時にも全件
//     (空でも) 届き、session の subscribe には一切流さない (kawaz 「セッション
//     への echo は不要、コンテキストの無駄」)
//   - 既存の 1on1 room が持つ say / say_read の行も session には遡って渡さない
//   - say_read が記録の read を立て、全タブに更新後の全件を送る
//   - role gate: say は session 限定、say_read は user 限定
//   - 再起動で記録 (未読含む) が消える
//
// 実 daemon を UDS 越しに叩く (one-on-one.test.ts と同じ harness): 配信経路の
// 抑制ルールは単体テストでは踏めないので、出荷する線の上で確かめる。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import type { SayRecord } from "@ccmsg/protocol";
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
const TS = "2026-01-01T00:00:00.000Z";

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

/** A subscribed user connection and the say records its subscribe-time
 * catch-up carried. */
async function subscribedUser(
  ctx: DaemonCtx,
): Promise<{ u: TestClient; says: readonly SayRecord[] }> {
  const u = await user(ctx);
  await u.request({ op: "subscribe" });
  const { ev } = await u.readEventUntil("says");
  return { u, says: ev.says };
}

/** Stop the daemon, optionally place a room file, and start it again on the
 * same data dir (stopTestDaemon would also remove it). */
async function restart(ctx: DaemonCtx, room?: { id: string; events: object[] }): Promise<void> {
  const c = await connect(ctx.sock);
  await c.request({ op: "shutdown" });
  c.close();
  await ctx.proc.exited;
  try {
    fs.unlinkSync(ctx.sock);
  } catch {
    // shutdown usually cleans it up
  }
  if (room !== undefined) {
    fs.mkdirSync(ctx.roomsDir, { recursive: true });
    fs.writeFileSync(
      `${ctx.roomsDir}/${room.id}.jsonl`,
      room.events.map((e) => `${JSON.stringify(e)}\n`).join(""),
    );
  }
  ctx.proc = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
  await waitConnectable(ctx.sock);
}

/** A 1on1 room of `sid` as an earlier daemon left it, holding one say and its
 * ack. */
function oneOnOneWithSay(sid: string): object[] {
  return [
    { type: "kind", kind: "1on1", ts: TS },
    { type: "title", title: "existing 1on1", ts: TS },
    { type: "member", id: "a1", sid, repo: "", ws: "", cwd: "", joined_at: TS },
    { type: "say", sid, text: "old say", ts: TS },
    { type: "say_read", ref: 4, ts: TS },
  ];
}

describe("say op", () => {
  // 何を保証するか: say は daemon のメモリにだけ記録され、room storage に
  // 依存しない (DR-0036 §3、room を削る段 C の前提)。room を作らず、rooms dir
  // にファイルも作らない。記録は user の subscribe に ev:"says" で届き、呼んだ
  // セッション自身の sid・本文・未読で入る。
  test(
    "records the say in memory and pushes it to user subscribers, creating no room",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const { u, says: before } = await subscribedUser(ctx);
        expect(before).toEqual([]);
        const s = await session(ctx, SID_SAY_1);
        const first = await s.requestOk({ op: "say", text: "hello" });
        const { ev: afterFirst } = await u.readEventUntil("says");
        expect(afterFirst.says.map((r) => [r.id, r.sid, r.text, r.read])).toEqual([
          [first.id, SID_SAY_1, "hello", false],
        ]);

        const second = await s.requestOk({ op: "say", text: "again" });
        expect(second.id).not.toBe(first.id);
        const { ev: afterSecond } = await u.readEventUntil("says");
        expect(afterSecond.says.map((r) => [r.id, r.text, r.read])).toEqual([
          [first.id, "hello", false],
          [second.id, "again", false],
        ]);

        expect((await u.requestOk({ op: "rooms" })).rooms).toEqual([]);
        const files = fs.existsSync(ctx.roomsDir) ? fs.readdirSync(ctx.roomsDir) : [];
        expect(files).toEqual([]);
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: そのセッションの 1on1 room が storage にあっても、say は
  // そこへ行を足さない。既存の 1on1 room は読み取り専用で残るだけ
  // (DR-0035 §2 / DR-0036 §3)。
  test(
    "appends nothing to the session's existing 1on1 room",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await restart(ctx, { id: "r1", events: oneOnOneWithSay(SID_SAY_2) });
        const before = fs.readFileSync(`${ctx.roomsDir}/r1.jsonl`, "utf8");

        const s = await session(ctx, SID_SAY_2);
        await s.requestOk({ op: "say", text: "yo" });
        const u = await user(ctx);
        const rooms = (await u.requestOk({ op: "rooms" })).rooms;
        expect(rooms.map((r) => [r.id, r.kind, r.last_mid])).toEqual([["r1", "1on1", 0]]);
        expect(fs.readFileSync(`${ctx.roomsDir}/r1.jsonl`, "utf8")).toBe(before);
        u.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (kawaz r244 m6「webui とかが知りたいだけなのでセッションへの
  // echo は不要」): user の subscribe には ev:"says" が届き、session の
  // subscribe には subscribe 時にも say の後にも届かない。喋った本人にも、
  // 他のエージェントにも流さない。
  test(
    "pushes says to user subscribers only, never to a session",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const speaker = await session(ctx, SID_SAY_3);
        await speaker.request({ op: "subscribe" });
        const { u } = await subscribedUser(ctx);

        const said = await speaker.requestOk({ op: "say", text: "listen up" });
        const { ev } = await u.readEventUntil("says");
        expect(ev.says.map((r) => [r.id, r.sid, r.text])).toEqual([
          [said.id, SID_SAY_3, "listen up"],
        ]);

        // 話者側の stream に says が無いことを、順序の確定した round trip の後で
        // 確認する (pendingEvents は「今そこに無い」しか言えないため)。
        await speaker.request({ op: "ping" });
        const speakerEvents = await speaker.pendingEvents();
        expect(speakerEvents.filter(isKind("says"))).toEqual([]);
        u.close();
        speaker.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: 既存の 1on1 room が持つ say / say_read の行も、後から
  // subscribe / room_history でさかのぼった session には渡らない。user には
  // room の本文として渡る (読み取り専用の閲覧)。
  test(
    "never replays an existing 1on1 room's say rows into a session's backlog or room_history",
    async () => {
      const ctx = await startTestDaemon();
      try {
        await restart(ctx, { id: "r1", events: oneOnOneWithSay(SID_SAY_4) });
        const speaker = await session(ctx, SID_SAY_4);

        // 話者は room の member なので room_history を引ける。それでも say は無い。
        await speaker.request({ op: "subscribe", backlog: true });
        await speaker.request({ op: "room_history", room: "r1" });
        const events = await speaker.pendingEvents();
        expect(events.filter(isKind("say"))).toEqual([]);
        expect(events.filter(isKind("say_read"))).toEqual([]);
        // member イベントは通常どおり見えている = 抑制が say に限定されている。
        expect(events.some(isKind("member"))).toBe(true);

        const u = await user(ctx);
        await u.request({ op: "subscribe", backlog: true });
        // subscribe replies before writing its snapshot, so order the stream
        // with a round trip before asserting on what did (not) arrive.
        await u.request({ op: "ping" });
        const userEvents = await u.pendingEvents();
        expect(userEvents.filter(isKind("say")).map((e) => e.text)).toEqual(["old say"]);
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
  // 何を保証するか: 既読は当該 id の記録だけを read にし (他は残る)、更新後の
  // 全件を subscribe 中の全タブに送る。同じ id への二重 ack が状態を壊さない
  // ことも含む — ボタン連打は普通に起きる。
  test(
    "acks one say, leaving the others unread and staying idempotent",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_5);
        const a = await s.requestOk({ op: "say", text: "one" });
        const b = await s.requestOk({ op: "say", text: "two" });
        const { u, says } = await subscribedUser(ctx);
        expect(says.map((r) => r.read)).toEqual([false, false]);
        const { u: otherTab } = await subscribedUser(ctx);

        expect(await u.request({ op: "say_read", id: a.id })).toMatchObject({ ok: true, id: a.id });
        const unreadAfter = (ev: { says: readonly SayRecord[] }) =>
          ev.says.filter((r) => !r.read).map((r) => r.id);
        expect(unreadAfter((await u.readEventUntil("says")).ev)).toEqual([b.id]);
        expect(unreadAfter((await otherTab.readEventUntil("says")).ev)).toEqual([b.id]);

        // 二度目の ack は成功を返し、状態は変わらない。
        expect(await u.request({ op: "say_read", id: a.id })).toMatchObject({ ok: true, id: a.id });
        await u.request({ op: "say_read", id: b.id });
        const { ev } = await u.readEventUntil("says");
        expect(ev.says.map((r) => [r.id, r.read])).toEqual([
          [a.id, true],
          [b.id, true],
        ]);
        u.close();
        otherTab.close();
        s.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか: 存在しない id の ack は黙って成功しない。成功を返すと
  // 「既読にしたのにバッジが減らない」という追いにくい形で壊れる。
  test(
    "rejects an ack for an id that is not a say",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_6);
        await s.requestOk({ op: "say", text: "hi" });
        const u = await user(ctx);
        const res = await u.requestError({ op: "say_read", id: "0000/9999" });
        expect(res.error).toEqual({ code: "invalid_args", msg: "no say with id 0000/9999" });
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
        const sessionAck = await s.requestError({ op: "say_read", id: said.id });
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

describe("say memory", () => {
  // 何を保証するか (DR-0036 §3「daemon の再起動で未読が消えるのは許容」):
  // 記録は daemon のメモリだけにあり、再起動した daemon は未読を含めて何も
  // 持たない。subscribe 時の ev:"says" は空で届く — これで再接続したタブが
  // 前の daemon の say を捨てられる。前の daemon の id への ack は失敗する。
  test(
    "a daemon restart forgets every say, unread ones included",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await session(ctx, SID_SAY_8);
        const a = await s.requestOk({ op: "say", text: "unread" });
        const { u, says } = await subscribedUser(ctx);
        expect(says.map((r) => [r.id, r.read])).toEqual([[a.id, false]]);
        u.close();
        s.close();

        await restart(ctx);

        const { u: u2, says: after } = await subscribedUser(ctx);
        expect(after).toEqual([]);
        const res = await u2.requestError({ op: "say_read", id: a.id });
        expect(res.error.code).toBe("invalid_args");
        u2.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
