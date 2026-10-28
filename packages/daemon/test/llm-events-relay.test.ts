// End-to-end: the LLM gateway POSTs request events to a real daemon's
// /webhook/llm-gateway, and user-role subscribers see them as
// ev:"llm_requests". Driven against a real daemon process rather than a
// stubbed Daemon because the wiring under test is the startup path — config →
// token file → registered source → cache → broadcast — that a stub would skip.
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
  isKind,
  streamMarker,
  sessionConn,
  userConn,
} from "./helpers.ts";

// Ids that say hello as a session must be session-id shaped (lowercase UUID).
const SID_MARK = "3a4c0000-0000-4000-8000-000000000001";
const SID_S9 = "59000000-0000-4000-8000-000000000009";
const TOKEN = "test-webhook-token";

interface Ctx extends DaemonCtx {
  /** Base URL of this daemon's HTTP listener, e.g. http://127.0.0.1:53412 */
  http: string;
}

/** A daemon with an HTTP listener, a token file, and `webhooks` configured to
 * accept it. Config and token are written before the spawn: both are read once
 * at startup. */
async function startWebhookDaemon(options: { configured?: boolean } = {}): Promise<Ctx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-wh-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const tokenFile = path.join(base, "webhook.token");
  fs.writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });
  const config =
    options.configured === false ? {} : { webhooks: { "llm-gateway": { token_file: tokenFile } } };
  fs.mkdirSync(testConfigDir(dataDir));
  fs.writeFileSync(path.join(testConfigDir(dataDir), "config.json"), JSON.stringify(config));
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

