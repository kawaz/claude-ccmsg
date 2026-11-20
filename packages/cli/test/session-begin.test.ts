// `ccmsg sidecar begin` の部品: VCS の事実から repo_root / branch を導くこと、
// session state file の書き込みと古いものの掃除 (DR-0039 §2)。実ファイルシステムに
// 対して動くため、テストごとに一時 dir を作って PATH/HOME/stateDir を注入する。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { JsonObjectSchema, jsonText, parseWith, type JsonObject } from "@ccmsg/protocol";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import {
  deriveRepoRoot,
  getVcsLocation,
  pruneOldSessionFiles,
  sessionFilePath,
  writeSessionFile,
} from "../src/session-begin.ts";

// deriveRepoRoot (DR-0008 addendum): repo_root = dirname(root) whenever
// worktree-name is non-empty, backend-agnostic (both kawaz's jj workspace and
// git bare+worktree layouts nest one level under a shared container — see the
// function's own doc for why no backend branch is needed here, unlike repo).
describe("deriveRepoRoot", () => {
  // jj, worktree-name あり (このリポ自身で実測した root/worktree-name):
  // dirname(root) が container ("claude-ccmsg") になる。
  test("worktree-name があれば dirname(root) を返す (jj)", () => {
    expect(
      deriveRepoRoot({
        backend: "jj",
        root: "/Users/kawaz/.local/share/repos/github.com/kawaz/claude-ccmsg/main",
        worktreeName: "main",
        currentBranch: "",
      }),
    ).toBe("/Users/kawaz/.local/share/repos/github.com/kawaz/claude-ccmsg");
  });

  // git は worktree-name があっても常に空文字 (既知の制約): 実測で
  // github.com/kawaz/mermaid-aa-pr1 (linked worktree) の root は本体
  // (mermaid-aa) の兄弟ではなく、owner ディレクトリ直下に他の無関係な
  // 数十リポと同列に並ぶ。dirname(root) を返すと「このリポの worktree 群」
  // ではなく「owner の全リポ」まで fs_list/fs_read の containment root が
  // 広がってしまう。真の worktree container を得るには `git worktree list`
  // による裏取りが必要 (bump-semver に該当 getter が無い) — 未対応の既知の
  // 制約として、必要になったら拡張する前提で今は "" を返す。
  test("git は worktree-name があっても常に空文字を返す (既知の制約、拡張未対応)", () => {
    expect(
      deriveRepoRoot({
        backend: "git",
        root: "/Users/kawaz/.local/share/repos/github.com/kawaz/mermaid-aa-pr1",
        worktreeName: "mermaid-aa-pr1",
        currentBranch: "",
      }),
    ).toBe("");
  });

  // worktree-name が空 (workspace 層が無い通常 checkout): root 自体が唯一のメンバーで
  // cwd から既に全体が見えているので、広げる先が無い = "" (フィールド省略の
  // トリガーになる、main() / ensureSessionFile 参照)。
  test("worktree-name が空なら空文字を返す (workspace 層なしの通常 checkout)", () => {
    expect(
      deriveRepoRoot({
        backend: "git",
        root: "/Users/kawaz/.local/share/repos/github.com/kawaz/ansible-role-postfix-relay",
        worktreeName: "",
        currentBranch: "default",
      }),
    ).toBe("");
  });

  // root が空 (VCS facts 未取得): worktree-name の値によらず常に空文字。
  test("root が空なら worktree-name の値によらず空文字になる", () => {
    expect(
      deriveRepoRoot({ backend: "git", root: "", worktreeName: "main", currentBranch: "" }),
    ).toBe("");
  });
});

