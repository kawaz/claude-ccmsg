// Protocol version (`major.minor`) + stale-client detection (DR-0002 §4).
// ccmsg evolves per host with no compatibility path, so the daemon's job is
// not to serve an out-of-date client but to make it visible: a client of
// another major — including one naming no `major.minor`, which is major 1 —
// is refused and the sid it claimed is flagged on `peers` until a current
// client hellos for it; a client of another minor is served, and its version
// is on its peer row for the webui to compare. The motivating case is a
// session's module started before an upgrade, which keeps talking to the new
// daemon and drops what it does not know without a word.
import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  UNANNOUNCED_PROTOCOL_MAJOR,
  VERSION,
  type PeerInfo,
} from "@ccmsg/protocol";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";

const SID_S1 = "51000000-0000-4000-8000-000000000001";
const SID_S2 = "52000000-0000-4000-8000-000000000002";
const SID_S3 = "53000000-0000-4000-8000-000000000003";
const SID_S4 = "54000000-0000-4000-8000-000000000004";
const SID_S4B = "54b00000-0000-4000-8000-000000000004";
const SID_S5 = "55000000-0000-4000-8000-000000000005";
const SID_S6 = "56000000-0000-4000-8000-000000000006";
const SID_S7 = "57000000-0000-4000-8000-000000000007";

/** A protocol of the major after the daemon's. */
const NEXT_MAJOR = { major: PROTOCOL_VERSION.major + 1, minor: 0 };
/** The daemon's major with the minor after the daemon's. */
const NEXT_MINOR = { major: PROTOCOL_VERSION.major, minor: PROTOCOL_VERSION.minor + 1 };
/** The daemon's version as the refusal names it. */
const SPOKEN = `${String(PROTOCOL_VERSION.major)}.${String(PROTOCOL_VERSION.minor)}`;

async function peersOf(ctx: DaemonCtx): Promise<readonly PeerInfo[]> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "user",
    ccmsg_version: VERSION,
    protocol: PROTOCOL_VERSION,
  });
  const res = await c.requestOk({ op: "peers" });
  c.close();
  return res.peers;
}

async function withDaemon(fn: (ctx: DaemonCtx) => Promise<void>): Promise<void> {
  const ctx = await startTestDaemon();
  try {
    await fn(ctx);
  } finally {
    await stopTestDaemon(ctx);
  }
}

