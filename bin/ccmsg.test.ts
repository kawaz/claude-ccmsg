// DR-0007 §2 の launcher 自己更新を、実 bin/ccmsg を実際に bash で実行してブラックボックス
// に検証する。テスト対象は「実 launcher スクリプトそのもの」— version-compare や
// path-extraction のロジックを bun 側に移植して二重に検証すると launcher の実体との
// 乖離を見逃すので、bash プロセスとして直接叩く。
//
// fake の versioned plugin cache 構造 (.../ccmsg/<version>/bin/ccmsg) を一時 dir に
// 作り、launcher をコピーして配置する。`bun` は PATH 上のスタブに差し替え、実際の
// CLI 起動 (exec bun run ...) をノーオペにして self-update 部分だけを観測する。
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
  // Stub `bun`: satisfies `command -v bun` and no-ops the `exec bun run ...`
  // tail of the launcher so the test never actually boots the real CLI.
  fs.writeFileSync(path.join(stubBin, "bun"), "#!/usr/bin/env bash\nexit 0\n");
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

function run(f: Fixture, launcherPath: string): { code: number } {
  const proc = Bun.spawnSync({
    cmd: [launcherPath, "status"],
    env: { PATH: `${f.userBin}:${f.stubBin}:${process.env.PATH ?? ""}` },
    stdout: "ignore",
    stderr: "ignore",
  });
  return { code: proc.exitCode ?? -1 };
}

function linkTarget(p: string): string | null {
  try {
    return fs.readlinkSync(p);
  } catch {
    return null;
  }
}

describe("bin/ccmsg self-update (DR-0007 §2)", () => {
  test("新しい版からの実行で PATH の symlink が張り替わる", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      fs.symlinkSync(f.v1, userCcmsg);
      run(f, f.v2);
      expect(linkTarget(userCcmsg)).toBe(f.v2);
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
