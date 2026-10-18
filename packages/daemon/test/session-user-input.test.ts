import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  parseWith,
  TranscriptRowLineSchema,
  type JsonObject,
  type PeerInfo,
  type TranscriptRow,
} from "@ccmsg/protocol";
import { classifyUserInputRow, isUserInputCandidate } from "../src/session-user-input.ts";
import {
  assistantContentRow,
  attachmentRow,
  imageBlock,
  line,
  queueOperationRow,
  textBlock,
  toolResultBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import {
  startInProcessDaemon,
  stopInProcessDaemon,
  sessionConn,
  userConn,
  fixtureDir,
} from "./helpers.ts";

const A = "aaaaaaaa-0000-4000-8000-000000000001";
const B = "bbbbbbbb-0000-4000-8000-000000000002";
const T1 = "2026-08-31T10:00:00.000Z";
const T2 = "2026-08-31T10:05:00.000Z";
const T3 = "2026-08-31T10:09:00.000Z";

/** A prompt the human typed, shaped after a real CC 2.1.x transcript row:
 * `promptSource:"typed"` with `origin:{kind:"human"}`. */
function typedPromptRow(text: string, timestamp: string, fields: JsonObject = {}): JsonObject {
  return userContentRow(text, {
    promptSource: "typed",
    origin: { kind: "human" },
    timestamp,
    ...fields,
  });
}

function typedPromptLine(text: string, timestamp: string): string {
  return `${line(typedPromptRow(text, timestamp))}\n`;
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
  return `${line(
    userContentRow(
      `<task-notification>\n<task-id>b2l67o1na</task-id>\n<summary>Monitor event: "ccmsg 新着メッセージ"</summary>\n<event>${event}</event>\n</task-notification>`,
      { promptSource: "system", origin: { kind: "task-notification" }, timestamp },
    ),
  )}\n`;
}

/** The session's own `ccmsg read` result — quotes the same event JSON, but is
 * the agent pulling history rather than the user speaking. */
function ccmsgReadResultLine(from: string, timestamp: string): string {
  const event = JSON.stringify({ type: "msg", r: "r144", mid: 2, from, msg: "hi", ts: timestamp });
  return `${line(
    userContentRow([toolResultBlock(event, { tool_use_id: "toolu_1" })], { timestamp }),
  )}\n`;
}

/** A teammate relay — another Claude session talking, not the user. */
function teammateRelayLine(timestamp: string): string {
  return `${line(
    userContentRow(
      'Another Claude session sent a message:\n<teammate-message teammate_id="w1">done</teammate-message>',
      { promptSource: "system", origin: { kind: "peer" }, isMeta: true, timestamp },
    ),
  )}\n`;
}

function assistantLine(timestamp: string): string {
  return `${line(assistantContentRow([textBlock("ok")], { timestamp }))}\n`;
}

/** A transcript line read as its row, as the fold reads it. */
function row(text: string): TranscriptRow {
  const read = parseWith(TranscriptRowLineSchema, text);
  if (!read.ok) throw new Error(read.failure.summary);
  return read.value;
}

/** A row built from its fields, read as the fold reads it. */
function rowOf(fields: JsonObject): TranscriptRow {
  return row(line(fields));
}

function inputAt(peers: readonly PeerInfo[], sid: string): string | undefined {
  return peers.find((p) => p.sid === sid)?.last_user_input_at;
}

describe("classifyUserInputRow", () => {
  // The two counted kinds (kawaz 2026-08-31: 通常のプロンプト + ccmsg の
  // from:"u1")。判定は wire field で行い、prefix カタログには依存しない。
  // 引数付き slash command (/clear に次タスクの本文を渡した形)
  // はユーザが書いたテキストなので数える。素の command (args 空/無し) は数えない。
  test("引数付き slash command はユーザ入力", () => {
    const command = userContentRow(
      "<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>8月の勤怠表を出力してください。</command-args>",
      { timestamp: "2026-09-01T03:02:23.224Z" },
    );
    expect(classifyUserInputRow(rowOf(command))).toBe("2026-09-01T03:02:23.224Z");
  });

  test("引数なし slash command は数えない", () => {
    for (const args of ["", "   "]) {
      const command = userContentRow(
        `<command-name>/clear</command-name>\n<command-message>clear</command-message>\n<command-args>${args}</command-args>`,
        { timestamp: "2026-09-01T03:02:23.224Z" },
      );
      expect(classifyUserInputRow(rowOf(command))).toBeUndefined();
    }
  });

  test("引数に markup が入っていてもユーザ入力 (webui の表示判定と同じ規則)", () => {
    const command = userContentRow(
      "<command-name>/clear</command-name>\n<command-args>直して: <div>a</div> の件</command-args>",
      { timestamp: "2026-09-01T03:02:23.224Z" },
    );
    expect(classifyUserInputRow(rowOf(command))).toBe("2026-09-01T03:02:23.224Z");
  });

  test("typed prompt counts, crediting the row's own timestamp", () => {
    expect(classifyUserInputRow(row(typedPromptLine("やって", T1)))).toBe(T1);
  });

  test("a queued prompt counts too — origin.kind is the signal, not promptSource", () => {
    const queued = rowOf(typedPromptRow("あとで", T1, { promptSource: "queued" }));
    expect(classifyUserInputRow(queued)).toBe(T1);
  });

  test("a pasted-image prompt counts: content shape is never consulted", () => {
    const pasted = rowOf(
      typedPromptRow("これ見て", T1, {
        message: { role: "user", content: [textBlock("これ見て"), imageBlock()] },
      }),
    );
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
    const sub = rowOf(typedPromptRow("調べて", T1, { isSidechain: true }));
    expect(classifyUserInputRow(sub)).toBeUndefined();
  });

  // origin/promptSource を持たない旧形式 (2026-01 頃まで) は答えを持たない。
  // 推測で拾うより「値なし」が正しい (= 一覧では末尾に落ちる)。
  test("a pre-origin transcript row yields nothing rather than a guess", () => {
    expect(
      classifyUserInputRow(rowOf(userContentRow("やって", { timestamp: T1 }))),
    ).toBeUndefined();
  });

  test("a row with no usable timestamp yields nothing", () => {
    const undated = rowOf(typedPromptRow("やって", ""));
    expect(classifyUserInputRow(undated)).toBeUndefined();
  });
});

// Standalone-ccmsg envelope rows, copied from a real transcript (Claude Code
// 2.1.282, 2026-09-26; path-bearing fields dropped).
const DIRECT_MID = "bfa02646e898a279fa4fea0065b06797/1";
function directEnvelope(from: string): string {
  const to = from === "user" ? "" : ` --to ${from}`;
  return `<cross-session-message from="ccmsg" from-name="${from}" from-mode="prompting" ccmsg-mid="${DIRECT_MID}" ccmsg-from="${from}">\nv2でのユーザメッセージはこんな感じで届きます。\n\nReply with: ccmsg reply ${DIRECT_MID}${to} <text>\n</cross-session-message>`;
}
function directDeliveryLine(from: string, timestamp: string): string {
  return line(
    userContentRow(
      `Another Claude session sent a message:\n${directEnvelope(from)}\n\nThis came from another Claude session — not typed by your user.`,
      {
        isMeta: true,
        promptSource: "system",
        turnOrigin: "peer",
        origin: { kind: "peer" },
        timestamp,
      },
    ),
  );
}

describe("standalone ccmsg envelopes", () => {
  test("a person's envelope is user input", () => {
    const delivery = directDeliveryLine("user", T2);
    expect(isUserInputCandidate(delivery)).toBe(true);
    expect(classifyUserInputRow(row(delivery))).toBe(T2);
  });

  test("a session's envelope is not", () => {
    const delivery = directDeliveryLine("11111111-2222-4333-8444-555555555555", T2);
    expect(classifyUserInputRow(row(delivery))).toBeUndefined();
  });

  test("the queue-operation copy is not counted", () => {
    const copy = queueOperationRow({ timestamp: T2, content: directEnvelope("user") });
    expect(classifyUserInputRow(rowOf(copy))).toBeUndefined();
  });
});

// Real row (Claude Code, 2026-09-28): a standalone-ccmsg message that arrived
// while the session was mid-turn, reduced to the fields read here.
const QUEUED_PROMPT =
  '<cross-session-message from="ccmsg" from-name="user" from-mode="prompting" ccmsg-mid="r349m12" ccmsg-from="user">\n両方publishしたよ。\noidcでリリースするやつはworkflowファイル名を設定する必要があったと思うが同じでOK？\n\nReply in your normal assistant response.\n</cross-session-message>';
const queuedAttachmentRow = line(
  attachmentRow(
    {
      type: "queued_command",
      prompt: QUEUED_PROMPT,
      commandMode: "prompt",
      origin: { kind: "peer" },
      isMeta: true,
    },
    {
      timestamp: "2026-09-28T06:44:03.962Z",
      rendered: [
        {
          content: `<system-reminder>\nAnother Claude session sent a message while you were working:\n${QUEUED_PROMPT}\n\nThis came from another Claude session.\n</system-reminder>`,
        },
      ],
    },
  ),
);
const queuedEnqueueRow = line(
  queueOperationRow({ timestamp: "2026-09-28T06:44:03.962Z", content: QUEUED_PROMPT }),
);

describe("standalone ccmsg delivered mid-turn", () => {
  test("a person's queued_command attachment is user input; its enqueue copy is not", () => {
    expect(isUserInputCandidate(queuedAttachmentRow)).toBe(true);
    expect(classifyUserInputRow(row(queuedAttachmentRow))).toBe("2026-09-28T06:44:03.962Z");
    expect(classifyUserInputRow(row(queuedEnqueueRow))).toBeUndefined();
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
  test("接続中セッションの transcript から最終ユーザ入力時刻が peers に載る", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-user-input");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      // 最後の行はアシスタント発話 = ユーザ入力より後。ソートキーは
      // 「最後のユーザ入力」であって「最後の行」ではない。
      fs.writeFileSync(file, typedPromptLine("やって", T1) + assistantLine(T2) + assistantLine(T3));
      await sessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });

      const res = await user.requestOk({ op: "peers" });
      expect(inputAt(res.peers, A)).toBe(T1);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test('ccmsg の from:"u1" 着信もユーザ入力として時刻を進める', async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-user-input");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, typedPromptLine("やって", T1));
      await sessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      expect(inputAt((await user.requestOk({ op: "peers" })).peers, A)).toBe(T1);

      // tail 駆動 (ポーリングではない): 届いた瞬間に ev:"peers" が飛ぶ。
      fs.appendFileSync(file, ccmsgDeliveryLine("u1", "ソート順変えて", T2));
      const pushed = await user.readEventUntil("peers", (event) => inputAt(event.peers, A) === T2);
      expect(inputAt(pushed.ev.peers, A)).toBe(T2);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("エージェントだけが喋り続けても時刻は動かない", async () => {
    // last_activity_at との違いの核心。走り続けているセッションが
    // 一覧の先頭に居座らないための性質。
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-user-input");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      fs.writeFileSync(file, typedPromptLine("やって", T1));
      await sessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });
      expect(inputAt((await user.requestOk({ op: "peers" })).peers, A)).toBe(T1);

      fs.appendFileSync(
        file,
        assistantLine(T2) + teammateRelayLine(T2) + ccmsgDeliveryLine("a3", "できました", T3),
      );
      // 変化が無いことの確認なので、push を待つのではなく往復 1 回で確定させる。
      expect(inputAt((await user.requestOk({ op: "peers" })).peers, A)).toBe(T1);
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  test("transcript が読めないセッションは値を持たない (0 ではなく無し)", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("session-user-input");
    try {
      const withPrompt = path.join(dir, `${A}.jsonl`);
      const empty = path.join(dir, `${B}.jsonl`);
      fs.writeFileSync(withPrompt, typedPromptLine("やって", T1));
      fs.writeFileSync(empty, assistantLine(T2));
      await sessionConn(ctx, A, { transcript_path: withPrompt });
      await sessionConn(ctx, B, { transcript_path: empty });
      const user = await userConn(ctx);
      await user.request({ op: "subscribe" });

      const res = await user.requestOk({ op: "peers" });
      expect(inputAt(res.peers, A)).toBe(T1);
      expect(inputAt(res.peers, B)).toBeUndefined();
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
