// A daemon a test run spawns lives no longer than that run (test-lifeline.ts,
// packages/testkit/src/lifeline.ts), and a run that leaves one running fails.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { fixtureDir, spawnDaemonProc, waitConnectable } from "./helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));
const LIFELINE_MODULE = fileURLToPath(new URL("../../testkit/src/lifeline.ts", import.meta.url));
const LEAKY_FIXTURE = fileURLToPath(new URL("./leaky-daemon.fixture.ts", import.meta.url));

/** bun and node:stream/web disagree on the reader type, so only the two
 * methods used are taken (as in the CLI's stream tests). */
interface LineReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  releaseLock(): void;
}

/** The first line `reader` gives that starts with `prefix`, without it. */
async function lineStarting(reader: LineReader, prefix: string): Promise<string> {
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    for (const line of buf.split("\n").slice(0, -1)) {
      if (line.startsWith(prefix)) {
        reader.releaseLock();
        return line.slice(prefix.length);
      }
    }
    const { value, done } = await reader.read();
    if (done) throw new Error(`stream ended before a line starting ${prefix}: ${buf}`);
    buf += decoder.decode(value, { stream: true });
  }
}

/** Resolves when the daemon behind `sock` is gone: it leaves its clients'
 * connections to the process exit. */
async function daemonGone(sock: string): Promise<void> {
  const { promise, resolve } = Promise.withResolvers<void>();
  await Bun.connect({
    unix: sock,
    socket: { data() {}, close: () => resolve(), error: () => resolve() },
  });
  return promise;
}

describe("test daemon lifeline", () => {
  test("a daemon shuts down when the process holding its lifeline is killed", async () => {
    const base = fixtureDir("lifeline");
    const line = path.join(base, "line.sock");
    const holder = Bun.spawn(
      [
        process.execPath,
        "-e",
        `const { openLifeline } = await import(${JSON.stringify(LIFELINE_MODULE)});
         openLifeline(${JSON.stringify(line)});
         console.log("ready");`,
      ],
      { stdout: "pipe", stderr: "inherit" },
    );
    const stateDir = path.join(base, "s");
    const dataDir = path.join(base, "d");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(dataDir);
    let daemon: Bun.Subprocess | undefined;
    try {
      await lineStarting(holder.stdout.getReader(), "ready");
      daemon = spawnDaemonProc(stateDir, dataDir, { CCMSG_TEST_LIFELINE: line });
      // Connectable means held: the daemon takes the line before it listens.
      await waitConnectable(path.join(stateDir, "daemon.sock"));

      // SIGKILL: nothing in the holder runs, only the kernel closes its end.
      holder.kill("SIGKILL");
      expect(await daemon.exited).toBe(0);
      expect(fs.readFileSync(path.join(stateDir, "daemon.log"), "utf8")).toContain(
        "graceful shutdown (test run ended)",
      );
    } finally {
      holder.kill("SIGKILL");
      daemon?.kill();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("a run that leaves a daemon running fails naming it, and the daemon goes with the run", async () => {
    const run = Bun.spawn([process.execPath, "test", LEAKY_FIXTURE], {
      cwd: REPO_ROOT,
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    });
    let sock: string | undefined;
    try {
      sock = await lineStarting(run.stdout.getReader(), "sock=");
      const gone = daemonGone(sock);
      // Let the fixture's test finish with its daemon still up.
      await run.stdin.end();
      const err = await new Response(run.stderr).text();
      expect(await run.exited).toBe(1);
      expect(err).toContain("1 process(es) were not stopped by the test that started them");
      expect(err).toContain(path.dirname(sock));
      await gone;
    } finally {
      run.kill();
      // The fixture's daemon dir: <base>/s/daemon.sock.
      if (sock) fs.rmSync(path.dirname(path.dirname(sock)), { recursive: true, force: true });
    }
  });
});
