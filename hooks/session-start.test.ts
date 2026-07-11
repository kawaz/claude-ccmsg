// DR-0007 §1 の PATH install 候補検出ロジック。ここでは detectPathInstallCandidate
// の分岐輪郭のみを検証する (hook 本体の stdout 組み立ては手動実行で確認済み — 別途
// journal/報告を参照)。実ファイルシステムに対して動くため、テストごとに一時 dir を
// 作って PATH/HOME/stateDir を注入する。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  buildSubscribeCommand,
  candidateBinDirs,
  declineMarkerPath,
  deriveRepoWs,
  detectPathInstallCandidate,
  getRepoWsFromVcs,
  pruneOldSessionFiles,
  sessionFilePath,
  writeSessionFile,
} from "./session-start.ts";

describe("candidateBinDirs", () => {
  // 優先順位: ~/.local/bin が ~/bin より先 (DR-0007 §1)。
  test("~/.local/bin が ~/bin より優先される順で並ぶ", () => {
    expect(candidateBinDirs("/home/u")).toEqual([
      path.join("/home/u", ".local", "bin"),
      path.join("/home/u", "bin"),
    ]);
  });
});

// deriveRepoWs: `bump-semver vcs get` の実測結果 (root / backend / worktree-name
// / current-branch) から repo/ws を組み立てる純関数。パス文字列の規約パースは
// 廃止 (kawaz 裁定、2026-07-11) — 全ケース実機観測済み (このリポ = jj 標準形、
// claude-rules-personal 親ディレクトリ = jj colocated 無ネスト、
// ansible-role-postfix-relay = git 単一 checkout、mermaid-aa-pr1 = git linked
// worktree)。
describe("deriveRepoWs", () => {
  // jj 標準形: kawaz の jj リポは常に <repo>/<ws> にネストされ (このリポ自身で
  // 実測: root=".../claude-ccmsg/main", worktree-name="main")、root は *workspace*
  // の root であって repo の root ではない。よって repo は dirname(root) から
  // basename を取る必要がある (basename(root) だと ws 名 "main" を repo と
  // 誤認する)。
  test("jj: worktree-name があれば repo は dirname(root) から、ws は worktree-name から取る", () => {
    expect(
      deriveRepoWs({
        backend: "jj",
        root: "/Users/kawaz/.local/share/repos/github.com/kawaz/claude-ccmsg/main",
        worktreeName: "main",
        currentBranch: "",
      }),
    ).toEqual({ repo: "claude-ccmsg", ws: "main" });
  });

  // jj colocated かつネスト無し (claude-rules-personal の親ディレクトリで実測:
  // .jj がリポ直下にあり、そこで実行すると worktree-name="" / current-branch は
  // ambiguous で exit 4 = 呼び出し側で "" に丸める)。ws 層が無いので repo は
  // basename(root) をそのまま使う (dirname を遡ると親の "kawaz" ディレクトリに
  // なってしまうため、worktree-name が空の間は遡らない)。
  test("jj: worktree-name が空ならネストを想定せず basename(root) を repo にする", () => {
    expect(
      deriveRepoWs({
        backend: "jj",
        root: "/Users/kawaz/.local/share/repos/github.com/kawaz/claude-rules-personal",
        worktreeName: "",
        currentBranch: "",
      }),
    ).toEqual({ repo: "claude-rules-personal", ws: "" });
  });

  // git 単一 checkout (ansible-role-postfix-relay で実測: worktree-name="",
  // current-branch="default")。root がそのまま repo dir なので basename(root)
  // が repo。ws 層が無いので current-branch ("default") にフォールバックする
  // (kawaz の「workspace 名があれば workspace 名、無ければ branch/bookmark 名」
  // 優先どおり)。
  test("git: worktree-name が空なら current-branch を ws にフォールバックする", () => {
    expect(
      deriveRepoWs({
        backend: "git",
        root: "/Users/kawaz/.local/share/repos/github.com/kawaz/ansible-role-postfix-relay",
        worktreeName: "",
        currentBranch: "default",
      }),
    ).toEqual({ repo: "ansible-role-postfix-relay", ws: "default" });
  });

  // git linked worktree (mermaid-aa-pr1 で実測: root=".../mermaid-aa-pr1" 自体が
  // worktree dir で bare 本体 (mermaid-aa) の兄弟。bump-semver に本体へ遡る
  // getter が無いため、repo は worktree 自身の名前に解決される既知の制約
  // (= ws と同値になる)。パス文字列パースへの復帰はしない設計判断。
  test("git: linked worktree では repo が worktree 名と同値になる (既知の制約)", () => {
    expect(
      deriveRepoWs({
        backend: "git",
        root: "/Users/kawaz/.local/share/repos/github.com/kawaz/mermaid-aa-pr1",
        worktreeName: "mermaid-aa-pr1",
        currentBranch: "",
      }),
    ).toEqual({ repo: "mermaid-aa-pr1", ws: "mermaid-aa-pr1" });
  });

  // root が空 (VCS facts が取れなかった = getRepoWsFromVcs 側で早期 bail した
  // 場合の入力): 常に空フォールバック、他フィールドの値によらない。
  test("root が空なら常に repo/ws とも空文字になる", () => {
    expect(
      deriveRepoWs({ backend: "git", root: "", worktreeName: "main", currentBranch: "main" }),
    ).toEqual({ repo: "", ws: "" });
  });
});

