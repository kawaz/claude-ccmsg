// End-to-end: a real daemon process, sessions stopped on an API error, and a
// network that comes back. The link is played through
// CCMSG_NETWORK_WATCH_FILE so the test drives actual transitions rather than
// the in-process seams (those are covered in network-watch.test.ts). The wake
// goes into a session's conversation (DR-0039 §9), so each session is a fake
// harness (peer-harness.ts) whose state file names a live pid.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
  userConn,
} from "./helpers.ts";
import { fakeHarness, type FakeHarness, parseEnvelope } from "./peer-harness.ts";
import { DIRECT_DELIVERY_DAEMON_SENDER, PROTOCOL_VERSION } from "@ccmsg/protocol";
import { WAKE_TEXT } from "../src/session-wake.ts";
import {
  assistantMessage,
  assistantRow,
  line,
  textBlock,
} from "../../protocol/test/transcript-rows.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const ERR_TS = "2026-08-12T03:00:00.000Z";

function apiErrorLine(text: string, timestamp = ERR_TS): string {
  return `${line(
    assistantRow({
      timestamp,
      message: assistantMessage({
        model: "<synthetic>",
        content: [textBlock(text)],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      }),
      isApiErrorMessage: true,
    }),
  )}\n`;
}

function assistantLine(text: string): string {
  return `${line(
    assistantRow({
      timestamp: "2026-08-12T03:01:00.000Z",
      message: assistantMessage({
        model: "claude-fable-5",
        content: [textBlock(text)],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      }),
    }),
  )}\n`;
}

const DEBOUNCE_MS = 20;
/** Barrier budget, well inside the test timeout so a stuck barrier reports
 * *which* condition never arrived instead of killing the whole test. */
const BARRIER_TIMEOUT_MS = 8_000;

interface Fixture {
  ctx: DaemonCtx;
  dir: string;
  linkFile: string;
  /** Close the fixture's own client (the daemon is stopped by the caller). */
  close(): void;
  /** Play a link state and return once the daemon has *observed* it.
   *
   * Waiting on the observation rather than on a fixed delay is what makes two
   * writes two transitions instead of one coalesced burst, and it is the only
   * form that holds on a loaded CI box. The daemon's own view is readable via
   * `ping`, so the test asks it. */
  setLink(state: "online" | "offline"): Promise<void>;
  /** Return once the daemon's api-error fold reports `sid` stopped at
   * `timestamp` — the input the wake reads, built asynchronously from the
   * transcript. */
  waitStall(sid: string, timestamp: string): Promise<void>;
}

async function startFixture(): Promise<Fixture> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-wake-"));
  const linkFile = path.join(dir, "link");
  // Start disconnected: a daemon that starts online has nothing to recover
  // from, and the first transition the test needs is the recovery itself.
  fs.writeFileSync(linkFile, "offline");
  const ctx = await startTestDaemon({
    CCMSG_NETWORK_WATCH: "on",
    CCMSG_NETWORK_WATCH_FILE: linkFile,
    CCMSG_NETWORK_WATCH_DEBOUNCE_MS: String(DEBOUNCE_MS),
  });
  const observer = await userConn(ctx);
  // The seam signals ctx.proc directly, so a daemon that lives in some other
  // process would silently never see a transition. Fail on that here instead.
  const hello = await observer.requestOk({ op: "ping" });
  expect(hello.pid).toBe(ctx.proc.pid);
  expect(hello.network).toBe("offline");
  return {
    ctx,
    dir,
    linkFile,
    close: () => observer.close(),
    setLink: async (state) => {
      fs.writeFileSync(linkFile, state);
      // SIGUSR2 is the seam's routing message; sending it after the write
      // means the probe cannot read a stale state. Signal the pid directly —
      // Bun's Subprocess.kill(signal) terminates the child instead of
      // delivering it (verified against this daemon).
      process.kill(ctx.proc.pid, "SIGUSR2");
      await waitFor(`daemon to observe the link as ${state}`, async () => {
        const pong = await observer.requestOk({ op: "ping" });
        return pong.network === state;
      });
    },
    waitStall: async (sid, timestamp) => {
      await waitFor(`${sid} to be reported stopped at ${timestamp}`, async () => {
        const res = await observer.requestOk({
          op: "session_errors",
        });
        return res.errors.some((e) => e.sid === sid && e.timestamp === timestamp);
      });
    },
  };
}

/** Wait for a condition the daemon reports over the wire, failing with what it
 * was waiting for rather than as a bare test timeout — a barrier that gives up
 * silently is what turned the first CI failure into a guessing game. */
