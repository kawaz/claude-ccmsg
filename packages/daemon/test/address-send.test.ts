// address_send (DR-0037): a SendMessage a session's hooks module took over is
// delivered to every live run its `ccmsg:` address names, and the sender is
// told delivered when any of them took it. Fake harnesses (peer-harness.ts)
// stand in for the recipients; their state files name live pids (this test
// process and its parent) because only running processes are sent to.
import { afterAll, afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { parseCcmsgAddress, parseDirectDeliveries } from "@ccmsg/protocol";
import {
  type AddressSendDeps,
  addressSendOutcome,
  liveRuns,
  realpathOrUndefined,
  resolveAddress,
  type SessionRun,
  sendToAddress,
} from "../src/address-send.ts";
import type { InjectFrame, InjectResult } from "../src/peer-inject.ts";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";
import {
  fakeHarness as spawnHarness,
  parseEnvelope,
  sessionWithConfig,
  type FakeHarness,
} from "./peer-harness.ts";

const T = 15000;
const A = "aaaaaaaa-2222-4333-8444-555555555555";
const B = "bbbbbbbb-2222-4333-8444-555555555555";
const C = "cccccccc-2222-4333-8444-555555555555";
const NOBODY = "dddddddd-2222-4333-8444-555555555555";
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

function address(text: string) {
  const read = parseCcmsgAddress(text);
  if (read === undefined) throw new Error(`not an address: ${text}`);
  return read;
}

describe("resolveAddress", () => {
  // Shared by the tests of this block, so removed after the block rather than
  // after each test.
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "as-resolve-")));
  afterAll(() => fs.rmSync(base, { recursive: true, force: true }));
  const work = path.join(base, "work");
  const sub = path.join(work, "sub");
  fs.mkdirSync(sub, { recursive: true });
  const link = path.join(base, "ws");
  fs.symlinkSync(work, link);
  const runs: SessionRun[] = [
    { configDir: "/c1", sid: A, pid: 10, cwd: work },
    { configDir: "/c1", sid: B, pid: 20, cwd: work },
    { configDir: "/c2", sid: B, pid: 21, cwd: work },
    { configDir: "/c2", sid: C, pid: 30, cwd: sub },
    { configDir: "/c2", sid: NOBODY, pid: 40 },
  ];
  const pids = (named: SessionRun[]) => named.map((r) => r.pid);

  test("a session: every run of it, in any config dir", async () => {
    expect(pids(await resolveAddress(address(`ccmsg:${B}`), A, runs, realpathOrUndefined))).toEqual(
      [20, 21],
    );
  });

  test("a run: that one only", async () => {
    expect(
      pids(await resolveAddress(address(`ccmsg:${B}.21`), A, runs, realpathOrUndefined)),
    ).toEqual([21]);
    expect(await resolveAddress(address(`ccmsg:${B}.99`), A, runs, realpathOrUndefined)).toEqual(
      [],
    );
  });

  test("a directory: the sessions working there, the sender aside, not a subdirectory", async () => {
    expect(
      pids(await resolveAddress(address(`ccmsg:path:${work}`), A, runs, realpathOrUndefined)),
    ).toEqual([20, 21]);
  });

  test("a directory through a symlink or with a trailing / is the same directory", async () => {
    for (const dir of [link, `${work}/`, `${link}/`]) {
      expect({
        dir,
        pids: pids(
          await resolveAddress(address(`ccmsg:path:${dir}`), A, runs, realpathOrUndefined),
        ),
      }).toEqual({ dir, pids: [20, 21] });
    }
  });

  test("a directory that does not exist names nobody", async () => {
    expect(
      await resolveAddress(
        address(`ccmsg:path:${path.join(work, "gone")}`),
        A,
        runs,
        realpathOrUndefined,
      ),
    ).toEqual([]);
  });
});

