// The daemon learns that a bash mode command ended (the person's
// `! <command>`, or a request's 「! で実行」, DR-0040 §11) by the
// `<bash-input>` row the session's module pushes, and tells the tabs
// (ev:"bash_command_ended").
//
// 何を保証するか (各 test の doc comment 参照):
//   - <bash-input> の行 (content が文字列でも text block でも) からコマンドを
//     そのまま取り出す。出力の行 (<bash-stdout>)、通常の prompt、前後に何か付いた
//     行、assistant の行はコマンドにしない
//   - subagent / teammate の行は数えない (bash mode は本体だけ)
//   - push で受けた新しい行のコマンドを user role の購読者に送る。追いつきで
//     読んだ行の push (compaction の再 push) では送らない
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import type { TranscriptPushRow } from "@ccmsg/protocol";
import { bashCommandsEnded, bashInputOf } from "../src/bash-command-rows.ts";
import {
  fixtureDir,
  liveSessionConn,
  stampRows,
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type TestClient,
} from "./helpers.ts";

const A = "ba500000-0000-4000-8000-000000000001";

/** A person's row as the engine hands it (`e.message`): what `session.append`
 * carried for `! <command>` in 2.1.319 (findings 2026-11-06-permit-bang-run.md). */
function userRow(text: string, fields: Partial<TranscriptPushRow> = {}): TranscriptPushRow {
  return {
    uuid: crypto.randomUUID(),
    door: "command",
    message: { role: "user", content: [{ type: "text", text }] },
    ...fields,
  };
}

describe("bashInputOf", () => {
  // 何を保証するか: <bash-input> だけの行のコマンドを、書かれたまま (先頭と中の
  // 空白、引用符、エスケープされない < & も) 取り出す。content が文字列の行
  // (transcript の行と同じ形) も読む。
  test("reads the command of a <bash-input> row as written", () => {
    expect(bashInputOf(userRow("<bash-input>ls -la</bash-input>"))).toBe("ls -la");
    expect(bashInputOf(userRow("<bash-input>  echo   '<a&b>'</bash-input>"))).toBe(
      "  echo   '<a&b>'",
    );
    expect(
      bashInputOf({
        uuid: "u",
        door: "command",
        message: { role: "user", content: "<bash-input>false</bash-input>" },
      }),
    ).toBe("false");
  });

  // 何を保証するか: コマンドが終わった印にするのは <bash-input> の行だけ。出力
  // の行、通常の prompt、前後に文字のある行、text でない block の行は null。
  test("is null for any other row", () => {
    for (const text of [
      "<bash-stdout>ok</bash-stdout><bash-stderr></bash-stderr>",
      "ls -la",
      "! ls -la",
      "x<bash-input>ls</bash-input>",
      "<bash-input>ls</bash-input>\n",
    ]) {
      expect(bashInputOf(userRow(text))).toBeNull();
    }
    expect(
      bashInputOf({
        uuid: "u",
        door: "response",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }],
        },
      }),
    ).toBeNull();
    expect(bashInputOf({ uuid: "u", door: "response", message: {} })).toBeNull();
  });
});

describe("bashCommandsEnded", () => {
  // 何を保証するか: 本体の <bash-input> の行のコマンドを行の順に返し、subagent /
  // teammate の行と他の行は数えない。
  test("the main thread's commands, in order", () => {
    expect(
      bashCommandsEnded([
        userRow("<bash-input>one</bash-input>"),
        userRow("<bash-stdout>1</bash-stdout><bash-stderr></bash-stderr>"),
        userRow("<bash-input>agent's</bash-input>", { agent_id: "a1" }),
        userRow("<bash-input>two</bash-input>"),
      ]),
    ).toEqual(["one", "two"]);
  });
});

/** The transcript line of a person's `<bash-input>` row. */
function bashInputLine(command: string): string {
  return `${JSON.stringify({
    type: "user",
    timestamp: new Date().toISOString(),
    message: { role: "user", content: `<bash-input>${command}</bash-input>` },
  })}\n`;
}

/** Write a `<bash-input>` row to the session's file and push it, as Claude
 * Code and the module do. */
async function writeAndPush(session: TestClient, file: string, command: string): Promise<void> {
  const row = stampRows(bashInputLine(command));
  fs.appendFileSync(file, row.text);
  await session.requestOk({
    op: "transcript_push",
    rows: [userRow(`<bash-input>${command}</bash-input>`, { uuid: row.uuids[0] ?? "" })],
  });
}

describe("ev:bash_command_ended", () => {
  // 何を保証するか: push で受けた新しい <bash-input> の行のコマンドを、そのセッ
  // ションの sid と一緒に user role の購読者へ送る。追いつき (live になった時の
  // ファイルの頭からの読み) で読んだ行が compaction で再 push されても送らない。
  // subagent の行も送らない。最初に届く ev が新しい行のものであることで、前の
  // push が何も送らなかったことを確かめる。
  test("tells the tabs of a pushed new row, and not of one read before", async () => {
    const ctx = await startInProcessDaemon();
    const dir = fixtureDir("bash-ended");
    try {
      const file = path.join(dir, `${A}.jsonl`);
      const old = stampRows(bashInputLine("old-command"));
      fs.writeFileSync(file, old.text);
      const session = await liveSessionConn(ctx, A, { transcript_path: file });
      const user = await userConn(ctx);
      await user.requestOk({ op: "subscribe" });
      await session.requestOk({
        op: "transcript_push",
        rows: [
          userRow("<bash-input>old-command</bash-input>", { uuid: old.uuids[0] ?? "" }),
          userRow("<bash-input>agent-command</bash-input>", { agent_id: "a1" }),
        ],
      });
      await writeAndPush(session, file, "ls -la");
      const { ev } = await user.readEventUntil("bash_command_ended");
      expect(ev).toEqual({ ev: "bash_command_ended", sid: A, command: "ls -la" });
    } finally {
      await stopInProcessDaemon(ctx);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
