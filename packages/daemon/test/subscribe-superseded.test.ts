// 同一セッションに対する `subscribe` が 2 本並走すると、同じイベントがその AI に
// 二重に届く (実例: Monitor で張った古い subscribe が生きたまま新しい subscribe
// を張った)。エージェント側に「二重起動するな」と求めても守らせようがないので、
// daemon が検出して古い方に `ev:"subscribe_superseded"` を送り、以降その conn へは
// 配信しない。新しい方 = 意図した起動なので残す。
import { describe, expect, test } from "bun:test";
import {
  startInProcessDaemon,
  stopInProcessDaemon,
  type InProcessDaemon,
  isKind,
  type TestClient,
  sessionConn,
  userConn,
} from "./helpers.ts";

const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SID_Z = "eeeeeeee-0000-4000-8000-00000000000f";

/** A session whose repo / ws / cwd are named after its sid. */
function session(ctx: InProcessDaemon, sid: string): Promise<TestClient> {
  return sessionConn(ctx, sid, { repo: `repo-${sid}`, ws: `ws-${sid}`, cwd: `/tmp/${sid}` });
}
describe("subscribe: duplicate session subscribe", () => {
  test("a second subscribe for the same sid supersedes the first, and only the newer one receives events", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const a = await session(ctx, SID_A);
      const oldSub = await session(ctx, SID_B);
      await oldSub.request({ op: "subscribe" });

      const newSub = await session(ctx, SID_B);
      await newSub.request({ op: "subscribe" });

      // 古い方は終了通知を受け取る。sid はどのセッションが重複したかを示す。
      const superseded = await oldSub.readEventUntil("subscribe_superseded");
      expect(superseded.ev.ev).toBe("subscribe_superseded");
      expect(superseded.ev.sid).toBe(SID_B);

      // 配信は新しい方だけに届く (= 二重通知が消えている)。session の
      // subscribe stream に流れる notify で見る。
      const sent = await a.requestOk({ op: "notify", sid: SID_B, text: "wake" });
      expect(sent.delivered).toBe(1);
      const delivered = await newSub.readEventUntil("notify");
      expect(delivered.ev.text).toBe("wake");

      // 古い conn は superseded 以降なにも push されない (subscriber 集合から
      // 外れている)。「届かないこと」は待ち時間でなく往復で確かめる: 配信が
      // 漏れていればこの request の応答より先にその行が stream に積まれている。
      const roundTrip = await oldSub.request({ op: "ping" });
      expect(roundTrip.ok).toBe(true);
      expect(await oldSub.pendingEvents()).toEqual([]);
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("user-role subscribers (multiple webui tabs) are never superseded", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u1 = await userConn(ctx);
      await u1.request({ op: "subscribe" });
      const u2 = await userConn(ctx);
      await u2.request({ op: "subscribe" });

      // A session subscribing must not disturb the user subscribers either.
      const s = await session(ctx, SID_A);
      await s.request({ op: "subscribe" });

      const a = await session(ctx, SID_Z);
      await a.requestOk({ op: "say", text: "hi" });

      for (const u of [u1, u2]) {
        const got = await u.readEventUntil("says", (ev) =>
          ev.says.some((say) => say.text === "hi"),
        );
        expect(got.seen.some(isKind("subscribe_superseded"))).toBe(false);
      }
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