// getRepoWsFromVcs: `bump-semver` サブプロセスの起動〜フォールバックを含む結合層。
// 実 VCS 状態には依存させず (このリポ自身に対して実行すると環境依存になる)、
// CCMSG_TAILSCALE_BIN と同じ流儀のテストシーム (fake bin script への差し替え)
// で検証する。
describe("getRepoWsFromVcs", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-vcsws-"));
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

  // バイナリ不在 (ENOENT) は黙って空フォールバックする (= hook の起動を壊さない)。
  test("バイナリが存在しなければ空フォールバックになる", async () => {
    const got = await getRepoWsFromVcs(dir, {
      bin: "/nonexistent/path/definitely-not-bump-semver",
      timeoutMs: 500,
    });
    expect(got).toEqual({ repo: "", ws: "" });
  });

  // cwd が VCS リポ外 (backend/root 取得が非ゼロ終了) の場合も空フォールバック。
  test("VCS リポ外 (get が失敗) なら空フォールバックになる", async () => {
    const bin = writeFakeBumpSemver(`#!/bin/sh\nexit 3\n`);
    const got = await getRepoWsFromVcs(dir, { bin, timeoutMs: 500 });
    expect(got).toEqual({ repo: "", ws: "" });
  });

  // 正常系 (jj, worktree-name あり): backend/root/worktree-name の 3 回の呼び出し
  // だけで解決し、current-branch は呼ばれない (worktree-name が非空なら不要な
  // 呼び出しを省略する設計)。
  test("正常系 (jj, worktree-name あり) は backend/root/worktree-name から解決する", async () => {
    const bin = writeFakeBumpSemver(`#!/bin/sh
case "$3" in
  backend) echo jj ;;
  root) echo "/Users/kawaz/.local/share/repos/github.com/kawaz/claude-ccmsg/main" ;;
  worktree-name) echo main ;;
  current-branch) echo "SHOULD_NOT_BE_CALLED"; exit 1 ;;
  *) exit 2 ;;
esac
`);
    const got = await getRepoWsFromVcs(
      "/Users/kawaz/.local/share/repos/github.com/kawaz/claude-ccmsg/main",
      { bin, timeoutMs: 500 },
    );
    expect(got).toEqual({ repo: "claude-ccmsg", ws: "main" });
  });

  // 正常系 (git, worktree-name 空): current-branch へのフォールバック呼び出しが
  // 実際に行われ、その値が ws に反映される。
  test("正常系 (git, worktree-name 空) は current-branch を ws にフォールバックする", async () => {
    const bin = writeFakeBumpSemver(`#!/bin/sh
case "$3" in
  backend) echo git ;;
  root) echo "/Users/kawaz/.local/share/repos/github.com/kawaz/ansible-role-postfix-relay" ;;
  worktree-name) echo "" ;;
  current-branch) echo default ;;
  *) exit 2 ;;
esac
`);
    const got = await getRepoWsFromVcs(dir, { bin, timeoutMs: 500 });
    expect(got).toEqual({ repo: "ansible-role-postfix-relay", ws: "default" });
  });

  // タイムアウト: バイナリが応答を返さず固まった場合、timeoutMs を超えたら
  // 空フォールバックで打ち切る (hook の起動を体感で遅くしないための上限)。
  // `exec sleep 10` (`sh -c 'sleep 10'` ではなく) で fake script プロセス自体を
  // sleep に置き換える: raceExit の kill 対象は fake script の直接子である
  // sleep そのものになるため、シェルの孫プロセスが stdout パイプを握ったまま
  // 残る (= kill してもテストプロセス自体がハングする) 事故を避けられる。
  test("バイナリが応答しなければ timeoutMs で打ち切り空フォールバックになる", async () => {
    const bin = writeFakeBumpSemver(`#!/bin/sh\nexec sleep 10\n`);
    const start = Date.now();
    const got = await getRepoWsFromVcs(dir, { bin, timeoutMs: 300 });
    expect(got).toEqual({ repo: "", ws: "" });
    // 実際に timeoutMs (300ms) 前後で打ち切られたことを確認する (= sleep 10 の
    // 10 秒丸ごと待たされていない = AbortSignal.timeout が効いている)。
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(250);
    expect(elapsed).toBeLessThan(2000);
  });
});

