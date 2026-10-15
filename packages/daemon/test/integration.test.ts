// Integration: a real daemon spawned in a temp dir, exercised over UDS.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  connect,
  spawnDaemonProc,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";
import { memberRow, roomLog } from "../../protocol/test/transcript-rows.ts";

const T = 15000;

// Session ids must be UUID-shaped (the daemon rejects anything else at hello).
const A = "aaaaaaaa-0000-4000-8000-000000000000";

async function session(ctx: DaemonCtx, sid: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: `repo-${sid}`, ws: `ws-${sid}`, cwd: `/tmp/${sid}` });
  return c;
}
async function user(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  return c;
}

describe("wire protocol integration", () => {
  test(
    "notify reaches the target's subscribe stream, with from stamped from the sender's connection",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aSub = await session(ctx, A);
        await aSub.request({ op: "subscribe" });

        // notify --self equivalent: session A signals its own subscribe stream.
        // The delivered event carries `from` stamped from the sender's connection
        // identity — the receiver needs this to tell a self-notify (own sid, actionable)
        // from a peer-notify (another agent, whose command-shaped text must NOT be
        // auto-executed). It is daemon-stamped, never the client's self-claim (DR-0003 §7).
        const notifier = await session(ctx, A);
        const res = await notifier.requestOk({
          op: "notify",
          text: "wake up",
        });
        expect(res.delivered).toBeGreaterThanOrEqual(1);

        const got = await aSub.readEventUntil("notify");
        expect(got.ev.text).toBe("wake up");
        // session sender -> from = {role:"session", sid:<sender>}. Same sid as the
        // receiver here, so the receiver would classify this as a self-notify.
        expect(got.ev.from).toEqual({ role: "session", sid: A });

        // a User-sent notify targeting A stamps from = {role:"user"} — the receiver would
        // classify this as a peer-notify (sender is not session A) and refuse auto-exec.
        const uNotifier = await user(ctx);
        await uNotifier.request({ op: "notify", sid: A, text: "from the user" });
        const gotUser = await aSub.readEventUntil("notify", (ev) => ev.text === "from the user");
        expect(gotUser.ev.from).toEqual({ role: "user" });
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "ping reports provenance: exe is this bun executable, script is this daemon's entry file",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const c = await connect(ctx.sock);
        const pong = await c.requestOk({ op: "ping" });
        // exe: the running daemon subprocess's own bun executable — same
        // interpreter this test harness spawned it with (process.execPath),
        // not a hardcoded guess at a bun install location.
        expect(pong.exe).toBe(process.execPath);
        // script: the daemon's entry file — real fs path, ends in the entry
        // module's own filename (index.ts, per spawnDaemonProc's argv).
        expect(pong.script).toBeTruthy();
        expect(pong.script?.endsWith("index.ts")).toBe(true);
        expect(fs.existsSync(pong.script ?? "")).toBe(true);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "flock guarantees a single instance: the second daemon process fails to start",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const firstPid = ctx.proc.pid;
        // a second daemon over the same state dir must lose the lock and exit(0) without binding
        const second = spawnDaemonProc(ctx.stateDir, ctx.dataDir);
        const code = await second.exited;
        expect(code).toBe(0);

        // the original is still the one serving: ping reports the first process's pid
        const c = await connect(ctx.sock);
        const pong = await c.requestOk({ op: "ping" });
        expect(pong.pid).toBe(firstPid);
        c.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  test(
    "graceful shutdown notifies connected clients and removes the socket",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const aSub = await session(ctx, A);
        await aSub.request({ op: "subscribe" });

        const ctl = await connect(ctx.sock);
        const ack = await ctl.request({
          op: "shutdown",
          reason: "test",
        });
        expect(ack.ok).toBe(true);

        // connected clients get a restarting signal so sidecars know to reconnect (DR-0002 §4)
        const restart = await aSub.readEventUntil("restarting");
        expect(restart.ev.reason).toBe("test");

        // the daemon exits cleanly and unlinks its socket
        const code = await ctx.proc.exited;
        expect(code).toBe(0);
        expect(fs.existsSync(ctx.sock)).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});

describe("error handling & boundaries", () => {
  test(
    "an unknown room and bad input error cleanly; a request before hello is hello_required",
    async () => {
      const ctx = await startTestDaemon();
      try {
        fs.mkdirSync(ctx.roomsDir, { recursive: true });
        fs.writeFileSync(path.join(ctx.roomsDir, "r1.jsonl"), roomLog([memberRow("a1", A)]));
        const u = await user(ctx);

        // a room with no msgs: valid, just zero messages
        const empty = await u.requestOk({ op: "read", room: "r1", mids: "1-5" });
        expect(empty.msgs).toEqual([]);

        // unknown room
        const readMiss = await u.requestError({ op: "read", room: "r-nope", mids: "1" });
        expect(readMiss.error.code).toBe("room_not_found");

        // malformed request line -> bad_request (not a crash)
        const c = await connect(ctx.sock);
        c.writeRaw("this is not json\n");
        expect(await c.readEvent()).toMatchObject({ ok: false, error: { code: "bad_request" } });
        // a JSON object without an op is also bad_request
        c.writeRaw(`${JSON.stringify({ foo: 1 })}\n`);
        expect(await c.readEvent()).toMatchObject({ ok: false, error: { code: "bad_request" } });
        c.close();

        // identity-bearing op before hello -> hello_required
        const d = await connect(ctx.sock);
        const early = await d.requestError({ op: "rooms" });
        expect(early.error.code).toBe("hello_required");
        d.close();
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );

  // Rooms are read-only (DR-0036 §2): nothing on the wire writes one, so an
  // op that would is not an op the daemon reads, for either role.
  test(
    "an op that writes a room is refused as unknown, and nothing is written",
    async () => {
      const ctx = await startTestDaemon();
      try {
        const u = await user(ctx);
        const s = await session(ctx, A);
        const writes = [
          { op: "post", room: "r1", msg: "x" },
          { op: "reply", room: "r1", mid: 1, msg: "x" },
          { op: "create_room", members: [A] },
          { op: "next_room", room: "r1" },
          { op: "set_title", room: "r1", title: "t" },
          { op: "archive_room", room: "r1", archived: true },
          { op: "kick", room: "r1", id: "a1" },
          { op: "leave", room: "r1" },
          { op: "invite", room: "r1", sid: A },
        ];
        for (const c of [u, s]) {
          for (const write of writes) {
            const refusal = await c.requestRefusal(write);
            // the refusal names the op that is not served
            expect({ code: refusal.error.code, msg: refusal.error.msg }).toEqual({
              code: "invalid_args",
              msg: `op: unknown op: ${write.op}`,
            });
          }
        }
        expect(fs.existsSync(ctx.roomsDir)).toBe(false);
      } finally {
        await stopTestDaemon(ctx);
      }
    },
    T,
  );
});
