// Detection logic for the UserPromptSubmit subscribe-liveness check. These are
// the pure functions the hook builds on; the hook itself only wires stdin + ps +
// stdout around them (verified by running it with mock stdin). Importing the hook
// module is side-effect free because main() is guarded by `import.meta.main`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { sessionFilePath } from "./session-start.ts";
import {
  parsePs,
  findClaudeAncestor,
  collectDescendants,
  isSubscribeCommand,
  detectSubscribeInTree,
  buildNagMessage,
  ensureSessionFile,
} from "./user-prompt-submit.ts";

describe("parsePs", () => {
  // ps -o pid=,ppid=,command= is headerless with right-aligned (space-padded)
  // numeric columns and a command that itself contains spaces.
  test("parses headerless pid/ppid/command with padded columns and spaces in command", () => {
    const raw = "  501   1 /sbin/launchd\n 1234 501 bun run /x/index.ts subscribe\n";
    expect(parsePs(raw)).toEqual([
      { pid: 501, ppid: 1, command: "/sbin/launchd" },
      { pid: 1234, ppid: 501, command: "bun run /x/index.ts subscribe" },
    ]);
  });

  // Blank lines and any non "<num> <num> <rest>" lines are dropped, not thrown on.
  test("skips blank and malformed lines", () => {
    expect(parsePs("\n  \nPID PPID COMMAND\n42 7 sh\n")).toEqual([
      { pid: 42, ppid: 7, command: "sh" },
    ]);
  });
});

describe("isSubscribeCommand", () => {
  // The launcher exec's `bun run <root>/packages/cli/src/index.ts subscribe`, so the
  // live process shows the CLI entry (index.ts) followed by `subscribe`.
  test("matches bun-run of the CLI entry", () => {
    expect(isSubscribeCommand("bun run /p/ccmsg/0.0.1/packages/cli/src/index.ts subscribe")).toBe(
      true,
    );
  });

  // Direct launcher invocation (before/without exec) shows basename `ccmsg`.
  test("matches the launcher basename", () => {
    expect(isSubscribeCommand("/p/ccmsg/0.0.1/bin/ccmsg subscribe")).toBe(true);
    expect(isSubscribeCommand("ccmsg subscribe")).toBe(true);
  });

  // A different subcommand is not a subscribe stream.
  test("rejects other subcommands", () => {
    expect(isSubscribeCommand("ccmsg post r-ab12cd34 hello")).toBe(false);
  });

  // `subscribe` appearing only as an argument value (not right after the entry
  // token) must not be mistaken for the subscribe stream.
  test("rejects subscribe as a trailing argument value", () => {
    expect(isSubscribeCommand("ccmsg read r-ab12cd34 subscribe")).toBe(false);
    expect(isSubscribeCommand("vim subscribe.ts")).toBe(false);
  });

  // Empty / whitespace-only command lines never match.
  test("rejects empty command", () => {
    expect(isSubscribeCommand("")).toBe(false);
    expect(isSubscribeCommand("   ")).toBe(false);
  });
});

describe("findClaudeAncestor", () => {
  // The hook (a bun process) is a descendant of claude; walking ppid up must reach it.
  const rows = [
    { pid: 1, ppid: 0, command: "/sbin/launchd" },
    { pid: 50, ppid: 1, command: "claude" },
    { pid: 60, ppid: 50, command: "bun run /x/hooks/user-prompt-submit.ts" },
    { pid: 70, ppid: 60, command: "ps -axww -o pid=,ppid=,command=" },
  ];

  // argv[0] basename `claude` is matched even when launched by absolute path.
  test("finds claude walking up the ppid chain", () => {
    expect(findClaudeAncestor(rows, 70)).toBe(50);
    expect(findClaudeAncestor(rows, 60)).toBe(50);
  });

  // No claude in the chain (e.g. run from a plain shell) => null => hook nags (safe side).
  test("returns null when no claude ancestor exists", () => {
    const noClaude = [
      { pid: 1, ppid: 0, command: "/sbin/launchd" },
      { pid: 90, ppid: 1, command: "bash" },
      { pid: 91, ppid: 90, command: "bun run hook.ts" },
    ];
    expect(findClaudeAncestor(noClaude, 91)).toBeNull();
  });

  // A ppid cycle must terminate rather than loop forever.
  test("terminates on a ppid cycle", () => {
    const cyclic = [
      { pid: 10, ppid: 11, command: "a" },
      { pid: 11, ppid: 10, command: "b" },
    ];
    expect(findClaudeAncestor(cyclic, 10)).toBeNull();
  });
});

describe("collectDescendants", () => {
  const rows = [
    { pid: 50, ppid: 1, command: "claude" },
    { pid: 60, ppid: 50, command: "monitor" },
    { pid: 70, ppid: 60, command: "subscribe" },
    { pid: 80, ppid: 1, command: "unrelated" },
  ];

  // Every transitive child of the root is collected; the root and unrelated trees are not.
  test("collects the transitive descendant set excluding the root", () => {
    expect(collectDescendants(rows, 50)).toEqual(new Set([60, 70]));
  });
});

