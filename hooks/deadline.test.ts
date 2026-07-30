// hook プロセスの「寿命」に関する test。
//
// ここで測っているのは戻り値ではなく **プロセスがいつ死ぬか**。hook が turn を
// 待たせる時間は main() が答えを出すまでではなく process が exit するまでなので、
// 「関数は 87ms で返るがプロセスは 1003ms 生きている」類の乖離は在来の
// unit test をすべて green にしたまま毎ターンのコストになる (実際そうなっていた)。
// したがって全 case を subprocess で走らせ、時刻はプロセス内部で自己計測させる。
//
// 閾値は wall clock の絶対値ではなく **「仕事が終わってから exit するまでの差分」**
// に置く。bun の起動や mock の spawn は高負荷下で数百 ms ぶれるが、この差分は
// ぶれの外側にあるので並列実行下でも安定する。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMockBin } from "../packages/testkit/src/mock-bin.ts";

const HOOKS_DIR = import.meta.dir;
// subprocess を spawn する test 群。bun 既定の 5000ms では 8 秒 hang する mock を
// 相手にした case (= 修正前の挙動) が先に打ち切られてしまうため広げる。
const spawnTest = (name: string, fn: () => Promise<void>) => test(name, fn, 30_000);

/** probe script を temp dir に書いて実行し、stdout/stderr と wall clock を返す。 */
async function runProbe(source: string): Promise<{ stdout: string; stderr: string; ms: number }> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-deadline-"));
  try {
    const file = path.join(dir, "probe.ts");
    fs.writeFileSync(file, source);
    const start = Date.now();
    const proc = Bun.spawn(["bun", "run", file], {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    await proc.exited;
    return { stdout, stderr, ms: Date.now() - start };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** probe が `console.error("<key>", <ms>)` で出した自己計測値を拾う。 */
function marker(stderr: string, key: string): number {
  const m = stderr.match(new RegExp(`^${key} (\\d+)$`, "m"));
  if (!m) throw new Error(`probe が ${key} を出さなかった: ${stderr}`);
  return Number(m[1]);
}

describe("hook プロセスの寿命", () => {
  // 修正前: getRepoWsFromVcs は 87ms で返るのにプロセスは 1003ms 生きていた
  // (raceExit が負けた側の setTimeout を clear していなかったため、共通デッド
  // ラインいっぱいまで event loop が保持される)。SessionStart 毎回と、state file
  // 救済が走る UserPromptSubmit のターンが丸ごとこれを払っていた。
  spawnTest("getRepoWsFromVcs は応答後に event loop を掴み続けない", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-deadline-bin-"));
    try {
      const bin = writeMockBin(
        path.join(dir, "fake-bump-semver"),
        `#!/bin/sh
case "$3" in
  backend) echo jj ;;
  root) echo "${dir}/repo/main" ;;
  worktree-name) echo main ;;
  current-branch) echo main ;;
  repository) echo "kawaz/repo" ;;
  *) exit 2 ;;
esac
`,
      );
      const { stderr } = await runProbe(`
        import { getRepoWsFromVcs } from ${JSON.stringify(path.join(HOOKS_DIR, "session-start.ts"))};
        const t0 = Date.now();
        process.on("exit", () => console.error("exit_ms", Date.now() - t0));
        await getRepoWsFromVcs(${JSON.stringify(dir)}, { bin: ${JSON.stringify(bin)}, timeoutMs: 10000 });
        console.error("work_ms", Date.now() - t0);
      `);
      // 予算 10s のうち実際に使うのは 5 回の spawn 分だけ。修正前はここが
      // 予算いっぱい (10s) まで開いていた。
      expect(marker(stderr, "exit_ms") - marker(stderr, "work_ms")).toBeLessThan(500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // 修正前: deadline で kill() しても子が SIGTERM を無視すると、放棄した stdout の
  // 読み取りがパイプを開いたままにするため、raceExit が 1000ms で返った後もプロセスは
  // 子が死ぬまで (実測 8328ms) 生きていた。max 21s 級の hook はこの経路。
  spawnTest("deadline を無視する子プロセスがプロセスを道連れにしない", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-deadline-bin-"));
    try {
      // SIGTERM を無視して 8 秒 stdout を握り続ける = repo lock 待ちで固まった
      // bump-semver の代役。
      const bin = writeMockBin(
        path.join(dir, "stuck-bump-semver"),
        "#!/bin/sh\ntrap '' TERM\nsleep 8\necho jj\n",
      );
      const { stderr } = await runProbe(`
        import { getRepoWsFromVcs } from ${JSON.stringify(path.join(HOOKS_DIR, "session-start.ts"))};
        const t0 = Date.now();
        process.on("exit", () => console.error("exit_ms", Date.now() - t0));
        await getRepoWsFromVcs(${JSON.stringify(dir)}, { bin: ${JSON.stringify(bin)}, timeoutMs: 500 });
        console.error("work_ms", Date.now() - t0);
      `);
      expect(marker(stderr, "exit_ms") - marker(stderr, "work_ms")).toBeLessThan(1500);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // armHookDeadline は「列挙できない hang」用の最後の砦。閉じられない stdin や
  // kill を生き延びた子など、個別に timeout を付けられなかった経路をまとめて塞ぐ。
  spawnTest("armHookDeadline は event loop が塞がっていても exit させる", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-deadline-bin-"));
    try {
      const bin = writeMockBin(path.join(dir, "hang"), "#!/bin/sh\nsleep 8\n");
      const { stderr, ms } = await runProbe(`
        import { armHookDeadline } from ${JSON.stringify(path.join(HOOKS_DIR, "deadline.ts"))};
        const t0 = Date.now();
        process.on("exit", () => console.error("exit_ms", Date.now() - t0));
        armHookDeadline(800);
        const proc = Bun.spawn([${JSON.stringify(bin)}], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
        await new Response(proc.stdout).text();
        console.error("never_ms", Date.now() - t0);
      `);
      expect(stderr).not.toContain("never_ms");
      expect(marker(stderr, "exit_ms")).toBeLessThan(4000);
      expect(ms).toBeLessThan(6000); // 修正前相当の 8s hang に対する上限
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  // armHookDeadline は unref'd。仕事が先に終わったならプロセスを引き延ばしては
  // ならない (= watchdog 自体が新たな linger 源にならないこと)。
  spawnTest("armHookDeadline は仕事が先に終わればプロセスを引き延ばさない", async () => {
    const { stderr } = await runProbe(`
      import { armHookDeadline } from ${JSON.stringify(path.join(HOOKS_DIR, "deadline.ts"))};
      const t0 = Date.now();
      process.on("exit", () => console.error("exit_ms", Date.now() - t0));
      armHookDeadline(5000);
    `);
    expect(marker(stderr, "exit_ms")).toBeLessThan(1000);
  });

  // exitHook は event loop の drain を待たずに殺すので、hook の唯一の成果物である
  // stdout が切り捨てられないことが前提条件になる (process.stdout.write では
  // pipe 相手にバッファが残りうる)。長さのある payload で確認する。
  spawnTest("exitHook は exit 前に stdout を出し切る", async () => {
    const payload = "x".repeat(100_000);
    const { stdout } = await runProbe(`
      import { exitHook } from ${JSON.stringify(path.join(HOOKS_DIR, "deadline.ts"))};
      await exitHook(${JSON.stringify(payload)});
      console.log("UNREACHABLE");
    `);
    expect(stdout).toBe(payload);
  });
});
