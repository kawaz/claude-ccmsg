// End-to-end: a real daemon process, a session stopped on an API error, and a
// network that comes back. The link is played through
// CCMSG_NETWORK_WATCH_FILE so the test drives actual transitions rather than
// the in-process seams (those are covered in network-watch.test.ts).
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";

const T = 20_000;
const ERR_TS = "2026-08-12T03:00:00.000Z";

function apiErrorLine(text: string, timestamp = ERR_TS): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp,
    message: {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    },
    isApiErrorMessage: true,
  })}\n`;
}

function assistantLine(text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: "2026-08-12T03:01:00.000Z",
    message: {
      model: "claude-fable-5",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    },
  })}\n`;
}

const DEBOUNCE_MS = 20;

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
   * form that holds on a loaded CI box: how long a filesystem watcher takes to
   * deliver a change is not something a test can assume (fs.watch on macOS
   * coalesces through FSEvents). The daemon's own view is readable via `ping`,
   * so the test asks it. */
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
  const observer = await connect(ctx.sock);
  await observer.hello({ role: "user" });
  return {
    ctx,
    dir,
    linkFile,
    close: () => observer.close(),
    setLink: async (state) => {
      fs.writeFileSync(linkFile, state);
      for (;;) {
        const pong = await observer.request<{ network: string }>({ op: "ping" });
        if (pong.network === state) return;
        // The watcher has not delivered the change yet. The bun test timeout
        // is the bound; a watcher that never delivers fails the test rather
        // than being papered over by a longer sleep.
        await Bun.sleep(DEBOUNCE_MS);
      }
    },
    waitStall: async (sid, timestamp) => {
      for (;;) {
        const res = await observer.request<{ errors: { sid: string; timestamp: string }[] }>({
          op: "session_errors",
        });
        if (res.errors.some((e) => e.sid === sid && e.timestamp === timestamp)) return;
        await Bun.sleep(DEBOUNCE_MS);
      }
    },
  };
}

describe("network online wake", () => {
  test(
    "回線復帰で API エラー停止中のセッションだけが 1 回起こされる",
    async () => {
      const f = await startFixture();
      const stuck = path.join(f.dir, "A.jsonl");
      const healthy = path.join(f.dir, "B.jsonl");
      fs.writeFileSync(stuck, assistantLine("working") + apiErrorLine("API Error: 503"));
      fs.writeFileSync(healthy, apiErrorLine("API Error: 500") + assistantLine("recovered"));
      const a = await connect(f.ctx.sock);
      const b = await connect(f.ctx.sock);
      try {
        await a.request({
          op: "hello",
          role: "session",
          sid: "A",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          transcript_path: stuck,
        });
        await b.request({
          op: "hello",
          role: "session",
          sid: "B",
          repo: "r",
          ws: "w",
          cwd: "/tmp",
          transcript_path: healthy,
        });
        await a.request({ op: "subscribe" });
        await b.request({ op: "subscribe" });

        // The wake reads the api-error fold, which is built asynchronously from
        // the transcript. Recovering before it lands would be a race the
        // feature loses silently, so wait until the daemon reports the stall.
        await f.waitStall("A", ERR_TS);
        await f.setLink("online");

        const woken = await a.readEventUntil<{ ev: string; text: string; error_ts: string }>(
          (ev) => ev.ev === "net_online",
        );
        expect(woken.ev.error_ts).toBe(ERR_TS);
        expect(woken.ev.text).toContain("API error");

        // A second recovery must not re-poke the same stall. Rather than
        // waiting on the absence of an event, drive a cycle that produces
        // nothing, then a *new* stall whose wake is observable: any duplicate
        // for the old stall would have to arrive before it.
        await f.setLink("offline");
        await f.setLink("online");
        const NEW_TS = "2026-08-12T04:00:00.000Z";
        fs.appendFileSync(stuck, assistantLine("back") + apiErrorLine("API Error: 529", NEW_TS));
        await f.waitStall("A", NEW_TS);
        await f.setLink("offline");
        await f.setLink("online");
        const second = await a.readEventUntil<{ ev: string; error_ts: string }>(
          (ev) => ev.ev === "net_online" && ev.error_ts === NEW_TS,
        );
        expect(second.seen.filter((ev) => ev.ev === "net_online")).toHaveLength(1);

        // B never stopped, so the wake was never addressed to it — checked
        // after A's second wake, which orders B's stream past both recoveries.
        await b.request({ op: "ping" });
        expect(await b.pendingEvents()).toEqual([]);
      } finally {
        f.close();
        a.close();
        b.close();
        await stopTestDaemon(f.ctx);
        fs.rmSync(f.dir, { recursive: true, force: true });
      }
    },
    T,
  );
});
