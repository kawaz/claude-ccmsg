// launcher の PATH 収束 (self-update + self-exec) を、実 bin/ccmsg を bash で実行して
// ブラックボックス検証する。テスト対象は「実 launcher スクリプトそのもの」—
// version-compare や path-extraction のロジックを bun 側に移植して二重に検証すると
// launcher の実体との乖離を見逃すので、pure 判定も source した shell 関数を直接叩く。
//
// fake の versioned plugin cache 構造 (.../ccmsg/<version>/bin/ccmsg) を一時 dir に
// 作り、launcher をコピーして配置する。`bun` は PATH 上のスタブに差し替え、実際の
// CLI 起動をノーオペにしつつ、最終的にどの版の entrypoint が選ばれたかを記録する。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const LAUNCHER = fileURLToPath(new URL("./ccmsg", import.meta.url));

interface Fixture {
  base: string;
  userBin: string;
  stubBin: string;
  devCheckoutBin: string;
  v1: string; // .../cache/ccmsg/0.0.1/bin/ccmsg
  v2: string; // .../cache/ccmsg/0.0.2/bin/ccmsg
  cleanup: () => void;
}

function makeFixture(): Fixture {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-launcher-"));

  const mkVersion = (v: string): string => {
    const binDir = path.join(base, "cache", "ccmsg", v, "bin");
    fs.mkdirSync(binDir, { recursive: true });
    fs.mkdirSync(path.join(base, "cache", "ccmsg", v, "packages", "cli", "src"), {
      recursive: true,
    });
    fs.writeFileSync(
      path.join(base, "cache", "ccmsg", v, "packages", "cli", "src", "index.ts"),
      "",
    );
    const dest = path.join(binDir, "ccmsg");
    fs.copyFileSync(LAUNCHER, dest);
    fs.chmodSync(dest, 0o755);
    return dest;
  };
  const v1 = mkVersion("0.0.1");
  const v2 = mkVersion("0.0.2");

  const userBin = path.join(base, "userbin");
  const stubBin = path.join(base, "stubbin");
  fs.mkdirSync(userBin);
  fs.mkdirSync(stubBin);
  // Stub `bun`: records the CLI entry path passed by the launcher, then no-ops.
  // The recorded path makes an exec redirect observable without booting the daemon.
  fs.writeFileSync(
    path.join(stubBin, "bun"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$2" >> "$CCMSG_TEST_BUN_LOG"\nexit 0\n',
  );
  fs.chmodSync(path.join(stubBin, "bun"), 0o755);

  const devCheckoutBin = path.join(base, "devcheckout", "bin");
  fs.mkdirSync(devCheckoutBin, { recursive: true });
  const devDest = path.join(devCheckoutBin, "ccmsg");
  fs.copyFileSync(LAUNCHER, devDest);
  fs.chmodSync(devDest, 0o755);

  return {
    base,
    userBin,
    stubBin,
    devCheckoutBin,
    v1,
    v2,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function run(
  f: Fixture,
  launcherPath: string,
  extraEnv: Record<string, string> = {},
): { code: number; cliEntry: string } {
  const log = path.join(f.base, `bun-${crypto.randomUUID()}.log`);
  const proc = Bun.spawnSync({
    cmd: [launcherPath, "status"],
    env: {
      PATH: `${f.userBin}:${f.stubBin}:/usr/bin:/bin`,
      CCMSG_TEST_BUN_LOG: log,
      ...extraEnv,
    },
    stdout: "ignore",
    stderr: "ignore",
  });
  return {
    code: proc.exitCode ?? -1,
    cliEntry: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "",
  };
}

function runFunction(name: string, args: string[]): { code: number; out: string } {
  const proc = Bun.spawnSync({
    cmd: ["/bin/bash", "-c", 'source "$1"; shift; "$@"', "bash", LAUNCHER, name, ...args],
    env: { PATH: "/usr/bin:/bin" },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    out: proc.stdout.toString().trim(),
  };
}

function linkTarget(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

describe("bin/ccmsg self-exec pure decisions", () => {
  test("launcher semver comparison follows the shared newer-wins ordering", () => {
    // Numeric major/minor/patch order and release-over-prerelease are the complete
    // version domain emitted by bump-semver, so these cases fix the launcher copy.
    expect(runFunction("__ccmsg_version_compare", ["2.0.0", "1.9.9"]).out).toBe("1");
    expect(runFunction("__ccmsg_version_compare", ["1.2.3", "1.2.3"]).out).toBe("0");
    expect(runFunction("__ccmsg_version_compare", ["1.2.3-a", "1.2.3"]).out).toBe("-1");
    expect(runFunction("__ccmsg_version_compare", ["1.2.3", "1.2.3-a"]).out).toBe("1");
  });

  test("親 directory の symlink も解決した物理 realpath を比較に使う", () => {
    // A stable PATH directory may itself be a symlink; lexical normalization alone
    // would misclassify the same executable as a different path.
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-realpath-"));
    try {
      const realDir = path.join(base, "real");
      const aliasDir = path.join(base, "alias");
      fs.mkdirSync(realDir);
      fs.writeFileSync(path.join(realDir, "ccmsg"), "");
      fs.symlinkSync(realDir, aliasDir);
      expect(runFunction("__ccmsg_resolve_symlink", [path.join(aliasDir, "ccmsg")]).out).toBe(
        fs.realpathSync(path.join(aliasDir, "ccmsg")),
      );
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("realpath が同一なら redirect しない", () => {
    // PATH lookup が自分自身を指す通常起動は exec せず、そのプロセスで続行する。
    const self = "/cache/ccmsg/1.2.3/bin/ccmsg";
    expect(runFunction("__ccmsg_should_self_exec", [self, self]).code).not.toBe(0);
  });

  test("PATH 側 realpath の semver が新しい時だけ redirect する", () => {
    // Path difference alone is insufficient: only a monotonic version advance may exec.
    const self = "/cache/ccmsg/1.2.3/bin/ccmsg";
    expect(
      runFunction("__ccmsg_should_self_exec", [self, "/cache/ccmsg/1.2.4/bin/ccmsg"]).code,
    ).toBe(0);
    expect(
      runFunction("__ccmsg_should_self_exec", [self, "/cache/ccmsg/1.2.2/bin/ccmsg"]).code,
    ).not.toBe(0);
  });
});

describe("bin/ccmsg self-exec", () => {
  test("古い plugin cache 実体から PATH 上の新版へ exec する", () => {
    // The bun stub records which version's packages/cli entry ultimately runs.
    const f = makeFixture();
    try {
      fs.symlinkSync(f.v2, path.join(f.userBin, "ccmsg"));
      const result = run(f, f.v1);
      expect(result.code).toBe(0);
      expect(path.normalize(result.cliEntry)).toContain("/ccmsg/0.0.2/packages/cli/src/index.ts");
    } finally {
      f.cleanup();
    }
  });

  test("CCMSG_NO_SELF_EXEC=1 は PATH 上の新版への exec を無効化する", () => {
    // Tests can pin the working copy process even when an installed ccmsg is newer.
    const f = makeFixture();
    try {
      fs.symlinkSync(f.v2, path.join(f.userBin, "ccmsg"));
      const result = run(f, f.v1, { CCMSG_NO_SELF_EXEC: "1" });
      expect(result.code).toBe(0);
      expect(path.normalize(result.cliEntry)).toContain("/ccmsg/0.0.1/packages/cli/src/index.ts");
    } finally {
      f.cleanup();
    }
  });

  test("PATH に ccmsg が無ければ起動元の実体で続行する", () => {
    // Fail-open keeps absolute plugin-cache invocations usable before PATH install.
    const f = makeFixture();
    try {
      const result = run(f, f.v1);
      expect(result.code).toBe(0);
      expect(path.normalize(result.cliEntry)).toContain("/ccmsg/0.0.1/packages/cli/src/index.ts");
    } finally {
      f.cleanup();
    }
  });
});

describe("bin/ccmsg self-update (DR-0007 §2)", () => {
  test("新しい版からの実行で PATH の symlink が張り替わる", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      fs.symlinkSync(f.v1, userCcmsg);
      run(f, f.v2);
      expect(linkTarget(userCcmsg)).toBe(fs.realpathSync(f.v2));
    } finally {
      f.cleanup();
    }
  });

  test("古い版から実行しても PATH の symlink は退行しない", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      fs.symlinkSync(f.v2, userCcmsg);
      run(f, f.v1);
      expect(linkTarget(userCcmsg)).toBe(f.v2);
    } finally {
      f.cleanup();
    }
  });

  test("PATH の ccmsg が versioned cache 外を指す symlink なら不干渉", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      const devEntry = path.join(f.devCheckoutBin, "ccmsg");
      fs.symlinkSync(devEntry, userCcmsg);
      run(f, f.v2);
      expect(linkTarget(userCcmsg)).toBe(devEntry);
    } finally {
      f.cleanup();
    }
  });

  test("PATH の ccmsg が symlink でない (実ファイル) なら不干渉", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      fs.copyFileSync(f.v1, userCcmsg);
      fs.chmodSync(userCcmsg, 0o755);
      run(f, f.v2);
      expect(fs.lstatSync(userCcmsg).isSymbolicLink()).toBe(false);
      // 内容も書き換わっていない (最初にコピーしたファイルのまま)
      expect(fs.readFileSync(userCcmsg, "utf8")).toBe(fs.readFileSync(f.v1, "utf8"));
    } finally {
      f.cleanup();
    }
  });

  test("dev checkout (unversioned path) からの実行では不発火", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      fs.symlinkSync(f.v1, userCcmsg);
      const devEntry = path.join(f.devCheckoutBin, "ccmsg");
      run(f, devEntry);
      expect(linkTarget(userCcmsg)).toBe(f.v1);
    } finally {
      f.cleanup();
    }
  });

  test("PATH に ccmsg が無ければ何も作らない (best-effort no-op)", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      run(f, f.v2);
      expect(fs.existsSync(userCcmsg)).toBe(false);
    } finally {
      f.cleanup();
    }
  });
});
