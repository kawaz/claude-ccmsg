// subscribe の daemon 再起動透過化 (自動再接続) の E2E テスト。
// 仕様正本: docs/issue/2026-07-10-subscribe-daemon-restart-transparent-reconnect.md
//
// 何を保証するか:
//   1. daemon が再起動しても subscribe プロセスが exit せず、跨ぎ前後に
//      セッション宛てに送られた notify がそれぞれ 1 度ずつ stdout に現れる
//      (= 再接続した subscribe が再び配信を受ける)。
//   2. `restarting` は stdout に流れない (= 上流 Monitor に接続制御ノイズを
//      見せない)。
//   3. daemon stop 後の subscribe は daemon を **spawn しない** (= 意図的な
//      停止を長寿命 subscribe が resurrection しない no-spawn 契約)。
//
// 手法: 実バイナリを subprocess で起動し、実 daemon を跨がせる。テスト内で
// spawn/kill する経路は既存 packages/daemon/test/helpers.ts と同型。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { CliStatusSchema, jsonObjectLine, printed, served } from "./cli-output.ts";
import { type JsonObject } from "@ccmsg/protocol";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/src/index.ts", import.meta.url));

interface CliResult {
  out: string;
  err: string;
  code: number;
}

async function runCli(args: string[], env: Record<string, string>): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const out = await new Response(proc.stdout).text();
  const err = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return { out, err, code };
}

