// launch_tool, a session's `launch` tool over POST /op (DR-0018 §3.7): the
// launch command's outcome when it ends within the daemon's wait, and
// otherwise `running`, the outcome then going into the asking conversation
// (a fake harness, peer-harness.ts, as the session; its state file names a
// live pid because only running processes are sent to).
//
// 何を保証するか (各 test の doc comment 参照):
//   - 待ちの内に終わった起動は、session_launch と同じ結果 (+ outcome: "done") で答える
//   - 待ちを超えた起動は running で答え、終わった時に結果を呼んだセッションの
//     会話へ daemon からの知らせとして入れる
//   - subagent からの起動の結果はその subagent 宛て。届かなければ daemon.log
//   - 断られた起動は session_launch と同じ error。user role は断る
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { LaunchCommandInputSchema, jsonText, parseWith } from "@ccmsg/protocol";
import type { CcmsgConfig } from "../src/config.ts";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import {
  startInProcessDaemon,
  stopInProcessDaemon,
  userConn,
  type InProcessDaemon,
  type TestClient,
} from "./helpers.ts";
import { fakeHarness, parseEnvelope, sessionWithConfig, type FakeHarness } from "./peer-harness.ts";

const tmp = perTestTmpDir();
const SID = "aaaaaaaa-4444-4333-8444-555555555555";
/** A process that runs for as long as the test does. */
const LIVE_PID = process.pid;

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

/** A launch command that prints its standard input, then exits 0. */
function echoCommand(dir: string): string {
  return writeMockBin(path.join(dir, "echo-launch"), "#!/bin/sh\ncat\n");
}

/** A launch command that waits for one line on a FIFO it makes in `dir`
 * (releaseGates), then prints its standard input. */
function gatedCommand(dir: string): string {
  const at = (name: string): string => JSON.stringify(path.join(dir, name));
  return writeMockBin(
    path.join(dir, "gated"),
    `#!/bin/sh\ninput=$(cat)\ngate=$(mktemp -u ${at("gate-XXXXXX")})\nmkfifo "$gate"\n` +
      `read line < "$gate"\nprintf '%s' "$input"\n`,
  );
}

/** Let every gated command waiting in `dir` go. */
async function releaseGates(dir: string): Promise<void> {
  const gates = fs
    .readdirSync(dir)
    .filter((name) => name.startsWith("gate-"))
    .map((name) => path.join(dir, name));
  await Promise.all(
    gates.map(async (fifo) => {
      await fs.promises.writeFile(fifo, "go\n");
      await fs.promises.rm(fifo);
    }),
  );
}

function launcherConfig(command: string, root: string): CcmsgConfig {
  return { session_launcher: { launch_command: [command], root_dirs: [root] } };
}

async function daemon(config: CcmsgConfig): Promise<InProcessDaemon> {
  const ctx = await startInProcessDaemon({ config });
  cleanups.push(() => stopInProcessDaemon(ctx));
  return ctx;
}

/** The session SID, as a fake harness its notices are written into, and a
 * connection that said hello as it with a run named (it has a module). */
async function liveSession(ctx: InProcessDaemon): Promise<{ h: FakeHarness; c: TestClient }> {
  const h = fakeHarness(SID, { pid: LIVE_PID });
  cleanups.push(() => h.dispose());
  const c = await sessionWithConfig(ctx, SID, h.configDir);
  await c.requestOk({ op: "sidecar_hello", run_id: "run1", started_at: Date.now() });
  cleanups.push(() => c.close());
  return { h, c };
}

