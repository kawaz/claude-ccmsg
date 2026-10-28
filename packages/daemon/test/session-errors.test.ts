import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  startInProcessDaemon,
  stopInProcessDaemon,
  appendPushed,
  liveSessionConn,
  nameRun,
  pushRows,
  sessionConn,
  stampRows,
  userConn,
  fixtureDir,
} from "./helpers.ts";

import {
  assistantMessage,
  assistantRow,
  line,
  textBlock,
} from "../../protocol/test/transcript-rows.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const C = "cccccccc-0000-4000-8000-000000000003";
const START = "2026-07-14T16:27:55.672Z";
const END = "2026-07-14T16:28:55.672Z";

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

describe("session_errors daemon op / push", () => {
  test("module の run があるセッションが最終 turn のエラーで止まっていれば一覧に出る", async () => {
    // サイドバーは開いていないセッションも色分けする必要があるので、
    // session_status の購読 (= 開いている 1 件) とは別経路で、run のある全セッション分が要る。
    // run の無いセッションは fold を持たないので、止まっていても一覧に出ない。
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-errors");
    try {
      const stuck = path.join(dir, `${A}.jsonl`);
      const healthy = path.join(dir, `${B}.jsonl`);
      const unmoduled = path.join(dir, `${C}.jsonl`);
      fs.writeFileSync(stuck, assistantLine("working") + apiErrorLine("Prompt is too long"));
      fs.writeFileSync(healthy, apiErrorLine("API Error: 500") + assistantLine("recovered"));
      fs.writeFileSync(unmoduled, assistantLine("working") + apiErrorLine("Prompt is too long"));
      await liveSessionConn(ctx, A, { transcript_path: stuck });
      await liveSessionConn(ctx, B, { transcript_path: healthy });
      await sessionConn(ctx, C, { transcript_path: unmoduled });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });

      const res = await user.requestOk({ op: "session_errors" });
      expect(res.errors).toEqual([{ sid: A, text: "Prompt is too long", timestamp: START }]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("エラー発生と復帰がそれぞれ ev:session_errors を push する", async () => {
    // 状態変化はポーリングではなく module の push を合図に拾う (行が会話に入った瞬間に届く)。
    // 書かれただけで push されていない行は読まれない。
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-errors");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, assistantLine("hello"));
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);

      const error = stampRows(apiErrorLine("You're out of extra usage · resets 7pm (Asia/Tokyo)"));
      fs.appendFileSync(file, error.text);
      expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);
      await pushRows(session, error.uuids);
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

      await appendPushed(session, file, assistantLine("back"));
      const cleared = await user.readEventUntil(
        "session_errors",
        (event) => event.errors.length === 0,
      );
      expect(cleared.ev.errors).toEqual([]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("sidechain のエラーは親セッションを止まったことにしない", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-errors");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(
        file,
        assistantLine("spawning") + apiErrorLine("Prompt is too long", { isSidechain: true }),
      );
      await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("session role からは呼べない (webui 専用 op)", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-errors");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, assistantLine("hello"));
      const session = await sessionConn(ctx, A, { transcript_path: file });
      const res = await session.requestError({ op: "session_errors" });
      expect(res.error.code).toBe("bad_request");
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("module の run が去ったセッションはエラー一覧から消え、run が再び名乗れば戻る", async () => {
    // エラーは run のある間だけの fold の値。セッションの接続が残っていても、run が去れば
    // fold は捨てられて一覧から消える (ev:session_errors で知らせる)。次の run は
    // ファイルを頭から読み直すので、同じ停止がまた一覧に出る。
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-errors");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, apiErrorLine("Prompt is too long"));
      await sessionConn(ctx, A, { transcript_path: file });
      const run = await sessionConn(ctx, A, { transcript_path: file });
      await nameRun(ctx, run);
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      expect((await user.requestOk({ op: "session_errors" })).errors).toHaveLength(1);

      await run.end();
      const gone = await user.readEventUntil(
        "session_errors",
        (event) => event.errors.length === 0,
      );
      expect(gone.ev.errors).toEqual([]);
      expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);
      const peers = await user.requestOk({ op: "peers" });
      expect(peers.peers.map((p) => p.sid)).toEqual([A]);

      const next = await sessionConn(ctx, A, { transcript_path: file });
      await nameRun(ctx, next);
      expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([
        { sid: A, text: "Prompt is too long", timestamp: START },
      ]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

// The API error is read off the transcript for every session whose hooks
// module has a run, the one that sends facts included, and its kind is the
// row's `error` (DR-0039 §2): the module has no way to read the
// classification.
describe("session_errors of a session whose hooks module sends facts", () => {
  test("the transcript's error row is listed with its kind, and an answer clears it", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-errors");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, assistantLine("hello"));
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      await session.requestOk({ op: "session_facts", facts: { at: Date.now(), model: "m" } });
      expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);

      const text = "API Error: Request rejected (429) · retry later";
      await appendPushed(session, file, apiErrorLine(text, { error: "rate_limit" }));
      const raised = await user.readEventUntil(
        "session_errors",
        (event) => event.errors.length > 0,
      );
      expect(raised.ev.errors).toEqual([{ sid: A, text, timestamp: START, kind: "rate_limit" }]);

      await appendPushed(session, file, assistantLine("back"));
      await user.readEventUntil("session_errors", (event) => event.errors.length === 0);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an API error a module still sends with its facts is not listed", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-errors");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, assistantLine("hello"));
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      const at = Date.now();
      await session.requestOk({
        op: "session_facts",
        facts: { at, api_error: { kind: "rate_limit", text: "API Error: 429", at } },
      });
      expect((await user.requestOk({ op: "session_errors" })).errors).toEqual([]);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
