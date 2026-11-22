// 回帰テスト: daemon は spawn 元セッションの process group から独立する
// (kawaz 実測 2026-08-19/20: PC 再起動後、webui の初回リスナーだった hyoui
// セッションが落ちたら daemon ごと死んだ)。
//
// 原因: `spawnDaemon` (client.ts) の Bun.spawn が `detached` を指定していなかった
// ため、子 (daemon) は親と同一 process group を継承する (実測で確認: Bun.spawn の
// 既定は setpgid しない、Node の child_process と同じ挙動)。hyoui のようなセッション
// マネージャがセッション終了時に process group ごと signal すると、その group に
// 居合わせただけの daemon も巻き込まれて死ぬ。`detached: true` を渡すと daemon は
// 自分自身が leader の新しい process group (pgid == pid) になり、生成元セッションの
// group への signal から独立する。
//
// 検証方法: daemon を spawn する CLI 呼び出し自体を「独立した process group」に
// detached で起動し、その CLI プロセスの pgid へ SIGKILL を送る。修正前なら daemon
// も同じ group の一員として巻き込まれて死ぬ。修正後は daemon が別 group にいるため
// 生存し続ける (呼び出し元 CLI プロセスは既に exit 済みなので、group が空なら
// kill(-pgid) は ESRCH — それ自体が「daemon がこの group にいない」証拠)。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { testHomeEnv } from "../../daemon/test/helpers.ts";

const CLI = fileURLToPath(new URL("../src/index.ts", import.meta.url));
const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/src/index.ts", import.meta.url));

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** daemon の socket に繋いだ接続。daemon は停止の途中で既存の接続を閉じず、プロセスが
 * 終わった時に kernel が閉じる (shutdownDaemon)。`gone` はその close で解ける、daemon
 * プロセスが本当に終わったことの通知 (daemon は子プロセスではなく wait できない)。 */
function watchDaemonExit(sock: string): Promise<{ gone: Promise<void> }> {
  return new Promise((resolve, reject) => {
    const conn = net.createConnection(sock);
    const gone = new Promise<void>((res) => conn.once("close", () => res()));
    conn.once("error", reject);
    conn.once("connect", () => {
      conn.on("data", () => {});
      resolve({ gone });
    });
  });
}

describe("daemon process-group detachment", () => {
  test("spawn 元セッションの process group が signal されても daemon は生存する", async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-detach-"));
    const stateDir = path.join(base, "s");
    const dataDir = path.join(base, "d");
    fs.mkdirSync(stateDir);
    fs.mkdirSync(dataDir);
    const env = {
      ...process.env,
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: path.join(dataDir, "config"),
      CCMSG_DATA_DIR: dataDir,
      ...testHomeEnv(dataDir),
      CCMSG_HTTP_BIND: "off",
      CCMSG_DAEMON_ENTRY: DAEMON_ENTRY,
    };
    let daemonPid: number | undefined;
    let daemonGone: Promise<void> | undefined;
    try {
      // CLI 呼び出し自体を新規 process group (leader = このプロセス自身) として
      // 起動する — hyoui が張る「セッションのプロセス群」の代役。この呼び出しが
      // ensureDaemon 経由で daemon を spawn する。
      const cli = Bun.spawn([process.execPath, CLI, "peers"], {
        env,
        stdout: "ignore",
        stderr: "ignore",
        detached: true,
      });
      const cliPid = cli.pid;
      const code = await cli.exited;
      expect(code).toBe(0);

      // daemon が起動し pid ファイルを書くまで待つ (spawn 直後は race がある)。
      const pidFile = path.join(stateDir, "daemon.pid");
      for (let i = 0; i < 50 && !fs.existsSync(pidFile); i++) await sleep(100);
      expect(fs.existsSync(pidFile)).toBe(true);
      daemonPid = Number(fs.readFileSync(pidFile, "utf8").trim());
      expect(isAlive(daemonPid)).toBe(true);
      daemonGone = (await watchDaemonExit(path.join(stateDir, "daemon.sock"))).gone;

      // 「セッション終了」を模した process group signal。修正前の daemon は
      // この group の一員なので巻き込まれて死ぬ。ESRCH ("No such process") は
      // 修正後の正常系 (= group が空、daemon はもう居ない) なので許容する。
      try {
        process.kill(-cliPid, "SIGKILL");
      } catch (e) {
        expect(e).toMatchObject({ code: "ESRCH" });
      }
      await sleep(300);

      expect(isAlive(daemonPid)).toBe(true);
    } finally {
      if (daemonPid !== undefined && isAlive(daemonPid)) {
        try {
          process.kill(daemonPid, "SIGTERM");
        } catch {
          // already gone
        }
        // daemon は止まる途中で state dir に書く。終わったのを待ってから消す。
        await daemonGone;
      }
      fs.rmSync(base, { recursive: true, force: true });
    }
  }, 30000);
});
