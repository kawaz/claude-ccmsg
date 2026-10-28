// notify through the daemon (DR-0039 §9): the text goes into the named
// session's conversation in the envelope a send's message comes in, from the
// calling session, through the same peer socket (fake harnesses,
// peer-harness.ts, as the recipients; their state files name live pids
// because only running processes are sent to). A session's own conversation
// is one it may notify. And the session-role stream notify used to arrive on
// is refused.
import { afterEach, describe, expect, test } from "bun:test";
import {
  connect,
  type DaemonCtx,
  startTestDaemon,
  stopTestDaemon,
  type TestClient,
  userConn,
} from "./helpers.ts";
import {
  fakeHarness as spawnHarness,
  parseEnvelope,
  sessionWithConfig,
  type FakeHarness,
} from "./peer-harness.ts";

const T = 15000;
const SENDER = "aaaaaaaa-3333-4333-8444-555555555555";
const PEER = "bbbbbbbb-3333-4333-8444-555555555555";
/** A process that runs for as long as the test does. */
const LIVE_PID = process.pid;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function harness(sid: string): FakeHarness {
  const h = spawnHarness(sid, { pid: LIVE_PID });
  cleanups.push(() => h.dispose());
  return h;
}

async function daemon(): Promise<DaemonCtx> {
  const ctx = await startTestDaemon();
  cleanups.push(() => stopTestDaemon(ctx));
  return ctx;
}

/** Name a run of `sid` to the daemon, as its sidecar does, announcing the
 * session's config dir: the session then has a hooks module. */
async function withModule(ctx: DaemonCtx, sid: string, configDir: string): Promise<void> {
  const c = await sessionWithConfig(ctx, sid, configDir);
  await c.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
  cleanups.push(() => c.close());
}

async function notify(from: TestClient, text: string, sid?: string) {
  return (await from.requestOk({ op: "notify", ...(sid !== undefined ? { sid } : {}), text }))
    .result;
}

describe("notify", () => {
  test(
    "without a sid it goes into the caller's own conversation, from the caller",
    async () => {
      const ctx = await daemon();
      const own = harness(SENDER);
      await withModule(ctx, SENDER, own.configDir);
      const a = await sessionWithConfig(ctx, SENDER, own.configDir);

      expect(await notify(a, "Monitor で just watch を起動して")).toEqual({
        sid: SENDER,
        outcome: "delivered",
      });
      const frame = await own.nextUser();
      expect(frame.session_id).toBe(SENDER);
      expect(parseEnvelope(frame.message.content)).toEqual({
        attrs: {
          from: `ccmsg:${SENDER}`,
          "from-name": `ccmsg:${SENDER}`,
          "from-mode": "prompting",
          "ccmsg-mid": frame.msg_id,
          "ccmsg-from": SENDER,
        },
        body: "Monitor で just watch を起動して",
      });
    },
    T,
  );

  test(
    "with a sid it goes into that session's conversation, from the caller",
    async () => {
      const ctx = await daemon();
      const peer = harness(PEER);
      await withModule(ctx, PEER, peer.configDir);
      const a = await sessionWithConfig(ctx, SENDER, peer.configDir);

      expect(await notify(a, "hello", PEER)).toEqual({ sid: PEER, outcome: "delivered" });
      const { attrs, body } = parseEnvelope(await peer.nextContent());
      expect({ from: attrs.from, sender: attrs["ccmsg-from"], body }).toEqual({
        from: `ccmsg:${SENDER}`,
        sender: SENDER,
        body: "hello",
      });
    },
    T,
  );

  // DR-0039 §7: a session without a hooks module has no ccmsg, and nothing
  // is written to it some other way.
  test(
    "a session without a hooks module is not written to, and says no_module",
    async () => {
      const ctx = await daemon();
      const peer = harness(PEER);
      // The session says where it runs, and no sidecar names a run of it.
      const unnamed = await sessionWithConfig(ctx, PEER, peer.configDir);
      cleanups.push(() => unnamed.close());
      const a = await sessionWithConfig(ctx, SENDER, peer.configDir);
      expect(await notify(a, "hello", PEER)).toEqual({
        sid: PEER,
        outcome: "not_delivered",
        reason: "no_module",
      });
      expect(peer.frames).toEqual([]);
    },
    T,
  );

  test(
    "a session no live run serves is said to have ended",
    async () => {
      const ctx = await daemon();
      const a = await sessionWithConfig(ctx, SENDER);
      expect(await notify(a, "hello", PEER)).toEqual({
        sid: PEER,
        outcome: "not_delivered",
        reason: "ended",
      });
    },
    T,
  );

  test(
    "a person's connection is refused, and hello comes first",
    async () => {
      const ctx = await daemon();
      const u = await userConn(ctx);
      expect((await u.requestError({ op: "notify", sid: PEER, text: "hi" })).error.code).toBe(
        "invalid_args",
      );
      const raw = await connect(ctx.sock);
      expect((await raw.requestError({ op: "notify", text: "hi" })).error.code).toBe(
        "hello_required",
      );
    },
    T,
  );
});

describe("subscribe", () => {
  // A session asking for a stream runs a plugin from before notices went
  // into the conversation; the refusal says a restart loads the current one.
  test(
    "a session's subscribe is refused, a person's is taken",
    async () => {
      const ctx = await daemon();
      const a = await sessionWithConfig(ctx, SENDER);
      const refusal = await a.requestError({ op: "subscribe" });
      expect(refusal.error.code).toBe("bad_request");
      expect(refusal.error.msg).toContain("restart the session");
      const u = await userConn(ctx);
      expect(await u.requestOk({ op: "subscribe" })).toEqual({ ok: true, subscribed: true });
    },
    T,
  );
});
