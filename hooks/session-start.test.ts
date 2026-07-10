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
  detectPathInstallCandidate,
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

// buildSubscribeCommand (DR-0009): the suggested `ccmsg subscribe` command line
// gets CCMSG_SID / CCMSG_TRANSCRIPT_PATH env prefixes stitched on, each only
// when its source value is present.
describe("buildSubscribeCommand", () => {
  const bin = "/opt/ccmsg/bin/ccmsg";

  // Neither session_id nor transcript_path known (degenerate hook input):
  // no env prefix at all, just the bare launcher + subcommand.
  test("session_id も transcript_path も無ければ prefix なし", () => {
    expect(buildSubscribeCommand(bin, undefined, undefined)).toBe(`${bin} subscribe`);
  });

  // session_id だけの場合は既存挙動どおり CCMSG_SID= だけが前置される
  // (回帰防止: CCMSG_TRANSCRIPT_PATH 追加で既存の CCMSG_SID 単独ケースを壊していないか)。
  test("session_id のみなら CCMSG_SID= だけが前置される", () => {
    expect(buildSubscribeCommand(bin, "sess-123", undefined)).toBe(
      `CCMSG_SID=sess-123 ${bin} subscribe`,
    );
  });

  // 両方揃っている本来のケース: CCMSG_SID の隣に CCMSG_TRANSCRIPT_PATH が
  // single-quote された絶対パスとともに続く (DR-0009 の申告経路)。
  test("session_id と transcript_path が両方あれば CCMSG_SID の隣に CCMSG_TRANSCRIPT_PATH が続く", () => {
    expect(buildSubscribeCommand(bin, "sess-123", "/home/u/.claude/proj/sess-123.jsonl")).toBe(
      `CCMSG_SID=sess-123 CCMSG_TRANSCRIPT_PATH='/home/u/.claude/proj/sess-123.jsonl' ${bin} subscribe`,
    );
  });

  // transcript_path のみ (session_id が欠けているような異常な hook 入力) でも
  // CCMSG_TRANSCRIPT_PATH 側は独立して前置される。
  test("transcript_path のみなら CCMSG_TRANSCRIPT_PATH だけが前置される", () => {
    expect(buildSubscribeCommand(bin, undefined, "/tmp/x.jsonl")).toBe(
      `CCMSG_TRANSCRIPT_PATH='/tmp/x.jsonl' ${bin} subscribe`,
    );
  });

  // シェル安全性: パスに単一引用符が含まれても `'\''` エスケープで壊れずに
  // 埋め込まれる (= あり得ない想定だが、シェルコマンド生成である以上防御する)。
  test("transcript_path にシングルクォートが含まれてもシェル安全にエスケープされる", () => {
    const got = buildSubscribeCommand(bin, "s1", "/tmp/it's-a-path/s1.jsonl");
    expect(got).toBe(
      `CCMSG_SID=s1 CCMSG_TRANSCRIPT_PATH='/tmp/it'\\''s-a-path/s1.jsonl' ${bin} subscribe`,
    );
  });
});
