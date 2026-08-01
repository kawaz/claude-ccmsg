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
  waitConnectable,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;
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
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
  const proc = spawnDaemonProc(stateDir, dataDir, { CCMSG_HTTP_BIND: "127.0.0.1:0" });
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  const c = await connect(sock);
  await c.request({ op: "hello", role: "user" });
  const pong = await c.request<{ http: string[] }>({ op: "ping" });
  c.close();
  return {
    base,
    stateDir,
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock,
    proc,
    env: { CCMSG_STATE_DIR: stateDir, CCMSG_DATA_DIR: dataDir },
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
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "user" });
  await c.request({ op: "subscribe" });
  return c;
}

interface LlmRequestsEv {
  ev: "llm_requests";
  requests: {
    ts: number;
    session_id: string;
    prefix: string;
    main: boolean;
    model?: string;
    status?: number;
  }[];
}

/** Connect a session that exists only to post a marker msg (peers-push.test.ts's
 * pattern): the room is created BY the poster so it is a member of it. A msg
 * from another connection is delivered with its body, whereas a self-post comes
 * back bodyless — which is why the anchor can't be a self-post. */
async function markerSession(ctx: Ctx, members: string[]): Promise<[TestClient, string]> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "session", sid: "MARK", repo: "r", ws: "w", cwd: "/tmp" });
  const { room } = await c.request<{ room: string }>({ op: "create_room", members });
  return [c, room];
}

/** Post the marker and return every event `reader` saw before it — the events
 * that must not include an llm_requests push. */
async function seenBeforeMarker(
  poster: TestClient,
  reader: TestClient,
  room: string,
): Promise<Record<string, any>[]> {
  await poster.request({ op: "post", room, msg: "marker" });
  const { seen } = await reader.readEventUntil<any>((e) => e.type === "msg" && e.msg === "marker");
  return seen;
}