describe("launch_tool", () => {
  // 何を保証するか: 待ちの内に終わった起動は、session_launch の返事の欄に
  // outcome: "done" を付けて同期で答える。起動コマンドは session_launch と
  // 同じ入力 (新しいセッションの id 付き) を読む。
  test("a launch that ends within the wait is answered with what the command did", async () => {
    const dir = fs.realpathSync(tmp("ccmsg-launch-tool-"));
    const ctx = await daemon(launcherConfig(echoCommand(dir), dir));
    const { c } = await liveSession(ctx);
    const reply = await c.requestOk({
      op: "launch_tool",
      launch: { cwd: dir, model: "haiku", effort: "low", prompt: "p" },
    });
    if (reply.outcome !== "done") throw new Error(`not done: ${JSON.stringify(reply)}`);
    expect(reply.exit_code).toBe(0);
    const read = parseWith(jsonText(LaunchCommandInputSchema), reply.stdout);
    if (!read.ok) throw new Error(read.failure.summary);
    expect(read.value).toEqual({
      cwd: dir,
      model: "haiku",
      effort: "low",
      prompt: "p",
      session_id: reply.session_id ?? "missing",
    });
  });

  // 何を保証するか: 待ちを超えた起動は running で答え、起動コマンドが終わった時に
  // 結果を呼んだセッションの会話へ daemon からの知らせとして入れる。文は
  // 同期の時の tool の結果と同じ JSON。
  test("a launch past the wait is answered running, and its outcome is told when it ends", async () => {
    const dir = fs.realpathSync(tmp("ccmsg-launch-tool-"));
    const ctx = await daemon(launcherConfig(gatedCommand(dir), dir));
    ctx.daemon.launchToolWaitMs = 50;
    const { h, c } = await liveSession(ctx);
    expect(await c.requestOk({ op: "launch_tool", launch: { cwd: dir, continue: true } })).toEqual({
      ok: true,
      outcome: "running",
    });
    await releaseGates(dir);
    const frame = await h.nextUser();
    const { attrs, body } = parseEnvelope(frame.message.content);
    expect(attrs.from).toBe("ccmsg:daemon");
    const told = JSON.stringify({
      exit_code: 0,
      stdout: JSON.stringify({ cwd: dir, continue: true }),
      stderr: "",
    });
    expect(body).toContain(`ccmsg の launch (cwd: ${dir}) が終わった: ${told}`);
  });

  // 何を保証するか: subagent からの起動の結果はその subagent 宛て。subagent に
  // 届けられない時 (ここでは module が返事をしない) は、main には入れずに
  // daemon.log に残す。
  test("a subagent's launch past the wait is told to it, and logged when it cannot be", async () => {
    const dir = fs.realpathSync(tmp("ccmsg-launch-tool-"));
    const ctx = await daemon(launcherConfig(gatedCommand(dir), dir));
    ctx.daemon.launchToolWaitMs = 50;
    const { h, c } = await liveSession(ctx);
    expect(
      await c.requestOk({
        op: "launch_tool",
        launch: { cwd: dir, continue: true },
        agent_id: "a1",
      }),
    ).toEqual({ ok: true, outcome: "running" });
    await releaseGates(dir);
    await Promise.all(ctx.daemon.launches);
    await Promise.all(ctx.daemon.launchNotices);
    expect(fs.readFileSync(ctx.daemon.paths.log, "utf8")).toMatch(
      new RegExp(`launch_tool: told ${SID} agent a1: (not_delivered|unconfirmed)`),
    );
    expect(h.frames.filter((f) => f.type === "user")).toEqual([]);
  });

  // 何を保証するか: 起動の前に断るものは session_launch と同じ error で答える。
  // user role は断る (人の起動は session_launch)。
  test("a refused launch answers the error; the user role is refused", async () => {
    const dir = fs.realpathSync(tmp("ccmsg-launch-tool-"));
    const ctx = await daemon(launcherConfig(echoCommand(dir), dir));
    const { c } = await liveSession(ctx);
    expect(
      await c.request({ op: "launch_tool", launch: { cwd: path.join(dir, "no"), continue: true } }),
    ).toMatchObject({ ok: false, error: { code: "invalid_args" } });
    const user = await userConn(ctx);
    cleanups.push(() => user.close());
    expect(await user.request({ op: "launch_tool", launch: { cwd: dir, continue: true } })).toEqual(
      { ok: false, error: { code: "bad_request", msg: "op 'launch_tool' requires session role" } },
    );
  });
});
