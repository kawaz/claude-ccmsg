import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { PeerInfo } from "@ccmsg/protocol";
import { classifyUserInputRow, isUserInputCandidate } from "../src/session-user-input.ts";
import {
  connect,
  startTestDaemon,
  stopTestDaemon,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 20_000;
const T1 = "2026-08-31T10:00:00.000Z";
const T2 = "2026-08-31T10:05:00.000Z";
const T3 = "2026-08-31T10:09:00.000Z";

function fixtureDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-session-user-input-"));
}

/** A prompt the human typed, shaped after a real CC 2.1.x transcript row:
 * `promptSource:"typed"` with `origin:{kind:"human"}`. */
function typedPromptLine(text: string, timestamp: string): string {
  return `${JSON.stringify({
    type: "user",
    isSidechain: false,
    userType: "external",
    promptSource: "typed",
    origin: { kind: "human" },
    timestamp,
    message: { role: "user", content: text },
  })}\n`;
}

/** A ccmsg room message delivered through the session's `ccmsg subscribe`
 * Monitor. Copied field-for-field from an observed delivery (transcript
 * `.../claude-rules-personal-main/704b44eb-….jsonl`, 2026-08-20): the harness
 * wraps it as a `task-notification` with `promptSource:"system"`, and the
 * event JSON sits inside the row's content string. */
function ccmsgDeliveryLine(from: string, msg: string, timestamp: string): string {
  const event = JSON.stringify({
    type: "msg",
    r: "r144",
    mid: 2,
    from,
    seq: 5,
    msg,
    reply_via: "Reply in your normal assistant response",
    ts: timestamp,
  });
  return `${JSON.stringify({
    type: "user",
    isSidechain: false,
    userType: "external",
    promptSource: "system",
    origin: { kind: "task-notification" },
    timestamp,
    message: {
      role: "user",
      content: `<task-notification>\n<task-id>b2l67o1na</task-id>\n<summary>Monitor event: "ccmsg 新着メッセージ"</summary>\n<event>${event}</event>\n</task-notification>`,
    },
  })}\n`;
}

/** The session's own `ccmsg read` result — quotes the same event JSON, but is
 * the agent pulling history rather than the user speaking. */
function ccmsgReadResultLine(from: string, timestamp: string): string {
  const event = JSON.stringify({ type: "msg", r: "r144", mid: 2, from, msg: "hi", ts: timestamp });
  return `${JSON.stringify({
    type: "user",
    isSidechain: false,
    timestamp,
    message: {
      role: "user",
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: event }],
    },
  })}\n`;
}

/** A teammate relay — another Claude session talking, not the user. */
function teammateRelayLine(timestamp: string): string {
  return `${JSON.stringify({
    type: "user",
    isSidechain: false,
    promptSource: "system",
    origin: { kind: "peer" },
    isMeta: true,
    timestamp,
    message: {
      role: "user",
      content:
        'Another Claude session sent a message:\n<teammate-message teammate_id="w1">done</teammate-message>',
    },
  })}\n`;
}

function assistantLine(timestamp: string): string {
  return `${JSON.stringify({
    type: "assistant",
    isSidechain: false,
    timestamp,
    message: {
      model: "claude-fable-5",
      role: "assistant",
      content: [{ type: "text", text: "ok" }],
    },
  })}\n`;
}

function row(line: string): Record<string, unknown> {
  return JSON.parse(line) as Record<string, unknown>;
}

