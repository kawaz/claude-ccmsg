// ev:"peers" push (issue 2026-07-12-peers-live-update-protocol): the daemon pushes
// the full peers list (same shape the `peers` op returns) to every user-role
// subscriber whenever a session registers (hello, new sid), fully disconnects
// (removeConn, sid entry actually removed), or its hello metadata changes for
// real (repo/ws/branch/transcript_path/repo_root). A no-op hello re-send must not
// spam a push, and session-role subscribers must never receive this event at all
// (webui-only, same rationale as ev:"agents" in agents.ts).
import { describe, expect, test } from "bun:test";
import {
  startInProcessDaemon,
  stopInProcessDaemon,
  type TestClient,
  defined,
  isKind,
  sayMarker,
  sessionConn,
  userConn,
} from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_B = "bbbbbbbb-0000-4000-8000-000000000002";
const SID_S = "5e000000-0000-4000-8000-000000000005";
const SID_M = "3a000000-0000-4000-8000-00000000000d";

/** Read ev:"peers" until every row of `sids` carries its input readiness. A
 * new sid is pushed twice: once as it registers, and once more when the
 * daemon has judged whether a person's input can reach it
 * (PeerInfo.input_readiness). The judgment lands after the hello's reply, so
 * a client subscribing after a hello may still receive that second push; a
 * test asserting no push follows something has to read past it first. */
async function readinessPushed(u: TestClient, ...sids: string[]) {
  return u.readEventUntil("peers", (ev) =>
    sids.every((sid) => ev.peers.find((p) => p.sid === sid)?.input_readiness !== undefined),
  );
}

describe("ev:peers push", () => {
  test("新規 sid の hello で user-role subscriber に ev:peers が届く", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const helloP = sessionConn(ctx, SID_A);
      const { ev } = await u.readEventUntil("peers");
      expect(ev.peers.some((p) => p.sid === SID_A)).toBe(true);
      (await helloP).close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("sid の接続が全て切れても peers に残り、ev:peers も送らない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const a = await sessionConn(ctx, SID_A);
      const m = await sessionConn(ctx, SID_M); // marker poster
      await readinessPushed(u, SID_A, SID_M); // drain both registrations' pushes
      await a.end();
      const seen = await sayMarker(m, u, "marker");
      expect(seen.some(isKind("peers"))).toBe(false);
      const res = await u.requestOk({ op: "peers" });
      expect(res.peers.some((p) => p.sid === SID_A)).toBe(true);
      m.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("session role の subscriber には ev:peers が一切届かない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const s = await sessionConn(ctx, SID_S);
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      await s.request({ op: "subscribe" });
      // A new sid's hello pushes ev:peers. The user subscriber receiving it
      // is the ordering anchor (the daemon writes every subscriber's copy in
      // one synchronous loop); a round trip on S then orders its stream past it.
      const b = await sessionConn(ctx, SID_B);
      await u.readEventUntil("peers", (e) => e.peers.some((p) => p.sid === SID_B));
      await s.request({ op: "ping" });
      const seen = await s.pendingEvents();
      expect(seen.some(isKind("peers"))).toBe(false);
      b.close();
      u.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("内容が変わらない hello の再送では ev:peers を再送しない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const m = await sessionConn(ctx, SID_M); // marker poster, connected up front
      await readinessPushed(u, SID_M); // drain M's own registration pushes
      const a = await sessionConn(ctx, SID_A, { repo: "r", ws: "w", cwd: "/tmp" });
      await readinessPushed(u, SID_A); // drain A's registration pushes

      // identical re-hello on the same conn — must not push again.
      await a.request({
        op: "hello",
        protocol: PROTOCOL_VERSION,
        role: "session",
        sid: SID_A,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
      });
      const seen = await sayMarker(m, u, "marker");
      expect(seen.some(isKind("peers"))).toBe(false);
      a.close();
      m.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("hello メタデータが実質変化 (repo 変更) すると ev:peers が再送され、新しい repo が載る", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const a = await sessionConn(ctx, SID_A, { repo: "r1", ws: "w", cwd: "/tmp" });
      await readinessPushed(u, SID_A); // the new sid's pushes

      await a.request({
        op: "hello",
        protocol: PROTOCOL_VERSION,
        role: "session",
        sid: SID_A,
        repo: "r2",
        ws: "w",
        cwd: "/tmp",
      });
      const { ev } = await u.readEventUntil("peers");
      const me = ev.peers.find((p) => p.sid === SID_A);
      expect(me?.repo).toBe("r2");
      a.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("同一 sid の複数 conn のうち 1 本を閉じただけ (sid は生存) では ev:peers を送らない", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const a1 = await sessionConn(ctx, SID_A);
      // second conn re-hellos the same sid, identical metadata (latest-hello-wins
      // path, entry reused) — this itself is a no-op push per the test above.
      const a2 = await sessionConn(ctx, SID_A);
      const m = await sessionConn(ctx, SID_M); // marker poster
      await readinessPushed(u, SID_A, SID_M); // drain both registrations' pushes

      await a1.end(); // one of two conns for sid A closes; A stays registered via a2
      const seen = await sayMarker(m, u, "marker");
      expect(seen.some(isKind("peers"))).toBe(false);
      a2.close();
      m.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("同一 conn 上で sid を変えて re-hello すると新 sid が加わり、旧 sid も残る", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const a = await sessionConn(ctx, SID_A);
      await readinessPushed(u, SID_A); // A's registration pushes

      // same conn, re-hello as a different sid
      await a.request({
        op: "hello",
        protocol: PROTOCOL_VERSION,
        role: "session",
        sid: SID_B,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
      });
      const { ev } = await u.readEventUntil("peers");
      expect(ev.peers.some((p) => p.sid === SID_A)).toBe(true);
      expect(ev.peers.some((p) => p.sid === SID_B)).toBe(true);

      // op:"peers" one-shot poll agrees
      const res = await u.requestOk({ op: "peers" });
      expect(res.peers.some((p) => p.sid === SID_A)).toBe(true);
      expect(res.peers.some((p) => p.sid === SID_B)).toBe(true);
      a.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("同一 conn 上で session role -> user role へ re-hello しても旧 sid は peers に残る", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const a = await sessionConn(ctx, SID_A);
      await u.readEventUntil("peers"); // A's registration push

      // same conn, re-hello as user role instead of session
      await a.request({ op: "hello", role: "user", protocol: PROTOCOL_VERSION });
      const res = await u.requestOk({ op: "peers" });
      expect(res.peers.some((p) => p.sid === SID_A)).toBe(true);
      a.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  test("op:peers の一発取得は ev:peers の push と同じ整形 (last_activity_at 以外の全フィールドが一致)", async () => {
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
    const ctx = await startInProcessDaemon();
    try {
      const u = await userConn(ctx);
      await u.request({ op: "subscribe" });
      const a = sessionConn(ctx, SID_A, { repo: "r", ws: "w", cwd: "/tmp", branch: "main" });
      const { ev } = await readinessPushed(u, SID_A);
      const pushed = defined(
        ev.peers.find((p) => p.sid === SID_A),
        "pushed",
      );

      const res = await u.requestOk({ op: "peers" });
      const polled = defined(
        res.peers.find((p) => p.sid === SID_A),
        "polled",
      );
      const { last_activity_at: _pushedLastActivity, ...pushedRest } = pushed;
      const { last_activity_at: _polledLastActivity, ...polledRest } = polled;
      expect(pushedRest).toEqual(polledRest);
      (await a).close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
