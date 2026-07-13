// subscribe の daemon 再起動透過化 (自動再接続) の E2E テスト。
// 仕様正本: docs/issue/2026-07-10-subscribe-daemon-restart-transparent-reconnect.md
//
// 何を保証するか:
//   1. daemon が再起動しても subscribe プロセスが exit せず、跨ぎ前後で
//      post された msg が **漏れなく重複なく** stdout に現れる (= since 状態を
//      維持した再 subscribe で BBS delta が成立する)。
//   2. `restarting` event は stdout に流れない (= 上流 Monitor に「張り直せ」
//      ノイズを見せないのが本改修の目的)。
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
      CCMSG_DATA_DIR: dataDir,
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
  test("daemon 再起動を跨いで subscribe が生存し、跨ぎ前後の post が両方 stdout に出る (restarting は出ない)", async () => {
    const { env, sock, cleanup } = makeEnv();
    try {
      // Setup: 別 session CREATOR が --exclude-self で S1 のみ member の room を
      // 作成する (CLI の write ops は identity 必須になったので、u1 として
      // create-room する経路は廃止。u1 は暗黙参加のため subscribe には引き続き
      // 届く)。改修前は --as-user create-room で同型の room を作っていた。
      const created = JSON.parse(
        (
          await runCli(
            ["--sid", "CREATOR", "create-room", "--members", "S1", "--exclude-self"],
            env,
          )
        ).out,
      ) as { ok: boolean; room: string };
      expect(created.ok).toBe(true);
      const room = created.room;

      // subscribe を長寿命 subprocess として起動 (実 CLI 経路)。sid 環境変数を
      // 一切 export しないので CLI は u1 として hello し、u1 は全 room に暗黙参加
      // (DR-0003 §5) なので room 開設・S1 の post が subscribe に届く。stderr に
      // 「subscribing as u1」警告が出るが stdout は pure jsonl。
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
      const reader = (sub.stdout as ReadableStream<Uint8Array>).getReader();
      const accum = { buf: "", lines: [] as string[] };

      try {
        // 跨ぎ前: S1 が post。u1 の subscribe stdout に msg が現れることを確認。
        const posted1 = JSON.parse(
          (await runCli(["--sid", "S1", "post", room, "hello-before"], env)).out,
        ) as { ok: boolean; mid: number };
        expect(posted1.ok).toBe(true);
        expect(posted1.mid).toBe(1);
        const line1 = await waitForLine(reader, accum, (l) => {
          try {
            const ev = JSON.parse(l) as { type?: string; msg?: string };
            return ev.type === "msg" && ev.msg === "hello-before";
          } catch {
            return false;
          }
        });
        expect(JSON.parse(line1).mid).toBe(1);

        // 跨ぎ: daemon を stop → 別コマンドで re-spawn する (ensureDaemon 経路)。
        // subscribe subprocess は生存し続けるはず。
        const stopped = JSON.parse((await runCli(["daemon", "stop"], env)).out) as {
          stopped?: boolean;
        };
        expect(stopped.stopped).toBe(true);
        // subscribe の再接続 backoff を跨ぐため少し待つ (initial 250ms)。
        // ここで socket 消失を確認: daemon.sock が無い状態で subscribe が
        // 再接続失敗を吸収して spawn しないことも兼ねて観測する。
        expect(fs.existsSync(sock)).toBe(false);

        // 再 spawn: `rooms` 呼び出しの ensureDaemon が新 daemon を起動する。
        const roomsAfter = JSON.parse((await runCli(["rooms"], env)).out) as {
          ok: boolean;
          rooms: { id: string }[];
        };
        expect(roomsAfter.ok).toBe(true);
        expect(roomsAfter.rooms.map((r) => r.id)).toContain(room);

        // 跨ぎ後: S1 が別の post。subscribe が自動再接続で受信することを確認。
        const posted2 = JSON.parse(
          (await runCli(["--sid", "S1", "post", room, "hello-after"], env)).out,
        ) as { ok: boolean; mid: number };
        expect(posted2.ok).toBe(true);
        expect(posted2.mid).toBe(2);
        const line2 = await waitForLine(reader, accum, (l) => {
          try {
            const ev = JSON.parse(l) as { type?: string; msg?: string };
            return ev.type === "msg" && ev.msg === "hello-after";
          } catch {
            return false;
          }
        });
        expect(JSON.parse(line2).mid).toBe(2);

        // 契約 (a): subscribe subprocess が exit していない (= 透過再接続が成功)。
        expect(sub.exitCode).toBeNull();

        // 契約 (b): `hello-before` の重複配信が起きていない。since 状態を維持
        // した再 subscribe が daemon 側の sendBacklog を「未受信ぶんだけ」に絞る
        // ことの検証 (BBS delta model)。lines 全体を走査して mid=1 の msg が
        // 1 回だけ現れる (=重複なし) ことを確認する。
        const msg1Count = accum.lines.filter((l) => {
          try {
            const ev = JSON.parse(l) as { type?: string; mid?: number };
            return ev.type === "msg" && ev.mid === 1;
          } catch {
            return false;
          }
        }).length;
        expect(msg1Count).toBe(1);

        // 契約 (c): `restarting` event が stdout に流れていない。
        // 上流 Monitor に「張り直せ」ノイズを見せないための不変条件。
        const restartingCount = accum.lines.filter((l) => {
          try {
            const ev = JSON.parse(l) as { ev?: string };
            return ev.ev === "restarting";
          } catch {
            return false;
          }
        }).length;
        expect(restartingCount).toBe(0);
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
        const st1 = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
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
        const st2 = JSON.parse((await runCli(["status"], env)).out) as { running: boolean };
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