/** POST as the gateway does. Returns the status so tests can assert on it. */
async function postEvents(
  ctx: Ctx,
  payload: unknown,
  token: string | null = TOKEN,
): Promise<number> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token !== null) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${ctx.http}/webhook/llm-gateway`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload),
  });
  return res.status;
}

async function userSubscriber(ctx: Ctx): Promise<TestClient> {
  const c = await userConn(ctx);
  await c.request({ op: "subscribe" });
  return c;
}

/** Connect a session that exists only to post a marker (helpers.ts
 * streamMarker); the reader is a user-role subscriber. */
async function markerSession(ctx: Ctx): Promise<TestClient> {
  const c = await sessionConn(ctx, SID_MARK);
  return c;
}

describe("webhook → ev:llm_requests", () => {
  test("a posted event reaches a user-role subscriber", async () => {
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      const ts = Date.now();
      const status = await postEvents(ctx, {
        ts,
        session_id: "S1",
        prefix: "484eda9c",
        model: "claude-fable-5",
        status: 200,
      });
      expect(status).toBe(204);
      const { ev } = await u.readEventUntil("llm_requests");
      expect(ev.requests).toEqual([
        {
          ts,
          session_id: "S1",
          prefix: "484eda9c",
          main: true,
          model: "claude-fable-5",
          status: 200,
        },
      ]);
      u.close();
    } finally {
      await stop(ctx);
    }
  });

  test("a batch is folded and pushed as one snapshot", async () => {
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      const ts = Date.now();
      expect(
        await postEvents(ctx, [
          { ts, session_id: "S2", prefix: "484eda9c" },
          { ts, session_id: "S3", prefix: "aa11bb22" },
        ]),
      ).toBe(204);
      const { ev } = await u.readEventUntil("llm_requests", (e) => e.requests.length === 2);
      expect(ev.requests.map((r) => r.session_id).sort()).toEqual(["S2", "S3"]);
      u.close();
    } finally {
      await stop(ctx);
    }
  });

  test("a redelivered event does not move the window", async () => {
    // Both gateway processes may report the same call; neither knows about
    // the other, so the daemon has to absorb the duplicate.
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      const ts = Date.now() - 100_000;
      await postEvents(ctx, { ts, session_id: "S4", prefix: "484eda9c" });
      await u.readEventUntil("llm_requests");
      await postEvents(ctx, { ts, session_id: "S4", prefix: "484eda9c" });
      // The duplicate is dropped by the cache, so its ts is unchanged. Anchor
      // on a later, genuinely new event to prove the assertion isn't just
      // reading the first push again.
      await postEvents(ctx, { ts: ts + 50_000, session_id: "S5", prefix: "aa11bb22" });
      const { ev } = await u.readEventUntil("llm_requests", (e) => e.requests.length === 2);
      expect(ev.requests.find((r) => r.session_id === "S4")?.ts).toBe(ts);
      u.close();
    } finally {
      await stop(ctx);
    }
  });

  test("unusable events are dropped without failing the delivery", async () => {
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      const ts = Date.now();
      // session_id: null is the gateway's own shape for a client that sent
      // no session header — the most common event ccmsg cannot place.
      expect(
        await postEvents(ctx, [
          { ts, session_id: null, prefix: "484eda9c" },
          { ts, session_id: "S6", prefix: "484eda9c" },
          { nonsense: true },
        ]),
      ).toBe(204);
      const { ev } = await u.readEventUntil("llm_requests");
      expect(ev.requests).toHaveLength(1);
      expect(ev.requests[0]?.session_id).toBe("S6");
      u.close();
    } finally {
      await stop(ctx);
    }
  });

  test("a subagent's request arrives as a separate, non-main series", async () => {
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      const mainTs = Date.now() - 240_000;
      await postEvents(ctx, { ts: mainTs, session_id: "S7", prefix: "484eda9c" });
      await u.readEventUntil("llm_requests");
      // Same session id, different system prompt: a subagent. The session's
      // own window must survive it untouched — that is what keeps the ring
      // counting down while a subagent chatters.
      const subTs = Date.now();
      await postEvents(ctx, { ts: subTs, session_id: "S7", prefix: "9c31aa02" });
      const { ev } = await u.readEventUntil("llm_requests", (e) => e.requests.length === 2);
      expect(ev.requests.find((r) => r.main)).toEqual({
        ts: mainTs,
        session_id: "S7",
        prefix: "484eda9c",
        main: true,
      });
      expect(ev.requests.find((r) => !r.main)?.prefix).toBe("9c31aa02");
      u.close();
    } finally {
      await stop(ctx);
    }
  });

  test("a later subscriber gets the window that opened before it connected", async () => {
    const ctx = await startWebhookDaemon();
    try {
      const first = await userSubscriber(ctx);
      const ts = Date.now();
      await postEvents(ctx, { ts, session_id: "S8", prefix: "484eda9c" });
      await first.readEventUntil("llm_requests");
      first.close();

      // The reload case: a brand-new connection subscribing mid-window.
      const second = await userSubscriber(ctx);
      const { ev } = await second.readEventUntil("llm_requests");
      expect(ev.requests).toEqual([{ ts, session_id: "S8", prefix: "484eda9c", main: true }]);
      second.close();
    } finally {
      await stop(ctx);
    }
  });

  test("session-role subscribers never receive it (webui-only, like ev:peers)", async () => {
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      const s = await sessionConn(ctx, SID_S9);
      await s.request({ op: "subscribe" });
      await postEvents(ctx, {
        ts: Date.now(),
        session_id: SID_S9,
        prefix: "484eda9c",
      });
      // The user connection receiving the push is the ordering anchor: the
      // daemon writes both sends in one synchronous loop, so once the user
      // side has it, a session-side copy would already be on the socket.
      // A round trip on the session connection then orders its stream past it.
      await u.readEventUntil("llm_requests");
      await s.request({ op: "ping" });
      const seen = await s.pendingEvents();
      expect(seen.some(isKind("llm_requests"))).toBe(false);
      u.close();
      s.close();
    } finally {
      await stop(ctx);
    }
  });

  test("a cache_keepalive item is not folded into the prompt-cache ring", async () => {
    // It carries a session_id and a ts of its own, which the request-event
    // parser would accept — restarting a countdown off a marker nothing sent
    // upstream. The gateway no longer sends one (llm-gateway DR-0027).
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      const ts = Date.now();
      expect(
        await postEvents(ctx, [
          { type: "cache_keepalive", session_id: "S1", marker: "m", deadline: ts + 60_000, ts },
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

  test("a bad token is rejected and nothing reaches the WS", async () => {
    const ctx = await startWebhookDaemon();
    try {
      const u = await userSubscriber(ctx);
      expect(
        await postEvents(
          ctx,
          { ts: Date.now(), session_id: "SA", prefix: "484eda9c" },
          "wrong-token",
        ),
      ).toBe(401);
      const marker = await markerSession(ctx);
      const seen = await streamMarker(marker, u, "marker");
      expect(seen.some(isKind("llm_requests"))).toBe(false);
      marker.close();
      u.close();
    } finally {
      await stop(ctx);
    }
  });

  test("with no webhooks configured the endpoint does not exist", async () => {
    const ctx = await startWebhookDaemon({ configured: false });
    try {
      expect(
        await postEvents(ctx, {
          ts: Date.now(),
          session_id: "SB",
          prefix: "484eda9c",
        }),
      ).toBe(404);
    } finally {
      await stop(ctx);
    }
  });
});