describe("detectSubscribeInTree", () => {
  const claudeTree = [
    { pid: 50, ppid: 1, command: "claude --session-id 11111111-2222-3333-4444-555555555555" },
    { pid: 60, ppid: 50, command: "bun run /x/hooks/user-prompt-submit.ts" },
    { pid: 61, ppid: 50, command: "bun run /x/packages/cli/src/index.ts subscribe" },
  ];

  // The Monitor-launched subscribe is a descendant of claude => detected => stay silent.
  test("detects a subscribe descendant of claude", () => {
    expect(detectSubscribeInTree(claudeTree, 50)).toBe(true);
  });

  // No subscribe descendant => not detected => hook nags.
  test("returns false when no subscribe descendant exists", () => {
    const noSub = claudeTree.filter((r) => r.pid !== 61);
    expect(detectSubscribeInTree(noSub, 50)).toBe(false);
  });

  // A subscribe belonging to a *different* claude tree must not count as ours
  // (multi-session isolation: detection is scoped to this session's process tree).
  test("ignores a subscribe outside the root's descendants", () => {
    const otherTree = [
      { pid: 50, ppid: 1, command: "claude" },
      { pid: 99, ppid: 1, command: "bun run /x/packages/cli/src/index.ts subscribe" },
    ];
    expect(detectSubscribeInTree(otherTree, 50)).toBe(false);
  });
});

// buildNagMessage: 提示コマンドは CCMSG_SID prefix のみ (transcript_path/repo/ws
// はコマンドラインへの埋め込みをやめ session state file 経由に変更、
// 2026-07-11 kawaz 裁定。session-start.ts の buildSubscribeCommand と同じ)。
describe("buildNagMessage", () => {
  const bin = "/opt/ccmsg/bin/ccmsg";

  test("session_id があれば CCMSG_SID= prefix 付きのコマンドになる", () => {
    const msg = buildNagMessage(bin, "sess-123");
    expect(msg).toBe(
      `[ccmsg] subscribe stream not detected in this session's process tree. ` +
        `Open it with the **Monitor tool** (persistent: true), not Bash: ` +
        `CCMSG_SID=sess-123 ${bin} subscribe\n`,
    );
  });

  test("session_id が無ければ prefix なしの裸コマンドになる", () => {
    const msg = buildNagMessage(bin, undefined);
    expect(msg).toBe(
      `[ccmsg] subscribe stream not detected in this session's process tree. ` +
        `Open it with the **Monitor tool** (persistent: true), not Bash: ${bin} subscribe\n`,
    );
  });
});

// ensureSessionFile: SessionStart が書き損ねた (未起動 plugin / prune 済み等の)
// session state file を UserPromptSubmit 側で救済する「無い時だけ書く」ロジック。
describe("ensureSessionFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-ensuresf-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFakeBumpSemver(script: string): string {
    const scriptPath = path.join(dir, "fake-bump-semver");
    fs.writeFileSync(scriptPath, script);
    fs.chmodSync(scriptPath, 0o755);
    return scriptPath;
  }

  // ファイルが存在しない場合は新規に書く。repo/ws/repo_root は cwd から
  // bump-semver 経由で導出される (SessionStart の書き込みロジックと同じ
  // getRepoWsFromVcs を使う)。
  test("ファイルが無ければ transcript_path/cwd/repo/ws/repo_root を書く", async () => {
    const bin = writeFakeBumpSemver(`#!/bin/sh
case "$3" in
  backend) echo jj ;;
  root) echo "${dir}/repo/main" ;;
  worktree-name) echo main ;;
  *) exit 2 ;;
esac
`);
    await ensureSessionFile(
      dir,
      "sess-1",
      { transcriptPath: "/home/u/.claude/proj/sess-1.jsonl", cwd: dir },
      { bin },
    );
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written.transcript_path).toBe("/home/u/.claude/proj/sess-1.jsonl");
    expect(written.cwd).toBe(dir);
    // jj + worktree-name あり: repo は basename(dirname(root)) = basename(`${dir}/repo`) = "repo"、
    // ws は worktree-name の "main" (deriveRepoWs のロジックそのまま)。
    expect(written.repo).toBe("repo");
    expect(written.ws).toBe("main");
    // repo_root は dirname(root) = `${dir}/repo` (deriveRepoRoot、worktree-name 非空)。
    expect(written.repo_root).toBe(`${dir}/repo`);
    expect(typeof written.updated_at).toBe("string");
  });

  // 既にファイルが存在する場合は一切書き換えない (= SessionStart の新しい値を
  // 上書きしない)。bump-semver も一切呼ばれない (無駄な subprocess を避ける)。
  test("ファイルが既にあれば書き換えず、bump-semver も呼ばれない", async () => {
    fs.mkdirSync(path.dirname(sessionFilePath(dir, "sess-1")), { recursive: true });
    fs.writeFileSync(sessionFilePath(dir, "sess-1"), JSON.stringify({ repo: "existing" }));
    const bin = writeFakeBumpSemver(`#!/bin/sh\necho SHOULD_NOT_BE_CALLED >&2\nexit 1\n`);
    await ensureSessionFile(dir, "sess-1", { cwd: dir }, { bin });
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written).toEqual({ repo: "existing" });
  });

  // cwd が無ければ repo/ws 導出を試みず (bump-semver 呼び出しなし)、
  // transcript_path だけを書く。
  test("cwd が無ければ repo/ws は導出されない", async () => {
    await ensureSessionFile(dir, "sess-1", { transcriptPath: "/tmp/sess-1.jsonl" });
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written).toEqual({
      transcript_path: "/tmp/sess-1.jsonl",
      updated_at: written.updated_at,
    });
  });
});
