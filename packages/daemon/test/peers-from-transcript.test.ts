// The Sessions list's row values the daemon reads off a session's transcript when it first knows the session (DR-0053): the last activity, the last time a person put something in, and the model and effort the main thread last ran at, on the peers row (`ev:"peers"`) of every session.
//
// 何を保証するか (各 test のコメント参照):
//   - daemon が知らないセッションを知ると (hello、agents の poll)、そのセッションを誰も開いていなくても、module が無くても、transcript を通読した値が peers に載って全 webui に push される
//   - 通読は 1 本ずつ、登録の順に行い、1 本読めるたびにそのセッションの値を push する
//   - transcript の値は live の新しい値を潰さない (last_activity_at は daemon が持つ値より新しい時だけ採る。last_user_input_at は live の fold があれば fold の値)
//   - 名乗り直し (sidecar_hello) や hello の再送、daemon の再起動で経過時間が数え直しにならない (transcript の時刻のまま)
//   - 読めなかったセッションは値を付けずに次へ進み、daemon のログに 1 行残す
//   - last_activity_at だけの変化は、すぐには push せず、待ちの窓の後にまとめて push する (activity のたびに全件を全タブへ送らない)
//   - daemon を作り直した後も、既読はファイルから読み戻され、module のあるセッションの say / permit の未読の数は再起動の前と同じになる
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { JsonObject, PeerInfo } from "@ccmsg/protocol";
import {
  assistantContentRow,
  assistantMessage,
  assistantRow,
  customTitleRow,
  line,
  metadataRow,
  systemRow,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { perTestLivePid } from "../../testkit/src/live-pid.ts";
import { permitLines } from "./permit-rows.ts";
import {
  appendPushed,
  connect,
  daemonLogOf,
  liveSessionConn,
  nameRun,
  sessionConn,
  spawnDaemonProc,
  startInProcessDaemon,
  stopInProcessDaemon,
  streamMarker,
  testConfigDir,
  userConn,
  waitConnectable,
  isKind,
  type DaemonCtx,
  type InProcessDaemon,
  type TestClient,
} from "./helpers.ts";

const A = "a0530000-0000-4000-8000-00000000000a";
const B = "b0530000-0000-4000-8000-00000000000b";
const C = "c0530000-0000-4000-8000-00000000000c";
const M = "d0530000-0000-4000-8000-00000000000d";

// Times well before the test runs, so a value stamped "now" is told apart.
const T1 = "2026-11-01T01:00:00.000Z";
const T2 = "2026-11-01T02:00:00.000Z";
const T3 = "2026-11-01T03:00:00.000Z";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

function tmp(prefix: string): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** A prompt the person typed at `timestamp`. */
function typed(text: string, timestamp: string): JsonObject {
  return userContentRow(text, { promptSource: "typed", origin: { kind: "human" }, timestamp });
}

/** A main-thread assistant turn that ran as `model` at `effort`. */
function answered(model: string, effort: string, timestamp: string): JsonObject {
  return assistantRow({ message: assistantMessage({ model }), effort, timestamp });
}

/** A transcript as Claude Code leaves it after one turn: the person's prompt at `promptAt`, the answer, the turn's end at `endAt`, then the metadata rows (no timestamp) it keeps appending. */
function turnLines(promptAt: string, model: string, effort: string, endAt: string): string {
  return [
    typed("go", promptAt),
    answered(model, effort, promptAt),
    systemRow({ timestamp: endAt }),
    customTitleRow(),
    metadataRow("last-prompt", { lastPrompt: "go", leafUuid: "u" }),
  ]
    .map((row) => `${line(row)}\n`)
    .join("");
}

/** `<dir>/<sid>.jsonl` holding `text`. */
function transcriptOf(dir: string, sid: string, text: string): string {
  const file = path.join(dir, `${sid}.jsonl`);
  fs.writeFileSync(file, text);
  return file;
}

function rowOf(peers: readonly PeerInfo[], sid: string): PeerInfo | undefined {
  return peers.find((p) => p.sid === sid);
}

async function subscribedUser(ctx: { sock: string }): Promise<TestClient> {
  const user = await userConn(ctx);
  await user.requestOk({ op: "subscribe" });
  return user;
}

async function inProcess(): Promise<InProcessDaemon> {
  const ctx = await startInProcessDaemon();
  cleanups.push(() => stopInProcessDaemon(ctx));
  return ctx;
}

/** A row going into `c`'s session's conversation, as its hooks module pushes it (transcript_push): the session working. */
async function pushARow(c: TestClient): Promise<void> {
  await c.requestOk({
    op: "transcript_push",
    rows: [{ uuid: crypto.randomUUID(), door: "response", message: {} }],
  });
}

/** Resolves once every transcript read queued so far has landed. */
async function readsDone(ctx: InProcessDaemon): Promise<void> {
  await ctx.daemon.transcriptFactsReads(async () => {});
}

/** Hold the daemon's transcript reads until the returned function is called: the reads queue behind this one, so a test can do things before any read lands. */
function holdReads(ctx: InProcessDaemon): () => void {
  const gate = Promise.withResolvers<void>();
  void ctx.daemon.transcriptFactsReads(() => gate.promise);
  // A test that fails before releasing must not leave the daemon's stop waiting on the held read (cleanups run in reverse: this before the stop).
  cleanups.push(() => gate.resolve());
  return () => gate.resolve();
}

describe("peers rows from the transcript", () => {
  // The session is never opened (no session_status_subscribe) and has no module (no sidecar named): before the read, its row had no model, no idle time and no prompt time. The idle time is the turn's end (the last row with a timestamp), not the metadata rows after it, and not now.
  test("a session that appears is pushed with its transcript's values, unopened and without a module", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const file = transcriptOf(dir, A, turnLines(T1, "claude-fable-5-2", "low", T2));
    await sessionConn(ctx, A, { transcript_path: file });
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.model !== undefined,
    );
    expect(rowOf(ev.peers, A)).toMatchObject({
      model: "claude-fable-5-2",
      effort: "low",
      last_activity_at: T2,
      last_user_input_at: T1,
    });
  });

  // The reads run one at a time in the order the sessions were registered, and each read's values are pushed as it lands: the sessions with values grow one at a time, A first. (That the reads do not overlap is the queue's own, createSerial: serial.test.ts.)
  test("several sessions are filled one at a time, in the order registered", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const release = holdReads(ctx);
    for (const sid of [A, B, C]) {
      const file = transcriptOf(dir, sid, turnLines(T1, "claude-opus-5", "high", T2));
      await sessionConn(ctx, sid, { transcript_path: file });
    }
    release();
    const filled: string[][] = [];
    await user.readEventUntil("peers", (e) => {
      const withModel = [A, B, C].filter((sid) => rowOf(e.peers, sid)?.model !== undefined);
      const last = filled.at(-1);
      if (withModel.length > 0 && withModel.join() !== last?.join()) filled.push(withModel);
      return withModel.length === 3;
    });
    expect(filled).toEqual([[A], [A, B], [A, B, C]]);
  });

  // The session worked (a row went into its conversation) while its transcript was waiting to be read: the read's time is older than that, and is not taken.
  test("the transcript's time does not replace a newer live activity", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const release = holdReads(ctx);
    const file = transcriptOf(dir, A, turnLines(T1, "claude-fable-5-2", "low", T2));
    const a = await sessionConn(ctx, A, { transcript_path: file });
    await a.requestOk({
      op: "transcript_push",
      rows: [{ uuid: crypto.randomUUID(), door: "response", message: {} }],
    });
    const live = rowOf((await user.requestOk({ op: "peers" })).peers, A)?.last_activity_at;
    expect(live).toBeDefined();
    expect(Date.parse(live ?? "")).toBeGreaterThan(Date.parse(T2));
    release();
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.model !== undefined,
    );
    expect(rowOf(ev.peers, A)?.last_activity_at).toBe(live);
  });

  // A live session's fold is the source of its prompt time once it has one: a prompt that came after the read moves the row past the read's value.
  test("a live session's prompt time is the fold's, past what the read found", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const file = transcriptOf(dir, A, turnLines(T1, "claude-fable-5-2", "low", T2));
    const a = await liveSessionConn(ctx, A, { transcript_path: file });
    await user.readEventUntil("peers", (e) => rowOf(e.peers, A)?.model !== undefined);
    await appendPushed(a, file, `${line(typed("next", T3))}\n`);
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.last_user_input_at === T3,
    );
    expect(rowOf(ev.peers, A)?.last_user_input_at).toBe(T3);
  });

  // Naming a run (what a sidecar does whenever the daemon starts) and saying hello again (what a hooks module does before every request) are not the session working: the idle time stays the transcript's.
  test("naming a run and saying hello again leave the idle time the transcript's", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const file = transcriptOf(dir, A, turnLines(T1, "claude-fable-5-2", "low", T2));
    const a = await sessionConn(ctx, A, { transcript_path: file });
    await user.readEventUntil("peers", (e) => rowOf(e.peers, A)?.model !== undefined);
    await nameRun(ctx, a);
    await sessionConn(ctx, A, { transcript_path: file });
    expect(rowOf((await user.requestOk({ op: "peers" })).peers, A)?.last_activity_at).toBe(T2);
  });

  // A transcript that is there and cannot be read (here a directory where the file should be) gives the session no values and one line in the log, and is not read again; the next session is read. (A file not there at all is the other case: "edges" below.)
  test("a transcript that cannot be read leaves its row without values and is logged", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    fs.mkdirSync(path.join(dir, `${A}.jsonl`));
    await sessionConn(ctx, A, { transcript_path: path.join(dir, `${A}.jsonl`) });
    const file = transcriptOf(dir, B, turnLines(T1, "claude-opus-5", "high", T2));
    await sessionConn(ctx, B, { transcript_path: file });
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, B)?.model !== undefined,
    );
    const a = rowOf(ev.peers, A);
    expect(a?.model).toBeUndefined();
    expect(a?.last_activity_at).toBeUndefined();
    const lines = daemonLogOf({ stateDir: ctx.daemon.paths.stateDir })
      .split("\n")
      .filter((l) => l.includes(`transcript facts ${A}:`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("not read");
  });

  // A transcript with lines that do not read gives the values of the rest, and one line in the log for the session.
  test("broken lines are skipped, the rest read, and logged once", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const file = transcriptOf(
      dir,
      A,
      `{broken\n${turnLines(T1, "claude-fable-5-2", "low", T2)}{"type":"user","timestamp":1}\n`,
    );
    await sessionConn(ctx, A, { transcript_path: file });
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.model !== undefined,
    );
    expect(rowOf(ev.peers, A)?.last_activity_at).toBe(T2);
    const lines = daemonLogOf({ stateDir: ctx.daemon.paths.stateDir })
      .split("\n")
      .filter((l) => l.includes(`transcript facts ${A}:`));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2 lines");
  });

  // The module's facts (live) come before the transcript's model and effort, as a pair: a module that said its model but no effort yet gives no effort, not the transcript's.
  test("the module's facts give the model and effort over the transcript's", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const file = transcriptOf(dir, A, turnLines(T1, "claude-fable-5-2", "low", T2));
    const a = await sessionConn(ctx, A, { transcript_path: file });
    await user.readEventUntil("peers", (e) => rowOf(e.peers, A)?.model !== undefined);
    await a.requestOk({
      op: "session_facts",
      facts: { at: Date.now(), model: "claude-opus-5[1m]" },
    });
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.model === "claude-opus-5[1m]",
    );
    expect(rowOf(ev.peers, A)?.effort).toBeUndefined();
  });
});

