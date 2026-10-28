// End-to-end: the LLM gateway POSTs a `cache_keepalive` item to a real
// daemon's /webhook/llm-gateway and the named session gets the marker in its
// conversation, as a notice from the daemon (DR-0039 §9). The session is a
// fake harness (peer-harness.ts) whose state file names a live pid.
//
// Driven against a real daemon process for the same reason
// llm-events-relay.test.ts is: the thing under test is the startup wiring
// (config → token file → registered source → the session's conversation),
// which a stubbed Daemon would skip entirely.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { DIRECT_DELIVERY_DAEMON_SENDER } from "@ccmsg/protocol";
import {
  connect,
  spawnDaemonProc,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
  type TestClient,
  userConn,
} from "./helpers.ts";
import { fakeHarness, type FakeHarness, parseEnvelope, sessionWithConfig } from "./peer-harness.ts";

const TOKEN = "test-webhook-token";
const SID = "ca000000-0000-4000-8000-000000000001";
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
  const c = await userConn({ sock });
  const pong = await c.requestOk({ op: "ping" });
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
  const now = Date.now();
  return {
    type: "cache_keepalive",
    session_id: SID,
    prefix: "484eda9c",
    nonce: "n1",
    deadline: now + 120_000,
    marker: MARKER,
    ts: now,
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

/** Session SID with a hooks module, running in a fake harness: the
 * conversation a keepalive marker is put into. Close the connection and
 * dispose the harness when done. */
async function sessionWithModule(ctx: Ctx): Promise<{ c: TestClient; h: FakeHarness }> {
  const h = fakeHarness(SID, { pid: process.pid });
  const c = await sessionWithConfig(ctx, SID, h.configDir);
  await c.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
  return { c, h };
}

async function userSubscriber(ctx: Ctx): Promise<TestClient> {
  const c = await userConn(ctx);
  await c.request({ op: "subscribe" });
  return c;
}

/** Have the session notify itself, and return the bodies of every notice it
 * got up to and including that one. Used as an ordering anchor: a keepalive
 * takes its place in the line of deliveries before the webhook POST returns,
 * and deliveries to one session arrive in that order, so a marker that has
 * not arrived *before* this notice was one the daemon deliberately did not
 * send. Proves absence without waiting out a clock. */
async function upToAnchor(c: TestClient, h: FakeHarness): Promise<string[]> {
  expect((await c.requestOk({ op: "notify", text: "anchor" })).result.outcome).toBe("delivered");
  const seen: string[] = [];
  for (;;) {
    const body = parseEnvelope(await h.nextContent()).body;
    seen.push(body);
    if (body === "anchor") return seen;
  }
}

describe("webhook cache_keepalive → a notice in the session's conversation", () => {
  test("a session gets the marker verbatim, from the daemon", async () => {
    const ctx = await startKeepaliveDaemon();
    const { c, h } = await sessionWithModule(ctx);
    try {
      expect(await postEvents(ctx, keepalivePayload())).toBe(204);
      const { attrs, body } = parseEnvelope(await h.nextContent());
      // Verbatim: the gateway matches this exact string back on the request
      // it is waiting for.
      expect(body).toBe(MARKER);
      expect(attrs["ccmsg-from"]).toBe(DIRECT_DELIVERY_DAEMON_SENDER);
    } finally {
      c.close();
      await stop(ctx);
      h.dispose();
    }
  });

  test("a marker past its deadline is never delivered", async () => {
    const ctx = await startKeepaliveDaemon();
    const { c, h } = await sessionWithModule(ctx);
    try {
      expect(await postEvents(ctx, keepalivePayload({ deadline: Date.now() - 1000 }))).toBe(204);
      expect(await upToAnchor(c, h)).toEqual(["anchor"]);
    } finally {
      c.close();
      await stop(ctx);
      h.dispose();
    }
  });

  test("a marker for another session does not reach this one", async () => {
    const ctx = await startKeepaliveDaemon();
    const { c, h } = await sessionWithModule(ctx);
    try {
      expect(await postEvents(ctx, keepalivePayload({ session_id: "NOBODY" }))).toBe(204);
      expect(await upToAnchor(c, h)).toEqual(["anchor"]);
    } finally {
      c.close();
      await stop(ctx);
      h.dispose();
    }
  });

  test("a keepalive item is not folded into the prompt-cache ring", async () => {
    // It carries a session_id and a ts of its own, which the request-event
    // parser would accept — restarting a countdown off a marker that has not
    // been sent upstream yet.
    const ctx = await startKeepaliveDaemon();
    try {
      const u = await userSubscriber(ctx);
      const ts = Date.now();
      expect(
        await postEvents(ctx, [
          keepalivePayload(),
          { ts, session_id: "OTHER", prefix: "aa11bb22" },
        ]),
      ).toBe(204);
      const { ev } = await u.readEventUntil("llm_requests");
      expect(ev.requests.map((r) => r.session_id)).toEqual(["OTHER"]);
      u.close();
    } finally {
      await stop(ctx);
    }
  });
});
