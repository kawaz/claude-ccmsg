import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { SessionErrorEntry } from "@ccmsg/protocol";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";

const T = 20_000;
const START = "2026-07-14T16:27:55.672Z";
const END = "2026-07-14T16:28:55.672Z";

function fixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-session-errors-"));
}

/** Harness API-error row, shaped after a real CC 2.1.x transcript line. */
function apiErrorLine(
  text: string,
  opts: { timestamp?: string; isSidechain?: boolean } = {},
): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: opts.isSidechain ?? false,
    timestamp: opts.timestamp ?? START,
    message: {
      model: "<synthetic>",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
    },
    isApiErrorMessage: true,
  })}\n`;
}

/** A real (model-generated) assistant turn — the thing that clears an error. */
function assistantLine(text: string): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp: END,
    message: {
      model: "claude-fable-5",
      role: "assistant",
      content: [{ type: "text", text }],
      usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
    },
  })}\n`;
}

async function sessionHello(ctx: DaemonCtx, sid: string, file: string): Promise<TestClient> {
  const client = await connect(ctx.sock);
  await client.request({
    op: "hello",
    protocol: PROTOCOL_VERSION,
    role: "session",
    sid,
    repo: "r",
    ws: "w",
    cwd: "/tmp",
    transcript_path: file,
  });
  return client;
}

async function userHello(ctx: DaemonCtx): Promise<TestClient> {
  const client = await connect(ctx.sock);
  await client.hello({ role: "user" });
  return client;
}

interface ErrorsOk {
  ok: true;
  errors: SessionErrorEntry[];
}
interface ErrorsEvent {
  ev: "session_errors";
  errors: SessionErrorEntry[];
}
interface ErrorLite {
  error: { code: string };
}

describe("session_errors daemon op / push", () => {
  test(
    "接続中セッションが最終 turn のエラーで止まっていれば一覧に出る",
    async () => {
      // サイドバーは開いていないセッションも色分けする必要があるので、
      // session_status の購読 (= 開いている 1 件) とは別経路で全 peer 分が要る。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const stuck = path.join(dir, "A.jsonl");
        const healthy = path.join(dir, "B.jsonl");
        fs.writeFileSync(stuck, assistantLine("working") + apiErrorLine("Prompt is too long"));
        fs.writeFileSync(healthy, apiErrorLine("API Error: 500") + assistantLine("recovered"));
        await sessionHello(ctx, "A", stuck);
        await sessionHello(ctx, "B", healthy);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });

        const res = await user.request<ErrorsOk>({ op: "session_errors" });
        expect(res.errors).toEqual([{ sid: "A", text: "Prompt is too long", timestamp: START }]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "エラー発生と復帰がそれぞれ ev:session_errors を push する",
    async () => {
      // 状態変化はポーリングではなく transcript tail で拾う (発生した瞬間に届く)。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, "A.jsonl");
        fs.writeFileSync(file, assistantLine("hello"));
        await sessionHello(ctx, "A", file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect((await user.request<ErrorsOk>({ op: "session_errors" })).errors).toEqual([]);

        fs.appendFileSync(
          file,
          apiErrorLine("You're out of extra usage · resets 7pm (Asia/Tokyo)"),
        );
        const raised = await user.readEventUntil<ErrorsEvent>(
          (event) => event.ev === "session_errors" && event.errors.length > 0,
        );
        expect(raised.ev.errors).toEqual([
          {
            sid: "A",
            text: "You're out of extra usage · resets 7pm (Asia/Tokyo)",
            timestamp: START,
          },
        ]);

        fs.appendFileSync(file, assistantLine("back"));
        const cleared = await user.readEventUntil<ErrorsEvent>(
          (event) => event.ev === "session_errors" && event.errors.length === 0,
        );
        expect(cleared.ev.errors).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "sidechain のエラーは親セッションを止まったことにしない",
    async () => {
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, "A.jsonl");
        fs.writeFileSync(
          file,
          assistantLine("spawning") + apiErrorLine("Prompt is too long", { isSidechain: true }),
        );
        await sessionHello(ctx, "A", file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect((await user.request<ErrorsOk>({ op: "session_errors" })).errors).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "session role からは呼べない (webui 専用 op)",
    async () => {
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, "A.jsonl");
        fs.writeFileSync(file, assistantLine("hello"));
        const session = await sessionHello(ctx, "A", file);
        const res = await session.request<ErrorLite>({ op: "session_errors" });
        expect(res.error.code).toBe("bad_request");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "切断したセッションは一覧から消える",
    async () => {
      // peers が減っただけで transcript イベントは起きないので、購読解除の側でも
      // 変化を push しないとサイドバーに幽霊のエラー行が残る。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, "A.jsonl");
        fs.writeFileSync(file, apiErrorLine("Prompt is too long"));
        const session = await sessionHello(ctx, "A", file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect((await user.request<ErrorsOk>({ op: "session_errors" })).errors).toHaveLength(1);

        session.close();
        const gone = await user.readEventUntil<ErrorsEvent>(
          (event) => event.ev === "session_errors" && event.errors.length === 0,
        );
        expect(gone.ev.errors).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});
