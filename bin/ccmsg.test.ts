// launcher (どの CLI を起動するか、依存の自己修復) を、実 bin/ccmsg を bash で実行して
// ブラックボックス検証する。テスト対象は「実 launcher スクリプトそのもの」なので、
// 個々の判定も source した shell 関数を直接叩く。
//
// fake の versioned plugin cache 構造 (.../ccmsg/<version>/bin/ccmsg) を一時 dir に
// 作り、launcher を配置する。`bun` は PATH 上のスタブに差し替え、実際の
// CLI 起動をノーオペにしつつ、最終的にどの版の entrypoint が選ばれたかを記録する。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeMockBin } from "../packages/testkit/src/mock-bin.ts";

const LAUNCHER = fileURLToPath(new URL("./ccmsg", import.meta.url));

/** Places the launcher at `dest` as a hard link rather than a copy. The launcher
 *  never writes to its own file, so every fixture copy can share the repo's inode, and sharing it is what keeps these tests fast on
 *  macOS: a copy is a new inode, and the first exec of a new inode waits for
 *  Gatekeeper (minutes under load; see packages/testkit/src/mock-bin.ts). Falls
 *  back to copying when a link is impossible (e.g. across filesystems). */
function linkLauncher(dest: string): void {
  fs.rmSync(dest, { force: true });
  try {
    fs.linkSync(LAUNCHER, dest);
  } catch {
    fs.copyFileSync(LAUNCHER, dest);
    fs.chmodSync(dest, 0o755);
  }
}

interface Fixture {
  base: string;
  userBin: string;
  stubBin: string;
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
    linkLauncher(dest);
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
  writeMockBin(
    path.join(stubBin, "bun"),
    '#!/usr/bin/env bash\nprintf \'%s\\n\' "$2" >> "$CCMSG_TEST_BUN_LOG"\nexit 0\n',
  );

  return {
    base,
    userBin,
    stubBin,
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

describe("bin/ccmsg resolves its own real path", () => {
  test("親 directory の symlink も解決した物理 realpath を返す", () => {
    // A stable PATH directory may itself be a symlink; the launcher finds its
    // plugin root from the physical path, not the lexical one.
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
  }, 30_000);
});

// DR-0032 §2.2-4: the launcher runs the CLI of the plugin it belongs to and
// leaves the `ccmsg` on PATH alone. The fixture's cache layout
// (`.../ccmsg/<version>/bin/ccmsg`) is one a version-reading launcher would
// recognise, so a launcher that went back to following PATH fails here.
describe("bin/ccmsg stays in its own plugin (DR-0032 §2.2-4)", () => {
  test("PATH に新しい版の ccmsg があっても、起動した launcher の版の CLI を動かす", () => {
    const f = makeFixture();
    try {
      fs.symlinkSync(f.v2, path.join(f.userBin, "ccmsg"));
      const result = run(f, f.v1);
      expect(result.code).toBe(0);
      expect(path.normalize(result.cliEntry)).toContain("/ccmsg/0.0.1/packages/cli/src/index.ts");
    } finally {
      f.cleanup();
    }
  }, 30_000);

  test("PATH の ccmsg の symlink を、起動した launcher が新しい版でも書き換えない", () => {
    const f = makeFixture();
    try {
      const userCcmsg = path.join(f.userBin, "ccmsg");
      fs.symlinkSync(f.v1, userCcmsg);
      run(f, f.v2);
      expect(linkTarget(userCcmsg)).toBe(f.v1);
    } finally {
      f.cleanup();
    }
  }, 30_000);
});

describe("bin/ccmsg __ccmsg_ensure_deps", () => {
  // bun stub が呼ばれたら引数と cwd をログに書く。ensure_deps は
  // `command -v bun` で存在確認してから呼ぶので、stub を PATH に置けば
  // 「呼んだ/呼ばなかった」と「どこで何を実行したか」の両方を観測できる。
  function runEnsureDeps(root: string): { code: number; log: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-deps-"));
    try {
      const stubBin = path.join(dir, "bin");
      fs.mkdirSync(stubBin);
      const log = path.join(dir, "bun.log");
      fs.writeFileSync(path.join(stubBin, "bun"), `#!/bin/bash\necho "$PWD $*" >> "${log}"\n`, {
        mode: 0o755,
      });
      const proc = Bun.spawnSync({
        cmd: [
          "/bin/bash",
          "-c",
          'source "$1"; shift; __ccmsg_ensure_deps "$@"',
          "bash",
          LAUNCHER,
          root,
        ],
        env: { PATH: `${stubBin}:/usr/bin:/bin` },
        stdout: "ignore",
        stderr: "ignore",
      });
      return {
        code: proc.exitCode ?? -1,
        log: fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "",
      };
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }

  test("bun.lock が無ければ何もしない", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-root-"));
    try {
      const r = runEnsureDeps(root);
      expect(r.code).toBe(0);
      expect(r.log).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("node_modules が既にあれば何もしない", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-root-"));
    try {
      fs.writeFileSync(path.join(root, "bun.lock"), "{}");
      fs.mkdirSync(path.join(root, "node_modules"));
      const r = runEnsureDeps(root);
      expect(r.code).toBe(0);
      expect(r.log).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("bun.lock ありで node_modules 欠落なら root で frozen install を走らせる", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-root-"));
    try {
      fs.writeFileSync(path.join(root, "bun.lock"), "{}");
      const r = runEnsureDeps(root);
      expect(r.code).toBe(0);
      // stub の $PWD は cd に渡したパスそのまま (realpath 化されない)
      expect(r.log).toBe(`${root} install --frozen-lockfile`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("bin/ccmsg deps self-heal from a PATH symlink", () => {
  // shell から使う時は PATH や alias に versioned cache の launcher への symlink を
  // 置く。ensure_deps の root は resolve_symlink 済みの実体パスから導出するので、
  // symlink 経由の起動でも install は実体 cache root で走る — その合成を launcher
  // 全体で固定する。
  test("symlink 起動でも実体 cache root に install が走る", () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-symheal-"));
    try {
      const root = path.join(base, "cache", "ccmsg", "9.9.9");
      fs.mkdirSync(path.join(root, "bin"), { recursive: true });
      fs.mkdirSync(path.join(root, "packages", "cli", "src"), { recursive: true });
      fs.writeFileSync(path.join(root, "packages", "cli", "src", "index.ts"), "");
      fs.writeFileSync(path.join(root, "bun.lock"), "{}");
      const dest = path.join(root, "bin", "ccmsg");
      linkLauncher(dest);
      const stubBin = path.join(base, "stubbin");
      fs.mkdirSync(stubBin);
      const log = path.join(base, "bun.log");
      writeMockBin(
        path.join(stubBin, "bun"),
        `#!/usr/bin/env bash\nif [ "$1" = "install" ]; then echo "$PWD $*" >> "${log}"; fi\nexit 0\n`,
      );
      const linkDir = path.join(base, "linkdir");
      fs.mkdirSync(linkDir);
      const link = path.join(linkDir, "ccmsg");
      fs.symlinkSync(dest, link);
      const proc = Bun.spawnSync({
        cmd: [link, "status"],
        env: { PATH: `${stubBin}:/usr/bin:/bin` },
        stdout: "ignore",
        stderr: "ignore",
      });
      expect(proc.exitCode).toBe(0);
      const recorded = fs.existsSync(log) ? fs.readFileSync(log, "utf8").trim() : "";
      // resolve_symlink は物理パス (pwd -P) を返すので realpath で比較する
      expect(recorded).toBe(`${fs.realpathSync(root)} install --frozen-lockfile`);
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30_000);
});
