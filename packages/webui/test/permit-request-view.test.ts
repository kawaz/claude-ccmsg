// 許可依頼 (DR-0040) の「許可する」が写す文と、開いた添付の見せ方。
// 写した文は人がそのセッションの入力欄に貼って送る許可で、auto mode の
// classifier はその文が名指す操作と、止めた操作を結び付ける。
import { describe, expect, test } from "bun:test";
import { PERMIT_ATTACHMENT_MAX_BYTES, type PermitCall } from "@ccmsg/protocol";
import {
  appliedAtOf,
  attachmentNote,
  commandHeading,
  fenceLangOfPath,
  isOneLineCommand,
  permitGrantText,
  projectSettingsPathOf,
} from "../src/client/permit-request-view.ts";

function request(fields: Partial<PermitCall>): PermitCall {
  return {
    blocked: "x",
    attachments: [],
    intents: [],
    commands: [],
    project_permissions: [],
    ...fields,
  };
}

describe("permitGrantText", () => {
  // 何を保証するか: 添付のパス、許可する intent、コマンドの全文をこの
  // 順に並べる。コマンドは説明があれば見出しに添え、書かれたとおり (引用符・
  // 記号を含めて) コードブロックに入る。
  test("lists the files, then each intent and each command whole", () => {
    expect(
      permitGrantText(
        request({
          attachments: ["/w/policy.json", "/w/deploy.sh"],
          intents: ["`/w/a.ts` の編集"],
          commands: [
            {
              command: `aws s3api put-bucket-policy --bucket b --policy "file://policy.json"`,
              description: "公開読み取りの policy を当てる",
            },
            { command: "sh /w/deploy.sh prod \\\n  && echo done" },
          ],
        }),
      ),
    ).toBe(
      [
        "以下ファイルの内容を確認しました。問題無し。",
        "- /w/policy.json",
        "- /w/deploy.sh",
        "",
        "以下の操作を許可します。",
        "- `/w/a.ts` の編集",
        "- 以下コマンドの実行（公開読み取りの policy を当てる）",
        "```",
        `aws s3api put-bucket-policy --bucket b --policy "file://policy.json"`,
        "```",
        "- 以下コマンドの実行",
        "```",
        "sh /w/deploy.sh prod \\",
        "  && echo done",
        "```",
        "",
      ].join("\n"),
    );
  });

  // 何を保証するか: 添付は全部を依頼に書かれた順に並べる。添付が無ければ
  // ファイルの段落ごと書かない。
  test("lists every file in the request's order, and leaves the paragraph out when there are none", () => {
    expect(
      permitGrantText(request({ attachments: ["/w/c", "/w/a", "/w/b"], intents: ["編集"] })),
    ).toBe(
      "以下ファイルの内容を確認しました。問題無し。\n- /w/c\n- /w/a\n- /w/b\n\n以下の操作を許可します。\n- 編集\n",
    );
    expect(permitGrantText(request({ intents: ["編集"] }))).toBe(
      "以下の操作を許可します。\n- 編集\n",
    );
  });

  // 何を保証するか: コマンドの中に ``` があっても、閉じられないフェンスで囲む。
  test("writes a command in a fence it cannot close", () => {
    const command = "cat <<'EOF' > a.md\n```\ncode\n```\nEOF";
    expect(permitGrantText(request({ commands: [{ command }] }))).toBe(
      `以下の操作を許可します。\n- 以下コマンドの実行\n\`\`\`\`\n${command}\n\`\`\`\`\n`,
    );
  });

  test("a command's heading carries its description when it has one", () => {
    expect(commandHeading({ command: "ls" })).toBe("以下コマンドの実行");
    expect(commandHeading({ command: "ls", description: "一覧" })).toBe(
      "以下コマンドの実行（一覧）",
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

// DR-0040 §7: 「! で実行」 is offered for a one-line command only.
describe("isOneLineCommand", () => {
  test("a command with no line break is one line", () => {
    for (const command of ["ls -la", "echo 'a  b' | wc -c", "  x  ", 'cat <<<"in"']) {
      expect(isOneLineCommand(command)).toBe(true);
    }
  });

  test("any line break makes it several: LF, CRLF, CR, a trailing one", () => {
    for (const command of ["a\nb", "a\r\nb", "a\rb", "ls\n", "cat <<EOF\nx\nEOF"]) {
      expect(isOneLineCommand(command)).toBe(false);
    }
  });
});

// DR-0040 §12: the settings file is the call's directory's, and a change is
// applied when the daemon's state lists that change of that request.
describe("project permissions", () => {
  test("the settings file is the call's directory's .claude/settings.local.json", () => {
    expect(projectSettingsPathOf("/w/repo")).toBe("/w/repo/.claude/settings.local.json");
    expect(projectSettingsPathOf("/w/repo/")).toBe("/w/repo/.claude/settings.local.json");
  });

  test("a change is applied when the same change of the same request is", () => {
    const applied = [
      { tool_use_id: "toolu_1", permission: { add: "Bash(ls)" }, applied_at: "t1" },
      { tool_use_id: "toolu_2", permission: { remove: "Bash(ls)" }, applied_at: "t2" },
    ];
    expect(appliedAtOf(applied, "toolu_1", { add: "Bash(ls)" })).toBe("t1");
    expect(appliedAtOf(applied, "toolu_1", { remove: "Bash(ls)" })).toBeUndefined();
    expect(appliedAtOf(applied, "toolu_2", { add: "Bash(ls)" })).toBeUndefined();
    expect(appliedAtOf(applied, "toolu_3", { add: "Bash(ls)" })).toBeUndefined();
  });
});
