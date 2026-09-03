// `op:"room_history"` — "paint me this one room". Subscribe carries room
// metadata only now (kawaz r99 m12: reloading the webui used to push every
// room's whole message history down the socket before anything rendered), so a
// client fetches a room's events when the user opens it. The op replays the
// same join snapshot the `backlog: true` subscribe path builds, for one room,
// and answers `{ok:true, room}` *after* those events so the reply doubles as a
// "snapshot complete" sentinel.
import { describe, expect, test } from "bun:test";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

// The recent-replay window (subscribe-recent-replay.test.ts) would add
// `replay: true` msgs to the bare-subscribe path and blur "did subscribe send
// history?"; these tests are about the snapshot, so the window is off.
const NO_RECENT = { CCMSG_RECENT_REPLAY_MS: "0" };

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

/** Send `room_history` and drain until its reply. The daemon writes the
 * snapshot events first and the `{ok:true, room}` reply last, and the test
 * helper's `request()` would take the first snapshot event for the reply (it
 * only sets aside frames carrying `ev`, and delivered events carry none), so
 * this reads the stream itself — which is also what the assertion needs. */
async function fetchHistory(c: TestClient, room: string): Promise<any[]> {
  c.write({ op: "room_history", room, request_id: "history" });
  const { seen } = await c.readEventUntil((ev) => ev.ok !== undefined);
  return seen;
}

describe("room_history", () => {
  test(
    "a user-role subscribe carries no msg history; room_history delivers all of it",
    async () => {
      const ctx = await startTestDaemon(NO_RECENT);
      try {
        const a = await session(ctx, "A");
        const room = (await a.request<{ room: string }>({ op: "create_room", members: ["B"] }))
          .room;
        await a.request({ op: "post", room, msg: "m1" });
        await a.request({ op: "post", room, msg: "m2" });

        // The webui's shape: hello as user, subscribe without `backlog`.
        const u = await user(ctx);
        await u.request({ op: "subscribe" });
        // Only the cursors summary — no `type:"msg"` line. This is the whole
        // point of the change: the user role used to get every msg of every
        // room here, uncapped.
        const first = await u.readEvent<{ ev?: string; rooms?: { room: string }[] }>();
        expect(first?.ev).toBe("room_cursors");
        expect(first?.rooms?.map((r) => r.room)).toEqual([room]);

        const seen = await fetchHistory(u, room);
        expect(seen.filter((e) => e.type === "msg").map((e) => e.mid)).toEqual([1, 2]);
        // member state comes with it, so the room paints without a second op
        expect(seen.some((e) => e.type === "member" && e.sid === "A")).toBe(true);
        // the reply is last, and it names the room it completed
        expect(seen.at(-1)).toMatchObject({ ok: true, room });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "history is not capped for a user, and live delivery continues after it",
    async () => {
      const ctx = await startTestDaemon(NO_RECENT);
      try {
        const a = await session(ctx, "A");
        const room = (await a.request<{ room: string }>({ op: "create_room", members: ["B"] }))
          .room;
        // more than DEFAULT_JOIN_BACKLOG=50: the cap exists to bound an agent's
        // context, and an explicitly opened room is not that.
        for (let i = 1; i <= 55; i++) await a.request({ op: "post", room, msg: `m${i}` });

        const u = await user(ctx);
        await u.request({ op: "subscribe" });
        await u.readEvent(); // room_cursors
        const seen = await fetchHistory(u, room);
        const mids = seen.filter((e) => e.type === "msg").map((e) => e.mid);
        expect(mids.length).toBe(55);
        expect(mids[0]).toBe(1);

        // The room is open; new posts must keep arriving on the same stream.
        await a.request({ op: "post", room, msg: "live" });
        const { ev } = await u.readEventUntil((e) => e.type === "msg");
        expect(ev).toMatchObject({ r: room, mid: 56, msg: "live" });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "a session sees its own rooms' history, and nothing about rooms it isn't in",
    async () => {
      const ctx = await startTestDaemon(NO_RECENT);
      try {
        const a = await session(ctx, "A");
        const shared = (await a.request<{ room: string }>({ op: "create_room", members: ["B"] }))
          .room;
        await a.request({ op: "post", room: shared, msg: "hello B" });
        const other = (await a.request<{ room: string }>({ op: "create_room", members: ["C"] }))
          .room;
        await a.request({ op: "post", room: other, msg: "not for B" });

        const b = await session(ctx, "B");
        await b.request({ op: "subscribe" });
        await b.readEvent(); // room_cursors (shared only)

        const seen = await fetchHistory(b, shared);
        expect(seen.filter((e) => e.type === "msg").map((e) => e.msg)).toEqual(["hello B"]);

        // A room B is not a member of is reported as absent rather than as a
        // permission error — room ids are opaque, "exists but not yours" would
        // leak that this one is live.
        b.write({ op: "room_history", room: other, request_id: "history-other" });
        const { ev } = await b.readEventUntil((e) => e.ok !== undefined);
        expect(ev).toMatchObject({ ok: false, error: { code: "room_not_found" } });

        const missing = await b.request<any>({ op: "room_history", room: "r9999" });
        expect(missing).toMatchObject({ ok: false, error: { code: "room_not_found" } });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
