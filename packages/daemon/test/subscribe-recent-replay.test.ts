// subscribe の bare default (since/backlog なし) で、user role の subscriber には
// 「直近 N ms 以内かつ live 配信されたはず」の msg を replay:true マーカー付きで流す。
// - since_seq / backlog:true 経路には影響しない (opt-in 既定の delta/full replay 側)
// - broadcast room の member/leave suppression と msgVisibleTo は live 配信と同じルール
// - session role の subscribe stream には msg を流さない (msg は peer-inject で届く)
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

describe("subscribe: recent-replay (bare default, within window)", () => {
  test(
    "post before subscribe → bare-default subscribe replays within-window msgs with replay:true, then room_cursors",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "60000" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });
        await a.request({ op: "post", room, msg: "m2" });

        const bSub = await user(ctx);
        await bSub.request({ op: "subscribe" });
        // Recent-replay msgs arrive first (replay:true), then the room_cursors summary.
        const { seen } = await bSub.readEventUntil((ev) => ev.ev === "room_cursors");
        const msgFrames = seen.filter((e) => e.type === "msg");
        expect(msgFrames.map((e) => e.mid)).toEqual([1, 2]);
        for (const m of msgFrames) expect(m.replay).toBe(true);
        // room_cursors still fires with the current last_mid — a room with recent
        // replay is still a room without a durable cursor for this subscriber.
        const cursors = seen.find((e) => e.ev === "room_cursors");
        expect(cursors?.rooms).toEqual([{ room, last_mid: 2 }]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "msgs older than the window are NOT replayed (only room_cursors emitted)",
    async () => {
      // window = 0 disables the recent-replay branch entirely — cleanest way
      // to assert "no replay for old msgs" without racing on sleep timing.
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "0" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });

        const bSub = await user(ctx);
        await bSub.request({ op: "subscribe" });
        const first = await bSub.readEvent<{ ev?: string; type?: string }>();
        expect(first?.ev).toBe("room_cursors");
        // Post a live msg to close out the read; assert no msg preceded room_cursors.
        await a.request({ op: "post", room, msg: "m2" });
        const { seen } = await bSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 2);
        // seen collects everything up to (and including) the terminator, so m2
        // will be there; m1 must not.
        expect(seen.filter((e) => e.type === "msg").map((e) => e.mid)).toEqual([2]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "recent replay to the user includes `to`-addressed msgs, as live delivery does",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "60000" });
      try {
        const a = await session(ctx, "A");
        await session(ctx, "B");
        await session(ctx, "C");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B", "C"],
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "for-B-only", to: ["a2"] });

        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe" });
        const { seen } = await uSub.readEventUntil((ev) => ev.ev === "room_cursors");
        const msgs = seen.filter((e) => e.type === "msg");
        expect(msgs.map((e) => [e.mid, e.to, e.replay])).toEqual([[1, ["a2"], true]]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "reconnect with since_seq takes the delta-replay path — recent replay does NOT re-fire",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "60000" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });

        // First subscribe: recent-replay fires and gives us the msg + cursors.
        const bSub1 = await user(ctx);
        await bSub1.request({ op: "subscribe" });
        const first = await bSub1.readEventUntil((ev) => ev.ev === "room_cursors");
        const firstSeq = first.seen.find((e) => e.type === "msg")?.seq;
        expect(typeof firstSeq).toBe("number");

        // Second subscribe with since_seq at that cursor: delta path, no recent-replay,
        // no room_cursors summary (since_seq counts as a cursor for the room).
        const bSub2 = await user(ctx);
        await bSub2.request({ op: "subscribe", since_seq: { [room]: firstSeq! } });
        // Nothing to read up to a terminator we can force: post m2 live and assert
        // that only m2 arrives, with no replay flag.
        await a.request({ op: "post", room, msg: "m2" });
        const { seen } = await bSub2.readEventUntil((ev) => ev.type === "msg" && ev.mid === 2);
        const msgs = seen.filter((e) => e.type === "msg");
        expect(msgs.map((e) => e.mid)).toEqual([2]);
        expect(msgs[0].replay).toBeUndefined();
        // no room_cursors summary in the delta path
        expect(seen.some((e) => e.ev === "room_cursors")).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a session-role subscriber gets no recent replay, only room_cursors",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "60000" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });

        for (const sid of ["A", "B"]) {
          const sub = await session(ctx, sid);
          await sub.request({ op: "subscribe" });
          const first = await sub.readEvent<{ ev?: string; rooms?: unknown }>();
          expect(first).toEqual({ ev: "room_cursors", rooms: [{ room, last_mid: 1 }] });
          await sub.request({ op: "rooms" });
          expect(await sub.pendingEvents()).toEqual([]);
        }
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "`backlog: true` still uses the legacy join snapshot — recent-replay branch is skipped",
    async () => {
      const ctx = await startTestDaemon({ CCMSG_RECENT_REPLAY_MS: "60000" });
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });

        const bSub = await user(ctx);
        await bSub.request({ op: "subscribe", backlog: true });
        const { seen } = await bSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 1);
        const msgs = seen.filter((e) => e.type === "msg");
        // full-replay path: msg present but NOT flagged replay (marker is
        // recent-replay-only, backlog path is the pre-existing snapshot).
        expect(msgs.map((e) => e.mid)).toEqual([1]);
        expect(msgs[0].replay).toBeUndefined();
        // no room_cursors summary because the room got a real replay.
        expect(seen.some((e) => e.ev === "room_cursors")).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