describe("detectPathInstallCandidate", () => {
  let base: string;
  let home: string;
  let stateDir: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-sshook-"));
    home = path.join(base, "home");
    stateDir = path.join(base, "state");
    fs.mkdirSync(home);
    fs.mkdirSync(stateDir);
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  // 正常系: PATH に ccmsg が無く、候補 dir (~/.local/bin) が PATH に含まれ書き込み可能
  // なら、その dir を候補として返す。
  test("PATH に ccmsg が無く候補 dir が書き込み可能なら検出する", () => {
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    const pathEnv = [localBin, "/usr/bin", "/bin"].join(path.delimiter);

    const got = detectPathInstallCandidate(pathEnv, home, stateDir);
    expect(got).toEqual({ dir: localBin, binPath: path.join(localBin, "ccmsg") });
  });

  // PATH に既に `ccmsg` という名の実行可能ファイルがあれば、候補 dir が条件を満たして
  // いても提案しない (= 二重 install 提案の防止)。
  test("PATH に既に ccmsg があれば null", () => {
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    const alreadyBinDir = path.join(base, "already");
    fs.mkdirSync(alreadyBinDir);
    fs.writeFileSync(path.join(alreadyBinDir, "ccmsg"), "#!/bin/sh\n");
    const pathEnv = [alreadyBinDir, localBin].join(path.delimiter);

    expect(detectPathInstallCandidate(pathEnv, home, stateDir)).toBeNull();
  });

  // decline マーカーが立っていれば、条件を満たしていても二度と提案しない
  // (= 毎セッション nag 防止、DR-0007 §1)。
  test("decline マーカーがあれば null", () => {
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.writeFileSync(declineMarkerPath(stateDir), "");
    const pathEnv = [localBin].join(path.delimiter);

    expect(detectPathInstallCandidate(pathEnv, home, stateDir)).toBeNull();
  });

  // 候補 dir が PATH に含まれない場合は対象外 (安定パスとして機能しないため)。
  test("候補 dir が PATH に含まれなければ null", () => {
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true }); // 存在するが PATH には無い
    const pathEnv = ["/usr/bin", "/bin"].join(path.delimiter);

    expect(detectPathInstallCandidate(pathEnv, home, stateDir)).toBeNull();
  });

  // 候補 dir が PATH にあっても書き込み不可 (read-only) なら対象外
  // (symlink 作成が失敗するだけの無意味な提案を防ぐ)。
  test("候補 dir が書き込み不可なら null", () => {
    const localBin = path.join(home, ".local", "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.chmodSync(localBin, 0o500); // r-x, 書き込み不可
    const pathEnv = [localBin].join(path.delimiter);
    try {
      expect(detectPathInstallCandidate(pathEnv, home, stateDir)).toBeNull();
    } finally {
      fs.chmodSync(localBin, 0o700); // rmSync (afterEach) のため復元
    }
  });

  // 候補 dir が PATH にあっても、実体が存在しない (mkdir されていない) なら対象外
  // (存在しない dir への書き込み可否は判定できないので安全側に倒す)。
  test("候補 dir が存在しなければ null", () => {
    const localBin = path.join(home, ".local", "bin"); // mkdir しない
    const pathEnv = [localBin].join(path.delimiter);

    expect(detectPathInstallCandidate(pathEnv, home, stateDir)).toBeNull();
  });

  // ~/.local/bin が使えない (書き込み不可) が ~/bin が使える場合、次点の ~/bin を返す
  // (= 優先順位フォールバック、DR-0007 §1 の「次点」)。
  test("~/.local/bin が不可でも ~/bin が使えればそちらを返す", () => {
    const localBin = path.join(home, ".local", "bin");
    const homeBin = path.join(home, "bin");
    fs.mkdirSync(localBin, { recursive: true });
    fs.mkdirSync(homeBin, { recursive: true });
    fs.chmodSync(localBin, 0o500);
    const pathEnv = [localBin, homeBin].join(path.delimiter);
    try {
      const got = detectPathInstallCandidate(pathEnv, home, stateDir);
      expect(got).toEqual({ dir: homeBin, binPath: path.join(homeBin, "ccmsg") });
    } finally {
      fs.chmodSync(localBin, 0o700);
    }
  });
});