async function waitFor(what: string, ready: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + BARRIER_TIMEOUT_MS;
  for (;;) {
    if (await ready()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(DEBOUNCE_MS);
  }
}

/** Say hello as `sid`, running in `harness`'s config dir with `transcript`,
 * and, with `module`, name a run of it as its sidecar does: the session then
 * has a hooks module. The connection stays open for the run to stay live. */
async function stalledSession(
  ctx: DaemonCtx,
  sid: string,
  harness: FakeHarness,
  transcript: string,
  module: boolean,
): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.requestOk({
    op: "hello",
    protocol: PROTOCOL_VERSION,
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
    transcript_path: transcript,
    config_dir: harness.configDir,
  });
  if (module) await nameRun(c);
  return c;
}

async function nameRun(c: TestClient): Promise<void> {
  await c.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
}

/** The wakes `harness` has been sent so far. */
function wakesIn(harness: FakeHarness): number {
  return harness.frames.filter((f) => f.type === "user").length;
}

describe("network online wake", () => {
  test("回線復帰で API エラー停止中のセッションだけが、その停止につき 1 回起こされる", async () => {
    const f = await startFixture();
    const stuck = path.join(f.dir, `${A}.jsonl`);
    const healthy = path.join(f.dir, `${B}.jsonl`);
    const unmoduled = path.join(f.dir, `${C}.jsonl`);
    fs.writeFileSync(stuck, assistantLine("working") + apiErrorLine("API Error: 503"));
    fs.writeFileSync(healthy, apiErrorLine("API Error: 500") + assistantLine("recovered"));
    fs.writeFileSync(unmoduled, assistantLine("working") + apiErrorLine("API Error: 503"));
    // A live pid each: the daemon reads one session per process.
    const third = Bun.spawn(["sleep", "60"]);
    const ha = fakeHarness(A, { pid: process.pid });
    const hb = fakeHarness(B, { pid: process.ppid });
    const hc = fakeHarness(C, { pid: third.pid });
    const conns: TestClient[] = [];
    try {
      conns.push(await stalledSession(f.ctx, A, ha, stuck, true));
      conns.push(await stalledSession(f.ctx, B, hb, healthy, true));
      const c = await stalledSession(f.ctx, C, hc, unmoduled, false);
      conns.push(c);

      // The wake reads the api-error fold, which is built asynchronously from
      // the transcript. Recovering before it lands would be a race the
      // feature loses silently, so wait until the daemon reports the stall.
      await f.waitStall(A, ERR_TS);
      await f.waitStall(C, ERR_TS);
      await f.setLink("online");

      const woken = await ha.nextUser();
      expect(woken.session_id).toBe(A);
      const { attrs, body } = parseEnvelope(woken.message.content);
      expect({ from: attrs.from, sender: attrs["ccmsg-from"], body }).toEqual({
        from: `ccmsg:${DIRECT_DELIVERY_DAEMON_SENDER}`,
        sender: DIRECT_DELIVERY_DAEMON_SENDER,
        body: WAKE_TEXT,
      });

      // C has no hooks module, so nothing reached it — and the stall is not
      // taken as woken: once C has a module, the next recovery wakes it, and
      // A's unchanged stall is not poked again.
      await nameRun(c);
      await f.setLink("offline");
      await f.setLink("online");
      expect(parseEnvelope(await hc.nextContent()).body).toBe(WAKE_TEXT);
      expect(wakesIn(hc)).toBe(1);

      // A new stall of A is woken again. Deliveries to one session go in
      // order, so a duplicate for the old stall would have to arrive before
      // this one.
      const NEW_TS = "2026-08-12T04:00:00.000Z";
      fs.appendFileSync(stuck, assistantLine("back") + apiErrorLine("API Error: 529", NEW_TS));
      await f.waitStall(A, NEW_TS);
      await f.setLink("offline");
      await f.setLink("online");
      expect(parseEnvelope(await ha.nextContent()).body).toBe(WAKE_TEXT);
      expect(wakesIn(ha)).toBe(2);

      // B never stopped, so the wake was never addressed to it — checked
      // after A's second wake, which comes after every recovery.
      expect(hb.frames).toEqual([]);
    } finally {
      f.close();
      for (const conn of conns) conn.close();
      await stopTestDaemon(f.ctx);
      for (const h of [ha, hb, hc]) h.dispose();
      third.kill();
      await third.exited;
      fs.rmSync(f.dir, { recursive: true, force: true });
    }
  });
});
