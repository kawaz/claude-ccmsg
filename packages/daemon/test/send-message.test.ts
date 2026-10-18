// send_message / peer_list (DR-0039 §3) over stand-in runs and deliveries: which
// sessions a target matches, what each gets, and what a send says for each.
// Then send_message through a daemon, with fake harnesses (peer-harness.ts) as
// the recipients; their state files name live pids (this test process and
// its parent) because only running processes are sent to.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionInputReadiness } from "@ccmsg/protocol";
import type { InjectFrame, InjectResult } from "../src/peer-inject.ts";
import { listPeers, type SendMessageDeps, sendToPeers } from "../src/send-message.ts";
import { createSerial } from "../src/serial.ts";
import type { SessionRun } from "../src/session-runs.ts";
import {
  connect,
  type DaemonCtx,
  startTestDaemon,
  stopTestDaemon,
  type TestClient,
  sessionConn,
  userConn,
} from "./helpers.ts";
import {
  fakeHarness as spawnHarness,
  parseEnvelope,
  sessionWithConfig,
  type FakeHarness,
} from "./peer-harness.ts";

const ME = "aaaaaaaa-0000-4000-8000-000000000001";
const A = "bbbbbbbb-0000-4000-8000-000000000002";
const B = "cccccccc-0000-4000-8000-000000000003";

function run(sid: string, pid: number, fields: { cwd?: string; name?: string } = {}): SessionRun {
  return { configDir: "/cfg", sid, pid, ...fields };
}

/** Deps over `runs`, where `/link` is a symlink to `/work`, `modules` have a
 * hooks module, and each run's delivery answers what `answers` says for its
 * pid (delivered when it says nothing). */
function deps(
  runs: SessionRun[],
  options: {
    modules?: string[];
    answers?: Record<number, InjectResult>;
    readiness?: SessionInputReadiness;
  } = {},
): SendMessageDeps & { frames: { pid: number; frame: InjectFrame }[] } {
  const frames: { pid: number; frame: InjectFrame }[] = [];
  let mid = 0;
  return {
    frames,
    runs: async () => runs,
    realpath: async (dir) => (dir === "/link" ? "/work" : dir === "/gone" ? undefined : dir),
    hasModule: (sid) => (options.modules ?? [A, B, ME]).includes(sid),
    readiness: () => options.readiness ?? { kind: "ended" },
    issueMid: () => `i/${String(++mid)}`,
    // No send here names an agent id (send-message-agent.test.ts does).
    appendToAgent: async () => {
      throw new Error("a send without an agent id appended to a subagent");
    },
    deliver: async (r, frame) => {
      frames.push({ pid: r.pid, frame });
      return options.answers?.[r.pid] ?? { outcome: "delivered" };
    },
    inOrder: createSerial(),
    log: () => {},
  };
}