// buildSubscribeCommand: 提示コマンドは CCMSG_SID prefix (+ launcher + subscribe)
// のみ。transcript_path/repo/ws は (2026-07-11 kawaz 裁定で) コマンドラインへの
// 埋め込みをやめ、session state file 経由で CLI 側が自分で読むようにした
// (= writeSessionFile / sessionFilePath 参照)。
describe("buildSubscribeCommand", () => {
  const bin = "/opt/ccmsg/bin/ccmsg";

  // session_id 無し (degenerate hook input): prefix なし、裸コマンドのみ。
  test("session_id が無ければ prefix なしの裸コマンドになる", () => {
    expect(buildSubscribeCommand(bin, undefined)).toBe(`${bin} subscribe`);
  });

  // 通常ケース: CCMSG_SID= だけが前置される。
  test("session_id があれば CCMSG_SID= が前置される", () => {
    expect(buildSubscribeCommand(bin, "sess-123")).toBe(`CCMSG_SID=sess-123 ${bin} subscribe`);
  });
});

// sessionFilePath: <stateDir>/sessions/<sid>.json という固定規則。CLI 側
// (packages/cli/src/index.ts) が独立に同じ規則で計算する対応先。
describe("sessionFilePath", () => {
  test("stateDir 配下の sessions/<sid>.json を返す", () => {
    expect(sessionFilePath("/state", "sess-123")).toBe(
      path.join("/state", "sessions", "sess-123.json"),
    );
  });
});

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
      transcript_path: "/home/u/.claude/proj/sess-1.jsonl",
      cwd: "/some/cwd",
      repo: "claude-ccmsg",
      ws: "main",
      updated_at: "2026-07-11T00:00:00.000Z",
    });
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written).toEqual({
      transcript_path: "/home/u/.claude/proj/sess-1.jsonl",
      cwd: "/some/cwd",
      repo: "claude-ccmsg",
      ws: "main",
      updated_at: "2026-07-11T00:00:00.000Z",
    });
  });

  // 既存ファイルは上書きされる (SessionStart は毎回「最新」を書く仕様)。
  test("既存ファイルは上書きされる", () => {
    writeSessionFile(dir, "sess-1", { updated_at: "2026-07-11T00:00:00.000Z" });
    writeSessionFile(dir, "sess-1", { repo: "newrepo", updated_at: "2026-07-11T01:00:00.000Z" });
    const written = JSON.parse(fs.readFileSync(sessionFilePath(dir, "sess-1"), "utf8"));
    expect(written).toEqual({ repo: "newrepo", updated_at: "2026-07-11T01:00:00.000Z" });
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
