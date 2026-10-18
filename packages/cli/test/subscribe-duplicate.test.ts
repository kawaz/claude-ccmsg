// 同一セッションに `ccmsg subscribe` が 2 本立った時の自動収束の E2E テスト。
//
// 何を保証するか:
//   1. 後から張った subscribe が生き残り、先に張っていた方は自分で exit 0 する
//      (= 二重通知の解消をエージェントの規律に頼らない)。
//   2. 終了する側は理由が読める文言を stderr に出す (stdout は Monitor 用の
//      イベント wire なので汚さない)。
//   3. 収束後、そのセッション宛ての notify は新しい subscribe にだけ届く。
//
// 手法は reconnect.test.ts と同型 (実バイナリを subprocess で起動し、実 daemon
// を相手にする)。
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { jsonObjectLine, served } from "./cli-output.ts";
import { runCli, CLI } from "./run-cli.ts";

const DAEMON_ENTRY = fileURLToPath(new URL("../../daemon/src/index.ts", import.meta.url));

/** The session the tests' notifies come from: a write names its sender. */
const SENDER = "5c000000-0000-4000-8000-000000000000";

function makeEnv(): { env: Record<string, string>; cleanup: () => void } {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-dup-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  return {
    env: {
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: path.join(dataDir, "config"),
      CCMSG_DATA_DIR: dataDir,
      CCMSG_HTTP_BIND: "off",
      CCMSG_DAEMON_ENTRY: DAEMON_ENTRY,
      // The session the CLI acts as is fixed here, never inherited: a test run
      // inside a Claude Code session would otherwise act as that session, and
      // one outside any session (CI) as none. Each write names its sender.
      CCMSG_SID: "",
      CLAUDE_CODE_SESSION_ID: "",
    },
    cleanup: () => fs.rmSync(base, { recursive: true, force: true }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

function spawnSubscribe(env: Record<string, string>, sid: string) {
  return Bun.spawn([process.execPath, CLI, "subscribe"], {
    env: {
      ...process.env,
      ...env,
      CCMSG_SID: sid,
      CLAUDE_CODE_SESSION_ID: "",
      CLAUDE_SESSION_ID: "",
    },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/** reconnect.test.ts と同じく、DOM/node の ReadableStreamDefaultReader 型差を
 * 避けるため使う分だけを構造的に受ける。 */
interface LineReader {
  read(): Promise<{ value?: Uint8Array; done: boolean }>;
  releaseLock(): void;
}
async function waitForNotifyLine(
  reader: LineReader,
  accum: { buf: string; lines: string[] },
  text: string,
): Promise<void> {
  const dec = new TextDecoder();
  for (;;) {
    for (;;) {
      const idx = accum.buf.indexOf("\n");
      if (idx < 0) break;
      const line = accum.buf.slice(0, idx);
      accum.buf = accum.buf.slice(idx + 1);
      accum.lines.push(line);
      try {
        const ev = jsonObjectLine(line);
        if (ev?.ev === "notify" && ev.text === text) return;
      } catch {
        // 非 JSON 行は無視 (現契約では発生しない)
      }
    }
    const { value, done } = await reader.read();
    if (done) throw new Error("subscribe stdout closed unexpectedly");
    accum.buf += dec.decode(value, { stream: true });
  }
}

describe("ccmsg subscribe: 同一 sid の二重起動", () => {
  test("後発の subscribe が残り、先発は理由を stderr に出して exit 0 する", async () => {
    const { env, cleanup } = makeEnv();

    const first = spawnSubscribe(env, "5b000000-0000-4000-8000-000000000000");
    let second: ReturnType<typeof spawnSubscribe> | null = null;
    try {
      // 先発が hello + subscribe を済ませたことを peers で観測する
      // (reconnect.test.ts と同じ readiness signal)。
      for (let i = 0; i < 200; i++) {
        const peers = served("peers", (await runCli(["peers"], env)).out);
        if (peers.peers.some((p) => p.sid === "5b000000-0000-4000-8000-000000000000")) break;
        await sleep(25);
      }

      second = spawnSubscribe(env, "5b000000-0000-4000-8000-000000000000");
      const secondReader = second.stdout.getReader();
      const secondAccum: { buf: string; lines: string[] } = { buf: "", lines: [] };

      // 先発の exit 自体が「後発の subscribe が daemon に届いた」証跡なので、
      // これを readiness signal にする (待ち時間ベースの推測をしない)。
      const firstCode = await first.exited;
      expect(firstCode).toBe(0);
      const firstErr = await new Response(first.stderr).text();
      expect(firstErr).toContain("duplicate detected");
      // 終了通知イベントを stdout (= Monitor の wire) に漏らさない。
      const firstOut = await new Response(first.stdout).text();
      expect(firstOut).not.toContain("subscribe_superseded");

      // 収束後の配信 (SUB 宛ての notify) は後発だけが受け取る。
      const notified = served(
        "notify",
        (
          await runCli(
            [
              "--as-session",
              SENDER,
              "--sid",
              "5b000000-0000-4000-8000-000000000000",
              "notify",
              "--text",
              "after",
            ],
            env,
          )
        ).out,
      );
      expect(notified.delivered).toBe(1);
      await waitForNotifyLine(secondReader, secondAccum, "after");
      expect(second.exitCode).toBeNull();
      secondReader.releaseLock();
    } finally {
      try {
        first.kill();
      } catch {
        // already exited
      }
      try {
        second?.kill();
      } catch {
        // already exited
      }
      await runCli(["daemon", "stop"], env);
      cleanup();
    }
  }, 30000);
});
