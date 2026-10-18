// The agents rows (DR-0034 §5): the live sessions read from Claude Code's
// state files (`<config dir>/sessions/<pid>.json`) across the config dirs the
// daemon serves, detected under a fake $HOME — read on a watch of each
// `sessions/` and on the poll interval — the session registry derived from
// them, what the session's hooks module says laid over them (DR-0035 §3), and
// the user-only permission gate. Each test spawns a real daemon over UDS with
// state files naming live processes (this test process and sleepers it
// starts), so no real ~/.claude* dir is ever read.
import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import {
  connect,
  spawnDaemonProc,
  testConfigDir,
  waitConnectable,
  type DaemonCtx,
  type ItemOf,
  type TestClient,
  isKind,
  sayMarker,
  sessionConn,
  userConn,
} from "./helpers.ts";

// Short poll period so tests don't wait a real 5s per cycle; still exercised
// via event-driven waits (readEventUntil), never a blind sleep for the "did
// something happen" assertions.
const POLL_MS = 150;
// Session ids that say hello must be session-id shaped (lowercase UUID).
const SID_A = "aaaaaaaa-0000-4000-8000-000000000001";
const SID_S = "55555555-0000-4000-8000-000000000005";
const SID_HELLO = "4e110000-0000-4000-8000-000000000001";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const f of cleanups.splice(0).reverse()) await f();
});

/** A fake $HOME (and a bin dir for PATH), as realpaths: the daemon reads each
 * config dir by its realpath. */
function mkHome(): { base: string; home: string; binDir: string } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agents-")));
  cleanups.push(() => fs.rmSync(base, { recursive: true, force: true }));
  const home = path.join(base, "home");
  const binDir = path.join(base, "bin");
  fs.mkdirSync(home);
  fs.mkdirSync(binDir);
  return { base, home, binDir };
}

