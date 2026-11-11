// `ccmsg secret take <id>` (DR-0052 §6): the value the person handed to a
// session from the webui, written to standard output for the next command of
// a pipe, as it was pasted. The daemon is a real one (it holds the value and
// tells a fake harness the id, peer-harness.ts).
//
// 何を保証するか:
//   - 標準出力は値そのもの (改行を足さない・削らない)、exit 0。セッションの中 (CLAUDE_CODE_SESSION_ID
//     がある) から呼んでも user role で hello して取り出せる
//   - 知らない ID・ID の無い呼び出し・daemon が動いていない時は、標準出力に何も書かず、
//     標準エラーに理由を書いて exit 1
//   - daemon が動いていない時に daemon を起こさない (起こした daemon は何も預かっていない)
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { perTestLivePid } from "../../testkit/src/live-pid.ts";
import {
  type DaemonCtx,
  startTestDaemon,
  stopTestDaemon,
  userConn,
} from "../../daemon/test/helpers.ts";
import { fakeHarness, parseEnvelope, sessionWithConfig } from "../../daemon/test/peer-harness.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { runCli } from "./run-cli.ts";

const T = 20000;
const SID = "dddddddd-3333-4333-8444-555555555555";
const SECRET = "test-secret-0123 \r\nline2 鍵\n";

const livePid = perTestLivePid();
const tmpDir = perTestTmpDir();
const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

async function daemon(): Promise<DaemonCtx> {
  const ctx = await startTestDaemon();
  cleanups.push(() => stopTestDaemon(ctx));
  return ctx;
}

/** Hand SECRET to session SID as the webui does, and return the id its
 * notice names. */
async function handed(ctx: DaemonCtx): Promise<string> {
  const h = fakeHarness(SID, { pid: livePid() });
  cleanups.push(() => h.dispose());
  const s = await sessionWithConfig(ctx, SID, h.configDir);
  cleanups.push(() => s.close());
  await s.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
  const user = await userConn(ctx);
  cleanups.push(() => user.close());
  await user.requestOk({ op: "secret_put", session_id: SID, value: SECRET });
  const line = parseEnvelope(await h.nextContent()).body.split("\n")[1] ?? "";
  const id = /^ccmsg secret take (\S+) \| <コマンド>$/.exec(line)?.[1];
  if (id === undefined) throw new Error(`the notice names no id: ${line}`);
  return id;
}

describe("ccmsg secret take", () => {
  test(
    "writes the value as it was pasted, and nothing else, from inside a session too",
    async () => {
      const ctx = await daemon();
      const id = await handed(ctx);
      const env = { ...ctx.env, CLAUDE_CODE_SESSION_ID: SID };
      expect(await runCli(["secret", "take", id], env)).toEqual({ out: SECRET, err: "", code: 0 });
      // Again, within its five minutes.
      expect((await runCli(["secret", "take", id], env)).out).toBe(SECRET);
    },
    T,
  );

  test(
    "an id nothing is held under writes nothing and says why on stderr",
    async () => {
      const ctx = await daemon();
      const res = await runCli(["secret", "take", "0b6c6f6e-3a4b-4c5d-8e9f-0a1b2c3d4e5f"], ctx.env);
      expect({ out: res.out, code: res.code }).toEqual({ out: "", code: 1 });
      expect(res.err).toContain("ccmsg secret take: no secret is held under this id");
    },
    T,
  );

  test(
    "no id writes nothing and says how to call it",
    async () => {
      const ctx = await daemon();
      const res = await runCli(["secret", "take"], ctx.env);
      expect({ out: res.out, code: res.code }).toEqual({ out: "", code: 1 });
      expect(res.err).toContain("missing <id>");
      expect(res.err).toContain("usage: ccmsg secret take <id>");
    },
    T,
  );

  test(
    "with no daemon running, it writes nothing, says why, and starts none",
    async () => {
      const base = tmpDir("ccmsg-secret-");
      const stateDir = path.join(base, "state");
      fs.mkdirSync(stateDir);
      const env = {
        CCMSG_STATE_DIR: stateDir,
        CCMSG_CONFIG_DIR: path.join(base, "config"),
        CCMSG_DATA_DIR: path.join(base, "data"),
      };
      const res = await runCli(["secret", "take", "0b6c6f6e-3a4b-4c5d-8e9f-0a1b2c3d4e5f"], env);
      expect({ out: res.out, code: res.code }).toEqual({ out: "", code: 1 });
      expect(res.err).toContain("the ccmsg daemon is not running");
      expect(fs.existsSync(path.join(stateDir, "daemon.sock"))).toBe(false);
    },
    T,
  );

  test("bare `ccmsg secret` prints its help", async () => {
    const res = await runCli(["secret"], {});
    expect(res.code).toBe(0);
    expect(res.out).toContain("ccmsg secret take <id>");
  });
});
