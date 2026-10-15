// `ccmsg daemon restart` の E2E テスト。
//
// 何を保証するか:
//   1. config.ts を編集して restart すると、新 daemon の hello capability に
//      編集後の設定が反映される (= 稼働中 daemon に設定変更を届ける手段が
//      成立している。設定は起動時 1 回読み (DR-0018 LN-Q4) なので、restart
//      でしか反映されない)。
//   2. restart を跨いで subscribe が生存し、跨ぎ後の notify を受け取る (= 意図的
//      な `daemon stop` と違い、restart は接続中クライアントを切り捨てない)。
//   3. daemon が居ない状態の restart は起動として成功する (restarted:false,
//      started:true) — 「現行設定の daemon が動いている状態にする」が要求。
//
// 手法は reconnect.test.ts と同型: 実 CLI を subprocess で起動し、temp dir の
// state/config/data を見る隔離 daemon を跨がせる。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "../../daemon/test/helpers.ts";
import { PROTOCOL_VERSION } from "@ccmsg/protocol";
import { CliStatusSchema, jsonObjectLine, printed, served } from "./cli-output.ts";

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
  configDir: string;
  cleanup: () => void;
}

/** The session the tests' notifies come from: a write names its sender. */
const SENDER = "5c000000-0000-4000-8000-000000000000";

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
      CCMSG_NO_SELF_EXEC: "1",
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

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
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

/** reconnect.test.ts と同じ構造型: bun と node:stream/web の
 * `ReadableStreamDefaultReader` は互換でないので、使う 2 メソッドだけを取る。 */
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
    for (;;) {
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

  test("restart を跨いで subscribe が生存する", async () => {
    const { env, cleanup } = makeEnv();
    const SUB = "5b000000-0000-4000-8000-000000000000";
    try {
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

      /** SUB 宛ての notify を、subscribe が受けられる状態になるまで (配信先が
       * 1 つになるまで) 送り直し、stdout に現れるのを待つ。 */
      const notifyArrives = async (text: string): Promise<void> => {
        for (let i = 0; ; i++) {
          const res = served(
            "notify",
            (await runCli(["--as-session", SENDER, "--sid", SUB, "notify", "--text", text], env))
              .out,
          );
          if (res.delivered === 1) break;
          if (i >= 200) throw new Error(`notify "${text}" never reached the subscribe`);
          await sleep(25);
        }
        await waitForLine(reader, accum, (l) => {
          const ev = jsonObjectLine(l);
          return ev?.ev === "notify" && ev.text === text;
        });
      };

      try {
        await notifyArrives("before");

        const restarted = printed(CliStatusSchema, (await runCli(["daemon", "restart"], env)).out);
        expect(restarted.restarted).toBe(true);

        // 跨ぎ後の notify が subscribe に届く = 自動再接続が成立している。
        await notifyArrives("after");
        expect(sub.exitCode).toBeNull();
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
