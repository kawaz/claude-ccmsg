// Correlated replies (DR-0029 addendum): every request carries a request_id,
// every reply carries it back, and the daemon runs one connection's requests
// concurrently instead of through a FIFO. These tests pin the three properties
// that follow — the echo, the pairing when replies come back out of order, and
// the absence of head-of-line blocking behind a slow op.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

const T = 30000;

/** A transcript big enough that its cold `session_status` scan takes long
 * enough to observe — the op the measurements in
 * docs/findings/2026-09-02-session-status-same-connection-latency.md used. */
function writeLargeTranscript(file: string): void {
  const filler = `${JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "x".repeat(1000) }] },
  })}\n`;
  fs.writeFileSync(file, filler.repeat(40000));
}

async function withDaemon(fn: (ctx: DaemonCtx) => Promise<void>): Promise<void> {
  const ctx = await startTestDaemon();
  try {
    await fn(ctx);
  } finally {
    await stopTestDaemon(ctx);
  }
}

describe("request correlation", () => {
  test("every reply carries back the request_id of the request it answers", async () => {
    await withDaemon(async (ctx) => {
      const c = await connect(ctx.sock);
      c.write({ op: "hello", role: "user", protocol: PROTOCOL_VERSION, request_id: "h1" });
      expect(await c.readEvent()).toMatchObject({ ok: true, request_id: "h1" });

      c.write({ op: "ping", request_id: "p1" });
      expect(await c.readEvent()).toMatchObject({ ok: true, pong: true, request_id: "p1" });

      // Errors are correlated too, or a failing op would hang its caller.
      c.write({ op: "read", room: "r-nope", mids: "all", request_id: "e1" });
      expect(await c.readEvent()).toMatchObject({ ok: false, request_id: "e1" });
      c.close();
    });
  });

  test("a request with no request_id is refused as bad_request", async () => {
    await withDaemon(async (ctx) => {
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });
      const res = await c.requestRaw({ op: "ping" });
      expect(res).toMatchObject({
        ok: false,
        error: { code: "bad_request", msg: "op 'ping' requires a non-empty string request_id" },
      });
      // An empty string is no more usable as a key than an absent one.
      expect(await c.requestRaw({ op: "ping", request_id: "" })).toMatchObject({
        ok: false,
        error: { code: "bad_request" },
      });
      c.close();
    });
  });

  test(
    "a slow op does not hold back a later one on the same connection",
    async () => {
      await withDaemon(async (ctx) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-correlation-"));
        try {
          const file = path.join(dir, "A.jsonl");
          writeLargeTranscript(file);
          const session = await connect(ctx.sock);
          await session.request({
            op: "hello",
            protocol: PROTOCOL_VERSION,
            role: "session",
            sid: "A",
            repo: "r",
            ws: "w",
            cwd: "/tmp",
            transcript_path: file,
          });

          const c = await connect(ctx.sock);
          await c.hello({ role: "user" });
          // The cold scan first, the cheap op immediately behind it on the same
          // socket. Under the removed FIFO the ping could only be answered
          // after the scan finished.
          c.write({ op: "session_status", sid: "A", request_id: "slow" });
          c.write({ op: "ping", request_id: "fast" });

          const first = (await c.readEvent()) as Record<string, unknown>;
          const second = (await c.readEvent()) as Record<string, unknown>;
          expect(first).toMatchObject({ ok: true, pong: true, request_id: "fast" });
          expect(second).toMatchObject({ ok: true, sid: "A", request_id: "slow" });

          session.close();
          c.close();
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    },
    T,
  );

  test(
    "replies that come back out of order still settle their own caller",
    async () => {
      await withDaemon(async (ctx) => {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-correlation-"));
        try {
          const file = path.join(dir, "A.jsonl");
          writeLargeTranscript(file);
          const session = await connect(ctx.sock);
          await session.request({
            op: "hello",
            protocol: PROTOCOL_VERSION,
            role: "session",
            sid: "A",
            repo: "r",
            ws: "w",
            cwd: "/tmp",
            transcript_path: file,
          });

          const c = await connect(ctx.sock);
          await c.hello({ role: "user" });
          // Both in flight at once, the slow one sent first: each Promise gets
          // its own answer, not whichever reply happens to arrive first.
          const slow = c.request<{ ok: true; sid: string }>({ op: "session_status", sid: "A" });
          const fast = c.request<{ ok: true; pong: true }>({ op: "ping" });
          expect(await fast).toMatchObject({ ok: true, pong: true });
          expect(await slow).toMatchObject({ ok: true, sid: "A" });

          session.close();
          c.close();
        } finally {
          fs.rmSync(dir, { recursive: true, force: true });
        }
      });
    },
    T,
  );
});