// Fixes of the read's edges: a file not there yet, a clock behind the transcript, a transcript that moves while its read waits.
describe("peers rows from the transcript: edges", () => {
  // A session nothing has been typed into has no `<sid>.jsonl` yet (Claude Code creates it with the first prompt), but its hello can name the path. That read finds nothing and is not taken as done: the session's next push (its rows going into the conversation, so the file is there now) queues it again. Nothing is logged for a file that is not there yet.
  test("a transcript not there yet is read once it is, on the session's next push", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const file = path.join(dir, `${A}.jsonl`);
    const a = await sessionConn(ctx, A, { transcript_path: file });
    await readsDone(ctx);
    expect(rowOf((await user.requestOk({ op: "peers" })).peers, A)?.model).toBeUndefined();
    fs.writeFileSync(file, turnLines(T1, "claude-fable-5-2", "low", T2));
    await pushARow(a);
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.model !== undefined,
    );
    expect(rowOf(ev.peers, A)).toMatchObject({ model: "claude-fable-5-2", last_user_input_at: T1 });
    expect(daemonLogOf({ stateDir: ctx.daemon.paths.stateDir })).not.toContain(
      `transcript facts ${A}:`,
    );
  });

  // The same, by the session's next hello (a hooks module says one before every request).
  test("a transcript not there yet is read once it is, on the session's next hello", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const file = path.join(dir, `${A}.jsonl`);
    await sessionConn(ctx, A, { transcript_path: file });
    await readsDone(ctx);
    fs.writeFileSync(file, turnLines(T1, "claude-opus-5", "high", T2));
    await sessionConn(ctx, A, { transcript_path: file });
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.model !== undefined,
    );
    expect(rowOf(ev.peers, A)?.model).toBe("claude-opus-5");
  });

  // The transcript's last time can be ahead of this daemon's clock (another machine's clock, a clock set back). A request of the session's work after the read stamps the daemon's now, which is earlier: the value does not move back.
  test("a request's stamp does not move last_activity_at back behind the transcript's", async () => {
    const ctx = await inProcess();
    const dir = tmp("ccmsg-pft-");
    const user = await subscribedUser(ctx);
    const ahead = new Date(Date.now() + 3_600_000).toISOString();
    const file = transcriptOf(dir, A, turnLines(T1, "claude-fable-5-2", "low", ahead));
    const a = await sessionConn(ctx, A, { transcript_path: file });
    await user.readEventUntil("peers", (e) => rowOf(e.peers, A)?.model !== undefined);
    await pushARow(a);
    expect(rowOf((await user.requestOk({ op: "peers" })).peers, A)?.last_activity_at).toBe(ahead);
  });

  // The session's hello names another transcript while the read of the first waits: the first file's values are not the session's now, so they are not taken, and the file the session names now is read instead.
  test("a transcript that moves while its read waits is read at its new path", async () => {
    const ctx = await inProcess();
    const user = await subscribedUser(ctx);
    const release = holdReads(ctx);
    const old = transcriptOf(tmp("ccmsg-pft-"), A, turnLines(T1, "claude-opus-5", "high", T2));
    const moved = transcriptOf(tmp("ccmsg-pft-"), A, turnLines(T1, "claude-fable-5-2", "low", T3));
    await sessionConn(ctx, A, { transcript_path: old });
    await sessionConn(ctx, A, { transcript_path: moved });
    release();
    const { ev } = await user.readEventUntil(
      "peers",
      (e) => rowOf(e.peers, A)?.model !== undefined,
    );
    expect(rowOf(ev.peers, A)).toMatchObject({ model: "claude-fable-5-2", last_activity_at: T3 });
  });
});

