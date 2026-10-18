// What a daemon holds open is released by its shutdown, not by the process
// exit that follows it in a spawned daemon: a daemon hosted in a test process
// is shut down and the process goes on. A FileHandle left open is closed by GC
// later, which bun reports as an error in whatever test is running then.
import { expect, test } from "bun:test";
import * as fs from "node:fs";
import { shutdownDaemon } from "../src/server.ts";
import { startInProcessDaemon, stopInProcessDaemon, userConn } from "./helpers.ts";

/** The descriptors of this process open on `file` (same device and inode). */
function descriptorsOn(file: string): number[] {
  const target = fs.statSync(file);
  const listing = fs.existsSync("/proc/self/fd") ? "/proc/self/fd" : "/dev/fd";
  const open: number[] = [];
  for (const name of fs.readdirSync(listing)) {
    const fd = Number(name);
    try {
      const st = fs.fstatSync(fd);
      if (st.dev === target.dev && st.ino === target.ino) open.push(fd);
    } catch {
      // the descriptor the listing itself used, closed by now
    }
  }
  return open;
}

test("shutdown closes the daemon's trace.jsonl and daemon.log", async () => {
  const ctx = await startInProcessDaemon();
  try {
    const c = await userConn(ctx);
    await c.requestOk({
      op: "client_trace",
      sid: "S1",
      start: 0,
      end: 1,
      size: 1,
      sampled: true,
      elapsed_ms: 1,
      points: [{ ts: "2026-10-18T00:00:00.000Z", comp: "webui", edge: "in", kind: "ws_receive" }],
    });
    c.close();
    const { trace, log } = ctx.daemon.paths;
    expect(descriptorsOn(trace)).toHaveLength(1);
    expect(descriptorsOn(log)).toHaveLength(1);

    await shutdownDaemon(ctx.daemon, "test");

    expect(descriptorsOn(trace)).toEqual([]);
    expect(descriptorsOn(log)).toEqual([]);
  } finally {
    await stopInProcessDaemon(ctx);
  }
});
