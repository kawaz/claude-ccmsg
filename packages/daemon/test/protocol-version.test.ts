// Protocol generation + stale-client detection (kawaz r259m33). ccmsg evolves
// per host with no compatibility path, so the daemon's job is not to serve an
// out-of-date client but to make it visible: a client that speaks another
// generation is refused, one too old to name a generation at all is served,
// and either way the sid it claimed is flagged on `peers` until a current
// client hellos for it. The motivating case is a `ccmsg subscribe` started
// before an upgrade — refused every few seconds, and otherwise invisible.
import { describe, expect, test } from "bun:test";
import {
  PROTOCOL_VERSION,
  UNANNOUNCED_PROTOCOL_VERSION,
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

const T = 15000;

async function peersOf(ctx: DaemonCtx): Promise<PeerInfo[]> {
  const c = await connect(ctx.sock);
  await c.request({
    op: "hello",
    role: "user",
    client_version: VERSION,
    protocol: PROTOCOL_VERSION,
  });
  const res = await c.request<{ peers: PeerInfo[] }>({ op: "peers" });
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
  test(
    "hello carries the client's build and the reply carries the daemon's generation",
    async () => {
      await withDaemon(async (ctx) => {
        const c = await connect(ctx.sock);
        const hello = await c.request<{ ok: boolean; version: string; protocol: number }>({
          op: "hello",
          role: "session",
          sid: SID_S1,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          client_version: "9.9.9",
          protocol: PROTOCOL_VERSION,
        });
        expect(hello.ok).toBe(true);
        expect(hello.protocol).toBe(PROTOCOL_VERSION);

        const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S1);
        expect(peer).toBeDefined();
        expect(peer?.client_version).toBe("9.9.9");
        expect(peer?.protocol).toBe(PROTOCOL_VERSION);
        expect(peer?.stale_client).toBeUndefined();
        c.close();
      });
    },
    T,
  );

  test(
    "a hello announcing another generation is refused and recorded as stale",
    async () => {
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
          client_version: VERSION,
          protocol: PROTOCOL_VERSION,
        });

        const old = await connect(ctx.sock);
        const err = await old.request<{ ok: boolean; error: { code: string; msg: string } }>({
          op: "hello",
          role: "session",
          sid: SID_S2,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          client_version: "0.1.0",
          protocol: PROTOCOL_VERSION + 1,
        });
        expect(err.ok).toBe(false);
        expect(err.error.code).toBe("bad_request");

        const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S2);
        expect(peer?.stale_client?.version).toBe("0.1.0");
        expect(peer?.stale_client?.protocol).toBe(PROTOCOL_VERSION + 1);
        expect(peer?.stale_client?.last_seen).toBeString();
        // The refused hello registered nothing: the healthy connection's build
        // is still what the peer reports.
        expect(peer?.client_version).toBe(VERSION);
        old.close();
        live.close();
      });
    },
    T,
  );

  // The generation is read before the rest of the hello: a client of another
  // generation may shape its hello differently, and what it needs to hear is
  // which generation to run, not which field it got wrong.
  test(
    "a hello of another generation is told so even when its other fields have another shape",
    async () => {
      await withDaemon(async (ctx) => {
        const old = await connect(ctx.sock);
        const err = await old.request<{ ok: boolean; error: { code: string; msg: string } }>({
          op: "hello",
          role: "observer",
          sid: SID_S2,
          cwd: ["/tmp"],
          client_version: "0.1.0",
          protocol: PROTOCOL_VERSION + 1,
        });
        expect(err.ok).toBe(false);
        expect(err.error).toEqual({
          code: "bad_request",
          msg: `client speaks protocol ${PROTOCOL_VERSION + 1}, this daemon speaks ${PROTOCOL_VERSION}`,
        });
        old.close();
      });
    },
    T,
  );

  test(
    "a hello with no request_id is still refused, and its sid is flagged",
    async () => {
      await withDaemon(async (ctx) => {
        const live = await connect(ctx.sock);
        await live.request({
          op: "hello",
          role: "session",
          sid: SID_S3,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          client_version: VERSION,
          protocol: PROTOCOL_VERSION,
        });

        // Exactly what a pre-v0.136.0 `ccmsg subscribe` sends: no correlation
        // envelope, no build fields.
        const old = await connect(ctx.sock);
        const err = await old.requestRaw<{ ok: boolean; error: { code: string; msg: string } }>({
          op: "hello",
          role: "session",
          sid: SID_S3,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        expect(err.ok).toBe(false);
        expect(err.error.code).toBe("bad_request");

        const stale = (await peersOf(ctx)).find((p) => p.sid === SID_S3)?.stale_client;
        expect(stale).toBeDefined();
        // Nothing to report but the fact of the attempt — that client is too
        // old to name either its build or its generation. The absent protocol
        // is itself the signal: refused before it could be read as a hello.
        expect(stale?.version).toBeUndefined();
        expect(stale?.protocol).toBeUndefined();
        old.close();
        live.close();
      });
    },
    T,
  );

  // Every subscribe running right now is this client. Flagging it would ask
  // kawaz to restart every session on the machine over nothing, so announcing
  // no generation means UNANNOUNCED_PROTOCOL_VERSION and is simply served.
  test(
    "a hello that announces no generation is served and not flagged",
    async () => {
      await withDaemon(async (ctx) => {
        const c = await connect(ctx.sock);
        const hello = await c.request<{ ok: boolean }>({
          op: "hello",
          role: "session",
          sid: SID_S4,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        expect(hello.ok).toBe(true);

        const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S4);
        expect(peer).toBeDefined();
        // Left absent rather than filled in with the assumed generation: the
        // client never mentioned one, and the display says "版数不明".
        expect(peer?.protocol).toBeUndefined();
        expect(peer?.client_version).toBeUndefined();
        expect(peer?.stale_client).toBeUndefined();
        c.close();
      });
    },
    T,
  );

  // The other half of the same rule: the assumed generation is compared, not
  // exempted. It passes today only because it equals PROTOCOL_VERSION.
  test(
    "the assumed generation is what a no-protocol hello is checked against",
    async () => {
      await withDaemon(async (ctx) => {
        const c = await connect(ctx.sock);
        const err = await c.request<{ ok: boolean; error: { code: string; msg: string } }>({
          op: "hello",
          role: "session",
          sid: SID_S4B,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          protocol: UNANNOUNCED_PROTOCOL_VERSION + 1,
        });
        expect(err.ok).toBe(false);
        expect(err.error.msg).toContain(`this daemon speaks ${PROTOCOL_VERSION}`);
        expect(UNANNOUNCED_PROTOCOL_VERSION).toBe(PROTOCOL_VERSION);
        c.close();
      });
    },
    T,
  );

  test(
    "a current hello for the same sid clears the flag",
    async () => {
      await withDaemon(async (ctx) => {
        const old = await connect(ctx.sock);
        await old.requestRaw({ op: "hello", role: "session", sid: SID_S5, cwd: "/tmp" });
        expect((await peersOf(ctx)).find((p) => p.sid === SID_S5)).toBeUndefined();

        const fresh = await connect(ctx.sock);
        await fresh.request({
          op: "hello",
          role: "session",
          sid: SID_S5,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          client_version: VERSION,
          protocol: PROTOCOL_VERSION,
        });
        const peer = (await peersOf(ctx)).find((p) => p.sid === SID_S5);
        expect(peer).toBeDefined();
        expect(peer?.stale_client).toBeUndefined();
        old.close();
        fresh.close();
      });
    },
    T,
  );

  test(
    'the flag reaches a watching webui as an ev:"peers" push',
    async () => {
      await withDaemon(async (ctx) => {
        const live = await connect(ctx.sock);
        await live.request({
          op: "hello",
          role: "session",
          sid: SID_S6,
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          client_version: VERSION,
          protocol: PROTOCOL_VERSION,
        });

        const watcher = await connect(ctx.sock);
        await watcher.request({
          op: "hello",
          role: "user",
          client_version: VERSION,
          protocol: PROTOCOL_VERSION,
        });
        await watcher.request({ op: "subscribe" });

        const old = await connect(ctx.sock);
        await old.requestRaw({ op: "hello", role: "session", sid: SID_S6, cwd: "/tmp" });

        const { ev } = await watcher.readEventUntil<{ ev: "peers"; peers: PeerInfo[] }>(
          (e) => e.ev === "peers" && e.peers.some((p: PeerInfo) => p.stale_client),
        );
        expect(ev.peers.find((p) => p.sid === SID_S6)?.stale_client).toBeDefined();
        old.close();
        watcher.close();
        live.close();
      });
    },
    T,
  );
});
