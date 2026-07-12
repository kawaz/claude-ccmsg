// ev:"peers" push (issue 2026-07-12-peers-live-update-protocol): the daemon pushes
// the full peers list (same shape the `peers` op returns) to every user-role
// subscriber whenever a session registers (hello, new sid), fully disconnects
// (removeConn, sid entry actually removed), or its hello metadata changes for
// real (repo/ws/branch/transcript_path/repo_root). A no-op hello re-send must not
// spam a push, and session-role subscribers must never receive this event at all
// (webui-only, same rationale as ev:"agents" in agents.ts).
import { describe, expect, test } from "bun:test";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;

async function sessionHello(
  ctx: DaemonCtx,
  sid: string,
  extra: Partial<{ repo: string; ws: string; cwd: string; branch: string }> = {},
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "session",
    sid,
    repo: extra.repo ?? "r",
    ws: extra.ws ?? "w",
    cwd: extra.cwd ?? "/tmp",
    ...(extra.branch ? { branch: extra.branch } : {}),
  });
  return c;
}

async function userConn(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "user" });
  return c;
}

interface PeerLite {
  sid: string;
  repo?: string;
  ws?: string;
  cwd?: string;
  transcript_path?: string;
  repo_root?: string;
  branch?: string;
  connected_at?: string;
  last_activity_at?: string;
}
interface PeersEv {
  ev: "peers";
  peers: PeerLite[];
}

/** Post a distinguishable marker msg via an ALREADY-connected session (never a
 *  fresh hello — a new hello is itself a peers-changing event and would
 *  contaminate the "no ev:'peers' arrived" tests below). Used to prove no
 *  ev:"peers" snuck in by collecting every event up to the marker and asserting
 *  none of them was ev:"peers", rather than a blind timeout sleep. For a
 *  user-role subscriber `room` may be a fresh no-member room (admin sees every
 *  room regardless); for a session-role subscriber the room must already
 *  include that session (subscriberSeesRoom), so callers targeting a session
 *  subscriber pass a room the target is already a member of. */
async function postMarkerVia(poster: TestClient, text: string, room?: string): Promise<void> {
  const roomId =
    room ?? (await poster.request<{ room: string }>({ op: "create_room", members: [] })).room;
  await poster.request({ op: "post", room: roomId, msg: text });
}

