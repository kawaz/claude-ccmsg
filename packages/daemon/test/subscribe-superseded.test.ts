// 同一セッションに対する `subscribe` が 2 本並走すると、同じ msg がその AI に
// 二重に届く (実例: Monitor で張った古い subscribe が生きたまま新しい subscribe
// を張った)。エージェント側に「二重起動するな」と求めても守らせようがないので、
// daemon が検出して古い方に `ev:"subscribe_superseded"` を送り、以降その conn へは
// 配信しない (kawaz r90m3 裁定)。新しい方 = 意図した起動なので残す。
import { describe, expect, test } from "bun:test";
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

describe("subscribe: duplicate session subscribe", () => {
  test(
    "a second subscribe for the same sid supersedes the first, and only the newer one receives msgs",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const oldSub = await session(ctx, "B");
        await oldSub.request({ op: "subscribe" });

        const newSub = await session(ctx, "B");
        await newSub.request({ op: "subscribe" });

        // 古い方は終了通知を受け取る。sid はどのセッションが重複したかを示す。
        const superseded = await oldSub.readEventUntil<{ ev: string; sid: string }>(
          (ev) => ev?.ev === "subscribe_superseded",
        );
        expect(superseded.ev.ev).toBe("subscribe_superseded");
        expect(superseded.ev.sid).toBe("B");

        // 配信は新しい方だけに届く (= 二重通知が消えている)。
        const created = await a.request<{ room: string }>({ op: "create_room", members: ["B"] });
        await a.request({ op: "post", room: created.room, msg: "hello" });
        const delivered = await newSub.readEventUntil<{ type?: string; msg?: string }>(
          (ev) => ev?.type === "msg",
        );
        expect(delivered.ev.msg).toBe("hello");

        // 古い conn は superseded 以降なにも push されない (room 作成の snapshot
        // も含め subscriber 集合から外れている)。「届かないこと」は待ち時間で
        // なく往復で確かめる: 配信が漏れていればこの request の応答より先に
        // その行が読まれる。
        const roundTrip = await oldSub.request<{ ok?: boolean; type?: string }>({ op: "rooms" });
        expect(roundTrip.ok).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "user-role subscribers (multiple webui tabs) are never superseded",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u1 = await user(ctx);
        await u1.request({ op: "subscribe" });
        const u2 = await user(ctx);
        await u2.request({ op: "subscribe" });

        // A session subscribing must not disturb the user subscribers either.
        const s = await session(ctx, "A");
        await s.request({ op: "subscribe" });

        const a = await session(ctx, "Z");
        const created = await a.request<{ room: string }>({ op: "create_room", members: ["A"] });
        await a.request({ op: "post", room: created.room, msg: "hi" });

        for (const u of [u1, u2]) {
          const got = await u.readEventUntil<{ type?: string; msg?: string }>(
            (ev) => ev?.type === "msg",
          );
          expect(got.ev.msg).toBe("hi");
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
