// DR-0017 §2.2 reply op: the daemon computes reply delivery targets so the
// replier never assembles a `to` list itself. Origin: reply_via (DR-0014) was
// a read-and-obey hint that agents demonstrably failed to obey (r17 mid=16 —
// the hint was delivered and readable, yet ignored); moving the target
// computation server-side turns the hint into a command the daemon enforces.
// Real daemon over UDS (same harness as one-on-one.test.ts).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
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

describe("DR-0017 reply op", () => {
  // 何を保証するか (§2.2 の宛先構成): reply の to = 元 msg の from + (元 to −
  // 返信者)、canonical id 順。返信者自身は入らない (自分に配る意味がない)。
  // u1 は force-add しない (always-exempt 配信は別経路、agent 同士の会話に
  // 毎回 "→ u1" 表示を混ぜないため)。storage には reply_to: "rNmN" が残る。
  test(
    "reply builds to = original from + (original to - replier), records reply_to",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const b = await session(ctx, "B");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B", "C"],
        });
        const room = created.room;

        // A (a1) posts to B (a2) + C (a3). B replies: to must be
        // [a1, a3] — original from (a1) + original to minus B himself (a3).
        // u1 is NOT included (delivered via always-exempt fanout instead).
        // Sorted canonical: a-prefix, numeric ascending.
        const posted = await a.request<{ mid: number }>({
          op: "post",
          room,
          msg: "question",
          to: ["a2", "a3"],
        });
        const replied = await b.request<{ ok: boolean; mid: number; to: string[] }>({
          op: "reply",
          room,
          mid: posted.mid,
          msg: "answer",
        });
        expect(replied.ok).toBe(true);
        expect(replied.to).toEqual(["a1", "a3"]);

        // The stored msg carries reply_to pointing at the original.
        const raw = fs.readFileSync(`${ctx.roomsDir}/${room}.jsonl`, "utf8");
        const lines = raw
          .trim()
          .split("\n")
          .map((l) => JSON.parse(l));
        const replyLine = lines.find((l) => l.type === "msg" && l.mid === replied.mid);
        expect(replyLine.reply_to).toBe(`${room}m${posted.mid}`);
        expect(replyLine.to).toEqual(["a1", "a3"]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.2 error: 自分の msg への reply): 構成上 to が
  // 「u1 + 自分」に潰れて意味を成さないので self_reply で弾く。
  test(
    "replying to your own msg is rejected with self_reply",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A", "B"],
        });
        const posted = await a.request<{ mid: number }>({
          op: "post",
          room: created.room,
          msg: "mine",
        });
        const res = await a.request<{ ok: false; error: { code: string } }>({
          op: "reply",
          room: created.room,
          mid: posted.mid,
          msg: "self",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("self_reply");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.2 error: 不在 mid): 存在しない msg を指した reply は
  // msg_not_found。曖昧に空 room へ post されるより error で意図の齟齬を
  // 即座に返す。
  test(
    "replying to a nonexistent mid is rejected with msg_not_found",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
        });
        const res = await a.request<{ ok: false; error: { code: string } }>({
          op: "reply",
          room: created.room,
          mid: 999,
          msg: "ghost",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("msg_not_found");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.5 tl 経路の矯正): 1on1 room の u1 msg (reply_via
  // "tl") への reply は error で弾き、error msg で「transcript 出力で返す」
  // を案内する。hint 素通り (r17 mid=16 の実事故) を、間違った経路を選んだ
  // 瞬間に矯正する仕組み — 黙って room post に変換すると kawaz が TL で
  // 読む前提と表示経路がずれる。
  test(
    "replying to a tl-routed msg (1on1, u1-authored) is rejected with guidance",
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
        const posted = await u.request<{ mid: number }>({
          op: "post",
          room: created.room,
          msg: "priv from u1",
        });
        const res = await a.request<{ ok: false; error: { code: string; msg: string } }>({
          op: "reply",
          room: created.room,
          mid: posted.mid,
          msg: "should be tl",
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

  // 何を保証するか (§2.2 × DR-0013): broadcast room の u1 msg への agent
  // reply が成立する — 元 msg の from が u1 なので reply の to に u1 が
  // 入り、broadcast の「agent post は to に u1 必須」制約 (DR-0013 §2.4) を
  // 構成上自動で満たす (reply op は §2.4 の post チェックを通らないが、
  // 意味論としての「u1 が受け手」は保たれる)。agent が自力で to を組む
  // 必要がないことの実証でもある。
  test(
    "agent reply in a broadcast room satisfies the u1-target constraint by construction",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: [],
          kind: "broadcast",
        });
        const posted = await u.request<{ mid: number }>({
          op: "post",
          room: created.room,
          msg: "broadcast question",
        });
        const replied = await a.request<{ ok: boolean; to: string[] }>({
          op: "reply",
          room: created.room,
          mid: posted.mid,
          msg: "agent answer",
        });
        expect(replied.ok).toBe(true);
        expect(replied.to).toContain("u1");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // 何を保証するか (§2.2 権限): 非 member session の reply は not_a_member。
  // post と同じ境界 — reply が member 判定を素通りする抜け道にならない。
  test(
    "reply from a non-member session is rejected with not_a_member",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const a = await session(ctx, "A");
        const outsider = await session(ctx, "X");
        const created = await u.request<{ room: string }>({
          op: "create_room",
          members: ["A"],
        });
        const posted = await a.request<{ mid: number }>({
          op: "post",
          room: created.room,
          msg: "insiders only",
        });
        const res = await outsider.request<{ ok: false; error: { code: string } }>({
          op: "reply",
          room: created.room,
          mid: posted.mid,
          msg: "let me in",
        });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("not_a_member");
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
