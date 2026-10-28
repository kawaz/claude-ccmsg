// `ccmsg daemon restart` の E2E テスト。
//
// 何を保証するか:
//   1. config.ts を編集して restart すると、新 daemon の hello capability に
//      編集後の設定が反映される (= 稼働中 daemon に設定変更を届ける手段が
//      成立している。設定は起動時 1 回読み (DR-0018 LN-Q4) なので、restart
//      でしか反映されない)。
//   2. daemon が居ない状態の restart は起動として成功する (restarted:false,
//      started:true) — 「現行設定の daemon が動いている状態にする」が要求。
//
// 接続中のサイドカーが入れ替わった daemon に名乗り直すことは sidecar.test.ts
// が見る。手法: 実 CLI を subprocess で起動し、temp dir の state/config/data
// を見る隔離 daemon を跨がせる。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../daemon/test/helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { CliStatusSchema, printed } from "./cli-output.ts";
import { runCli } from "./run-cli.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/src/index.ts", import.meta.url));

interface TestEnv {
  env: Record<string, string>;
  sock: string;
  configDir: string;
  cleanup: () => void;
}

function makeEnv(): TestEnv {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-restart-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  const configDir = path.join(dataDir, "config");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  fs.mkdirSync(configDir);
  return {
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: configDir,
      CCMSG_DATA_DIR: dataDir,
      CCMSG_HTTP_BIND: "off",
      CCMSG_NETWORK_WATCH: "off",
      CCMSG_DAEMON_ENTRY: DAEMON_ENTRY,
      // The session the CLI acts as is fixed here, never inherited: a test run
      // inside a Claude Code session would otherwise act as that session, and
      // one outside any session (CI) as none. Each write names its sender.
      CCMSG_SID: "",
      CLAUDE_CODE_SESSION_ID: "",
    },
    sock: path.join(stateDir, "daemon.sock"),
    configDir,
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

/** user role で hello して capability を読む。CLI は hello 応答を出力しないので、
 * 「設定が daemon に載ったか」は daemon へ直接 hello して確かめる。capability は
 * 真のときだけ載るキーなので、未設定は undefined として現れる。 */
async function helloCapabilities(sock: string): Promise<Record<string, unknown>> {
  const client = await connect(sock);
  try {
    return await client.request({
      op: "hello",
      role: "user",
      protocol: PROTOCOL_VERSION,
    });
  } finally {
    client.close();
  }
}

describe("ccmsg daemon restart", () => {
  test("config.ts の編集が restart で反映される", async () => {
    const { env, sock, configDir, cleanup } = makeEnv();
    try {
      // 設定なしで起動: llm_status_url 未設定 = capability キー自体が載らない。
      const started = printed(CliStatusSchema, (await runCli(["daemon", "start"], env)).out);
      expect(started.started).toBe(true);
      expect((await helloCapabilities(sock)).llm_status_available).toBeUndefined();

      // 稼働中に config.ts を書く。まだ反映されない (起動時 1 回読み)。
      fs.writeFileSync(
        path.join(configDir, "config.ts"),
        'export default { llm_status_url: "http://127.0.0.1:9/status" };\n',
      );
      expect((await helloCapabilities(sock)).llm_status_available).toBeUndefined();

      // restart で反映される。
      const restarted = printed(CliStatusSchema, (await runCli(["daemon", "restart"], env)).out);
      expect(restarted.ok).toBe(true);
      expect(restarted.restarted).toBe(true);
      expect(restarted.started).toBe(false);
      expect((await helloCapabilities(sock)).llm_status_available).toBe(true);

      // 逆方向 (設定を消す) も同じ経路で戻る。片面だけの確認にしない。
      fs.rmSync(path.join(configDir, "config.ts"));
      await runCli(["daemon", "restart"], env);
      expect((await helloCapabilities(sock)).llm_status_available).toBeUndefined();
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);

  test("daemon が居なければ restart は起動になる", async () => {
    const { env, cleanup } = makeEnv();
    try {
      const res = printed(CliStatusSchema, (await runCli(["daemon", "restart"], env)).out);
      expect(res.ok).toBe(true);
      expect(res.running).toBe(true);
      expect(res.restarted).toBe(false);
      expect(res.started).toBe(true);
    } finally {
      await runCli(["daemon", "stop"], env).catch(() => {});
      cleanup();
    }
  }, 30000);
});
