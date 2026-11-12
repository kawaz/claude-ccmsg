// The daemon tells its HTTP fallback (the webui) to prepare once an HTTP
// listener is up (DR-0005 §3), and a daemon that listens for no HTTP never
// does: the webui's build and compression take the process's pool of threads
// for a second or more on a machine with few cores, and every async file read
// the daemon makes (a hello's location, a send's state files) waits for them.
// The spawned daemon is the real one (run.ts wires the webui in), so what is
// seen here is its log line, read once the daemon has answered a request
// (daemonLogAfterStart): a connect to its socket succeeds before its start has
// come to the HTTP listeners, so a read right after it can miss both lines.
import { afterEach, describe, expect, test } from "bun:test";
import { daemonLogAfterStart, type DaemonCtx, startTestDaemon, stopTestDaemon } from "./helpers.ts";

const PREPARING = "http: the fallback is preparing for its first request";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

async function daemon(env: Record<string, string> = {}): Promise<DaemonCtx> {
  const ctx = await startTestDaemon(env);
  cleanups.push(() => stopTestDaemon(ctx));
  return ctx;
}

describe("the HTTP fallback's prepare", () => {
  test("a daemon with no HTTP listener does not prepare it", async () => {
    const log = await daemonLogAfterStart(await daemon());
    expect(log).toContain("op http listening on ");
    expect(log).not.toContain(PREPARING);
  });

  test("a daemon that listens for HTTP prepares it once, after the listener is up", async () => {
    const ctx = await daemon({ CCMSG_HTTP_BIND: "127.0.0.1:0" });
    // Counted past the start's stretch that prepares it, so a second prepare
    // there is in the count too.
    const lines = (await daemonLogAfterStart(ctx)).split("\n");
    const listening = lines.findIndex((l) => l.includes("] http listening on 127.0.0.1:"));
    const preparing = lines.findIndex((l) => l.includes(PREPARING));
    expect(listening).toBeGreaterThanOrEqual(0);
    expect(preparing).toBeGreaterThan(listening);
    expect(lines.filter((l) => l.includes(PREPARING))).toHaveLength(1);
  });
});