// getVcsLocation: `bump-semver` サブプロセスの起動〜フォールバックを含む結合層。
// 実 VCS 状態には依存させず (このリポ自身に対して実行すると環境依存になる)、
// CCMSG_TAILSCALE_BIN と同じ流儀のテストシーム (fake bin script への差し替え)
// で検証する。
describe("getVcsLocation", () => {
  let dir: string;
  // 保険値: getVcsLocation は最大 4 回 `sh` を直列 spawn する共通デッドライン
  // 方式。500ms だと 8 並列テスト実行時に sh の spawn だけで超過し、AbortSignal
  // 由来ではなく本コード内の deadline で空フォールバックに落ちる flaky が出た
  // (実測 503-506ms、tailscale-origin flaky と同型)。timeout 機構の検証は下の
  // 専用 test が担うため、他 test は負荷耐性のある大きめ値を渡す。
  const NORMAL_TIMEOUT_MS = 10_000;
  // 上の予算を待てるようにするための per-test timeout。bun の既定は 5000ms で、
  // NORMAL_TIMEOUT_MS (10s) より短いため、予算を使い切る前に bun 側が先に test を
  // 打ち切ってしまう (負荷下の実測 wall clock は 2.4-3.0s、8 並列 x 高負荷で
  // 「timed out after 5000ms」が 100% 再現した)。subprocess を spawn する test に付ける。
  const spawnTest = (name: string, fn: () => Promise<void>) => test(name, fn, 30_000);

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-vcsws-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeFakeBumpSemver(script: string): string {
    return writeMockBin(path.join(dir, "fake-bump-semver"), script);
  }

  // バイナリ不在 (ENOENT) は黙って空フォールバックする (= セッションの開始を壊さない)。
  spawnTest("バイナリが存在しなければ空フォールバックになる", async () => {
    const got = await getVcsLocation(dir, {
      bin: "/nonexistent/path/definitely-not-bump-semver",
      timeoutMs: NORMAL_TIMEOUT_MS,
    });
    expect(got).toEqual({ repoRoot: "", branch: "" });
  });

  // cwd が VCS リポ外 (backend/root 取得が非ゼロ終了) の場合も空フォールバック。
  spawnTest("VCS リポ外 (get が失敗) なら空フォールバックになる", async () => {
    const bin = writeFakeBumpSemver(`#!/bin/sh\nexit 3\n`);
    const got = await getVcsLocation(dir, { bin, timeoutMs: NORMAL_TIMEOUT_MS });
    expect(got).toEqual({ repoRoot: "", branch: "" });
  });

  // 正常系 (jj, worktree-name あり): backend/root/worktree-name/current-branch
  // の 4 回の呼び出しで解決し、repository は聞かない (リポジトリは daemon が
  // cwd のファイルから導く、DR-0003 §3)。repoRoot は同じ facts から (追加の
  // subprocess 無しで) 導出される: dirname(root) = ".../claude-ccmsg"。
  spawnTest(
    "正常系 (jj, worktree-name あり) は worktree-name/current-branch から解決し、repository は聞かない",
    async () => {
      const asked = path.join(dir, "asked.log");
      const bin = writeFakeBumpSemver(`#!/bin/sh
echo "$3" >> "${asked}"
case "$3" in
  backend) echo jj ;;
  root) echo "/Users/kawaz/.local/share/repos/github.com/kawaz/claude-ccmsg/main" ;;
  worktree-name) echo main ;;
  current-branch) echo main ;;
  repository) echo "kawaz/claude-ccmsg" ;;
  *) exit 2 ;;
esac
`);
      // cwd (第 1 引数) は spawn の作業ディレクトリとして実在する必要がある —
      // 実マシン固有のリポパスを渡すと CI (そのパスが無い) で spawn 自体が失敗し
      // 空フォールバックに落ちる。fake は cwd を見ないので tmpdir で足りる。
      const got = await getVcsLocation(dir, { bin, timeoutMs: NORMAL_TIMEOUT_MS });
      expect(got).toEqual({
        repoRoot: "/Users/kawaz/.local/share/repos/github.com/kawaz/claude-ccmsg",
        branch: "main",
      });
      expect(fs.readFileSync(asked, "utf8").split("\n").filter(Boolean)).toEqual([
        "backend",
        "root",
        "worktree-name",
        "current-branch",
      ]);
    },
  );

  // 正常系 (git, worktree-name 空): current-branch が branch に入る。
  // worktree-name が空なので repoRoot は "" (workspace 層が無く、広げる先が無い)。
  spawnTest(
    "正常系 (git, worktree-name 空) は current-branch を branch に記録し repoRoot は空",
    async () => {
      const bin = writeFakeBumpSemver(`#!/bin/sh
case "$3" in
  backend) echo git ;;
  root) echo "/Users/kawaz/.local/share/repos/github.com/kawaz/ansible-role-postfix-relay" ;;
  worktree-name) echo "" ;;
  current-branch) echo default ;;
  repository) echo "kawaz/ansible-role-postfix-relay" ;;
  *) exit 2 ;;
esac
`);
      const got = await getVcsLocation(dir, { bin, timeoutMs: NORMAL_TIMEOUT_MS });
      expect(got).toEqual({ repoRoot: "", branch: "default" });
    },
  );

  // タイムアウト: バイナリが応答を返さず固まった場合、timeoutMs を超えたら
  // 空フォールバックで打ち切る (begin を遅くしないための上限)。
  // `exec sleep 10` (`sh -c 'sleep 10'` ではなく) で fake script プロセス自体を
  // sleep に置き換える: raceExit の kill 対象は fake script の直接子である
  // sleep そのものになるため、シェルの孫プロセスが stdout パイプを握ったまま
  // 残る (= kill してもテストプロセス自体がハングする) 事故を避けられる。
  spawnTest("バイナリが応答しなければ timeoutMs で打ち切り空フォールバックになる", async () => {
    const bin = writeFakeBumpSemver(`#!/bin/sh\nexec sleep 10\n`);
    const start = Date.now();
    const got = await getVcsLocation(dir, { bin, timeoutMs: 300 });
    expect(got).toEqual({ repoRoot: "", branch: "" });
    // 実際に timeoutMs (300ms) 前後で打ち切られたことを確認する (= sleep 10 の
    // 10 秒丸ごと待たされていない = AbortSignal.timeout が効いている)。
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("sessionFilePath", () => {
  test("stateDir 配下の sessions/<sid>.json を返す", () => {
    expect(sessionFilePath("/state", "sess-123")).toBe(
      path.join("/state", "sessions", "sess-123.json"),
    );
  });
});

const JsonObjectTextSchema = jsonText(JsonObjectSchema);

// 書かれたファイルを JSON オブジェクトとして読む。フィールドを落とさずに読むため
// SessionStateFileSchema でなく任意のオブジェクトとして通す (余計なフィールドが
// 書かれていれば toEqual で落ちる)。
function writtenObject(file: string): JsonObject {
  const read = parseWith(JsonObjectTextSchema, fs.readFileSync(file, "utf8"));
  if (!read.ok) throw new Error(`not a JSON object: ${read.failure.summary}: ${file}`);
  return read.value;
}

// writeSessionFile: mkdir -p + JSON 書き込みの best-effort I/O。
describe("writeSessionFile", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-sessfile-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  // sessions/ ディレクトリが存在しなくても mkdir -p して書き込める。
  test("sessions/ ディレクトリが無くても作成して書き込む", () => {
    writeSessionFile(dir, "sess-1", {
      cwd: "/some/cwd",
      branch: "main",
      updated_at: "2026-07-11T00:00:00.000Z",
    });
    const written = writtenObject(sessionFilePath(dir, "sess-1"));
    expect(written).toEqual({
      cwd: "/some/cwd",
      branch: "main",
      updated_at: "2026-07-11T00:00:00.000Z",
    });
  });

  // repo_root (DR-0008 addendum) も他フィールドと同じく素通しで書ける
  // (worktree-name 非空の場合のみ begin が渡す値、フィールド自体は optional)。
  test("repo_root が渡されれば書き込まれる", () => {
    writeSessionFile(dir, "sess-1", {
      cwd: "/repo/main",
      branch: "main",
      repo_root: "/repo",
      updated_at: "2026-07-11T00:00:00.000Z",
    });
    const written = writtenObject(sessionFilePath(dir, "sess-1"));
    expect(written).toEqual({
      cwd: "/repo/main",
      branch: "main",
      repo_root: "/repo",
      updated_at: "2026-07-11T00:00:00.000Z",
    });
  });

  // 既存ファイルは上書きされる (begin は毎回「最新」を書く仕様)。
  test("既存ファイルは上書きされる", () => {
    writeSessionFile(dir, "sess-1", { updated_at: "2026-07-11T00:00:00.000Z" });
    writeSessionFile(dir, "sess-1", {
      branch: "newbranch",
      updated_at: "2026-07-11T01:00:00.000Z",
    });
    const written = writtenObject(sessionFilePath(dir, "sess-1"));
    expect(written).toEqual({ branch: "newbranch", updated_at: "2026-07-11T01:00:00.000Z" });
  });

  // stateDir が書き込み不可なら例外を投げず黙って何もしない (best-effort)。
  test("書き込み不可な stateDir では例外を投げず何もしない", () => {
    fs.chmodSync(dir, 0o500);
    try {
      expect(() =>
        writeSessionFile(dir, "sess-1", { updated_at: "2026-07-11T00:00:00.000Z" }),
      ).not.toThrow();
      expect(fs.existsSync(sessionFilePath(dir, "sess-1"))).toBe(false);
    } finally {
      fs.chmodSync(dir, 0o700); // rmSync (afterEach) のため復元
    }
  });
});

// pruneOldSessionFiles: sessions/*.json の age-based GC (best-effort)。
describe("pruneOldSessionFiles", () => {
  let dir: string;
  const NOW = Date.parse("2026-07-11T00:00:00.000Z");
  const DAY_MS = 24 * 60 * 60 * 1000;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-prune-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function writeAged(sid: string, ageMs: number): void {
    const file = sessionFilePath(dir, sid);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{}");
    fs.utimesSync(file, new Date(NOW - ageMs), new Date(NOW - ageMs));
  }

  // 30 日超 (mtime) のファイルは削除、30 日以内は残す。
  test("30 日超のファイルだけ削除し、30 日以内は残す", () => {
    writeAged("old", 31 * DAY_MS);
    writeAged("fresh", 29 * DAY_MS);
    pruneOldSessionFiles(dir, NOW);
    expect(fs.existsSync(sessionFilePath(dir, "old"))).toBe(false);
    expect(fs.existsSync(sessionFilePath(dir, "fresh"))).toBe(true);
  });

  // sessions/ ディレクトリ自体が存在しない場合も例外を投げず何もしない
  // (SessionStart 初回起動時など)。
  test("sessions/ ディレクトリが無くても例外を投げない", () => {
    expect(() => pruneOldSessionFiles(dir, NOW)).not.toThrow();
  });
});