interface TestEnv {
  env: Record<string, string>;
  sock: string;
  cleanup: () => void;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-rc-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  return {
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: path.join(dataDir, "config"),
      CCMSG_DATA_DIR: dataDir,
      // Pin every spawned CLI to this working copy even if PATH has a newer install.
      CCMSG_NO_SELF_EXEC: "1",
      // HTTP off で並列 test の port 衝突を避ける (daemon helpers.ts と同じ理由)。
      CCMSG_HTTP_BIND: "off",
      // ensure-daemon の spawn 経路は bun test 下では argv[1] を test runner に
      // 誤認するため、DAEMON_ENTRY を明示指定する (client.ts の Design rationale 参照)。
      CCMSG_DAEMON_ENTRY: DAEMON_ENTRY,
    },
    sock: path.join(stateDir, "daemon.sock"),
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

/**
 * subprocess の stdout を行単位で読み、predicate を満たす行が現れるまで待つ。
 * 見つかったら見た行の配列と一緒に返す。timeout ミスは bun test のケース全体の
 * timeout に任せる (= 期待 event が来なければテストが timeout で fail する)。
 */
interface LineReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  releaseLock(): void;
}
async function waitForLine(
  reader: LineReader,
  accum: { buf: string; lines: string[] },
  pred: (line: string) => boolean,
): Promise<string> {
  const dec = new TextDecoder();
  for (;;) {
    // 既に buffered な行から探す
    while (true) {
      const idx = accum.buf.indexOf("\n");
      if (idx < 0) break;
      const line = accum.buf.slice(0, idx);
      accum.buf = accum.buf.slice(idx + 1);
      accum.lines.push(line);
      if (pred(line)) return line;
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("subscribe stdout closed unexpectedly");
    accum.buf += dec.decode(value, { stream: true });
  }
}

describe("ccmsg subscribe daemon restart transparency", () => {
  test("daemon 再起動を跨いで subscribe が生存し、跨ぎ前後の notify がそれぞれ 1 度ずつ stdout に出る", async () => {
    const { env, sock, cleanup } = makeEnv();
    const SUB = "5b000000-0000-4000-8000-000000000000";
    try {
      // subscribe を長寿命 subprocess として起動 (実 CLI 経路)。session role にして
      // peers から hello 完了を観測でき、SUB 宛ての notify を受ける。
      const sub = Bun.spawn([process.execPath, CLI, "subscribe"], {
        env: {
          ...process.env,
          ...env,
          CCMSG_SID: SUB,
          CLAUDE_CODE_SESSION_ID: "",
          CLAUDE_SESSION_ID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      const reader = sub.stdout.getReader();
      const accum: { buf: string; lines: string[] } = { buf: "", lines: [] };
      const parsed = (l: string): JsonObject => jsonObjectLine(l) ?? {};
      const isNotify =
        (text: string) =>
        (l: string): boolean => {
          const ev = parsed(l);
          return ev.ev === "notify" && ev.text === text;
        };
      /** SUB 宛ての notify を、subscribe が受けられる状態になるまで (配信先が
       * 1 つになるまで) 送り直す。subscribe は peers に現れた後に subscribe
       * request を送るので、その間に送った notify は配信先 0 で返る。 */
      const notifySub = async (text: string): Promise<void> => {
        for (let i = 0; i < 200; i++) {
          const res = served(
            "notify",
            (await runCli(["--sid", SUB, "notify", "--text", text], env)).out,
          );
          if (res.delivered === 1) return;
          await sleep(25);
        }
        throw new Error(`notify "${text}" never reached the subscribe`);
      };

      try {
        // 跨ぎ前: SUB 宛ての notify が stdout に現れる。
        await notifySub("before");
        await waitForLine(reader, accum, isNotify("before"));

        // 跨ぎ: daemon を stop → 別コマンドで re-spawn する (ensureDaemon 経路)。
        // subscribe subprocess は生存し続けるはず。
        const stopped = printed(CliStatusSchema, (await runCli(["daemon", "stop"], env)).out);
        expect(stopped.stopped).toBe(true);
        // socket 消失を確認: daemon.sock が無い状態で subscribe が再接続失敗を
        // 吸収して spawn しないことも兼ねて観測する。
        expect(fs.existsSync(sock)).toBe(false);

        // 再 spawn: `peers` 呼び出しの ensureDaemon が新 daemon を起動する。
        expect(served("peers", (await runCli(["peers"], env)).out).ok).toBe(true);

        // 跨ぎ後: subscribe が自動再接続して SUB 宛ての notify を受信する。
        await notifySub("after");
        await waitForLine(reader, accum, isNotify("after"));

        // 契約 (a): subscribe subprocess が exit していない (= 透過再接続が成功)。
        expect(sub.exitCode).toBeNull();

        // 契約 (b): 跨ぎ前の notify が再接続で重ねて出ていない。
        expect(accum.lines.filter(isNotify("before"))).toHaveLength(1);

        // 契約 (c): 接続制御イベント (restarting) が stdout に流れていない。
        expect(accum.lines.filter((l) => parsed(l).ev === "restarting")).toEqual([]);
      } finally {
        reader.releaseLock();
        try {
          sub.kill();
        } catch {
          // already gone
        }
        await sub.exited;
      }
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  test("daemon stop 中の subscribe は daemon を spawn しない (no-spawn 契約)", async () => {
    // 「何を保証するか」: 意図的な `ccmsg daemon stop` を長寿命 subscribe が
    // resurrection しないこと。initial の ensureDaemon 経路で 1 度だけ spawn し、
    // その daemon を止めたら再接続は attach 試行だけに徹する契約。
    const { env, sock, cleanup } = makeEnv();
    try {
      // ここでは subscribe subprocess を起動する **前に** daemon が居ない状態
      // にはできない (subscribe 初回接続で ensureDaemon が spawn するのが仕様)。
      // 代わりに: subscribe 起動 → daemon stop → しばらく待って daemon 不在維持
      // を確認、という順で検証する。

      // 改修前は --as-user で明示的に u1 として subscribe していた。改修後は sid
      // 環境変数を空にすることで CLI の u1 fallback (subscribe だけ許容) に乗る。
      const sub = Bun.spawn([process.execPath, CLI, "subscribe"], {
        env: {
          ...process.env,
          ...env,
          CCMSG_SID: "",
          CLAUDE_CODE_SESSION_ID: "",
          CLAUDE_SESSION_ID: "",
        },
        stdout: "pipe",
        stderr: "pipe",
      });
      try {
        // subscribe が initial spawn+subscribe を完了するまで少し待つ
        // (= daemon.sock が現れる)。
        for (let i = 0; i < 100; i++) {
          if (fs.existsSync(sock)) break;
          await sleep(25);
        }
        expect(fs.existsSync(sock)).toBe(true);

        // status で running=true を先に固定 (= subscribe が initial ensureDaemon
        // を完走した証拠)。
        const st1 = printed(CliStatusSchema, (await runCli(["status"], env)).out);
        expect(st1.running).toBe(true);

        // daemon stop。daemon.sock が消える。
        await runCli(["daemon", "stop"], env);
        expect(fs.existsSync(sock)).toBe(false);

        // no-spawn 契約: 6s 待って (backoff 最長 5s + margin) socket が
        // **依然として無い** ことを確認する。subscribe が resurrection してたら
        // ここで socket が生えている。
        await sleep(6000);
        expect(fs.existsSync(sock)).toBe(false);

        // status も running=false のまま (連鎖 spawn していないことの追証)。
        const st2 = printed(CliStatusSchema, (await runCli(["status"], env)).out);
        expect(st2.running).toBe(false);

        // subprocess はまだ生きている (= 再接続失敗を fatal 化していない)。
        expect(sub.exitCode).toBeNull();
      } finally {
        try {
          sub.kill();
        } catch {
          // already gone
        }
        await sub.exited;
      }
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);
});