describe("protocol version handshake", () => {
  test("hello carries the client's build and the reply carries the daemon's protocol version", async () => {
    await withDaemon(async (ctx) => {
      const c = await connect(ctx.sock);
      const hello = await c.requestOk({
        op: "hello",
        role: "session",
        sid: SID_S1,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: "9.9.9",
        protocol: PROTOCOL_VERSION,
      });
      expect(hello.ok).toBe(true);
      expect(hello.protocol).toEqual(PROTOCOL_VERSION);

      const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S1);
      expect(peer).toBeDefined();
      expect(peer?.ccmsg_version).toBe("9.9.9");
      expect(peer?.protocol).toEqual(PROTOCOL_VERSION);
      expect(peer?.stale_client).toBeUndefined();
      c.close();
    });
  });

  // Migration (issue drop-legacy-client-version-hello-key): a module loaded
  // before the rename names its build `client_version` until its session
  // restarts; the daemon reads it as `ccmsg_version`, and the new name wins
  // when a hello carries both.
  test("a hello naming its build by the old name client_version is read as ccmsg_version", async () => {
    await withDaemon(async (ctx) => {
      const legacy = await connect(ctx.sock);
      await legacy.requestOk({
        op: "hello",
        role: "session",
        sid: SID_S1,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        client_version: "9.9.8",
        protocol: PROTOCOL_VERSION,
      });
      expect((await peersOf(ctx)).find((p) => p.sid === SID_S1)?.ccmsg_version).toBe("9.9.8");

      const both = await connect(ctx.sock);
      await both.requestOk({
        op: "hello",
        role: "session",
        sid: SID_S1,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: "9.9.9",
        client_version: "9.9.8",
        protocol: PROTOCOL_VERSION,
      });
      expect((await peersOf(ctx)).find((p) => p.sid === SID_S1)?.ccmsg_version).toBe("9.9.9");
      legacy.close();
      both.close();
    });
  });

  test("a hello announcing another major is refused and recorded as stale", async () => {
    await withDaemon(async (ctx) => {
      // The sid has a healthy connection too — the realistic shape of this,
      // where one process of a session is current and another is not.
      const live = await connect(ctx.sock);
      await live.request({
        op: "hello",
        role: "session",
        sid: SID_S2,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: VERSION,
        protocol: PROTOCOL_VERSION,
      });

      // A client of another major names its build by the old name.
      const old = await connect(ctx.sock);
      const err = await old.requestRefusal({
        op: "hello",
        role: "session",
        sid: SID_S2,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        client_version: "0.1.0",
        protocol: NEXT_MAJOR,
      });
      expect(err.ok).toBe(false);
      expect(err.error.code).toBe("bad_request");

      const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S2);
      expect(peer?.stale_client?.version).toBe("0.1.0");
      expect(peer?.stale_client?.protocol).toEqual(NEXT_MAJOR);
      expect(peer?.stale_client?.last_seen).toBeString();
      // The refused hello registered nothing: the healthy connection's build
      // is still what the peer reports.
      expect(peer?.ccmsg_version).toBe(VERSION);
      old.close();
      live.close();
    });
  });

  // A hello of another major is read for what its refusal needs (the
  // protocol, the role, the sid, the build), not for the rest: a client of
  // another major may shape its other fields differently, and what it needs
  // to hear is which version to run, not which field it got wrong.
  test("a hello of another major is told so even when its other fields have another shape", async () => {
    await withDaemon(async (ctx) => {
      const old = await connect(ctx.sock);
      const err = await old.requestRefusal({
        op: "hello",
        role: "session",
        sid: SID_S2,
        cwd: ["/tmp"],
        client_version: "0.1.0",
        protocol: NEXT_MAJOR,
      });
      expect(err.ok).toBe(false);
      expect(err.error).toEqual({
        code: "bad_request",
        msg: `client speaks protocol ${String(NEXT_MAJOR.major)}.0, this daemon speaks ${SPOKEN}`,
      });
      old.close();
    });
  });

  // A line the request schema does not read is refused and read no further,
  // so a hello without its request_id flags nothing: there is no hello to take
  // a sid from.
  test("a hello with no request_id is refused, and flags nothing", async () => {
    await withDaemon(async (ctx) => {
      const live = await connect(ctx.sock);
      await live.request({
        op: "hello",
        role: "session",
        sid: SID_S3,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: VERSION,
        protocol: PROTOCOL_VERSION,
      });

      // Exactly what a pre-v0.136.0 `ccmsg subscribe` sends: no correlation
      // envelope, no build fields.
      const old = await connect(ctx.sock);
      const err = await old.requestRaw({
        op: "hello",
        role: "session",
        sid: SID_S3,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
      });
      expect(err.ok).toBe(false);
      expect(err.error.code).toBe("bad_request");

      expect((await peersOf(ctx)).find((p) => p.sid === SID_S3)?.stale_client).toBeUndefined();
      old.close();
      live.close();
    });
  });

  // A client from before `major.minor` names no protocol, or a bare number:
  // both are major 1 (UNANNOUNCED_PROTOCOL_MAJOR), a major this daemon does
  // not speak, so both are refused and flagged like any other major — such a
  // module drops what this daemon sends it without a word.
  test("a hello naming no protocol, or a bare number, is of major 1: refused and flagged", async () => {
    await withDaemon(async (ctx) => {
      const live = await connect(ctx.sock);
      for (const sid of [SID_S4, SID_S4B]) {
        await live.requestOk({
          op: "hello",
          role: "session",
          sid,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          ccmsg_version: VERSION,
          protocol: PROTOCOL_VERSION,
        });
      }

      const unannounced = await connect(ctx.sock);
      const silent = await unannounced.requestRefusal({
        op: "hello",
        role: "session",
        sid: SID_S4,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: "0.217.1",
      });
      expect(silent.error).toEqual({
        code: "bad_request",
        msg: `client speaks protocol ${String(UNANNOUNCED_PROTOCOL_MAJOR)}, this daemon speaks ${SPOKEN}`,
      });

      const bare = await connect(ctx.sock);
      const numbered = await bare.requestRefusal({
        op: "hello",
        role: "session",
        sid: SID_S4B,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: "0.217.1",
        protocol: 1,
      });
      expect(numbered.error).toEqual({
        code: "bad_request",
        msg: `client speaks protocol 1, this daemon speaks ${SPOKEN}`,
      });

      const peers = await peersOf(ctx);
      for (const sid of [SID_S4, SID_S4B]) {
        const peer = peers.find((p) => p.sid === sid);
        expect(peer?.stale_client?.protocol).toEqual({ major: UNANNOUNCED_PROTOCOL_MAJOR });
        expect(peer?.stale_client?.version).toBe("0.217.1");
        // The refused hello registered nothing: the healthy connection's
        // version is still what the peer reports.
        expect(peer?.protocol).toEqual(PROTOCOL_VERSION);
      }
      unannounced.close();
      bare.close();
      live.close();
    });
  });

  // A client of another minor talks to the daemon fine, but may drop a field
  // or an op it does not know. It is served, not flagged as stale; its
  // version is on its peer row, which the webui compares with the daemon's.
  test("a hello of the daemon's major and another minor is served, its version on the peer row", async () => {
    await withDaemon(async (ctx) => {
      const c = await connect(ctx.sock);
      const hello = await c.requestOk({
        op: "hello",
        role: "session",
        sid: SID_S7,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: VERSION,
        protocol: NEXT_MINOR,
      });
      expect(hello.protocol).toEqual(PROTOCOL_VERSION);

      const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S7);
      expect(peer?.protocol).toEqual(NEXT_MINOR);
      expect(peer?.stale_client).toBeUndefined();
      c.close();
    });
  });

  // Ping needs no hello, so it is where a client whose hello was refused for
  // its major learns the daemon's version and protocol (the webui's reload,
  // the CLI's upgrade).
  test("ping names the daemon's protocol version, with no hello", async () => {
    await withDaemon(async (ctx) => {
      const c = await connect(ctx.sock);
      const pong = await c.requestOk({ op: "ping" });
      expect(pong.protocol).toEqual(PROTOCOL_VERSION);
      expect(pong.version).toBe(VERSION);
      c.close();
    });
  });

  test("a current hello for the same sid clears the flag", async () => {
    await withDaemon(async (ctx) => {
      const old = await connect(ctx.sock);
      await old.requestRefusal({
        op: "hello",
        role: "session",
        sid: SID_S5,
        cwd: "/tmp",
        protocol: NEXT_MAJOR,
      });

      const fresh = await connect(ctx.sock);
      await fresh.request({
        op: "hello",
        role: "session",
        sid: SID_S5,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: VERSION,
        protocol: PROTOCOL_VERSION,
      });
      const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S5);
      expect(peer).toBeDefined();
      expect(peer?.stale_client).toBeUndefined();
      old.close();
      fresh.close();
    });
  });

  test('the flag reaches a watching webui as an ev:"peers" push', async () => {
    await withDaemon(async (ctx) => {
      const live = await connect(ctx.sock);
      await live.request({
        op: "hello",
        role: "session",
        sid: SID_S6,
        repo: "r",
        ws: "w",
        cwd: "/tmp",
        ccmsg_version: VERSION,
        protocol: PROTOCOL_VERSION,
      });

      const watcher = await connect(ctx.sock);
      await watcher.request({
        op: "hello",
        role: "user",
        ccmsg_version: VERSION,
        protocol: PROTOCOL_VERSION,
      });
      await watcher.request({ op: "subscribe" });

      const old = await connect(ctx.sock);
      await old.requestRefusal({
        op: "hello",
        role: "session",
        sid: SID_S6,
        cwd: "/tmp",
        protocol: NEXT_MAJOR,
      });

      const { ev } = await watcher.readEventUntil("peers", (e) =>
        e.peers.some((p: PeerInfo) => p.stale_client),
      );
      expect(ev.peers.find((p) => p.sid === SID_S6)?.stale_client).toBeDefined();
      old.close();
      watcher.close();
      live.close();
    });
  });
});
