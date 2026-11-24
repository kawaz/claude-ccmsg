// session_search over the wire (DR-0021 §3.1, DR-0029): a search reads its
// window without holding back the connection's other requests, and a
// connection's next search stops the one it runs — except a lookup of one
// whole session id, which neither stops nor is stopped.
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, test } from "bun:test";
import { line, userContentRow } from "../../protocol/test/transcript-rows.ts";
import { connect, startTestDaemon, stopTestDaemon, type DaemonCtx } from "./helpers.ts";

const PROJECT = "-workspace-project";
const CWD = "/workspace/project";

function sid(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

/** The daemon's HOME is `<dataDir>/home` (testHomeEnv); its `.claude` dir is
 * one the daemon detects. */
function writeSession(ctx: DaemonCtx, id: string, texts: readonly string[]): void {
  const dir = path.join(ctx.dataDir, "home", ".claude", "projects", PROJECT);
  fs.mkdirSync(dir, { recursive: true });
  const rows = texts.map((text) =>
    line(userContentRow(text, { timestamp: "2026-11-24T00:00:00.000Z", cwd: CWD })),
  );
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), `${rows.join("\n")}\n`);
}

/** Sessions large enough that a search through them all is still reading
 * when the requests written right behind it arrive: 6 files of about 20MB. */
function writeLargeSessions(ctx: DaemonCtx): void {
  const filler = Array.from({ length: 20_000 }, () => "x".repeat(1000));
  for (let i = 1; i <= 6; i++) writeSession(ctx, sid(i), [...filler, `wireneedle ${i}`]);
}

async function withDaemon(fn: (ctx: DaemonCtx) => Promise<void>): Promise<void> {
  const ctx = await startTestDaemon();
  try {
    await fn(ctx);
  } finally {
    await stopTestDaemon(ctx);
  }
}

describe("session_search on the wire", () => {
  test("a long search holds back no other request on its connection", async () => {
    await withDaemon(async (ctx) => {
      writeLargeSessions(ctx);
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });

      // The search first, the ping right behind it on the same socket: the
      // ping is answered while the search still reads.
      c.write({
        op: "session_search",
        query: "wireneedle",
        timeout_ms: 15000,
        request_id: "search",
      });
      c.write({ op: "ping", request_id: "ping" });

      expect(await c.readEvent()).toMatchObject({ ok: true, pong: true, request_id: "ping" });
      expect(await c.readEvent()).toMatchObject({ ok: true, request_id: "search" });
      c.close();
    });
  });

  test("a connection's next search stops the one it runs", async () => {
    await withDaemon(async (ctx) => {
      writeLargeSessions(ctx);
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });

      const first = c.requestError({
        op: "session_search",
        query: "wireneedle",
        timeout_ms: 15000,
      });
      const second = c.requestOk({
        op: "session_search",
        query: "wireneedle 3",
        timeout_ms: 15000,
      });

      expect((await first).error.code).toBe("search_superseded");
      expect((await second).hits.map((hit) => hit.sid)).toEqual([sid(3)]);
      c.close();
    });
  });

  test("a lookup of one whole session id neither stops nor is stopped", async () => {
    await withDaemon(async (ctx) => {
      writeLargeSessions(ctx);
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });

      const panel = c.requestOk({ op: "session_search", query: "wireneedle", timeout_ms: 15000 });
      const lookup = c.requestOk({ op: "session_search", sid: sid(2), mtime_within: "36500d" });

      expect((await lookup).hits.map((hit) => hit.sid)).toEqual([sid(2)]);
      expect((await panel).hits).toHaveLength(6);
      c.close();
    });
  });

  test("searches on different connections do not stop each other", async () => {
    await withDaemon(async (ctx) => {
      writeLargeSessions(ctx);
      const a = await connect(ctx.sock);
      const b = await connect(ctx.sock);
      await a.hello({ role: "user" });
      await b.hello({ role: "user" });

      const fromA = a.requestOk({ op: "session_search", query: "wireneedle", timeout_ms: 15000 });
      const fromB = b.requestOk({ op: "session_search", query: "wireneedle", timeout_ms: 15000 });

      expect((await fromA).hits).toHaveLength(6);
      expect((await fromB).hits).toHaveLength(6);
      a.close();
      b.close();
    });
  });
});