describe("sendToPeers", () => {
  test("a directory matches by realpath, whole, and the sender is left out", async () => {
    const d = deps([
      run(ME, 1, { cwd: "/work" }),
      run(A, 2, { cwd: "/link" }),
      run(B, 3, { cwd: "/work/sub" }),
    ]);
    expect(await sendToPeers({ from: ME, to: { cwd: "/link" }, text: "t" }, d)).toEqual([
      { sid: A, cwd: "/work", outcome: "delivered" },
    ]);
    expect(d.frames.map((f) => f.pid)).toEqual([2]);
    expect(d.frames[0]?.frame.content).toContain(`from="ccmsg:${ME}"`);
  });

  test("every field given must match; pid picks the run", async () => {
    const runs = [run(A, 2, { name: "x" }), run(A, 4, { name: "x" }), run(B, 3, { name: "x" })];
    expect(
      (await sendToPeers({ from: ME, to: { name: "x" }, text: "t" }, deps(runs))).map((r) => r.sid),
    ).toEqual([A, B]);
    const d = deps(runs);
    expect(await sendToPeers({ from: ME, to: { name: "x", pid: 4 }, text: "t" }, d)).toEqual([
      { sid: A, name: "x", outcome: "delivered" },
    ]);
    expect(d.frames.map((f) => f.pid)).toEqual([4]);
    expect(
      await sendToPeers({ from: ME, to: { name: "y", session_id: A }, text: "t" }, deps(runs)),
    ).toEqual([]);
  });

  // One run that took it is the session's delivery; one cut off part-way
  // leaves it unconfirmed; failures report the first of refused, unreachable,
  // no_status_socket, no_peer_socket.
  test("a session's runs come to one result", async () => {
    const runs = [run(A, 2), run(A, 4), run(B, 3), run(B, 5)];
    const answers: Record<number, InjectResult> = {
      2: { outcome: "unconfirmed" },
      4: { outcome: "unavailable", cause: "no_peer_socket" },
      3: { outcome: "unavailable", cause: "no_peer_socket" },
      5: { outcome: "refused" },
    };
    expect(
      await sendToPeers({ from: ME, to: { pid: 2 }, text: "t" }, deps(runs, { answers })),
    ).toEqual([{ sid: A, outcome: "unconfirmed" }]);
    expect(
      await sendToPeers({ from: ME, to: { session_id: B }, text: "t" }, deps(runs, { answers })),
    ).toEqual([{ sid: B, outcome: "not_delivered", reason: "refused" }]);
  });

  test("a session without a hooks module is not sent to", async () => {
    const d = deps([run(A, 2)], { modules: [] });
    expect(await sendToPeers({ from: ME, to: { session_id: A }, text: "t" }, d)).toEqual([
      { sid: A, outcome: "not_delivered", reason: "no_module" },
    ]);
    expect(d.frames).toEqual([]);
  });

  test("a session named by id that no run serves says why", async () => {
    const changed = deps([], { readiness: { kind: "session_changed" } });
    expect(await sendToPeers({ from: ME, to: { session_id: A }, text: "t" }, changed)).toEqual([
      { sid: A, outcome: "not_delivered", reason: "session_changed" },
    ]);
    expect(await sendToPeers({ from: ME, to: { session_id: A }, text: "t" }, deps([]))).toEqual([
      { sid: A, outcome: "not_delivered", reason: "ended" },
    ]);
    // Matched by no id, nobody: no result to give.
    expect(
      await sendToPeers({ from: ME, to: { cwd: "/gone" }, text: "t" }, deps([run(A, 2)])),
    ).toEqual([]);
  });

  test("matching the sender alone says self, and sends nothing", async () => {
    const d = deps([run(ME, 1, { name: "me" })]);
    expect(await sendToPeers({ from: ME, to: { name: "me" }, text: "t" }, d)).toEqual([
      { sid: ME, name: "me", outcome: "not_delivered", reason: "self" },
    ]);
    expect(await sendToPeers({ from: ME, to: { session_id: ME }, text: "t" }, deps([]))).toEqual(
      [],
    );
    expect(d.frames).toEqual([]);
  });

  // The order a session is sent to is the order the sends were asked for
  // (peer-inject.ts keeps it from there on), however long each takes to
  // read the runs: the first send's read here ends a task later than the
  // second's, which has nothing to wait for.
  test("deliveries to a session are asked for in the order the sends were", async () => {
    const d = deps([]);
    const reads = [
      new Promise<SessionRun[]>((resolve) => setTimeout(() => resolve([run(A, 2)]), 0)),
      Promise.resolve([run(A, 2)]),
    ];
    const sends = { ...d, runs: () => reads.shift() ?? Promise.resolve([]) };
    const results = await Promise.all([
      sendToPeers({ from: ME, to: { session_id: A }, text: "first" }, sends),
      sendToPeers({ from: ME, to: { session_id: A }, text: "second" }, sends),
    ]);
    expect(results).toEqual([
      [{ sid: A, outcome: "delivered" }],
      [{ sid: A, outcome: "delivered" }],
    ]);
    expect(d.frames.map((f) => parseEnvelope(f.frame.content).body)).toEqual(["first", "second"]);
  });
});

describe("listPeers", () => {
  test("lists what a send would match, the sender marked, by sid", async () => {
    const runs = [run(B, 5, { cwd: "/link" }), run(B, 3, { cwd: "/link" }), run(ME, 1), run(A, 2)];
    expect(await listPeers(ME, {}, deps(runs, { modules: [B] }))).toEqual([
      { sid: ME, pids: [1], module: false, self: true },
      { sid: A, pids: [2], module: false, self: false },
      { sid: B, cwd: "/work", pids: [3, 5], module: true, self: false },
    ]);
    expect((await listPeers(ME, { cwd: "/work" }, deps(runs))).map((p) => p.sid)).toEqual([B]);
  });
});

