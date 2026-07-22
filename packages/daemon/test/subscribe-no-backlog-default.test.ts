// docs/issue/2026-07-17-subscribe-no-backlog-default.md: subscribe's bare default
// (no since/since_seq entry for a room, no `backlog: true`) sends NO backlog for
// that room — only a one-shot `ev:"room_cursors"` summary ({room, last_mid} per
// visible room). Legacy full/delta replay is opt-in: name the room in
// since/since_seq (even with an invalid value, e.g. old-client compat), or set
// `backlog: true` (the webui's unconditional choice, since it paints room
// history from the backlog).
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

// The bare-default subscribe path additionally emits a **recent-replay** of
// msgs from the last few minutes with `replay: true` (kawaz r46 mid=35, see
// subscribe-recent-replay.test.ts). These tests isolate the pure no-backlog
// contract for **pre-window** history by disabling the recent-replay window
// (CCMSG_RECENT_REPLAY_MS=0) — the recent-replay concern lives in its own
// test file so the two contracts don't tangle here.
const NO_RECENT = { CCMSG_RECENT_REPLAY_MS: "0" };

describe("subscribe: no-backlog bare default", () => {
  test(
    "bare `subscribe` (no since, no backlog) delivers no msg backlog — only ev:room_cursors",
    async () => {
      const ctx = await startTestDaemon(NO_RECENT);
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({
          op: "create_room",
          members: ["B"],
        });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });
        await a.request({ op: "post", room, msg: "m2" }); // mid 2, room.lastMid = 2

        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });
        // the very first pushed frame must be the cursors summary, carrying this
        // room's current last_mid — not a replayed `type:"msg"` backlog line.
        const first = await bSub.readEvent<{
          ev?: string;
          rooms?: { room: string; last_mid: number }[];
        }>();
        expect(first?.ev).toBe("room_cursors");
        expect(first?.rooms).toEqual([{ room, last_mid: 2 }]);

        // a live-terminator msg posted AFTER subscribe still arrives normally —
        // the no-backlog default only withholds pre-existing history, not future
        // live delivery.
        await a.request({ op: "post", room, msg: "m3" }); // mid 3, delivered live
        const { seen } = await bSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 3);
        // no `type:"msg"` line for mid 1 or 2 ever arrived on this connection.
        const backlogMids = seen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(backlogMids).toEqual([3]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "room_cursors covers every visible room the subscriber has no cursor for, one event",
    async () => {
      const ctx = await startTestDaemon(NO_RECENT);
      try {
        const a = await session(ctx, "A");
        await session(ctx, "C"); // just needs to be a resolvable peer for create_room
        // distinct member sets (B-only vs B+C) so create_room's dedup fold
        // (same author + same member set within the window) doesn't collapse
        // these into a single room.
        const r1 = (await a.request<{ room: string }>({ op: "create_room", members: ["B"] })).room;
        await a.request({ op: "post", room: r1, msg: "r1m1" });
        const r2 = (await a.request<{ room: string }>({ op: "create_room", members: ["B", "C"] }))
          .room;
        await a.request({ op: "post", room: r2, msg: "r2m1" });
        await a.request({ op: "post", room: r2, msg: "r2m2" });

        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe" });
        const first = await bSub.readEvent<{
          ev?: string;
          rooms?: { room: string; last_mid: number }[];
        }>();
        expect(first?.ev).toBe("room_cursors");
        const byRoom = new Map((first?.rooms ?? []).map((r) => [r.room, r.last_mid]));
        expect(byRoom.get(r1)).toBe(1);
        expect(byRoom.get(r2)).toBe(2);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "naming a room in `since_seq` (even at 0) opts that room back into a full replay",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({ op: "create_room", members: ["B"] });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });
        await a.request({ op: "post", room, msg: "m2" });

        const bSub = await session(ctx, "B");
        await bSub.request({ op: "subscribe", since_seq: { [room]: 0 } });
        // `since_seq: 0` is a positional-delta replay from the start (DR-0016), not
        // the room_cursors summary — both pre-existing msgs arrive as real events
        // (preceded by the room's member-join event, also part of the full replay).
        const { seen } = await bSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 2);
        expect(seen.some((e) => e.ev === "room_cursors")).toBe(false);
        const mids = seen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(mids).toEqual([1, 2]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "`backlog: true` restores the legacy join-snapshot for every room without a since cursor",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await session(ctx, "A");
        const created = await a.request<{ room: string }>({ op: "create_room", members: ["B"] });
        const room = created.room;
        await a.request({ op: "post", room, msg: "m1" });
        await a.request({ op: "post", room, msg: "m2" });

        // user role: uncapped join snapshot, same shape webui gets on every connect.
        const uSub = await user(ctx);
        await uSub.request({ op: "subscribe", backlog: true });
        const first = await uSub.readEvent<{ type?: string }>();
        // first frame is the room's member snapshot (create_room's member event),
        // not a room_cursors summary — `backlog: true` suppresses it entirely.
        expect(first?.type).not.toBeUndefined();
        const { seen } = await uSub.readEventUntil((ev) => ev.type === "msg" && ev.mid === 2);
        const mids = seen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(mids).toEqual([1, 2]);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
