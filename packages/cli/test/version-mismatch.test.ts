// DR-0002 §4 の client-driven version upgrade 経路の自動テスト。
//
// 何を保証するのか:
//   1. 旧 version を名乗る daemon が常駐しているとき、新 version の client が
//      ensureDaemon 経由で接続すると、旧 daemon が graceful shutdown され新 daemon
//      に差し替わって新 version の hello 応答が返る (= 正常系の upgrade 経路)。
//   2. shutdown 中の daemon が **接続中のクライアント** に `{ev:"restarting", reason:"upgrade"}`
//      を broadcast する (= DR-0002 §4 の restarting 通知契約、sidecar 再接続の起点)。
//   3. version が一致していれば daemon は再起動しない (= 誤爆しない側の輪郭、
//      毎ターン hook の常時 ensure がコストゼロで済むための不変条件)。
//   4. daemon が client より新しい (= client が古い) 場合も daemon は再起動しない
//      (= newer-wins ポリシー、docs/issue/2026-07-10-daemon-version-flapping-on-gradual-rollout.md。
//      gradual rollout 中の新旧混在で降格・昇格の綱引きが起きないための不変条件)。
//
// テスト用シームの根拠 (Design rationale):
// - CCMSG_VERSION_OVERRIDE: 旧 version の実バイナリを別途用意しなくても
//   subprocess に synthetic version を名乗らせるため。version.ts に説明あり。
// - CCMSG_DAEMON_ENTRY: bun test では process.argv[1] が test runner を指すため、
//   client 側 daemonSpawnCmd の自動判定に頼らず daemon entry を明示する。
//   client.ts に説明あり。
// 両者とも本番コードは設定しない env-var で、既存の CCMSG_STATE_DIR 系と同じ形。
// 代替 (module mock / DI パラメータ) は本番シグネチャに test 都合を漏らすため不採用。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { VERSION, resolvePaths } from "@ccmsg/protocol";
import { ensureDaemon } from "../src/client.ts";
import {
  connect,
  spawnDaemonProc,
  waitConnectable,
  type TestClient,
} from "../../daemon/test/helpers.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/src/index.ts", import.meta.url));
const OLD_VERSION = "0.0.0-old-for-test";
const T = 15000;

interface Env {
  base: string;
  stateDir: string;
  dataDir: string;
  sock: string;
  pidFile: string;
  restoreEnv: () => void;
}

