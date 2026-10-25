// 許可依頼 (DR-0040) の「許可する」が写す文と、attachments の見せ方。
// 写した文は人がそのセッションの入力欄に貼って送る許可で、auto mode の
// classifier はその文が名指す操作と、止めた操作を結び付ける。
import { describe, expect, test } from "bun:test";
import { PERMIT_ATTACHMENT_MAX_BYTES, type PermitRequestRecord } from "@ccmsg/protocol";
import {
  attachmentNote,
  fenceLangOfPath,
  permitGrantText,
} from "../src/client/permit-request-view.ts";

function request(fields: Partial<PermitRequestRecord>): PermitRequestRecord {
  return {
    id: "i/1",
    sid: "s",
    ts: "2026-10-25T00:00:00.000Z",
    blocked: "x",
    attachments: [],
    intents: [],
    commands: [],
    read: false,
    ...fields,
  };
}

describe("permitGrantText", () => {
  // 何を保証するか: 見たファイル、許可する intent、コマンドの全文を、この
  // 順に並べる。コマンドは書かれたとおり (引用符・記号を含めて) 1 行に入る。
  test("lists the files seen, then each intent and each command whole", () => {
    expect(
      permitGrantText(
        request({
          attachments: [
            { path: "/w/policy.json", read: true, content: "{}", bytes: 2, truncated: false },
          ],
          intents: ["`/w/a.ts` の編集"],
          commands: [`aws s3api put-bucket-policy --bucket b --policy "file://policy.json"`],
        }),
      ),
    ).toBe(
      [
        "内容を確認したファイル",
        "- /w/policy.json",
        "",
        "以下を許可します。",
        "- `/w/a.ts` の編集",
        `- aws s3api put-bucket-policy --bucket b --policy "file://policy.json" の実行`,
        "",
      ].join("\n"),
    );
  });

  // 何を保証するか: 人が中身を見られなかったファイルは「確認した」に入れず、
  // 先頭だけを見たファイルはそう書く。ファイルが無ければ節ごと書かない。
  test("leaves out files the person could not see, and says which were cut short", () => {
    const text = permitGrantText(
      request({
        attachments: [
          { path: "/w/gone", read: false, reason: "missing" },
          { path: "/w/long.log", read: true, content: "a", bytes: 1e6, truncated: true },
        ],
        commands: ["ls"],
      }),
    );
    expect(text).toBe(
      `内容を確認したファイル\n- /w/long.log (先頭の ${String(PERMIT_ATTACHMENT_MAX_BYTES / 1024)} KiB)\n\n以下を許可します。\n- ls の実行\n`,
    );
    expect(permitGrantText(request({ commands: ["ls"] }))).toBe(
      "以下を許可します。\n- ls の実行\n",
    );
  });

  // 何を保証するか: 複数行のコマンド (行末の \ や here document) も全文が
  // 入る。中身に ``` があっても閉じられないフェンスで囲む。
  test("writes a command of several lines in a fence it cannot close", () => {
    const command = "cat <<'EOF' > a.md\n```\ncode\n```\nEOF";
    expect(permitGrantText(request({ commands: [command] }))).toBe(
      `以下を許可します。\n- 次のコマンドの実行\n\`\`\`\`\n${command}\n\`\`\`\`\n`,
    );
    expect(permitGrantText(request({ commands: ["git push \\\n  origin main"] }))).toBe(
      "以下を許可します。\n- 次のコマンドの実行\n```\ngit push \\\n  origin main\n```\n",
    );
  });
});

describe("attachments", () => {
  test("a file's code block language is its extension, none without one", () => {
    expect(fenceLangOfPath("/w/policy.json")).toBe("json");
    expect(fenceLangOfPath("/w/dir.d/deploy.SH")).toBe("SH");
    expect(fenceLangOfPath("/w/Makefile")).toBeNull();
    expect(fenceLangOfPath("/w/.envrc")).toBeNull();
  });

  test("the note says why a file is not shown, or that only its start is", () => {
    expect(attachmentNote({ path: "/a", read: false, reason: "denied" })).toBe("読む権限が無い");
    expect(
      attachmentNote({ path: "/a", read: true, content: "", bytes: 100_000, truncated: true }),
    ).toBe(`先頭の ${String(PERMIT_ATTACHMENT_MAX_BYTES / 1024)} KiB だけ (全体 100,000 バイト)`);
    expect(
      attachmentNote({ path: "/a", read: true, content: "", bytes: 0, truncated: false }),
    ).toBeNull();
  });
});