/** A process that runs until the test ends, for a state file to name. */
function sleeper(): number {
  const proc = Bun.spawn(["sleep", "600"], { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
  cleanups.push(async () => {
    proc.kill();
    await proc.exited;
  });
  return proc.pid;
}

interface Row {
  sessionId: string;
  cwd: string;
  pid?: number;
  [field: string]: unknown;
}

function row(sessionId: string, cwd: string, extra: Partial<Row> = {}): Row {
  return { sessionId, cwd, ...extra };
}

/** Make `dir`'s `sessions/` hold exactly `rows`, each as Claude Code writes
 * it, and nothing else. A row without a pid is the process `pidOf` gives its
 * session. `"FAIL"` leaves a record that does not read, which keeps the dir
 * from being read whole. */
function writeRows(
  dir: string,
  rows: readonly Row[] | "FAIL",
  pidOf: (sid: string) => number,
): void {
  const sessionsDir = path.join(dir, "sessions");
  fs.mkdirSync(sessionsDir, { recursive: true });
  const files = new Map<string, string>();
  if (rows === "FAIL") files.set("0.json", "not json");
  else {
    for (const r of rows) {
      const pid = r.pid ?? pidOf(r.sessionId);
      files.set(
        `${String(pid)}.json`,
        JSON.stringify({ kind: "interactive", startedAt: 1, ...r, pid }),
      );
    }
  }
  for (const name of fs.readdirSync(sessionsDir)) {
    if (!files.has(name)) fs.rmSync(path.join(sessionsDir, name));
  }
  for (const [name, text] of files) {
    fs.writeFileSync(path.join(sessionsDir, `${name}.tmp`), text);
    fs.renameSync(path.join(sessionsDir, `${name}.tmp`), path.join(sessionsDir, name));
  }
}

/** For rows that each name their pid. */
function namedPid(sid: string): number {
  throw new Error(`the row of ${sid} names no pid`);
}

async function startAgentsTestDaemon(
  home: string,
  binDir: string,
  extraEnv: Record<string, string> = {},
): Promise<DaemonCtx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agents-daemon-"));
  // The default state dir of this environment (XDG_STATE_HOME/ccmsg): the
  // daemon there serves the `$HOME/.claude*` dirs (servedConfigDirs).
  const stateDir = path.join(base, "ccmsg");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const env: Record<string, string> = {
    XDG_STATE_HOME: base,
    CCMSG_STATE_DIR: stateDir,
    CCMSG_CONFIG_DIR: testConfigDir(dataDir),
    CCMSG_DATA_DIR: dataDir,
    CCMSG_HTTP_BIND: "off",
    CCMSG_AGENTS_POLL: "on",
    CCMSG_AGENTS_POLL_MS: String(POLL_MS),
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    ...extraEnv,
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
  cleanups.push(() => stopAgentsTestDaemon(ctx));
  return ctx;
}

async function stopAgentsTestDaemon(ctx: DaemonCtx): Promise<void> {
  try {
    const c = await connect(ctx.sock);
    await c.request({ op: "shutdown" });
    c.close();
  } catch {
    // fall back to signal
  }
  try {
    ctx.proc.kill();
  } catch {
    // already gone
  }
  await ctx.proc.exited;
  fs.rmSync(ctx.base, { recursive: true, force: true });
}

/** The agents rows once a round has run. */
async function afterARound(u: TestClient): Promise<readonly { sessionId: string }[]> {
  for (;;) {
    const res = await u.requestOk({ op: "agents" });
    if (res.polled_at !== null) return res.agents;
    await new Promise((r) => setTimeout(r, POLL_MS));
  }
}

describe("agents: config dir detection", () => {
  test("$HOME/.claude* のうちディレクトリのみ読み、regular file の ~/.claude は除外される", async () => {
    const { home, binDir } = mkHome();
    // ~/.claude is a regular FILE (kawaz's real environment shape, see
    // claude-config-dir-isolation rule) — must be excluded, unlike the
    // directory candidates below.
    fs.writeFileSync(path.join(home, ".claude"), "not a directory");
    const dirA = path.join(home, ".claude-a");
    const dirB = path.join(home, ".claude-b");
    // a dir NOT prefixed ".claude" must never be read.
    const other = path.join(home, "not-claude-dir");
    writeRows(
      dirA,
      [row("sA", "/a", { pid: process.pid, status: "waiting", waitingFor: "dialog open" })],
      namedPid,
    );
    writeRows(dirB, [row("sB", "/b", { pid: process.ppid })], namedPid);
    writeRows(other, [row("sX", "/x")], () => sleeper());

    const ctx = await startAgentsTestDaemon(home, binDir);
    const u = await userConn(ctx);
    await u.request({ op: "subscribe" });
    const { ev } = await u.readEventUntil("agents");
    const agents = ev.agents;
    expect(agents.map((a) => a.sessionId).sort()).toEqual(["sA", "sB"]);
    expect(agents.map((a) => a.config_dir).sort()).toEqual([dirA, dirB].sort());
    expect(agents.find((a) => a.sessionId === "sA")).toMatchObject({
      pid: process.pid,
      cwd: "/a",
      kind: "interactive",
      startedAt: 1,
      status: "waiting",
      waitingFor: "dialog open",
    });
  });

  // DR-0034 §2: the sessions on the machine talk to the daemon at the default
  // state dir; one at another state dir lists none of them.
  test("既定でない state dir の daemon は $HOME/.claude* を読まない", async () => {
    const { base, home, binDir } = mkHome();
    writeRows(path.join(home, ".claude-a"), [row("sA", "/a", { pid: process.pid })], namedPid);
    const ctx = await startAgentsTestDaemon(home, binDir, {
      XDG_STATE_HOME: path.join(base, "elsewhere"),
    });
    expect(await afterARound(await userConn(ctx))).toEqual([]);
  });

  test("config dir が1つも無い場合、agents は空のまま", async () => {
    const { home, binDir } = mkHome();
    const ctx = await startAgentsTestDaemon(home, binDir);
    expect(await afterARound(await userConn(ctx))).toEqual([]);
  });
});

describe("agents: permission (user role only)", () => {
  test("session role からの op:'agents' は bad_request", async () => {
    const { home, binDir } = mkHome();
    const ctx = await startAgentsTestDaemon(home, binDir);
    const s = await sessionConn(ctx, SID_A);
    const res = await s.requestError({ op: "agents" });
    expect(res.ok).toBe(false);
    expect(res.error.code).toBe("bad_request");
  });
});

describe("agents: reading the state files", () => {
  test("webui が一度も繋がらなくても daemon 起動直後から読む", async () => {
    const { home, binDir } = mkHome();
    writeRows(path.join(home, ".claude-a"), [row("sA", "/a", { pid: process.pid })], namedPid);
    const ctx = await startAgentsTestDaemon(home, binDir);
    // A session-role conn only asks for peers; nothing here starts a round.
    const s = await sessionConn(ctx, SID_S);
    for (;;) {
      const res = await s.requestOk({ op: "peers" });
      if (res.peers.some((p) => p.sid === "sA")) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  });

  test("user subscribe で ev:'agents' が届き、op:'agents' で同じ結果が読める", async () => {
    const { home, binDir } = mkHome();
    writeRows(path.join(home, ".claude-a"), [row("sA", "/a", { pid: process.pid })], namedPid);
    const ctx = await startAgentsTestDaemon(home, binDir);
    const u = await userConn(ctx);
    await u.request({ op: "subscribe" });
    const { ev } = await u.readEventUntil("agents");
    expect(ev.agents.map((a) => a.sessionId)).toEqual(["sA"]);
    expect(ev.polled_at).not.toBeNull();

    const cached = await u.requestOk({ op: "agents" });
    expect(cached.agents.map((a) => a.sessionId)).toEqual(["sA"]);
    // >= rather than === : rounds keep running in the background, so one can
    // land between the ev above and this request — the result is unchanged
    // (still just sA) but polled_at may have advanced.
    expect(cached.polled_at).not.toBeNull();
    expect(new Date(cached.polled_at ?? "").getTime()).toBeGreaterThanOrEqual(
      new Date(ev.polled_at).getTime(),
    );
  });

  test("state file が変わらない限り、2 回目以降の round では ev:'agents' が再配信されない", async () => {
    const { home, binDir } = mkHome();
    writeRows(path.join(home, ".claude-a"), [row("sA", "/a", { pid: process.pid })], namedPid);
    const ctx = await startAgentsTestDaemon(home, binDir);
    const u = await userConn(ctx);
    await u.request({ op: "subscribe" });
    const first = await u.readEventUntil("agents");
    // Several more rounds run underneath (proves this isn't just "the second
    // round hasn't happened yet").
    for (;;) {
      const res = await u.requestOk({ op: "agents" });
      if (res.polled_at !== null && res.polled_at > first.ev.polled_at) break;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
    // Drive a distinguishable event through the same subscribe stream (a
    // say from a fresh session) and confirm no "agents" event snuck in
    // among the events collected while waiting for it.
    const s = await sessionConn(ctx, SID_S);
    const seen = await sayMarker(s, u, "marker");
    expect(seen.some(isKind("agents"))).toBe(false);
  });

  // The interval is out of reach here, so only the watch on `sessions/` can
  // be what reads a session starting and ending.
  test("sessions/ の変化は poll の間隔を待たずに読まれる", async () => {
    const { home, binDir } = mkHome();
    const dirA = path.join(home, ".claude-a");
    writeRows(dirA, [], namedPid);
    const ctx = await startAgentsTestDaemon(home, binDir, { CCMSG_AGENTS_POLL_MS: "600000" });
    const u = await userConn(ctx);
    await u.request({ op: "subscribe" });
    await afterARound(u);
    writeRows(dirA, [row("sA", "/a", { pid: process.pid })], namedPid);
    const listed = await u.readEventUntil("agents", (e) => e.agents.length === 1);
    expect(listed.ev.agents.map((a) => a.sessionId)).toEqual(["sA"]);
    writeRows(dirA, [], namedPid);
    await u.readEventUntil("agents", (e) => e.agents.length === 0);
  });

  // A session that ended without removing its file (a crash) has no process.
  test("process の無い state file は読まない", async () => {
    const { home, binDir } = mkHome();
    const gone = Bun.spawn(["true"]);
    await gone.exited;
    writeRows(
      path.join(home, ".claude-a"),
      [row("sGone", "/a", { pid: gone.pid }), row("sA", "/a", { pid: process.pid })],
      namedPid,
    );
    const ctx = await startAgentsTestDaemon(home, binDir);
    const u = await userConn(ctx);
    await u.request({ op: "subscribe" });
    const { ev } = await u.readEventUntil("agents");
    expect(ev.agents.map((a) => a.sessionId)).toEqual(["sA"]);
  });
});

describe("session registry derived from the agents rows (DR-0034)", () => {
  async function withRegistryFixture(
    body: (f: {
      ctx: DaemonCtx;
      dirA: string;
      setRows: (dir: string, rows: Row[] | "FAIL") => void;
      cwd: string;
      base: string;
      binDir: string;
    }) => Promise<void>,
  ): Promise<void> {
    const { base, home, binDir } = mkHome();
    const dirA = path.join(home, ".claude-a");
    fs.mkdirSync(dirA);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agents-cwd-")));
    cleanups.push(() => fs.rmSync(cwd, { recursive: true, force: true }));
    // A session is one process for as long as the test runs, as on a real
    // machine: its record keeps its pid from one setRows to the next.
    const pids = new Map<string, number>();
    const pidOf = (sid: string): number => {
      const pid = pids.get(sid) ?? sleeper();
      pids.set(sid, pid);
      return pid;
    };
    const setRows = (dir: string, rows: Row[] | "FAIL"): void => writeRows(dir, rows, pidOf);
    const ctx = await startAgentsTestDaemon(home, binDir);
    await body({ ctx, dirA, setRows, cwd, base, binDir });
  }

  async function watcher(ctx: DaemonCtx): Promise<TestClient> {
    const u = await userConn(ctx);
    await u.request({ op: "subscribe" });
    return u;
  }

  function hasPeer(sid: string): (e: ItemOf<"peers">) => boolean {
    return (e) => e.peers.some((p) => p.sid === sid);
  }
  function lacksPeer(sid: string): (e: ItemOf<"peers">) => boolean {
    return (e) => !e.peers.some((p) => p.sid === sid);
  }

  test("agents に出た sid が hello なしで peers に載る (cwd から repo/ws を導出)", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      for (const args of [
        ["init", "-q", "-b", "feat"],
        ["remote", "add", "origin", "https://github.com/someone/somerepo.git"],
      ]) {
        expect(Bun.spawnSync(["git", ...args], { cwd }).exitCode).toBe(0);
      }
      const u = await watcher(ctx);
      setRows(dirA, [row("sA", cwd)]);
      const { ev } = await u.readEventUntil("peers", hasPeer("sA"));
      const peer = ev.peers.find((p) => p.sid === "sA");
      expect(peer).toMatchObject({ cwd, ws: "feat" });
      expect(peer?.repo).toContain("somerepo");
    });
  });

  test("agents から消えた sid は peers から消える", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      setRows(dirA, [row("sA", cwd), row("sB", cwd)]);
      await u.readEventUntil("peers", (e) => hasPeer("sA")(e) && hasPeer("sB")(e));
      setRows(dirA, [row("sB", cwd)]);
      const { ev } = await u.readEventUntil("peers", lacksPeer("sA"));
      expect(ev.peers.map((p) => p.sid)).toEqual(["sB"]);
    });
  });

  test("hello 済みの sid は agents 由来の値で上書きされない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      // No dir is read whole until the row is there, so no round in between
      // forgets the hello for not listing it.
      setRows(dirA, "FAIL");
      await sessionConn(ctx, SID_A, { repo: "hello-repo", ws: "hello-ws", cwd });
      await u.readEventUntil("peers", hasPeer(SID_A));
      setRows(dirA, [row(SID_A, os.tmpdir()), row("sMarker", cwd)]);
      const { ev } = await u.readEventUntil("peers", hasPeer("sMarker"));
      expect(ev.peers.find((p) => p.sid === SID_A)).toMatchObject({
        repo: "hello-repo",
        ws: "hello-ws",
        cwd,
      });
    });
  });

  // A hello alone is not the harness's word that the session runs: a sid the
  // state files never list (one the harness does not know, or one whose
  // harness is gone) is forgotten by the first round begun after the hello.
  test("hello だけで登録された sid は、hello の後に始まった round に載らなければ peers から消える", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      setRows(dirA, [row("sA", cwd)]);
      await u.readEventUntil("peers", hasPeer("sA"));
      await sessionConn(ctx, SID_HELLO, { cwd });
      await u.readEventUntil("peers", hasPeer(SID_HELLO));
      const { ev } = await u.readEventUntil("peers", lacksPeer(SID_HELLO));
      expect(ev.peers.map((p) => p.sid)).toEqual(["sA"]);
    });
  });

  test("hello の後に round に載った sid は、round から消えるまで peers に残る", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      // Rounds in which no dir is read whole forget nothing: the hello waits
      // for the row.
      setRows(dirA, "FAIL");
      await sessionConn(ctx, SID_HELLO, { cwd });
      setRows(dirA, [row(SID_HELLO, cwd)]);
      await u.readEventUntil("agents", (e) => e.agents.some((a) => a.sessionId === SID_HELLO));
      // Rounds go on listing it: still there once a later round registered
      // a marker.
      setRows(dirA, [row(SID_HELLO, cwd), row("sMarker", cwd)]);
      const marked = await u.readEventUntil("peers", hasPeer("sMarker"));
      expect(marked.ev.peers.map((p) => p.sid).toSorted()).toEqual(
        [SID_HELLO, "sMarker"].toSorted(),
      );
      setRows(dirA, [row("sMarker", cwd)]);
      const { ev } = await u.readEventUntil("peers", lacksPeer(SID_HELLO));
      expect(ev.peers.map((p) => p.sid)).toEqual(["sMarker"]);
    });
  });

  test("hello だけで登録された sid は、名乗った config dir が読めない間は消えない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      const dirB = path.join(path.dirname(dirA), ".claude-b");
      setRows(dirB, "FAIL");
      await sessionConn(ctx, SID_HELLO, { cwd, config_dir: dirB });
      // Each marker is registered by a later round than the one before it:
      // the second's round began after the first's ended, so after the hello,
      // and the third's push comes once that round has run its forgetting.
      for (const marker of ["sM1", "sM2", "sM3"]) {
        setRows(dirA, [row(marker, cwd)]);
        await u.readEventUntil("peers", hasPeer(marker));
      }
      const res = await u.requestOk({ op: "peers" });
      expect(res.peers.map((p) => p.sid).toSorted()).toEqual([SID_HELLO, "sM3"].toSorted());
      // Its dir read whole without it is what forgets it.
      setRows(dirB, []);
      await u.readEventUntil("peers", lacksPeer(SID_HELLO));
    });
  });

  test("読めない config dir のセッションは消さない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      const dirB = path.join(path.dirname(dirA), ".claude-b");
      setRows(dirA, [row("sA", cwd)]);
      setRows(dirB, [row("sB", cwd)]);
      await u.readEventUntil("peers", (e) => hasPeer("sA")(e) && hasPeer("sB")(e));
      // dirA does not read while dirB drops sB: only the read dir's loss
      // counts.
      setRows(dirA, "FAIL");
      setRows(dirB, []);
      // The push that follows the registry update for a round in which dirA
      // did not read and dirB listed nothing.
      await u.readEventUntil("agents", (e) => e.agents.length === 0);
      const res = await u.requestOk({ op: "peers" });
      expect(res.peers.map((p) => p.sid)).toEqual(["sA"]);
    });
  });

  /** Name a run of `sid` to the daemon on a connection of its own, as its
   * sidecar does (sidecar_hello); ending the connection is the run going. */
  async function nameRun(
    ctx: DaemonCtx,
    sid: string,
    runId: string,
    hyouiSessionId?: string,
  ): Promise<TestClient> {
    const c = await sessionConn(ctx, sid);
    await c.requestOk({
      op: "sidecar_hello",
      run_id: runId,
      started_at: Date.now(),
      ...(hyouiSessionId !== undefined ? { hyoui_session_id: hyouiSessionId } : {}),
    });
    return c;
  }

  const SID_RUN = "7e000000-0000-4000-8000-000000000001";
  /** The terminal the agents rows of `sid` carry, row by row in pid order. */
  function terminalsOf(
    agents: readonly { sessionId: string; pid: number; hyoui_session_id?: string }[],
    sid: string,
  ): { pid: number; terminal: string | undefined }[] {
    return agents
      .filter((a) => a.sessionId === sid)
      .map((a) => ({ pid: a.pid, terminal: a.hyoui_session_id }))
      .toSorted((a, b) => a.pid - b.pid);
  }

  // DR-0035 §3: the terminal is what the session's hooks module names. A row
  // carries it from the run tied to its process, and the run's harness has
  // to be alive for that, so the rows here name the test's own process.
  test("行は名乗った run の端末 (hyoui_session_id) を持ち、名乗る前は持たない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      setRows(dirA, [row(SID_RUN, cwd, { pid: process.pid, startedAt: Date.now() })]);
      const before = await u.readEventUntil("agents", (e) =>
        e.agents.some((a) => a.sessionId === SID_RUN),
      );
      expect(terminalsOf(before.ev.agents, SID_RUN)).toEqual([
        { pid: process.pid, terminal: undefined },
      ]);

      const run = await nameRun(ctx, SID_RUN, "run1", "hy-1");
      const named = await u.readEventUntil(
        "agents",
        (e) => terminalsOf(e.agents, SID_RUN)[0]?.terminal !== undefined,
      );
      expect(terminalsOf(named.ev.agents, SID_RUN)).toEqual([
        { pid: process.pid, terminal: "hy-1" },
      ]);
      const reply = await u.requestOk({ op: "agents" });
      expect(terminalsOf(reply.agents, SID_RUN)).toEqual([{ pid: process.pid, terminal: "hy-1" }]);
      // A tab that subscribes now is handed the rows with the terminal.
      const late = await watcher(ctx);
      const caught = await late.readEventUntil("agents");
      expect(terminalsOf(caught.ev.agents, SID_RUN)).toEqual([
        { pid: process.pid, terminal: "hy-1" },
      ]);
      run.close();
    });
  });

  test("名乗りが行より先でも、行が出た poll で行が端末を持つ", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      const run = await nameRun(ctx, SID_RUN, "run1", "hy-1");
      setRows(dirA, [row(SID_RUN, cwd, { pid: process.pid, startedAt: Date.now() })]);
      const { ev } = await u.readEventUntil(
        "agents",
        (e) => terminalsOf(e.agents, SID_RUN)[0]?.terminal !== undefined,
      );
      expect(terminalsOf(ev.agents, SID_RUN)).toEqual([{ pid: process.pid, terminal: "hy-1" }]);
      run.close();
    });
  });

  // A session listed in two processes: the run is tied to the one whose start
  // is nearest its own, and only that process's row is its terminal.
  test("同じ sid の別 process の行は、run の端末を持たない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      const other = sleeper();
      setRows(dirA, [
        row(SID_RUN, cwd, { pid: process.pid, startedAt: Date.now() }),
        row(SID_RUN, cwd, { pid: other, startedAt: 1 }),
      ]);
      await u.readEventUntil("agents", (e) => terminalsOf(e.agents, SID_RUN).length === 2);
      const run = await nameRun(ctx, SID_RUN, "run1", "hy-1");
      const { ev } = await u.readEventUntil("agents", (e) =>
        terminalsOf(e.agents, SID_RUN).some((r) => r.terminal !== undefined),
      );
      expect(terminalsOf(ev.agents, SID_RUN)).toEqual(
        [
          { pid: process.pid, terminal: "hy-1" },
          { pid: other, terminal: undefined },
        ].toSorted((a, b) => a.pid - b.pid),
      );
      run.close();
    });
  });

  // session_rename types into the terminal the row carries, and a session
  // whose run went has none to type into.
  test("run が去ると行は端末を持たず、session_rename は terminal_unavailable", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd, base, binDir }) => {
      const hyouiLog = path.join(base, "hyoui.log");
      fs.writeFileSync(hyouiLog, "");
      writeMockBin(
        path.join(binDir, "hyoui"),
        `#!/usr/bin/env bash\nprintf '%s|' "$@" >> "${hyouiLog}"\necho >> "${hyouiLog}"\n`,
      );
      const u = await watcher(ctx);
      setRows(dirA, [row(SID_RUN, cwd, { pid: process.pid, startedAt: Date.now() })]);
      const run = await nameRun(ctx, SID_RUN, "run1", "hy-1");
      await u.readEventUntil(
        "agents",
        (e) => terminalsOf(e.agents, SID_RUN)[0]?.terminal !== undefined,
      );
      const renamed = await u.requestOk({
        op: "session_rename",
        session_id: SID_RUN,
        title: "t",
      });
      expect(renamed).toMatchObject({ hyoui_session_id: "hy-1", title: "t" });
      expect(fs.readFileSync(hyouiLog, "utf-8")).toBe("input|hy-1|text:/rename t|key:Enter|\n");

      await run.end();
      const { ev } = await u.readEventUntil("agents", (e) =>
        terminalsOf(e.agents, SID_RUN).every((r) => r.terminal === undefined),
      );
      expect(terminalsOf(ev.agents, SID_RUN)).toEqual([{ pid: process.pid, terminal: undefined }]);
      const refused = await u.requestError({
        op: "session_rename",
        session_id: SID_RUN,
        title: "t",
      });
      expect(refused.error.code).toBe("terminal_unavailable");
    });
  });

  // DR-0035 §3: whether a session answers a turn is its hooks module's word,
  // laid over the session's rows as the module says it, between polls.
  test("行は module が言った turn を持ち、言う前は持たない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      setRows(dirA, [row(SID_RUN, cwd)]);
      const turnOf = (e: ItemOf<"agents">) => e.agents.find((a) => a.sessionId === SID_RUN)?.turn;
      const listed = await u.readEventUntil("agents", (e) =>
        e.agents.some((a) => a.sessionId === SID_RUN),
      );
      expect(turnOf(listed.ev)).toBeUndefined();

      const module = await sessionConn(ctx, SID_RUN);
      const since = Date.parse("2026-10-18T01:00:00.000Z");
      await module.requestOk({
        op: "session_facts",
        facts: { at: 1, turn: { state: "responding", since } },
      });
      const responding = await u.readEventUntil("agents", (e) => turnOf(e) !== undefined);
      expect(turnOf(responding.ev)).toEqual({
        state: "responding",
        since: "2026-10-18T01:00:00.000Z",
      });
      await module.requestOk({
        op: "session_facts",
        facts: { at: 2, turn: { state: "idle", since: since + 1000 } },
      });
      const idle = await u.readEventUntil("agents", (e) => turnOf(e)?.state === "idle");
      expect(turnOf(idle.ev)).toEqual({ state: "idle", since: "2026-10-18T01:00:01.000Z" });
      expect((await u.requestOk({ op: "agents" })).agents[0]?.turn?.state).toBe("idle");
      module.close();
    });
  });

  test("登録時に無かった transcript が後で書かれたら次の poll で peers に載る", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const sid = "231e3d3d-1aed-4050-be17-7e5cdf2f7402";
      const u = await watcher(ctx);
      setRows(dirA, [row(sid, cwd)]);
      const first = await u.readEventUntil("peers", hasPeer(sid));
      expect(first.ev.peers.find((p) => p.sid === sid)?.transcript_path).toBeUndefined();
      const projectDir = path.join(dirA, "projects", "-some-project");
      fs.mkdirSync(projectDir, { recursive: true });
      const file = path.join(projectDir, `${sid}.jsonl`);
      fs.writeFileSync(file, "");
      const { ev } = await u.readEventUntil("peers", (e) =>
        e.peers.some((p) => p.sid === sid && p.transcript_path !== undefined),
      );
      expect(ev.peers.find((p) => p.sid === sid)?.transcript_path).toBe(file);
    });
  });
});