async function sessionHello(ctx: DaemonCtx, sid: string, file: string): Promise<TestClient> {
  const client = await connect(ctx.sock);
  await client.request({
    op: "hello",
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

interface PeersOk {
  ok: true;
  peers: PeerInfo[];
}
interface PeersEvent {
  ev: "peers";
  peers: PeerInfo[];
}

function inputAt(peers: PeerInfo[], sid: string): string | undefined {
  return peers.find((p) => p.sid === sid)?.last_user_input_at;
}

describe("classifyUserInputRow", () => {
  // The two counted kinds (kawaz 2026-08-31: 通常のプロンプト + ccmsg の
  // from:"u1")。判定は wire field で行い、prefix カタログには依存しない。
  // kawaz r244m18: 引数付き slash command (/clear に次タスクの本文を渡した形)
  // はユーザが書いたテキストなので数える。素の command (args 空/無し) は数えない。
  test("引数付き slash command はユーザ入力", () => {
    const row = {
      type: "user",
      timestamp: "2026-09-01T03:02:23.224Z",
      message: {
        role: "user",
        content:
          "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>8月の勤怠表を出力してください。</command-args>",
      },
    };
    expect(classifyUserInputRow(row)).toBe("2026-09-01T03:02:23.224Z");
  });

  test("引数なし slash command は数えない", () => {
    for (const args of ["", "   "]) {
      const row = {
        type: "user",
        timestamp: "2026-09-01T03:02:23.224Z",
        message: {
          role: "user",
          content: `<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>${args}</command-args>`,
        },
      };
      expect(classifyUserInputRow(row)).toBeUndefined();
    }
  });

  test("引数に markup が入っていてもユーザ入力 (webui の表示判定と同じ規則)", () => {
    const row = {
      type: "user",
      timestamp: "2026-09-01T03:02:23.224Z",
      message: {
        role: "user",
        content:
          "<command-name>/clear</command-name>\n<command-args>直して: <div>a</div> の件</command-args>",
      },
    };
    expect(classifyUserInputRow(row)).toBe("2026-09-01T03:02:23.224Z");
  });

  test("typed prompt counts, crediting the row's own timestamp", () => {
    expect(classifyUserInputRow(row(typedPromptLine("やって", T1)))).toBe(T1);
  });

  test("a queued prompt counts too — origin.kind is the signal, not promptSource", () => {
    const queued = row(typedPromptLine("あとで", T1));
    queued.promptSource = "queued";
    expect(classifyUserInputRow(queued)).toBe(T1);
  });

  test("a pasted-image prompt counts: content shape is never consulted", () => {
    const pasted = row(typedPromptLine("これ見て", T1));
    (pasted.message as Record<string, unknown>).content = [
      { type: "text", text: "これ見て" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "iVBOR" } },
    ];
    expect(classifyUserInputRow(pasted)).toBe(T1);
  });

  test('a ccmsg delivery from:"u1" counts', () => {
    expect(classifyUserInputRow(row(ccmsgDeliveryLine("u1", "ソート順変えて", T2)))).toBe(T2);
  });

  test("a ccmsg delivery from another agent does not count", () => {
    expect(
      classifyUserInputRow(row(ccmsgDeliveryLine("a3", "実装できました", T2))),
    ).toBeUndefined();
  });

  // 同じ event JSON を含むが、これはエージェントが自分で読みに行った結果。
  // 新しい入力として二重計上してはいけない。
  test("a `ccmsg read` tool_result quoting a u1 event does not count", () => {
    expect(classifyUserInputRow(row(ccmsgReadResultLine("u1", T2)))).toBeUndefined();
  });

  test("a teammate relay does not count", () => {
    expect(classifyUserInputRow(row(teammateRelayLine(T2)))).toBeUndefined();
  });

  test("an assistant row does not count", () => {
    expect(classifyUserInputRow(row(assistantLine(T2)))).toBeUndefined();
  });

  // サブエージェント転写に届いた spawn prompt は「親が書いた指示書」であって
  // kawaz の発話ではない。
  test("a sidechain row does not count", () => {
    const sub = row(typedPromptLine("調べて", T1));
    sub.isSidechain = true;
    expect(classifyUserInputRow(sub)).toBeUndefined();
  });

  // origin/promptSource を持たない旧形式 (2026-01 頃まで) は答えを持たない。
  // 推測で拾うより「値なし」が正しい (= 一覧では末尾に落ちる)。
  test("a pre-origin transcript row yields nothing rather than a guess", () => {
    expect(
      classifyUserInputRow({
        type: "user",
        timestamp: T1,
        message: { role: "user", content: "やって" },
      }),
    ).toBeUndefined();
  });

  test("a row with no usable timestamp yields nothing", () => {
    const undated = row(typedPromptLine("やって", T1));
    delete undated.timestamp;
    expect(classifyUserInputRow(undated)).toBeUndefined();
  });
});

describe("isUserInputCandidate", () => {
  // プレフィルタは「取りこぼさない」ことだけが要件 (通し過ぎは classify が弾く)。
  test("admits both counted kinds", () => {
    expect(isUserInputCandidate(typedPromptLine("やって", T1))).toBe(true);
    expect(isUserInputCandidate(ccmsgDeliveryLine("u1", "hi", T2))).toBe(true);
  });

  test("rejects a plain assistant row", () => {
    expect(isUserInputCandidate(assistantLine(T2))).toBe(false);
  });
});

describe("last_user_input_at on peers", () => {
  test(
    "接続中セッションの transcript から最終ユーザ入力時刻が peers に載る",
    async () => {
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, "A.jsonl");
        // 最後の行はアシスタント発話 = ユーザ入力より後。ソートキーは
        // 「最後のユーザ入力」であって「最後の行」ではない。
        fs.writeFileSync(
          file,
          typedPromptLine("やって", T1) + assistantLine(T2) + assistantLine(T3),
        );
        await sessionHello(ctx, "A", file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });

        const res = await user.request<PeersOk>({ op: "peers" });
        expect(inputAt(res.peers, "A")).toBe(T1);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    'ccmsg の from:"u1" 着信もユーザ入力として時刻を進める',
    async () => {
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, "A.jsonl");
        fs.writeFileSync(file, typedPromptLine("やって", T1));
        await sessionHello(ctx, "A", file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect(inputAt((await user.request<PeersOk>({ op: "peers" })).peers, "A")).toBe(T1);

        // tail 駆動 (ポーリングではない): 届いた瞬間に ev:"peers" が飛ぶ。
        fs.appendFileSync(file, ccmsgDeliveryLine("u1", "ソート順変えて", T2));
        const pushed = await user.readEventUntil<PeersEvent>(
          (event) => event.ev === "peers" && inputAt(event.peers, "A") === T2,
        );
        expect(inputAt(pushed.ev.peers, "A")).toBe(T2);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "エージェントだけが喋り続けても時刻は動かない",
    async () => {
      // last_activity_at との違いの核心。走り続けているセッションが
      // 一覧の先頭に居座らないための性質。
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const file = path.join(dir, "A.jsonl");
        fs.writeFileSync(file, typedPromptLine("やって", T1));
        await sessionHello(ctx, "A", file);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });
        expect(inputAt((await user.request<PeersOk>({ op: "peers" })).peers, "A")).toBe(T1);

        fs.appendFileSync(
          file,
          assistantLine(T2) + teammateRelayLine(T2) + ccmsgDeliveryLine("a3", "できました", T3),
        );
        // 変化が無いことの確認なので、push を待つのではなく往復 1 回で確定させる。
        expect(inputAt((await user.request<PeersOk>({ op: "peers" })).peers, "A")).toBe(T1);
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "transcript が読めないセッションは値を持たない (0 ではなく無し)",
    async () => {
      const ctx = await startTestDaemon();
      const dir = fixtureDir();
      try {
        const withPrompt = path.join(dir, "A.jsonl");
        const empty = path.join(dir, "B.jsonl");
        fs.writeFileSync(withPrompt, typedPromptLine("やって", T1));
        fs.writeFileSync(empty, assistantLine(T2));
        await sessionHello(ctx, "A", withPrompt);
        await sessionHello(ctx, "B", empty);
        const user = await userHello(ctx);
        await user.request({ op: "subscribe" });

        const res = await user.request<PeersOk>({ op: "peers" });
        expect(inputAt(res.peers, "A")).toBe(T1);
        expect(inputAt(res.peers, "B")).toBeUndefined();
      } finally {
        await stopTestDaemon(ctx);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    T,
  );
});
