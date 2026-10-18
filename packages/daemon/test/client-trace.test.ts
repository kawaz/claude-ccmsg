// `client_trace`: ブラウザでしか測れない 3 境界 (ws_receive / store_dispatch /
// dom_commit) を daemon 側の trace.jsonl に合流させる受け口。daemon 側の行と同じ
// ファイルに (sid, start, end) で並ぶことが、この計器の全体像を成立させる条件。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  jsonObjectOf,
  sessionConn,
  userConn,
} from "./helpers.ts";
import { type JsonObject } from "@ccmsg/protocol";

const traceLines = (ctx: DaemonCtx): JsonObject[] => {
  const file = path.join(ctx.stateDir, "trace.jsonl");
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map(jsonObjectOf);
};

describe("client_trace", () => {
  test("user ロールの投稿が trace.jsonl に 1 point 1 行で並ぶ", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await userConn(ctx);
      const res = await c.requestOk({
        op: "client_trace",
        sid: "S1",
        start: 100,
        end: 200,
        size: 200,
        sampled: true,
        elapsed_ms: 42,
        points: [
          { ts: "2026-07-29T00:00:00.000Z", comp: "webui", edge: "in", kind: "ws_receive" },
          { ts: "2026-07-29T00:00:00.005Z", comp: "webui", edge: "in", kind: "store_dispatch" },
          { ts: "2026-07-29T00:00:00.042Z", comp: "webui", edge: "in", kind: "dom_commit" },
        ],
      });
      expect(res.ok).toBe(true);
      expect(res.written).toBe(3);

      const webui = traceLines(ctx).filter((l) => l.comp === "webui");
      expect(webui.map((l) => l.kind)).toEqual(["ws_receive", "store_dispatch", "dom_commit"]);
      // ブラウザで測った時刻がそのまま残る (到着時に打ち直すと遅延自体が消える)
      expect(webui[0]?.ts).toBe("2026-07-29T00:00:00.000Z");
      // 相関キーは全 point で共通 — daemon 側の行と突き合わせられる
      for (const line of webui) {
        expect([line.sid, line.start, line.end]).toEqual(["S1", 100, 200]);
        expect(line.elapsed_ms).toBe(42);
      }
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // tail 系の op と同じ user 限定。セッションはこの計器を投稿しない。
  test("session ロールは拒否される", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await sessionConn(ctx, "a9e47000-0000-4000-8000-000000000001", { cwd: "/tmp/x" });
      const res = await c.requestError({
        op: "client_trace",
        sid: "S1",
        start: 0,
        end: 1,
        size: 1,
        sampled: true,
        elapsed_ms: 1,
        points: [{ ts: "2026-07-29T00:00:00.000Z", comp: "webui", edge: "in", kind: "ws_receive" }],
      });
      expect(res.error).toEqual({
        code: "bad_request",
        msg: "op 'client_trace' requires user role",
      });
      expect(traceLines(ctx).filter((l) => l.comp === "webui")).toHaveLength(0);
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // 1 クライアントが trace.jsonl を無制限に伸ばせないよう、バッチは頭打ちにする。
  test("point 数は上限で切り詰められる", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await userConn(ctx);
      const res = await c.requestOk({
        op: "client_trace",
        sid: "S1",
        start: 0,
        end: 1,
        size: 1,
        sampled: true,
        elapsed_ms: 1,
        points: Array.from({ length: 50 }, () => ({
          ts: "2026-07-29T00:00:00.000Z",
          comp: "webui",
          edge: "in",
          kind: "ws_receive",
        })),
      });
      expect(res.written).toBe(8);
      expect(traceLines(ctx).filter((l) => l.comp === "webui")).toHaveLength(8);
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });
});