describe("addressSendOutcome", () => {
  const delivered: InjectResult = { outcome: "delivered" };
  const refused: InjectResult = { outcome: "refused" };
  const unconfirmed: InjectResult = { outcome: "unconfirmed" };
  const unreachable: InjectResult = { outcome: "unavailable", cause: "unreachable" };
  const noSocket: InjectResult = { outcome: "unavailable", cause: "no_peer_socket" };

  test("one run that took it makes it delivered, whatever the others did", () => {
    expect(addressSendOutcome([refused, delivered, unconfirmed])).toEqual({
      outcome: "delivered",
    });
  });

  test("none took it and one may have: unconfirmed", () => {
    expect(addressSendOutcome([refused, unconfirmed])).toEqual({ outcome: "unconfirmed" });
  });

  test("all failed: the reason they share, or the first in order", () => {
    expect(addressSendOutcome([noSocket, noSocket])).toEqual({
      outcome: "not_delivered",
      reason: "no_peer_socket",
    });
    expect(addressSendOutcome([noSocket, unreachable])).toEqual({
      outcome: "not_delivered",
      reason: "unreachable",
    });
    expect(addressSendOutcome([unreachable, refused])).toEqual({
      outcome: "not_delivered",
      reason: "refused",
    });
  });
});

describe("sendToAddress", () => {
  function deps(runs: SessionRun[], results: Map<number, InjectResult>) {
    const sent: { run: SessionRun; frame: InjectFrame }[] = [];
    const logs: string[] = [];
    let n = 0;
    const d: AddressSendDeps = {
      runs: async () => runs,
      realpath: realpathOrUndefined,
      issueMid: () => `${"0".repeat(32)}/${String(++n)}`,
      deliver: async (run, frame) => {
        sent.push({ run, frame });
        return results.get(run.pid) ?? { outcome: "delivered" };
      },
      log: (line) => logs.push(line),
    };
    return { d, sent, logs };
  }
  const runs: SessionRun[] = [
    { configDir: "/c", sid: B, pid: 20, cwd: "/w" },
    { configDir: "/c", sid: B, pid: 21, cwd: "/w" },
  ];

  test("each run gets its own mid, the envelope from ccmsg:<sender> with no reply line", async () => {
    const { d, sent, logs } = deps(runs, new Map());
    expect(await sendToAddress({ from: A, to: `ccmsg:${B}`, text: "hi\nthere" }, d)).toEqual({
      outcome: "delivered",
    });
    expect(sent.map((s) => s.frame.mid)).toEqual([`${"0".repeat(32)}/1`, `${"0".repeat(32)}/2`]);
    const first = sent[0];
    if (first === undefined) throw new Error("nothing sent");
    const { attrs, body } = parseEnvelope(first.frame.content);
    expect(attrs).toEqual({
      from: `ccmsg:${A}`,
      "from-name": `ccmsg:${A}`,
      "from-mode": "prompting",
      "ccmsg-mid": first.frame.mid,
      "ccmsg-from": A,
    });
    expect(body).toBe("hi\nthere");
    expect(parseDirectDeliveries(first.frame.content)).toEqual([
      { mid: first.frame.mid, from: A, fromLabel: `ccmsg:${A}`, text: "hi\nthere" },
    ]);
    expect(logs).toEqual([
      `peer-inject ${"0".repeat(32)}/1 -> ${B}.20 (ccmsg:${B}): delivered`,
      `peer-inject ${"0".repeat(32)}/2 -> ${B}.21 (ccmsg:${B}): delivered`,
    ]);
  });

  test("one run refusing while another takes it is delivered", async () => {
    const { d } = deps(runs, new Map([[20, { outcome: "refused" }]]));
    expect(await sendToAddress({ from: A, to: `ccmsg:${B}`, text: "hi" }, d)).toEqual({
      outcome: "delivered",
    });
  });

  test("every run failing is not delivered, with why", async () => {
    const { d, logs } = deps(
      runs,
      new Map<number, InjectResult>([
        [20, { outcome: "unavailable", cause: "unreachable" }],
        [21, { outcome: "unavailable", cause: "unreachable" }],
      ]),
    );
    expect(await sendToAddress({ from: A, to: `ccmsg:${B}`, text: "hi" }, d)).toEqual({
      outcome: "not_delivered",
      reason: "unreachable",
    });
    expect(logs[0]).toEndWith(": unavailable (unreachable)");
  });

  test("an address that does not read, the sender itself, or no run: nothing is sent", async () => {
    const { d, sent } = deps(runs, new Map());
    const reason = async (to: string) => sendToAddress({ from: A, to, text: "hi" }, d);
    for (const to of [B, `ccmsg:${B}.0`, "ccmsg:path:relative/dir", "ccmsg:user", `x:${B}`]) {
      expect({ to, sent: await reason(to) }).toEqual({
        to,
        sent: { outcome: "not_delivered", reason: "invalid_address" },
      });
    }
    expect(await reason(`ccmsg:${A}`)).toEqual({ outcome: "not_delivered", reason: "self" });
    expect(await reason(`ccmsg:${A}.20`)).toEqual({ outcome: "not_delivered", reason: "self" });
    expect(await reason(`ccmsg:${NOBODY}`)).toEqual({
      outcome: "not_delivered",
      reason: "no_recipient",
    });
    expect(sent).toEqual([]);
  });
});