describe("the push of last_activity_at", () => {
  // A row going into a working session's conversation moves its activity, several times a second in a turn. The list is not pushed for each: the first change of the activity alone opens a window, every change in it goes in the one push when it ends, and a `peers` reply has the value at once. The window's end is the test's to say (`afterActivityWindow`), so the count of pushes does not depend on how fast the machine runs.
  test("the activities of a window go in one push, sent when the window ends", async () => {
    const ctx = await inProcess();
    const windows: (() => void)[] = [];
    ctx.daemon.afterActivityWindow = (fire) => {
      windows.push(fire);
      return { cancel: () => {} };
    };
    const user = await subscribedUser(ctx);
    const m = await sessionConn(ctx, M);
    const a = await sessionConn(ctx, A);
    await user.readEventUntil("peers", (e) =>
      [A, M].every((sid) => rowOf(e.peers, sid)?.input_readiness !== undefined),
    );
    for (let i = 0; i < 3; i++) await pushARow(a);
    // Three changes, one window.
    expect(windows).toHaveLength(1);
    const before = await streamMarker(m, user, "before");
    expect(before.filter(isKind("peers"))).toHaveLength(0);
    const held = rowOf((await user.requestOk({ op: "peers" })).peers, A)?.last_activity_at;
    expect(held).toBeDefined();

    windows[0]?.();
    const after = await streamMarker(m, user, "after");
    const pushes = after.filter(isKind("peers"));
    expect(pushes).toHaveLength(1);
    expect(rowOf(pushes[0]?.peers ?? [], A)?.last_activity_at).toBe(held);
  });
});

