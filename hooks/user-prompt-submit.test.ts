// Session state file rescue for the UserPromptSubmit hook. Importing the hook
// module is side-effect free because main() is guarded by `import.meta.main`.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMockBin } from "../packages/testkit/src/mock-bin.ts";
import { sessionFilePath } from "./session-start.ts";
import { ensureSessionFile } from "./user-prompt-submit.ts";

// ensureSessionFile: SessionStart が書き損ねた (未起動 plugin / prune 済み等の)
// session state file を UserPromptSubmit 側で救済する「無い時だけ書く」ロジック。
describe("ensureSessionFile", () => {
  let dir: string;
  // 保険値 (session-start.test.ts の NORMAL_TIMEOUT_MS と同趣旨): getRepoWsFromVcs
  // は最大 5 回 `sh` を直列 spawn する共通デッドライン方式で、production 既定の
  // 1000ms は高負荷下だと 5 回目 (repository → repo フィールド) の前に尽きる
  // (実測 1037-1229ms で repo が "" に degrade)。timeout 機構自体の検証は
  // session-start.test.ts の専用 test が担うので、ここは負荷耐性のある値を渡す。
  const NORMAL_TIMEOUT_MS = 10_000;
  // 上の予算を待てるようにするための per-test timeout。bun の既定は 5000ms で、
  // NORMAL_TIMEOUT_MS (10s) より短いため、予算を使い切る前に bun 側が先に test を
  // 打ち切ってしまう (負荷下の実測 wall clock は 2.4-3.0s、8 並列 x 高負荷で
  // 「timed out after 5000ms」が 100% 再現した)。subprocess を spawn する test に付ける。
  const spawnTest = (name: string, fn: () => Promise<void>) => test(name, fn, 30_000);

  // この hook は所在を event の cwd から名乗らない (DR-0003 §3 「所在の正本」)。
  // 救済ファイルに書ける所在は CLAUDE_PROJECT_DIR だけなので、各 test が自分で
  // 立てる。実プロセスの値が漏れ込まないよう毎回消してから始める。
  let savedProjectDir: string | undefined;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-ensuresf-"));
    savedProjectDir = process.env.CLAUDE_PROJECT_DIR;
    delete process.env.CLAUDE_PROJECT_DIR;
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
    if (savedProjectDir === undefined) delete process.env.CLAUDE_PROJECT_DIR;
    else process.env.CLAUDE_PROJECT_DIR = savedProjectDir;
  });

  function writeFakeBumpSemver(script: string): string {
    return writeMockBin(path.join(dir, "fake-bump-semver"), script);
  }

  // ファイルが存在しない場合は新規に書く。repo/ws/repo_root/branch は
  // CLAUDE_PROJECT_DIR から bump-semver 経由で導出される (SessionStart の
  // 書き込みロジックと同じ getRepoWsFromVcs を使う)。
  spawnTest("ファイルが無ければ transcript_path/cwd/repo/ws/repo_root/branch を書く", async () => {
    process.env.CLAUDE_PROJECT_DIR = dir;
    const bin = writeFakeBumpSemver(`#!/bin/sh
case "$3" in
  backend) echo jj ;;
  root) echo "${dir}/repo/main" ;;
  worktree-name) echo main ;;
  current-branch) echo main ;;
  repository) echo "kawaz/repo" ;;
  *) exit 2 ;;
esac
`);
    await ensureSessionFile(
      dir,
      "sess-1",
      { transcriptPath: "/home/u/.claude/proj/sess-1.jsonl" },
      { bin, timeoutMs: NORMAL_TIMEOUT_MS },
    );
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written.transcript_path).toBe("/home/u/.claude/proj/sess-1.jsonl");
    expect(written.cwd).toBe(dir);
    // repo は repository getter の生値 (owner/repo slug)、ws は worktree-name の
    // "main" (deriveWs のロジックそのまま)。
    expect(written.repo).toBe("kawaz/repo");
    expect(written.ws).toBe("main");
    // repo_root は dirname(root) = `${dir}/repo` (deriveRepoRoot、worktree-name 非空)。
    expect(written.repo_root).toBe(`${dir}/repo`);
    expect(written.branch).toBe("main");
    expect(typeof written.updated_at).toBe("string");
  });

  // 既にファイルが存在する場合は一切書き換えない (= SessionStart の新しい値を
  // 上書きしない)。bump-semver も一切呼ばれない (無駄な subprocess を避ける)。
  test("ファイルが既にあれば書き換えず、bump-semver も呼ばれない", async () => {
    fs.mkdirSync(path.dirname(sessionFilePath(dir, "sess-1")), { recursive: true });
    fs.writeFileSync(sessionFilePath(dir, "sess-1"), JSON.stringify({ repo: "existing" }));
    const bin = writeFakeBumpSemver(`#!/bin/sh\necho SHOULD_NOT_BE_CALLED >&2\nexit 1\n`);
    process.env.CLAUDE_PROJECT_DIR = dir;
    await ensureSessionFile(dir, "sess-1", {}, { bin });
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written).toEqual({ repo: "existing" });
  });

  // 所在を名乗れなければ (CLAUDE_PROJECT_DIR なし) repo/ws 導出を試みず
  // (bump-semver 呼び出しなし)、transcript_path だけを書く。
  test("CLAUDE_PROJECT_DIR が無ければ cwd も repo/ws も書かれない", async () => {
    await ensureSessionFile(dir, "sess-1", { transcriptPath: "/tmp/sess-1.jsonl" });
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written).toEqual({
      transcript_path: "/tmp/sess-1.jsonl",
      updated_at: written.updated_at,
    });
  });
});