describe("liveRuns", () => {
  test("the state files of running processes, across config dirs", async () => {
    const c1 = tempDir("as-cfg-");
    const c2 = tempDir("as-cfg-");
    const write = (dir: string, name: string, body: string) => {
      fs.mkdirSync(path.join(dir, "sessions"), { recursive: true });
      fs.writeFileSync(path.join(dir, "sessions", name), body);
    };
    write(c1, `${LIVE_PID}.json`, JSON.stringify({ pid: LIVE_PID, sessionId: A, cwd: "/w" }));
    write(c1, "424242.json", JSON.stringify({ pid: 424242, sessionId: B, cwd: "/w" }));
    write(c1, "77.json", "not json");
    write(c1, `${LIVE_PID}.abc.key`, JSON.stringify({ peerToken: "t" }));
    write(c2, `${OTHER_LIVE_PID}.json`, JSON.stringify({ pid: OTHER_LIVE_PID, sessionId: C }));
    const alive = (pid: number) => pid === LIVE_PID || pid === OTHER_LIVE_PID;
    expect(await liveRuns([c1, c2, path.join(c1, "missing")], alive)).toEqual([
      { configDir: c1, sid: A, pid: LIVE_PID, cwd: "/w" },
      { configDir: c2, sid: C, pid: OTHER_LIVE_PID },
    ]);
  });
});

