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
} from "./helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import {
  assistantMessage,
  assistantRow,
  line,
  textBlock,
} from "../../protocol/test/transcript-rows.ts";

const T = 20_000;
const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const START = "2026-07-14T16:27:55.672Z";
const END = "2026-07-14T16:28:55.672Z";

function fixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-session-errors-"));
}

/** Harness API-error row, shaped after a real CC 2.1.x transcript line.
 * `error` is the row's classification, which some rows do not carry. */
function apiErrorLine(
  text: string,
  opts: { timestamp?: string; isSidechain?: boolean; error?: string } = {},
): string {
  return `${line(
    assistantRow({
      isSidechain: opts.isSidechain ?? false,
      timestamp: opts.timestamp ?? START,
      ...(opts.error !== undefined ? { error: opts.error } : {}),
      message: assistantMessage({
        model: "<synthetic>",
        content: [textBlock(text)],
        usage: { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0 },
      }),
      isApiErrorMessage: true,
    }),
  )}\n`;
}

/** A real (model-generated) assistant turn — the thing that clears an error. */
function assistantLine(text: string): string {
  return `${line(
    assistantRow({
      timestamp: END,
      message: assistantMessage({
        model: "claude-fable-5",
        content: [textBlock(text)],
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 100 },
      }),
    }),
  )}\n`;
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

describe("session_errors daemon op / push", () => {
  test(
    "接続中セッションが最終 turn のエラーで止まっていれば一覧に出る",
    async () => {
      // サイドバーは開いていないセッションも色分けする必要があるので、
      // session_status の購読 (= 開いている 1 件) とは別経路で全 peer 分が要る。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const stuck = path.join(dir, `${A}.jsonl`);
        const healthy = path.join(dir, `${B}.jsonl`);
        fs.writeFileSync(stuck, assistantLine("working") + apiErrorLine("Prompt is too long"));
        fs.writeFileSync(healthy, apiErrorLine("API Error: 500") + assistantLine("recovered"));
        await sessionHello(ctx, A, stuck);
        await sessionHello(ctx, B, healthy);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });

        const res = await user.requestOk({ op: "session_errors" });
        expect(res.errors).toEqual([{ sid: A, text: "Prompt is too long", timestamp: START }]);
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
        const file = path.join(dir, `${A}.jsonl`);
        fs.writeFileSync(file, assistantLine("hello"));
        await sessionHello(ctx, A, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);

        fs.appendFileSync(
          file,
          apiErrorLine("You're out of extra usage · resets 7pm (Asia/Tokyo)"),
        );
        const raised = await user.readEventUntil(
          "session_errors",
          (event) => event.errors.length > 0,
        );
        expect(raised.ev.errors).toEqual([
          {
            sid: A,
            text: "You're out of extra usage · resets 7pm (Asia/Tokyo)",
            timestamp: START,
          },
        ]);

        fs.appendFileSync(file, assistantLine("back"));
        const cleared = await user.readEventUntil(
          "session_errors",
          (event) => event.errors.length === 0,
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
        const file = path.join(dir, `${A}.jsonl`);
        fs.writeFileSync(
          file,
          assistantLine("spawning") + apiErrorLine("Prompt is too long", { isSidechain: true }),
        );
        await sessionHello(ctx, A, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);
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
        const file = path.join(dir, `${A}.jsonl`);
        fs.writeFileSync(file, assistantLine("hello"));
        const session = await sessionHello(ctx, A, file);
        const res = await session.requestError({ op: "session_errors" });
        expect(res.error.code).toBe("bad_request");
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "接続が切れたセッションもエラー一覧に残る",
    async () => {
      // 接続の有無はセッションの生存を意味しないので、切断後もエラー行を出し続ける。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, `${A}.jsonl`);
        fs.writeFileSync(file, apiErrorLine("Prompt is too long"));
        const session = await sessionHello(ctx, A, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect((await user.requestOk({ op: "session_errors" })).errors).toHaveLength(1);

        session.close();
        await new Promise((r) => setTimeout(r, 50));
        expect((await user.requestOk({ op: "session_errors" })).errors).toHaveLength(1);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});

// The API error is read off the transcript for every session, the one whose
// hooks module sends facts included, and its kind is the row's `error`
// (DR-0039 §2): the module has no way to read the classification.
describe("session_errors of a session whose hooks module sends facts", () => {
  test(
    "the transcript's error row is listed with its kind, and an answer clears it",
    async () => {
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, `${A}.jsonl`);
        fs.writeFileSync(file, assistantLine("hello"));
        const session = await sessionHello(ctx, A, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        await session.requestOk({ op: "session_facts", facts: { at: Date.now(), model: "m" } });
        expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);

        const text = "API Error: Request rejected (429) · retry later";
        fs.appendFileSync(file, apiErrorLine(text, { error: "rate_limit" }));
        const raised = await user.readEventUntil(
          "session_errors",
          (event) => event.errors.length > 0,
        );
        expect(raised.ev.errors).toEqual([{ sid: A, text, timestamp: START, kind: "rate_limit" }]);

        fs.appendFileSync(file, assistantLine("back"));
        await user.readEventUntil("session_errors", (event) => event.errors.length === 0);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "an API error a module still sends with its facts is not listed",
    async () => {
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, `${A}.jsonl`);
        fs.writeFileSync(file, assistantLine("hello"));
        const session = await sessionHello(ctx, A, file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        const at = Date.now();
        await session.requestOk({
          op: "session_facts",
          facts: { at, api_error: { kind: "rate_limit", text: "API Error: 429", at } },
        });
        expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});