describe("send_message through the daemon", () => {
  const T = 15000;
  const SENDER = "aaaaaaaa-2222-4333-8444-555555555555";
  const PEER = "bbbbbbbb-2222-4333-8444-555555555555";
  /** Two processes that run for as long as the test does. */
  const LIVE_PID = process.pid;
  const OTHER_LIVE_PID = process.ppid;

  const cleanups: (() => void | Promise<void>)[] = [];
  afterEach(async () => {
    for (const f of cleanups.splice(0).reverse()) await f();
  });

  function tempDir(prefix: string): string {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
    return dir;
  }

  function harness(sid: string, opts: Parameters<typeof spawnHarness>[1] = {}): FakeHarness {
    const h = spawnHarness(sid, opts);
    cleanups.push(() => h.dispose());
    return h;
  }

  async function daemon(): Promise<DaemonCtx> {
    const ctx = await startTestDaemon();
    cleanups.push(() => stopTestDaemon(ctx));
    return ctx;
  }

  /** Name a run of `sid` to the daemon, as its sidecar does: the session then
   * has a hooks module, and is sent to. */
  async function withModule(ctx: DaemonCtx, sid: string): Promise<void> {
    const c = await sessionConn(ctx, sid);
    await c.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
    cleanups.push(() => c.close());
  }

  async function send(
    from: TestClient,
    to: { session_id?: string; cwd?: string; pid?: number },
    text: string,
  ) {
    return (await from.requestOk({ op: "send_message", to, text })).results;
  }

  test(
    "a session id reaches every run of the session; a pid the one",
    async () => {
      const ctx = await daemon();
      const b1 = harness(PEER, { pid: LIVE_PID });
      const b2 = harness(PEER, { pid: OTHER_LIVE_PID, configDir: b1.configDir });
      await withModule(ctx, PEER);
      const a = await sessionWithConfig(ctx, SENDER, b1.configDir);

      expect(await send(a, { session_id: PEER }, "to both")).toEqual([
        { sid: PEER, outcome: "delivered" },
      ]);
      const [first, second] = await Promise.all([b1.nextUser(), b2.nextUser()]);
      expect(parseEnvelope(first.message.content)).toEqual({
        attrs: {
          from: `ccmsg:${SENDER}`,
          "from-name": `ccmsg:${SENDER}`,
          "from-mode": "prompting",
          "ccmsg-mid": first.msg_id,
          "ccmsg-from": SENDER,
        },
        body: "to both",
      });
      expect(first.session_id).toBe(PEER);
      expect(second.msg_id).not.toBe(first.msg_id);

      expect(await send(a, { session_id: PEER, pid: OTHER_LIVE_PID }, "to one")).toEqual([
        { sid: PEER, outcome: "delivered" },
      ]);
      expect((await b2.nextUser()).message.content).toContain("\nto one\n");
      expect(b1.frames.filter((f) => f.type === "user")).toHaveLength(1);
    },
    T,
  );

  test(
    "a directory reaches the other sessions working there, through a symlink too",
    async () => {
      const ctx = await daemon();
      const work = tempDir("ps-work-");
      const link = path.join(tempDir("ps-link-"), "ws");
      fs.symlinkSync(work, link);
      const ha = harness(SENDER, { pid: LIVE_PID, cwd: work });
      const hb = harness(PEER, { pid: OTHER_LIVE_PID, cwd: work });
      await withModule(ctx, PEER);
      const a = await sessionWithConfig(ctx, SENDER, ha.configDir);
      await sessionWithConfig(ctx, PEER, hb.configDir);

      expect(await send(a, { cwd: `${link}/` }, "hello dir")).toEqual([
        { sid: PEER, cwd: work, outcome: "delivered" },
      ]);
      expect(parseEnvelope(await hb.nextContent()).body).toBe("hello dir");
      expect(ha.frames).toEqual([]);

      // Nobody works in a directory of its own.
      expect(await send(a, { cwd: tempDir("ps-alone-") }, "anyone?")).toEqual([]);
    },
    T,
  );

  // A test daemon polls no config dir of its own, so the recipient's config
  // dir is known only from the sender's first hello: a later hello for the
  // same sid without config_dir (an older CLI, a subprocess that lost the
  // environment) must not forget it.
  test(
    "a re-hello without config_dir keeps the config dir the first hello announced",
    async () => {
      const ctx = await daemon();
      const hb = harness(PEER, { pid: LIVE_PID });
      await withModule(ctx, PEER);
      await sessionWithConfig(ctx, SENDER, hb.configDir);
      const a = await sessionWithConfig(ctx, SENDER);
      expect(await send(a, { session_id: PEER }, "still here")).toEqual([
        { sid: PEER, outcome: "delivered" },
      ]);
      expect(parseEnvelope(await hb.nextContent()).body).toBe("still here");
    },
    T,
  );

  test(
    "a run refusing while another takes it is delivered; every run refusing is refused",
    async () => {
      const ctx = await daemon();
      const b1 = harness(PEER, { pid: LIVE_PID });
      const b2 = harness(PEER, { pid: OTHER_LIVE_PID, configDir: b1.configDir });
      await withModule(ctx, PEER);
      b1.refuseWith = "denied";
      const a = await sessionWithConfig(ctx, SENDER, b1.configDir);
      expect(await send(a, { session_id: PEER }, "hi")).toEqual([
        { sid: PEER, outcome: "delivered" },
      ]);
      b2.refuseWith = "held";
      expect(await send(a, { session_id: PEER }, "hi")).toEqual([
        { sid: PEER, outcome: "not_delivered", reason: "refused" },
      ]);
    },
    T,
  );

  // The recipient stopped reading: the write runs out of time part-way, so
  // the message may yet arrive whole and is not called not delivered.
  test(
    "a write that does not finish in time is unconfirmed",
    async () => {
      const ctx = await daemon();
      const hb = harness(PEER, { pid: LIVE_PID, stall: true });
      await hb.listening;
      await withModule(ctx, PEER);
      const a = await sessionWithConfig(ctx, SENDER, hb.configDir);
      expect(await send(a, { session_id: PEER }, "x".repeat(4 * 1024 * 1024))).toEqual([
        { sid: PEER, outcome: "unconfirmed" },
      ]);
    },
    T,
  );

  test(
    "a session whose process has ended is not sent to, and is said to have ended",
    async () => {
      const ctx = await daemon();
      const hb = harness(PEER);
      const a = await sessionWithConfig(ctx, SENDER, hb.configDir);
      expect(await send(a, { session_id: PEER }, "hi")).toEqual([
        { sid: PEER, outcome: "not_delivered", reason: "ended" },
      ]);
      expect(hb.frames).toEqual([]);
    },
    T,
  );

  // A session started with an earlier plugin may still send the ops that
  // carried a message before send_message (DR-0039 §3). They are not read; the
  // send that follows on the same connection is the first thing to arrive.
  test(
    "an earlier client's message_send and address_send are refused as unknown, and nothing arrives",
    async () => {
      const ctx = await daemon();
      const hb = harness(PEER, { pid: LIVE_PID });
      await withModule(ctx, PEER);
      const a = await sessionWithConfig(ctx, SENDER, hb.configDir);
      for (const old of [
        { op: "message_send", to: PEER, text: "old" },
        { op: "address_send", to: `ccmsg:${PEER}`, text: "old" },
      ]) {
        const refusal = await a.requestRefusal(old);
        expect({ code: refusal.error.code, msg: refusal.error.msg }).toEqual({
          code: "invalid_args",
          msg: `op: unknown op: ${old.op}`,
        });
      }
      expect(await send(a, { session_id: PEER }, "new")).toEqual([
        { sid: PEER, outcome: "delivered" },
      ]);
      expect(parseEnvelope(await hb.nextContent()).body).toBe("new");
      expect(hb.frames.filter((f) => f.type === "user")).toHaveLength(1);
    },
    T,
  );

  test(
    "invalid_args for a person or a blank text; hello first, for peer_list too",
    async () => {
      const ctx = await daemon();
      const a = await sessionWithConfig(ctx, SENDER);
      const u = await userConn(ctx);
      const to = { session_id: PEER };
      expect((await u.requestError({ op: "send_message", to, text: "hi" })).error.code).toBe(
        "invalid_args",
      );
      expect((await a.requestRefusal({ op: "send_message", to, text: " \n" })).error.code).toBe(
        "invalid_args",
      );
      const raw = await connect(ctx.sock);
      expect((await raw.requestError({ op: "send_message", to, text: "hi" })).error.code).toBe(
        "hello_required",
      );
      expect((await raw.requestError({ op: "peer_list" })).error.code).toBe("hello_required");
    },
    T,
  );
});