describe("address_send through the daemon", () => {
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

  test(
    "ccmsg:<sid> reaches every run of the session; ccmsg:<sid>.<pid> the one",
    async () => {
      const ctx = await daemon();
      const b1 = harness(B, { pid: LIVE_PID });
      const b2 = harness(B, { pid: OTHER_LIVE_PID, configDir: b1.configDir });
      const a = await sessionWithConfig(ctx, A, b1.configDir);

      expect(await a.request({ op: "address_send", to: `ccmsg:${B}`, text: "to both" })).toEqual({
        ok: true,
        outcome: "delivered",
      });
      const [first, second] = await Promise.all([b1.nextUser(), b2.nextUser()]);
      expect(parseEnvelope(first.message.content)).toEqual({
        attrs: {
          from: `ccmsg:${A}`,
          "from-name": `ccmsg:${A}`,
          "from-mode": "prompting",
          "ccmsg-mid": first.msg_id,
          "ccmsg-from": A,
        },
        body: "to both",
      });
      expect(first.session_id).toBe(B);
      expect(second.msg_id).not.toBe(first.msg_id);

      expect(
        await a.request({
          op: "address_send",
          to: `ccmsg:${B}.${OTHER_LIVE_PID}`,
          text: "to one",
        }),
      ).toEqual({ ok: true, outcome: "delivered" });
      expect((await b2.nextUser()).message.content).toContain("\nto one\n");
      expect(b1.frames.filter((f) => f.type === "user")).toHaveLength(1);
    },
    T,
  );

  test(
    "ccmsg:path:<dir> reaches the other sessions working there, through a symlink too",
    async () => {
      const ctx = await daemon();
      const work = tempDir("as-work-");
      const link = path.join(tempDir("as-link-"), "ws");
      fs.symlinkSync(work, link);
      const ha = harness(A, { pid: LIVE_PID, cwd: work });
      const hb = harness(B, { pid: OTHER_LIVE_PID, cwd: work });
      const a = await sessionWithConfig(ctx, A, ha.configDir);
      await sessionWithConfig(ctx, B, hb.configDir);

      expect(
        await a.request({ op: "address_send", to: `ccmsg:path:${link}/`, text: "hello dir" }),
      ).toEqual({ ok: true, outcome: "delivered" });
      expect(parseEnvelope(await hb.nextContent()).body).toBe("hello dir");
      expect(ha.frames).toEqual([]);

      // Only the sender works in its own directory.
      const alone = tempDir("as-alone-");
      expect(
        await a.request({ op: "address_send", to: `ccmsg:path:${alone}`, text: "anyone?" }),
      ).toEqual({ ok: true, outcome: "not_delivered", reason: "no_recipient" });
    },
    T,
  );

  test(
    "a run refusing while another takes it is delivered; every run refusing is refused",
    async () => {
      const ctx = await daemon();
      const b1 = harness(B, { pid: LIVE_PID });
      const b2 = harness(B, { pid: OTHER_LIVE_PID, configDir: b1.configDir });
      b1.refuseWith = "denied";
      const a = await sessionWithConfig(ctx, A, b1.configDir);
      expect(await a.request({ op: "address_send", to: `ccmsg:${B}`, text: "hi" })).toEqual({
        ok: true,
        outcome: "delivered",
      });
      b2.refuseWith = "held";
      expect(await a.request({ op: "address_send", to: `ccmsg:${B}`, text: "hi" })).toEqual({
        ok: true,
        outcome: "not_delivered",
        reason: "refused",
      });
    },
    T,
  );

  // The recipient stopped reading: the write runs out of time part-way, so
  // the message may yet arrive whole and is not called not delivered.
  test(
    "a write that does not finish in time is unconfirmed",
    async () => {
      const ctx = await daemon();
      const hb = harness(B, { pid: LIVE_PID, stall: true });
      await hb.listening;
      const a = await sessionWithConfig(ctx, A, hb.configDir);
      expect(
        await a.request({
          op: "address_send",
          to: `ccmsg:${B}`,
          text: "x".repeat(4 * 1024 * 1024),
        }),
      ).toEqual({ ok: true, outcome: "unconfirmed" });
    },
    T,
  );

  test(
    "a run whose process has ended is not sent to",
    async () => {
      const ctx = await daemon();
      const hb = harness(B);
      const a = await sessionWithConfig(ctx, A, hb.configDir);
      expect(await a.request({ op: "address_send", to: `ccmsg:${B}`, text: "hi" })).toEqual({
        ok: true,
        outcome: "not_delivered",
        reason: "no_recipient",
      });
      expect(hb.frames).toEqual([]);
    },
    T,
  );

  test(
    "invalid_args for a person or an empty text; hello first",
    async () => {
      const ctx = await daemon();
      const a = await sessionWithConfig(ctx, A);
      const u = await connect(ctx.sock);
      await u.hello({ role: "user" });
      expect(
        (await u.requestError({ op: "address_send", to: `ccmsg:${B}`, text: "hi" })).error.code,
      ).toBe("invalid_args");
      expect(
        (await a.requestError({ op: "address_send", to: `ccmsg:${B}`, text: "" })).error.code,
      ).toBe("invalid_args");
      const raw = await connect(ctx.sock);
      expect(
        (await raw.requestError({ op: "address_send", to: `ccmsg:${B}`, text: "hi" })).error.code,
      ).toBe("hello_required");
    },
    T,
  );
});
