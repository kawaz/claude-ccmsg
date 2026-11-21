// 許可依頼 (DR-0040) の「まとめて許可」が写す文と、開いた添付の見せ方。
// 写した文は人がそのセッションの入力欄に貼って送る許可で、auto mode の
// classifier はその文が名指す操作と、止めた操作を結び付ける。
import { describe, expect, test } from "bun:test";
import {
  isBashCommandOf,
  PERMIT_ATTACHMENT_MAX_BYTES,
  type PermitCall,
  type PermitItemMark,
} from "@ccmsg/protocol";
import {
  attachmentNote,
  commandHeading,
  endPermitBangRuns,
  fenceLangOfPath,
  permitBangKey,
  permitGrantText,
  permitItemMarkOf,
  permitRuleSetOf,
  projectPermissionLines,
  type PermitPicked,
  projectSettingsPathOf,
  type PermitBangRun,
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

/** Every intent and command of `call` picked (✅). */
function all(call: PermitCall): PermitPicked {
  return {
    intents: call.intents.map((_, i) => i),
    commands: call.commands.map((_, i) => i),
  };
}

/** permitGrantText with every intent and command picked. */
function grantAll(call: PermitCall): string {
  return permitGrantText(call, all(call));
}

describe("permitGrantText", () => {
  // 何を保証するか: 添付のパス、許可する intent、コマンドの全文をこの
  // 順に並べる。コマンドは説明があれば見出しに添え、書かれたとおり (引用符・
  // 記号を含めて) コードブロックに入る。
  test("lists the files, then each intent and each command whole", () => {
    expect(
      grantAll(
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
    expect(grantAll(request({ attachments: ["/w/c", "/w/a", "/w/b"], intents: ["編集"] }))).toBe(
      "以下ファイルの内容を確認しました。問題無し。\n- /w/c\n- /w/a\n- /w/b\n\n以下の操作を許可します。\n- 編集\n",
    );
    expect(grantAll(request({ intents: ["編集"] }))).toBe("以下の操作を許可します。\n- 編集\n");
  });

  // 何を保証するか: コマンドの中に ``` があっても、閉じられないフェンスで囲む。
  test("writes a command in a fence it cannot close", () => {
    const command = "cat <<'EOF' > a.md\n```\ncode\n```\nEOF";
    expect(grantAll(request({ commands: [{ command }] }))).toBe(
      `以下の操作を許可します。\n- 以下コマンドの実行\n\`\`\`\`\n${command}\n\`\`\`\`\n`,
    );
  });

  // 何を保証するか: 許可の文に入るのは、人が選んだ (✅) intents と commands
  // だけで、依頼に書かれた順 (選んだ順ではない)。添付は選びに依らず全部
  // (DR-0040 §8)。
  test("lists only the intents and commands picked, in the request's order", () => {
    const call = request({
      attachments: ["/w/a"],
      intents: ["一つ目", "二つ目", "三つ目"],
      commands: [{ command: "ls" }, { command: "pwd" }],
    });
    expect(permitGrantText(call, { intents: [2, 0], commands: [1] })).toBe(
      [
        "以下ファイルの内容を確認しました。問題無し。",
        "- /w/a",
        "",
        "以下の操作を許可します。",
        "- 一つ目",
        "- 三つ目",
        "- 以下コマンドの実行",
        "```",
        "pwd",
        "```",
        "",
      ].join("\n"),
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

// DR-0040 §12: the settings file is the call's directory's. DR-0040 §4: what
// became of an item is the daemon's mark of that request's item, by its kind
// and its place.
describe("project permissions", () => {
  test("the settings file is the call's directory's .claude/settings.local.json", () => {
    expect(projectSettingsPathOf("/w/repo")).toBe("/w/repo/.claude/settings.local.json");
    expect(projectSettingsPathOf("/w/repo/")).toBe("/w/repo/.claude/settings.local.json");
  });

  test("an item's mark is the one of the same request, kind and place", () => {
    const marks: PermitItemMark[] = [
      { tool_use_id: "toolu_1", kind: "project_permissions", index: 0, mark: "run", at: "t1" },
      { tool_use_id: "toolu_1", kind: "commands", index: 1, mark: "dismiss", at: "t2" },
    ];
    expect(permitItemMarkOf(marks, "toolu_1", "project_permissions", 0)?.at).toBe("t1");
    expect(permitItemMarkOf(marks, "toolu_1", "commands", 1)?.mark).toBe("dismiss");
    expect(permitItemMarkOf(marks, "toolu_1", "commands", 0)).toBeUndefined();
    expect(permitItemMarkOf(marks, "toolu_1", "project_permissions", 1)).toBeUndefined();
    expect(permitItemMarkOf(marks, "toolu_2", "project_permissions", 0)).toBeUndefined();
  });

  // 何を保証するか: settings の項目は、daemon が書く rule の組を 1 行ずつ diff の
  // 行にする (+ 足す / - 消す)。daemon がまだ組を持たない間は、エージェントが
  // 書いた rule の 1 行。組は依頼と位置で引く。
  test("a project permission is a diff line per rule the daemon writes, + to add and - to remove", () => {
    expect(projectPermissionLines({ add: "Edit(~/a/b)" }, ["Edit(~/a/b)", "Edit(//r/b)"])).toEqual([
      { kind: "add", marker: "+", rule: "Edit(~/a/b)" },
      { kind: "add", marker: "+", rule: "Edit(//r/b)" },
    ]);
    expect(projectPermissionLines({ add: "Write(/a)" }, undefined)).toEqual([
      { kind: "add", marker: "+", rule: "Write(/a)" },
    ]);
    expect(projectPermissionLines({ remove: "Bash(ls)" }, ["Bash(ls)"])).toEqual([
      { kind: "delete", marker: "-", rule: "Bash(ls)" },
    ]);
    const sets = [{ tool_use_id: "toolu_1", index: 1, rules: ["Bash(x)"] }];
    expect(permitRuleSetOf(sets, "toolu_1", 1)).toEqual(["Bash(x)"]);
    expect(permitRuleSetOf(sets, "toolu_1", 0)).toBeUndefined();
    expect(permitRuleSetOf(sets, "toolu_2", 1)).toBeUndefined();
  });
});

describe("the runs of 「! で実行」", () => {
  // 何を保証するか: Claude Code は <bash-input> にコマンドの末尾の空白を落として
  // 書き、他は変えない (先頭と中の空白、引用符、< & はそのまま)。送ったコマンドと
  // 行のコマンドはその違いだけを許して同じとみなす。
  test("a row's command is the one sent but for the trailing blanks", () => {
    expect(isBashCommandOf("ls -la", "ls -la")).toBe(true);
    expect(isBashCommandOf("  echo   x  \t", "  echo   x")).toBe(true);
    expect(isBashCommandOf("echo '<a&b>'", "echo '<a&b>'")).toBe(true);
    expect(isBashCommandOf("ls -la", "ls  -la")).toBe(false);
    expect(isBashCommandOf("  ls", "ls")).toBe(false);
    expect(isBashCommandOf("ls", "ls -la")).toBe(false);
  });

  // 何を保証するか: 複数行のコマンドも同じ規則で、Claude Code が書く形
  // (findings 2026-11-11-permit-bang-multiline.md で見たもの) と一致する。
  // 行の間の改行・先頭の空行・インデントはそのまま、末尾の空白と空行は落ち、
  // CRLF と単独の CR の改行は LF になる。それ以外の変形は吸収しない。
  test("a multi-line command is the row's but for the trailing blanks and CR line breaks as LF", () => {
    expect(isBashCommandOf("echo a\necho b", "echo a\necho b")).toBe(true);
    expect(isBashCommandOf("cat <<'EOF'\n$HOME\nEOF", "cat <<'EOF'\n$HOME\nEOF")).toBe(true);
    expect(isBashCommandOf("\n\n\techo a\n    echo b\n\n\n", "\n\n\techo a\n    echo b")).toBe(
      true,
    );
    expect(isBashCommandOf("echo a\r\necho b\r\n", "echo a\necho b")).toBe(true);
    expect(isBashCommandOf("echo a\r\necho b", "echo a\necho b")).toBe(true);
    expect(isBashCommandOf("echo a\necho b", "echo a\n  echo b")).toBe(false);
    expect(isBashCommandOf("echo a\necho b", "echo a")).toBe(false);
    expect(isBashCommandOf("\necho a", "echo a")).toBe(false);
    expect(isBashCommandOf("echo a\recho b", "echo a\necho b")).toBe(true);
    expect(isBashCommandOf("echo a\recho b", "echo a\recho b")).toBe(false);
  });

  // 何を保証するか: 行が来たセッションとコマンドの、実行中の run だけを終える。
  // 別のセッション・別のコマンド・実行済みは変えない。変わらなければ同じ Map を
  // 返す (store が描き直しを起こさない)。依頼とコマンドの位置で別の run になる。
  test("a row ends the running runs of its session and command alone", () => {
    const mine = permitBangKey("toolu_1", 0);
    const sameCommandElsewhere = permitBangKey("toolu_2", 0);
    const otherCommand = permitBangKey("toolu_1", 1);
    expect(new Set([mine, sameCommandElsewhere, otherCommand]).size).toBe(3);
    const runs: ReadonlyMap<string, PermitBangRun> = new Map<string, PermitBangRun>([
      [mine, { kind: "running", sid: "s", command: "ls -la " }],
      [sameCommandElsewhere, { kind: "running", sid: "t", command: "ls -la" }],
      [otherCommand, { kind: "running", sid: "s", command: "pwd" }],
      [permitBangKey("toolu_3", 0), { kind: "ended" }],
    ]);
    const after = endPermitBangRuns(runs, "s", "ls -la");
    expect([...after]).toEqual([
      [mine, { kind: "ended" }],
      [sameCommandElsewhere, { kind: "running", sid: "t", command: "ls -la" }],
      [otherCommand, { kind: "running", sid: "s", command: "pwd" }],
      [permitBangKey("toolu_3", 0), { kind: "ended" }],
    ]);
    expect(endPermitBangRuns(runs, "s", "whoami")).toBe(runs);
  });
});
