// ev:"llm_requests" relay: a daemon configured with `llm_events_url`
// subscribes to the gateway's SSE stream at startup and forwards each
// attributable request to user-role subscribers, plus a catch-up snapshot to
// whoever subscribes after the fact (the browser-reload case the whole
// snapshot shape exists for). Driven against a real daemon process and a real
// (fake) gateway, because the wiring under test is exactly the startup path a
// stubbed Daemon object would skip.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterAll, describe, expect, test } from "bun:test";
import {
  connect,
  spawnDaemonProc,
  waitConnectable,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;
const PORT = 18962;

let openStreams: ReadableStreamDefaultController<Uint8Array>[] = [];
const gateway = Bun.serve({
  port: PORT,
  fetch() {
    return new Response(
      new ReadableStream<Uint8Array>({
        start(controller) {
          openStreams.push(controller);
          controller.enqueue(new TextEncoder().encode(": hello\n\n"));
        },
      }),
      { headers: { "content-type": "text/event-stream" } },
    );
  },
});
afterAll(() => {
  for (const c of openStreams) {
    try {
      c.close();
    } catch {
      // already closed
    }
  }
  void gateway.stop(true);
});

/** Publish to every stream still open, dropping the ones that aren't: each
 * test shuts its daemon down, which cancels that daemon's subscription, and a
 * cancelled stream's controller stays in the list until it is written to. */
function emit(payload: unknown): void {
  const frame = new TextEncoder().encode(`event: request\ndata: ${JSON.stringify(payload)}\n\n`);
  openStreams = openStreams.filter((c) => {
    try {
      c.enqueue(frame);
      return true;
    } catch {
      return false;
    }
  });
}

/** startTestDaemon, but with `config.json` written before the spawn — the
 * daemon reads its config once at startup, so the file has to exist first.
 * (Not folded into helpers.ts: that file is shared with every other suite.) */
async function startConfiguredDaemon(config: Record<string, unknown>): Promise<DaemonCtx> {
  // Only this daemon's stream may satisfy untilGatewayConnected/emit below.
  openStreams = [];
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-llmev-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  fs.writeFileSync(path.join(dataDir, "config.json"), JSON.stringify(config));
  const proc = spawnDaemonProc(stateDir, dataDir);
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  return {
    base,
    stateDir,
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock,
    proc,
    env: { CCMSG_STATE_DIR: stateDir, CCMSG_DATA_DIR: dataDir },
  };
}

async function stop(ctx: DaemonCtx): Promise<void> {
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

async function userSubscriber(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.request({ op: "hello", role: "user" });
  await c.request({ op: "subscribe" });
  return c;
}

interface LlmRequestsEv {
  ev: "llm_requests";
  requests: { ts: number; session_id: string; model?: string; status?: number }[];
}

/** Wait until THIS test's daemon has established its subscription, so an
 * emit() can't be published into a stream nobody is reading yet. Callers reset
 * `openStreams` first (see startConfiguredDaemon) so a controller left over
 * from an earlier test can't satisfy the wait. */
function untilGatewayConnected(): Promise<void> {
  return new Promise((resolve) => {
    const check = (): void => {
      if (openStreams.length > 0) resolve();
      else setTimeout(check, 5);
    };
    check();
  });
}

/** Connect a session that exists only to post a marker msg (peers-push.test.ts's
 * postMarkerVia pattern): the room is created BY the poster so it is a member
 * of it, with `members` naming whoever has to be able to read the marker. A
 * msg from another connection is delivered with its body, whereas a self-post
 * comes back bodyless — which is why the anchor can't just be a self-post. */
async function markerSession(ctx: DaemonCtx, members: string[]): Promise<[TestClient, string]> {
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

describe("ev:llm_requests relay", () => {
  test(
    "a gateway request event reaches a user-role subscriber",
    async () => {
      const ctx = await startConfiguredDaemon({
        llm_events_url: `http://127.0.0.1:${PORT}/events`,
      });
      try {
        const u = await userSubscriber(ctx);
        await untilGatewayConnected();
        const ts = Math.floor(Date.now() / 1000);
        emit({ ts, session_id: "S1", model: "claude-fable-5", status: 200 });
        const { ev } = await u.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        expect(ev.requests).toEqual([
          { ts, session_id: "S1", model: "claude-fable-5", status: 200 },
        ]);
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
      const ctx = await startConfiguredDaemon({
        llm_events_url: `http://127.0.0.1:${PORT}/events`,
      });
      try {
        const first = await userSubscriber(ctx);
        await untilGatewayConnected();
        const ts = Math.floor(Date.now() / 1000);
        emit({ ts, session_id: "S2" });
        // Wait for the daemon to have recorded it (observed via the live push
        // to the connection that was already listening).
        await first.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        first.close();

        // The reload case: a brand-new connection subscribing mid-window.
        const second = await userSubscriber(ctx);
        const { ev } = await second.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        expect(ev.requests).toEqual([{ ts, session_id: "S2" }]);
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
      const ctx = await startConfiguredDaemon({
        llm_events_url: `http://127.0.0.1:${PORT}/events`,
      });
      try {
        const u = await userSubscriber(ctx);
        const s = await connect(ctx.sock);
        await s.request({
          op: "hello",
          role: "session",
          sid: "S3",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
        });
        await s.request({ op: "subscribe" });
        await untilGatewayConnected();
        emit({ ts: Math.floor(Date.now() / 1000), session_id: "S3" });
        // The user connection receiving the push is the ordering anchor: the
        // daemon writes both sends in one synchronous loop, so once the user
        // side has it, a session-side copy would already be on the socket.
        await u.readEventUntil<LlmRequestsEv>((e) => e.ev === "llm_requests");
        // Anchor read on the session side: everything it received up to a msg
        // it can see, which must include no llm_requests push.
        const [marker, room] = await markerSession(ctx, ["S3"]);
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
    "with no llm_events_url configured, subscribing pushes nothing",
    async () => {
      const ctx = await startConfiguredDaemon({});
      try {
        const u = await userSubscriber(ctx);
        // An unconfigured daemon must not emit an empty snapshot: the webui
        // reads "no event at all" as "this feature isn't set up".
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
});