describe("webhook → ev:llm_requests", () => {
  test(
    "a posted event reaches a user-role subscriber",
    async () => {
      const ctx = await startWebhookDaemon();
      try {
        const u = await userSubscriber(ctx);
        const ts = Math.floor(Date.now() / 1000);
        const status = await postEvents(ctx, {
          ts,
          session_id: "S1",
          prefix: "484eda9c",
          model: "claude-fable-5",
          status: 200,
        });
        expect(status).toBe(204);
        const { ev } = await u.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
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
    },
    T,
  );

  test(
    "a batch is folded and pushed as one snapshot",
    async () => {
      const ctx = await startWebhookDaemon();
      try {
        const u = await userSubscriber(ctx);
        const ts = Math.floor(Date.now() / 1000);
        expect(
          await postEvents(ctx, [
            { ts, session_id: "S2", prefix: "484eda9c" },
            { ts, session_id: "S3", prefix: "aa11bb22" },
          ]),
        ).toBe(204);
        const { ev } = await u.readEventUntil<LlmRequestsEv>(
          (e) => e.ev === "llm_requests" && e.requests.length === 2,
        );
        expect(ev.requests.map((r) => r.session_id).sort()).toEqual(["S2", "S3"]);
        u.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "a redelivered event does not move the window",
    async () => {
      // Both gateway processes may report the same call; neither knows about
      // the other, so the daemon has to absorb the duplicate.
      const ctx = await startWebhookDaemon();
      try {
        const u = await userSubscriber(ctx);
        const ts = Math.floor(Date.now() / 1000) - 100;
        await postEvents(ctx, { ts, session_id: "S4", prefix: "484eda9c" });
        await u.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        await postEvents(ctx, { ts, session_id: "S4", prefix: "484eda9c" });
        // The duplicate is dropped by the cache, so its ts is unchanged. Anchor
        // on a later, genuinely new event to prove the assertion isn't just
        // reading the first push again.
        await postEvents(ctx, { ts: ts + 50, session_id: "S5", prefix: "aa11bb22" });
        const { ev } = await u.readEventUntil<LlmRequestsEv>(
          (e) => e.ev === "llm_requests" && e.requests.length === 2,
        );
        expect(ev.requests.find((r) => r.session_id === "S4")?.ts).toBe(ts);
        u.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "unusable events are dropped without failing the delivery",
    async () => {
      const ctx = await startWebhookDaemon();
      try {
        const u = await userSubscriber(ctx);
        const ts = Math.floor(Date.now() / 1000);
        // session_id: null is the gateway's own shape for a client that sent
        // no session header — the most common event ccmsg cannot place.
        expect(
          await postEvents(ctx, [
            { ts, session_id: null, prefix: "484eda9c" },
            { ts, session_id: "S6", prefix: "484eda9c" },
            { nonsense: true },
          ]),
        ).toBe(204);
        const { ev } = await u.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        expect(ev.requests).toHaveLength(1);
        expect(ev.requests[0]?.session_id).toBe("S6");
        u.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "a subagent's request arrives as a separate, non-main series",
    async () => {
      const ctx = await startWebhookDaemon();
      try {
        const u = await userSubscriber(ctx);
        const mainTs = Math.floor(Date.now() / 1000) - 240;
        await postEvents(ctx, { ts: mainTs, session_id: "S7", prefix: "484eda9c" });
        await u.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        // Same session id, different system prompt: a subagent. The session's
        // own window must survive it untouched — that is what keeps the ring
        // counting down while a subagent chatters.
        const subTs = Math.floor(Date.now() / 1000);
        await postEvents(ctx, { ts: subTs, session_id: "S7", prefix: "9c31aa02" });
        const { ev } = await u.readEventUntil<LlmRequestsEv>(
          (e) => e.ev === "llm_requests" && e.requests.length === 2,
        );
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
    },
    T,
  );

  test(
    "a later subscriber gets the window that opened before it connected",
    async () => {
      const ctx = await startWebhookDaemon();
      try {
        const first = await userSubscriber(ctx);
        const ts = Math.floor(Date.now() / 1000);
        await postEvents(ctx, { ts, session_id: "S8", prefix: "484eda9c" });
        await first.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        first.close();

        // The reload case: a brand-new connection subscribing mid-window.
        const second = await userSubscriber(ctx);
        const { ev } = await second.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        expect(ev.requests).toEqual([{ ts, session_id: "S8", prefix: "484eda9c", main: true }]);
        second.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "session-role subscribers never receive it (webui-only, like ev:peers)",
    async () => {
      const ctx = await startWebhookDaemon();
      try {
        const u = await userSubscriber(ctx);
        const s = await connect(ctx.sock);
        await s.request({
          op: "hello",
          role: "session",
          sid: "S9",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        await s.request({ op: "subscribe" });
        await postEvents(ctx, {
          ts: Math.floor(Date.now() / 1000),
          session_id: "S9",
          prefix: "484eda9c",
        });
        // The user connection receiving the push is the ordering anchor: the
        // daemon writes both sends in one synchronous loop, so once the user
        // side has it, a session-side copy would already be on the socket.
        await u.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        const [marker, room] = await markerSession(ctx, ["S9"]);
        const seen = await seenBeforeMarker(marker, s, room);
        expect(seen.some((e: any) => e.ev === "llm_requests")).toBe(false);
        marker.close();
        u.close();
        s.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "a bad token is rejected and nothing reaches the WS",
    async () => {
      const ctx = await startWebhookDaemon();
      try {
        const u = await userSubscriber(ctx);
        expect(
          await postEvents(
            ctx,
            { ts: Math.floor(Date.now() / 1000), session_id: "SA", prefix: "484eda9c" },
            "wrong-token",
          ),
        ).toBe(401);
        const [marker, room] = await markerSession(ctx, []);
        const seen = await seenBeforeMarker(marker, u, room);
        expect(seen.some((e: any) => e.ev === "llm_requests")).toBe(false);
        marker.close();
        u.close();
      } finally {
        await stop(ctx);
      }
    },
    T,
  );

  test(
    "with no webhooks configured the endpoint does not exist",
    async () => {
      const ctx = await startWebhookDaemon({ configured: false });
      try {
        expect(
          await postEvents(ctx, {
            ts: Math.floor(Date.now() / 1000),
            session_id: "SB",
            prefix: "484eda9c",
          }),
        ).toBe(404);
      } finally {
        await stop(ctx);
      }
    },
    T,
  );
});
