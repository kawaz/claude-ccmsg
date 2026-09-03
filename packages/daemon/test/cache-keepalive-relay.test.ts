// End-to-end: the LLM gateway POSTs a `cache_keepalive` item to a real
// daemon's /webhook/llm-gateway and the named session sees the marker on its
// own subscribe stream, as an ordinary ev:"notify".
//
// Driven against a real daemon process for the same reason
// llm-events-relay.test.ts is: the thing under test is the startup wiring
// (config → token file → registered source → session stream), which a stubbed
// Daemon would skip entirely.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import {
  connect,
  spawnDaemonProc,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

const T = 20000;
const TOKEN = "test-webhook-token";
const SID = "KA1";
const MARKER = "[llm-gateway cache keepalive nonce=n1]";

interface Ctx extends DaemonCtx {
  http: string;
}

async function startKeepaliveDaemon(): Promise<Ctx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-ka-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const tokenFile = path.join(base, "webhook.token");
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  fs.mkdirSync(testConfigDir(dataDir));
  fs.writeFileSync(
    path.join(testConfigDir(dataDir), "config.json"),
    JSON.stringify({ webhooks: { "llm-gateway": { token_file: tokenFile } } }),
  );

  const proc = spawnDaemonProc(stateDir, dataDir, { CCMSG_HTTP_BIND: "127.0.0.1:0" });
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  const c = await connect(sock);
  await c.request({ op: "hello", role: "user", protocol: PROTOCOL_VERSION });
  const pong = await c.request<{ http: string[] }>({ op: "ping" });
  c.close();
  return {
    base,
    stateDir,
    configDir: testConfigDir(dataDir),
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock,
    proc,
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: testConfigDir(dataDir),
      CCMSG_DATA_DIR: dataDir,
    },
    http: `http://${pong.http[0]}`,
  };
}

async function stop(ctx: Ctx): Promise<void> {
  try {
    const c = await connect(ctx.sock);
    await c.request({ op: "shutdown" });
    c.close();
  } catch {
    // fall back to the signal below
  }
  try {
    ctx.proc.kill();
  } catch {
    // already gone
  }
  await ctx.proc.exited;
  fs.rmSync(ctx.base, { recursive: true, force: true });
}

function keepalivePayload(over: Record<string, unknown> = {}): Record<string, unknown> {
  const now = Math.floor(Date.now() / 1000);
  return {
    type: "cache_keepalive",
    session_id: SID,
    prefix: "484eda9c",
    nonce: "n1",
    deadline: now + 120,
    deadline_iso: new Date((now + 120) * 1000).toISOString(),
    marker: MARKER,
    ts: now,
    ts_iso: new Date(now * 1000).toISOString(),
    ...over,
  };
}

async function postEvents(ctx: Ctx, payload: unknown): Promise<number> {
  const res = await fetch(`${ctx.http}/webhook/llm-gateway`, {
    method: "POST",
    headers: { "content-type": "application/json", Authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(payload),
  });
  return res.status;
}

/** A subscribed session — the stream a keepalive marker is delivered on. */
async function sessionSubscriber(ctx: Ctx, sid = SID): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: "r", ws: "w", cwd: "/tmp" });
  await c.request({ op: "subscribe" });
  return c;
}

async function userSubscriber(ctx: Ctx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "user", protocol: PROTOCOL_VERSION });
  await c.request({ op: "subscribe" });
  return c;
}

/** Send an ordinary notify to `sid`. Used as an ordering anchor: the webhook
 * POST has already returned by the time this is sent, so a marker that has not
 * arrived *before* this notify was one the daemon deliberately did not send.
 * Proves absence without waiting out a clock. */
async function anchor(ctx: Ctx, sid: string, text: string): Promise<void> {
  const u = await connect(ctx.sock);
  await u.request({ op: "hello", role: "user", protocol: PROTOCOL_VERSION });
  await u.request({ op: "notify", sid, text });
  u.close();
}

interface NotifyEv {
  ev: "notify";
  text: string;
  from: { role: string; sid?: string };
}

describe("webhook cache_keepalive → session notify", () => {
  test(
    "an idle session gets the marker verbatim on its subscribe stream",
    async () => {
      const ctx = await startKeepaliveDaemon();
      try {
        const s = await sessionSubscriber(ctx);
        expect(await postEvents(ctx, keepalivePayload())).toBe(204);
        const { ev } = await s.readEventUntil<NotifyEv>((e) => e.ev === "notify");
        // Verbatim: the gateway matches this exact string back on the request
        // it is waiting for, and a decorated one would also risk truncation.
        expect(ev.text).toBe(MARKER);
        expect(ev.from).toEqual({ role: "user" });
        s.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "a marker past its deadline is never delivered",
    async () => {
      const ctx = await startKeepaliveDaemon();
      try {
        const s = await sessionSubscriber(ctx);
        const now = Math.floor(Date.now() / 1000);
        expect(await postEvents(ctx, keepalivePayload({ deadline: now - 1 }))).toBe(204);
        await anchor(ctx, SID, "anchor");
        const { ev, seen } = await s.readEventUntil<NotifyEv>(
          (e) => e.ev === "notify" && e.text === "anchor",
        );
        expect(ev.text).toBe("anchor");
        expect(seen.some((e) => e.text === MARKER)).toBe(false);
        s.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "a marker for a session that is not subscribed goes nowhere",
    async () => {
      const ctx = await startKeepaliveDaemon();
      try {
        const s = await sessionSubscriber(ctx);
        expect(await postEvents(ctx, keepalivePayload({ session_id: "NOBODY" }))).toBe(204);
        await anchor(ctx, SID, "anchor");
        const { seen } = await s.readEventUntil<NotifyEv>(
          (e) => e.ev === "notify" && e.text === "anchor",
        );
        expect(seen.some((e) => e.text === MARKER)).toBe(false);
        s.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "a keepalive item is not folded into the prompt-cache ring",
    async () => {
      // It carries a session_id and a ts of its own, which the request-event
      // parser would accept — restarting a countdown off a marker that has not
      // been sent upstream yet.
      const ctx = await startKeepaliveDaemon();
      try {
        const u = await userSubscriber(ctx);
        const ts = Math.floor(Date.now() / 1000);
        expect(
          await postEvents(ctx, [
            keepalivePayload(),
            { ts, session_id: "OTHER", prefix: "aa11bb22" },
          ]),
        ).toBe(204);
        const { ev } = await u.readEventUntil<{
          ev: string;
          requests: { session_id: string }[];
        }>((e) => e.ev === "llm_requests");
        expect(ev.requests.map((r) => r.session_id)).toEqual(["OTHER"]);
        u.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );
});