function setupEnv(): Env {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-vm-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  // 親プロセス (この test) の env を書き換える理由: ensureDaemon 内 spawnDaemon が
  // 子 daemon に process.env をそのまま渡すため、respawn される新 daemon が
  // temp dir を見るには親側 env に置く必要がある。テスト終了時に restore する。
  const prev = {
    CCMSG_STATE_DIR: process.env.CCMSG_STATE_DIR,
    CCMSG_DATA_DIR: process.env.CCMSG_DATA_DIR,
    CCMSG_DAEMON_ENTRY: process.env.CCMSG_DAEMON_ENTRY,
    CCMSG_VERSION_OVERRIDE: process.env.CCMSG_VERSION_OVERRIDE,
  };
  process.env.CCMSG_STATE_DIR = stateDir;
  process.env.CCMSG_DATA_DIR = dataDir;
  process.env.CCMSG_DAEMON_ENTRY = DAEMON_ENTRY;
  // 親側で override を設定してはいけない (= 親 = "新 version" client 役)。
  delete process.env.CCMSG_VERSION_OVERRIDE;
  const restoreEnv = (): void => {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
  return {
    base,
    stateDir,
    dataDir,
    sock: path.join(stateDir, "daemon.sock"),
    pidFile: path.join(stateDir, "daemon.pid"),
    restoreEnv,
  };
}

async function cleanup(env: Env): Promise<void> {
  // 残っている daemon を落として temp dir を破棄。テスト失敗時にも呼ぶ。
  try {
    const c = await connect(env.sock);
    await c.request({ op: "shutdown" });
    c.close();
    // shutdown が届き socket が消えるまで少し待つ (poll は helpers 側にあり)
    for (let i = 0; i < 20; i++) {
      if (!fs.existsSync(env.sock)) break;
      await new Promise((r) => setTimeout(r, 25));
    }
  } catch {
    // 既に居ない
  }
  try {
    fs.rmSync(env.base, { recursive: true, force: true });
  } catch {
    // best effort
  }
  env.restoreEnv();
}

function readPid(pidFile: string): number | null {
  try {
    const raw = fs.readFileSync(pidFile, "utf8").trim();
    const n = Number(raw);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

describe("DR-0002 §4 version mismatch upgrade", () => {
  let env: Env;
  beforeEach(() => {
    env = setupEnv();
  });
  afterEach(async () => {
    await cleanup(env);
  });

  test(
    "旧 version daemon が新 version client の接続で自動 upgrade される",
    async () => {
      // 「本テストが検出すべき仕様」: version.ts の実 VERSION と一致しない override
      // でなければ mismatch 経路を通らないので、事前に等しくないことを assert。
      expect(OLD_VERSION).not.toBe(VERSION);

      // 旧 version の daemon を先に立てる (subprocess の env に override を注入)。
      const oldProc = spawnDaemonProc(env.stateDir, env.dataDir, {
        CCMSG_VERSION_OVERRIDE: OLD_VERSION,
      });
      await waitConnectable(env.sock);
      const oldPid = readPid(env.pidFile);
      expect(oldPid).not.toBeNull();

      // 新 version 側の client として ensureDaemon を呼ぶ。
      const paths = resolvePaths();
      const client = await ensureDaemon(paths, {
        role: "session",
        sid: "S-upgrade",
        repo: "r",
        ws: "w",
        cwd: "/tmp",
      });

      // ensureDaemon が完了した時点で、繋がっている daemon の version は現行 VERSION
      // でなければならない (= mismatch を検知 → shutdown → respawn が完走した証拠)。
      // ping で version を確認するのが自然 (hello の応答値は ensureDaemon 内部で消費済み)。
      const pong = await client.request<{ ok: boolean; version: string; pid: number }>({
        op: "ping",
      });
      expect(pong.ok).toBe(true);
      expect(pong.version).toBe(VERSION);

      // 旧 daemon プロセスが実際に exit していること (= graceful shutdown が届いた)。
      await oldProc.exited;
      expect(oldProc.exitCode).toBe(0);

      // 新 daemon の PID は旧 PID と別 (= 同一プロセスが version を持ち替えたのではなく
      // 本当に「差し替わった」ことの直接的証拠)。
      const newPid = readPid(env.pidFile);
      expect(newPid).not.toBeNull();
      expect(newPid).not.toBe(oldPid);
      expect(pong.pid).toBe(newPid!);

      client.close();
    },
    T,
  );

  test(
    "shutdown 時に接続中クライアントへ restarting 通知が broadcast される",
    async () => {
      // 「何を保証するか」: DR-0002 §4 の restarting 通知は sidecar 自動再接続の起点。
      // これが飛ばなければ sidecar は shutdown を検知できず、上流仕様に穴が空く。

      const oldProc = spawnDaemonProc(env.stateDir, env.dataDir, {
        CCMSG_VERSION_OVERRIDE: OLD_VERSION,
      });
      await waitConnectable(env.sock);

      // 事前に user role で接続 + subscribe しておく (= 「接続中の他クライアント」役)。
      const watcher: TestClient = await connect(env.sock);
      const helloRes = await watcher.hello({ role: "user" });
      expect(helloRes.ok).toBe(true);
      // subscribe しなくても gracefulShutdown は connections 全部に flush するが、
      // 実運用の sidecar は subscribe 済み前提なのでその条件を再現する。
      await watcher.request({ op: "subscribe" });

      // 別スレッドで restarting event を待つ。ensureDaemon 完了より先に来ることも
      // 後になることもあるので Promise で並行に受ける。
      const restartingSeen = watcher.readEventUntil((ev) => ev?.ev === "restarting");

      // ensureDaemon で upgrade を発動。
      const paths = resolvePaths();
      const client = await ensureDaemon(paths, {
        role: "session",
        sid: "S-r",
        repo: "r",
        ws: "w",
        cwd: "/tmp",
      });

      const { ev } = await restartingSeen;
      // 通知 shape: {ev:"restarting", reason:"upgrade"}。reason は shutdown 送信時の
      // reason (= client.ts が "upgrade" 固定で送っている) をそのまま乗せる契約。
      expect(ev.ev).toBe("restarting");
      expect(ev.reason).toBe("upgrade");

      await oldProc.exited;
      watcher.close();
      client.close();
    },
    T,
  );

  test(
    "version 一致時は daemon を再起動しない (誤爆しない側の輪郭)",
    async () => {
      // 「何を保証するか」: 毎ターン hook の常時 ensure が「不必要な再起動を起こさない」
      // ことは DR-0002 §2 の軽量静寂チェック要件そのもの。ここが壊れると全 hook 呼び出し
      // ごとに daemon が生死を繰り返す最悪パターンに陥る。

      // override なしで daemon を起動 (= 現行 VERSION を名乗る)。
      const proc = spawnDaemonProc(env.stateDir, env.dataDir);
      await waitConnectable(env.sock);
      const pidBefore = readPid(env.pidFile);
      expect(pidBefore).not.toBeNull();

      const paths = resolvePaths();
      const client = await ensureDaemon(paths, {
        role: "session",
        sid: "S-noop",
        repo: "r",
        ws: "w",
        cwd: "/tmp",
      });

      // version 一致経路: ping の pid が起動時の PID と同一 = 同一プロセス継続。
      const pong = await client.request<{ ok: boolean; version: string; pid: number }>({
        op: "ping",
      });
      expect(pong.ok).toBe(true);
      expect(pong.version).toBe(VERSION);
      expect(pong.pid).toBe(pidBefore!);

      // proc がまだ生きている (= 再起動していない) ことを別経路でも確認: exited は
      // subprocess が終了したときに解決される Promise なので、Promise.race で
      // 短時間タイムアウトさせて「まだ生きている」を実測する。
      const stillAliveMarker = Symbol("alive");
      const raceResult = await Promise.race([
        proc.exited.then(() => "exited" as const),
        new Promise<typeof stillAliveMarker>((res) => setTimeout(() => res(stillAliveMarker), 100)),
      ]);
      expect(raceResult).toBe(stillAliveMarker);

      client.close();
    },
    T,
  );

  test(
    "daemon が新しい (client が古い) 場合は再起動しない (newer-wins ポリシー)",
    async () => {
      // 「何を保証するか」: gradual rollout 中に旧 client が新 daemon へ接続しても、
      // 旧 client 側が「version 不一致」を理由に新 daemon を降格させてはいけない
      // (docs/issue/2026-07-10-daemon-version-flapping-on-gradual-rollout.md)。
      // ここでは「daemon の方が client より新しい」を、実 VERSION より大きい
      // synthetic override ("99.0.0") を daemon に名乗らせることで再現する
      // (client 側はテストプロセスの実 VERSION のままで固定、それより確実に新しい
      // 数字を daemon 側に与えれば compareVersions(VERSION, hello.version) < 0 になる)。
      const FUTURE_VERSION = "99.0.0";
      const proc = spawnDaemonProc(env.stateDir, env.dataDir, {
        CCMSG_VERSION_OVERRIDE: FUTURE_VERSION,
      });
      await waitConnectable(env.sock);
      const pidBefore = readPid(env.pidFile);
      expect(pidBefore).not.toBeNull();

      const paths = resolvePaths();
      const client = await ensureDaemon(paths, {
        role: "session",
        sid: "S-newer-daemon",
        repo: "r",
        ws: "w",
        cwd: "/tmp",
      });

      // daemon はそのまま (= 降格されず FUTURE_VERSION を名乗り続け、pid も不変)。
      const pong = await client.request<{ ok: boolean; version: string; pid: number }>({
        op: "ping",
      });
      expect(pong.ok).toBe(true);
      expect(pong.version).toBe(FUTURE_VERSION);
      expect(pong.pid).toBe(pidBefore!);

      // proc がまだ生きていることも別経路で確認 (version 一致テストと同じ手法)。
      const stillAliveMarker = Symbol("alive");
      const raceResult = await Promise.race([
        proc.exited.then(() => "exited" as const),
        new Promise<typeof stillAliveMarker>((res) => setTimeout(() => res(stillAliveMarker), 100)),
      ]);
      expect(raceResult).toBe(stillAliveMarker);

      client.close();
    },
    T,
  );
});