// A daemon started again (the same state dir, a new process's memory): the rows come back with the transcript's times, not the time of the restart, for sessions with and without a module, and the says and requests for permission the person read stay read.
describe("a daemon started again", () => {
  const livePid = perTestLivePid();
  const POLL_MS = 150;

  /** A daemon serving the config dirs under `home`, on `base`'s state dir, with the agents poll on. */
  async function agentsDaemon(base: string, home: string): Promise<DaemonCtx> {
    const stateDir = path.join(base, "ccmsg");
    const dataDir = path.join(base, "d");
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const env: Record<string, string> = {
      XDG_STATE_HOME: base,
      CCMSG_STATE_DIR: stateDir,
      CCMSG_CONFIG_DIR: testConfigDir(dataDir),
      CCMSG_DATA_DIR: dataDir,
      CCMSG_HTTP_BIND: "off",
      CCMSG_NETWORK_WATCH: "off",
      CCMSG_AGENTS_POLL: "on",
      CCMSG_AGENTS_POLL_MS: String(POLL_MS),
      HOME: home,
    };
    const proc = spawnDaemonProc(stateDir, dataDir, env);
    const sock = path.join(stateDir, "daemon.sock");
    await waitConnectable(sock);
    const ctx: DaemonCtx = {
      base,
      stateDir,
      configDir: testConfigDir(dataDir),
      dataDir,
      roomsDir: path.join(dataDir, "rooms"),
      sock,
      proc,
      env,
    };
    return ctx;
  }

  async function stop(ctx: DaemonCtx): Promise<void> {
    try {
      const c = await connect(ctx.sock);
      await c.request({ op: "shutdown" });
      c.close();
    } catch {
      // fall back to the signal
    }
    try {
      ctx.proc.kill();
    } catch {
      // already gone
    }
    await ctx.proc.exited;
  }

  // Three sessions in the harness's register (`sessions/<pid>.json` naming a live process each) with their transcripts in `projects/`; none is opened. B's module names a run in each daemon, as its sidecar does once a daemon is up. Every row's idle time is its transcript's, in both daemons.
  test("the rows keep the transcript's times across the restart, with and without a module", async () => {
    const base = tmp("ccmsg-pft-restart-");
    const home = path.join(base, "home");
    const cfg = path.join(home, ".claude-t");
    const project = path.join(cfg, "projects", "p");
    fs.mkdirSync(path.join(cfg, "sessions"), { recursive: true });
    fs.mkdirSync(project, { recursive: true });
    const ends = new Map([
      [A, T1],
      [B, T2],
      [C, T3],
    ]);
    for (const [sid, endAt] of ends) {
      transcriptOf(project, sid, turnLines(T1, "claude-fable-5-2", "low", endAt));
      const pid = livePid();
      fs.writeFileSync(
        path.join(cfg, "sessions", `${String(pid)}.json`),
        JSON.stringify({ pid, sessionId: sid, cwd: base, kind: "interactive", startedAt: 1 }),
      );
    }
    const allFilled = (peers: readonly PeerInfo[]): boolean =>
      [...ends].every(([sid, endAt]) => rowOf(peers, sid)?.last_activity_at === endAt);

    // The first daemon, then one started again on the same state dir.
    for (const _daemon of ["first", "again"]) {
      const ctx = await agentsDaemon(base, home);
      try {
        const user = await subscribedUser(ctx);
        const b = await sessionConn(ctx, B, {
          transcript_path: path.join(project, `${B}.jsonl`),
          config_dir: cfg,
        });
        await nameRun(ctx, b);
        const { ev } = await user.readEventUntil("peers", (e) => allFilled(e.peers));
        for (const sid of ends.keys()) {
          expect(rowOf(ev.peers, sid)).toMatchObject({ model: "claude-fable-5-2", effort: "low" });
        }
        // Read again after the poll has run more rounds and the run is named: nothing has moved the idle times to the restart.
        expect(allFilled((await user.requestOk({ op: "peers" })).peers)).toBe(true);
      } finally {
        await stop(ctx);
      }
    }
  });

  // The says and the requests for permission the person read are kept in the state dir, so a daemon started again counts the same unread for a session whose module names a run again (its fold reads the transcript from the start, and the read ids are taken off it).
  test("the unread says and requests of a session with a module are the same after the restart", async () => {
    const dir = tmp("ccmsg-pft-unread-");
    const file = path.join(dir, `${A}.jsonl`);
    fs.writeFileSync(file, "");
    const permit = { blocked: "x", commands: [{ command: "ls" }] };
    const SAY = "mcp__ccmsg-v1__say";
    const sayLine = (id: string): string =>
      `${line(assistantContentRow([toolUseBlock(SAY, { text: id }, id)], { timestamp: new Date().toISOString() }))}\n`;

    const first = await startInProcessDaemon();
    const base = first.base;
    cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
    let before: { says: string[]; permits: string[] };
    try {
      const a = await liveSessionConn(first, A, { transcript_path: file });
      const user = await subscribedUser(first);
      await appendPushed(a, file, sayLine("toolu_s1") + sayLine("toolu_s2"));
      await appendPushed(
        a,
        file,
        permitLines("toolu_p1", permit, { timestamp: new Date().toISOString() }) +
          permitLines("toolu_p2", permit, { timestamp: new Date().toISOString() }),
      );
      await user.readEventUntil("say_unread", (e) => e.says.length === 2);
      await user.readEventUntil("permit_state", (e) => e.unread.length === 2);
      await user.requestOk({ op: "say_read", ids: ["toolu_s1"] });
      await user.requestOk({ op: "permit_read", ids: ["toolu_p1"] });
      const says = await user.readEventUntil("say_unread", (e) => e.says.length === 1);
      const permits = await user.readEventUntil("permit_state", (e) => e.unread.length === 1);
      before = {
        says: says.ev.says.map((s) => s.tool_use_id),
        permits: permits.ev.unread.map((p) => p.tool_use_id),
      };
    } finally {
      await stopInProcessDaemon(first, { keepBase: true });
    }
    expect(before).toEqual({ says: ["toolu_s2"], permits: ["toolu_p2"] });

    const second = await startInProcessDaemon({ base });
    try {
      const user = await subscribedUser(second);
      await liveSessionConn(second, A, { transcript_path: file });
      const says = await user.readEventUntil("say_unread", (e) => e.says.length > 0);
      const permits = await user.readEventUntil("permit_state", (e) => e.unread.length > 0);
      expect({
        says: says.ev.says.map((s) => s.tool_use_id),
        permits: permits.ev.unread.map((p) => p.tool_use_id),
      }).toEqual(before);
    } finally {
      await stopInProcessDaemon(second, { keepBase: true });
    }
  });
});
