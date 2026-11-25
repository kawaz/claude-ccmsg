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
/** The file a finished install leaves in node_modules (`__CCMSG_DEPS_MARKER`). */
const DEPS_MARKER = ".ccmsg-deps-installed";

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

  test("入れ込みの済んだ印が node_modules にあれば何もしない", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-root-"));
    try {
      fs.writeFileSync(path.join(root, "bun.lock"), "{}");
      fs.mkdirSync(path.join(root, "node_modules"));
      fs.writeFileSync(path.join(root, "node_modules", DEPS_MARKER), "");
      const r = runEnsureDeps(root);
      expect(r.code).toBe(0);
      expect(r.log).toBe("");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  // bun は入れ込みの始めに node_modules を作るので、ディレクトリが在ることは
  // 入れ込みが済んだことを意味しない (途中のものや、殺されて途中で止まったもの)。
  test("node_modules が在っても済んだ印が無ければ root で frozen install を走らせる", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-root-"));
    try {
      fs.writeFileSync(path.join(root, "bun.lock"), "{}");
      fs.mkdirSync(path.join(root, "node_modules"));
      const r = runEnsureDeps(root);
      expect(r.code).toBe(0);
      expect(r.log).toBe(`${root} install --frozen-lockfile`);
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

// 新しい版を最初に呼ぶ launcher は 1 つとは限らない (push の後処理、セッションの
// hooks、定期実行)。入れ込みの途中に来た launcher は、途中の node_modules で CLI を
// 走らせず、入れ込みが済むのを待つ。殺された入れ込みは次の呼び出しがやり直す。
//
// 時間の前後には頼らない。`bun` の偽物は入れ込みの途中 (node_modules を作った後)
// で FIFO の gate を読んで止まり、テストが gate に書くまで終わらない。偽物の bun と、
// launcher が使う排他のコマンド (flock / lockf) の前に挟んだ shim は、着いたことを
// FIFO の events に 1 行書く。テストは events を読んで、後から来た launcher が排他の
// 待ちに入ったのを見てから入れ込みを終わらせる。
describe("bin/ccmsg installs the deps once, and the others wait for it", () => {
  /** The lock command the launcher finds on this OS (flock on Linux, lockf on macOS). */
  function lockTool(): string {
    const found =
      Bun.which("flock", { PATH: "/usr/bin:/bin" }) ??
      Bun.which("lockf", { PATH: "/usr/bin:/bin" });
    if (found === null) throw new Error("neither flock nor lockf is in /usr/bin:/bin");
    return found;
  }

  // note は log にだけ、tell は log と events に書く。tell にするのはテストが待つ行
  // (排他の待ちに入る、入れ込みを始める、CLI を走らせる) だけ。events を読む側の
  // いない launcher (環境変数 CCMSG_TEST_EVENTS が無い) は events に書かない。
  const STUB_PRELUDE = [
    "#!/bin/bash",
    'note() { printf \'%s\\n\' "$*" >> "$CCMSG_TEST_LOG"; }',
    'tell() { note "$@"; if [ -n "${CCMSG_TEST_EVENTS:-}" ]; then printf \'%s\\n\' "$*" > "$CCMSG_TEST_EVENTS"; fi; }',
  ].join("\n");

  const BUN_STUB = `${STUB_PRELUDE}
case "$1" in
  install)
    mkdir -p node_modules
    tell install-start
    if [ -n "\${CCMSG_TEST_GATE:-}" ]; then read -r _ < "$CCMSG_TEST_GATE"; fi
    note install-end
    ;;
  run) tell run ;;
esac
exit 0
`;

  interface DepsFixture {
    root: string;
    launcher: string;
    log: string;
    events: string;
    gate: string;
    env: (opts: { events: boolean; gate: boolean }) => Record<string, string>;
    cleanup: () => void;
  }

  function makeDepsFixture(): DepsFixture {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-deps-lock-"));
    const root = path.join(base, "cache", "ccmsg", "9.9.9");
    fs.mkdirSync(path.join(root, "bin"), { recursive: true });
    fs.mkdirSync(path.join(root, "packages", "cli", "src"), { recursive: true });
    fs.writeFileSync(path.join(root, "packages", "cli", "src", "index.ts"), "");
    fs.writeFileSync(path.join(root, "bun.lock"), "{}");
    const launcher = path.join(root, "bin", "ccmsg");
    linkLauncher(launcher);
    const stubBin = path.join(base, "stubbin");
    fs.mkdirSync(stubBin);
    writeMockBin(path.join(stubBin, "bun"), BUN_STUB);
    const tool = lockTool();
    writeMockBin(
      path.join(stubBin, path.basename(tool)),
      `${STUB_PRELUDE}\ntell lock\nexec ${tool} "$@"\n`,
    );
    const log = path.join(base, "log");
    fs.writeFileSync(log, "");
    const events = path.join(base, "events");
    const gate = path.join(base, "gate");
    expect(Bun.spawnSync(["mkfifo", events, gate]).exitCode).toBe(0);
    return {
      root,
      launcher,
      log,
      events,
      gate,
      env: (opts) => ({
        PATH: `${stubBin}:/usr/bin:/bin`,
        CCMSG_TEST_LOG: log,
        ...(opts.events ? { CCMSG_TEST_EVENTS: events } : {}),
        ...(opts.gate ? { CCMSG_TEST_GATE: gate } : {}),
      }),
      cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
    };
  }

  interface EventReader {
    /** The next `n` lines, in the order they were written. */
    next: (n: number) => Promise<string[]>;
    close: () => Promise<void>;
  }

  /** Opens the events FIFO for the whole test, for reading and writing: with
   *  the test itself holding a write end, the FIFO never reads as ended between
   *  two writers, and a line written while no read is waiting stays in the pipe
   *  for the next read. (Opening it afresh per read loses a line written after
   *  one read has seen the end and before it has closed.) */
  async function openEvents(f: DepsFixture): Promise<EventReader> {
    const handle = await fs.promises.open(f.events, "r+");
    const buf = Buffer.alloc(4096);
    let text = "";
    let reading: Promise<unknown> = Promise.resolve();
    return {
      next: async (n) => {
        while (text.split("\n").length - 1 < n) {
          const read = handle.read(buf, 0, buf.length);
          reading = read;
          const { bytesRead } = await read;
          text += buf.toString("utf8", 0, bytesRead);
        }
        const lines = text.split("\n");
        text = lines.slice(n).join("\n");
        return lines.slice(0, n);
      },
      // A read still waiting (a test that failed before the line it waited
      // for came) gets a line of the test's own, so the handle closes idle.
      close: async () => {
        await handle.write("\n");
        await reading;
        await handle.close();
      },
    };
  }

  /** Lets the gated install end: the write waits for the stub to open the gate. */
  async function releaseGate(f: DepsFixture): Promise<void> {
    await fs.promises.writeFile(f.gate, "go\n");
  }

  function logLines(f: DepsFixture): string[] {
    return fs
      .readFileSync(f.log, "utf8")
      .split("\n")
      .filter((l) => l !== "");
  }

  /** Starts the launcher as the leader of its own process group, so that
   *  killGroup reaches the subshell and the fake install it started. */
  function spawnLauncher(
    f: DepsFixture,
    opts: { events: boolean; gate: boolean },
  ): Bun.Subprocess<"ignore", "ignore", "ignore"> {
    return Bun.spawn([f.launcher, "status"], {
      env: f.env(opts),
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
      detached: true,
    });
  }

  /** SIGKILLs the process group `p` leads; a group already gone is fine. */
  function killGroup(p: { pid: number }): void {
    try {
      process.kill(-p.pid, "SIGKILL");
    } catch {
      // ESRCH: every process of the group has ended
    }
  }

  test("依存の無い写しに 3 つ同時に起動すると、入れ込みは 1 回で、全部がその後に CLI を走らせて成功する", async () => {
    const f = makeDepsFixture();
    const procs: Bun.Subprocess<"ignore", "ignore", "ignore">[] = [];
    const start = (): void => {
      procs.push(spawnLauncher(f, { events: true, gate: true }));
    };
    const events = await openEvents(f);
    const next = events.next;
    try {
      start();
      expect(await next(1)).toEqual(["lock"]);
      expect(await next(1)).toEqual(["install-start"]);
      expect(fs.existsSync(path.join(f.root, "node_modules"))).toBe(true);

      // 入れ込みの途中 (node_modules は在り、済んだ印は無い) に 2 つ来る。
      // 2 つとも排他の待ちに入り、CLI を走らせない。
      start();
      expect(await next(1)).toEqual(["lock"]);
      start();
      expect(await next(1)).toEqual(["lock"]);

      await releaseGate(f);
      expect(await next(3)).toEqual(["run", "run", "run"]);
      const codes = await Promise.all(procs.map((p) => p.exited));
      expect(codes).toEqual([0, 0, 0]);

      const log = logLines(f);
      expect(log.filter((k) => k === "install-start")).toHaveLength(1);
      const end = log.indexOf("install-end");
      expect(end).toBeGreaterThan(-1);
      expect(log.slice(end + 1).filter((k) => k === "run")).toHaveLength(3);
      expect(fs.existsSync(path.join(f.root, "node_modules", DEPS_MARKER))).toBe(true);
    } finally {
      for (const p of procs) killGroup(p);
      await events.close();
      f.cleanup();
    }
  }, 30_000);

  test("入れ込みの途中で launcher ごと殺された後の次の呼び出しは、入れ込みをやり直してから CLI を走らせる", async () => {
    const f = makeDepsFixture();
    const events = await openEvents(f);
    const next = events.next;
    const a = spawnLauncher(f, { events: true, gate: true });
    try {
      expect(await next(1)).toEqual(["lock"]);
      expect(await next(1)).toEqual(["install-start"]);
      killGroup(a);
      await a.exited;

      // 殺された入れ込みは node_modules を残し、済んだ印を残さない
      expect(fs.existsSync(path.join(f.root, "node_modules"))).toBe(true);
      expect(fs.existsSync(path.join(f.root, "node_modules", DEPS_MARKER))).toBe(false);

      const b = spawnLauncher(f, { events: false, gate: false });
      expect(await b.exited).toBe(0);
      const log = logLines(f);
      expect(log.filter((k) => k === "install-start")).toHaveLength(2);
      expect(log.slice(-2)).toEqual(["install-end", "run"]);
      expect(fs.existsSync(path.join(f.root, "node_modules", DEPS_MARKER))).toBe(true);
    } finally {
      killGroup(a);
      await events.close();
      f.cleanup();
    }
  }, 30_000);

  test("入れ込みが済んでいれば、排他も入れ込みも呼ばずに CLI を走らせる", async () => {
    const f = makeDepsFixture();
    try {
      fs.mkdirSync(path.join(f.root, "node_modules"));
      fs.writeFileSync(path.join(f.root, "node_modules", DEPS_MARKER), "");
      const p = spawnLauncher(f, { events: false, gate: false });
      expect(await p.exited).toBe(0);
      expect(logLines(f)).toEqual(["run"]);
    } finally {
      f.cleanup();
    }
  }, 30_000);
});