describe("ev:peers push", () => {
  test(
    "新規 sid の hello で user-role subscriber に ev:peers が届く",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const helloP = sessionHello(ctx, "A");
        const { ev } = await u.readEventUntil<PeersEv>((e) => e.ev === "peers");
        expect(ev.peers.some((p) => p.sid === "A")).toBe(true);
        (await helloP).close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "完全切断 (sid のエントリ消滅) で user-role subscriber に ev:peers が届き、peers から消える",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a = await sessionHello(ctx, "A");
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        a.close();
        const { ev } = await u.readEventUntil<PeersEv>((e) => e.ev === "peers");
        expect(ev.peers.some((p) => p.sid === "A")).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "session role の subscriber には ev:peers が一切届かない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const s = await sessionHello(ctx, "S");
        const m = await sessionHello(ctx, "M"); // marker poster, already connected
        const markerRoom = (
          await m.request<{ room: string }>({ op: "create_room", members: ["S"] })
        ).room;
        await s.request({ op: "subscribe" });
        // trigger two peers-changing events while S is subscribed: a new hello
        // and a full disconnect.
        const b = await sessionHello(ctx, "B");
        b.close();
        await postMarkerVia(m, "marker", markerRoom);
        const { seen } = await s.readEventUntil((e) => e.type === "msg" && e.msg === "marker");
        expect(seen.some((e: any) => e.ev === "peers")).toBe(false);
        m.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "内容が変わらない hello の再送では ev:peers を再送しない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const m = await sessionHello(ctx, "M"); // marker poster, connected up front
        await u.readEventUntil<PeersEv>((e) => e.ev === "peers"); // drain M's own registration push
        const a = await sessionHello(ctx, "A", { repo: "r", ws: "w", cwd: "/tmp" });
        await u.readEventUntil<PeersEv>((e) => e.ev === "peers"); // drain A's registration push

        // identical re-hello on the same conn — must not push again.
        await a.request({
          op: "hello",
          role: "session",
          sid: "A",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        await postMarkerVia(m, "marker");
        const { seen } = await u.readEventUntil((e) => e.type === "msg" && e.msg === "marker");
        expect(seen.some((e: any) => e.ev === "peers")).toBe(false);
        a.close();
        m.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "hello メタデータが実質変化 (repo 変更) すると ev:peers が再送され、新しい repo が載る",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const a = await sessionHello(ctx, "A", { repo: "r1", ws: "w", cwd: "/tmp" });
        await u.readEventUntil<PeersEv>((e) => e.ev === "peers"); // first push (new sid)

        await a.request({
          op: "hello",
          role: "session",
          sid: "A",
          repo: "r2",
          ws: "w",
          cwd: "/tmp",
        });
        const { ev } = await u.readEventUntil<PeersEv>((e) => e.ev === "peers");
        const me = ev.peers.find((p) => p.sid === "A");
        expect(me?.repo).toBe("r2");
        a.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "同一 sid の複数 conn のうち 1 本を閉じただけ (sid は生存) では ev:peers を送らない",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const a1 = await sessionHello(ctx, "A");
        // second conn re-hellos the same sid, identical metadata (latest-hello-wins
        // path, entry reused) — this itself is a no-op push per the test above.
        const a2 = await sessionHello(ctx, "A");
        const m = await sessionHello(ctx, "M"); // marker poster, connected before u subscribes
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });

        a1.close(); // one of two conns for sid A closes; A stays registered via a2
        await postMarkerVia(m, "marker");
        const { seen } = await u.readEventUntil((e) => e.type === "msg" && e.msg === "marker");
        expect(seen.some((e: any) => e.ev === "peers")).toBe(false);
        a2.close();
        m.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "同一 conn 上で sid を変えて re-hello すると旧 sid が peers から消える (ghost peer 防止)",
    async () => {
      // adversarial review finding (2026-07-12): registerSession only ever added
      // conn to the *new* sid's entry, never removed it from a *previous* sid's
      // entry on the same conn — so re-helloing under a different sid left the
      // old sid's entry.conns.size stuck > 0 forever, and it never disappeared
      // from `peers`/ev:"peers" (detachSession in server.ts is the fix).
      const ctx = await startTestDaemon();
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const a = await sessionHello(ctx, "A");
        await u.readEventUntil<PeersEv>((e) => e.ev === "peers"); // A's registration push

        // same conn, re-hello as a different sid
        await a.request({
          op: "hello",
          role: "session",
          sid: "B",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        const { ev } = await u.readEventUntil<PeersEv>((e) => e.ev === "peers");
        expect(ev.peers.some((p) => p.sid === "A")).toBe(false);
        expect(ev.peers.some((p) => p.sid === "B")).toBe(true);

        // op:"peers" one-shot poll agrees: A is gone, B is present
        const res = await u.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        expect(res.peers.some((p) => p.sid === "A")).toBe(false);
        expect(res.peers.some((p) => p.sid === "B")).toBe(true);
        a.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "同一 conn 上で session role -> user role へ re-hello すると旧 sid が peers から消える",
    async () => {
      // same ghost-peer gap as above, but the boundary crossed is role (session ->
      // user) instead of sid — detachSession's condition covers both.
      const ctx = await startTestDaemon();
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const a = await sessionHello(ctx, "A");
        await u.readEventUntil<PeersEv>((e) => e.ev === "peers"); // A's registration push

        // same conn, re-hello as user role instead of session
        await a.request({ op: "hello", role: "user" });
        const { ev } = await u.readEventUntil<PeersEv>((e) => e.ev === "peers");
        expect(ev.peers.some((p) => p.sid === "A")).toBe(false);
        a.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "op:peers の一発取得は ev:peers の push と同じ整形 (last_activity_at 以外の全フィールドが一致)",
    async () => {
      // currentPeers() (server.ts) is the single shared source both the "peers" op
      // and the ev:"peers" push read from — this test pins that "never drift apart"
      // design intent by deep-equaling every field except last_activity_at, not just
      // sid/repo (adversarial review finding, 2026-07-12: comparing only 2 of 9
      // PeerInfo fields let a shape mismatch in ws/cwd/connected_at/branch/
      // transcript_path/repo_root go undetected despite the test's name claiming
      // "same shape").
      //
      // last_activity_at is the one deliberate exclusion: the push fires from
      // inside registerSession, before hello's own post-dispatch choke point stamps
      // this entry's lastActivityAt (see peersCompareKey's comment), so the very
      // first push for a brand-new sid legitimately omits it while a subsequent
      // op:"peers" poll (issued after that stamp lands) legitimately includes it.
      // That's a timing artifact of *when* each snapshot was taken, not a shape
      // mismatch between the two payloads.
      const ctx = await startTestDaemon();
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const a = sessionHello(ctx, "A", { repo: "r", ws: "w", cwd: "/tmp", branch: "main" });
        const { ev } = await u.readEventUntil<PeersEv>((e) => e.ev === "peers");
        const pushed = ev.peers.find((p) => p.sid === "A")!;

        const res = await u.request<{ ok: true; peers: PeerLite[] }>({ op: "peers" });
        const polled = res.peers.find((p) => p.sid === "A")!;
        const { last_activity_at: _pushedLastActivity, ...pushedRest } = pushed;
        const { last_activity_at: _polledLastActivity, ...polledRest } = polled;
        expect(pushedRest).toEqual(polledRest);
        (await a).close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
