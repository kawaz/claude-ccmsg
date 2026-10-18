// agents polling (DR-0009-agents addendum): CLAUDE_CONFIG_DIR auto-detection
// under a fake $HOME, per-dir `claude agents --json` merge, the always-on poll
// lifecycle, the session registry derived from it (DR-0034), the terminal each
// row carries from the run its sidecar named (DR-0035 §3), and the user-only
// permission gate. Each test spawns a real daemon over UDS with a mock `claude` binary on
// PATH so no real Claude CLI or real ~/.claude* dirs are ever touched.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeMockBin } from "../../testkit/src/mock-bin.ts";
import { mkFixture, writeMockClaude } from "./fake-claude.ts";
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
  return {
    base,
    stateDir,
    configDir: testConfigDir(dataDir),
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock,
    proc,
    env,
  };
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
  try {
    fs.rmSync(ctx.base, { recursive: true, force: true });
  } catch {
    // best effort
  }
}

function callCount(callLog: string): number {
  const text = fs.readFileSync(callLog, "utf-8");
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

describe("agents polling: config dir detection", () => {
  test("$HOME/.claude* のうちディレクトリのみ検出され、regular file の ~/.claude は除外される", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      // ~/.claude is a regular FILE (kawaz's real environment shape, see
      // claude-config-dir-isolation rule) — must be excluded, unlike the
      // directory candidates below.
      fs.writeFileSync(path.join(home, ".claude"), "not a directory");
      const dirA = path.join(home, ".claude-a");
      const dirB = path.join(home, ".claude-b");
      fs.mkdirSync(dirA);
      fs.mkdirSync(dirB);
      // a dir NOT prefixed ".claude" must never be scanned in.
      fs.mkdirSync(path.join(home, "not-claude-dir"));

      writeMockClaude(binDir, callLog, {
        [dirA]: [
          {
            pid: 1,
            cwd: "/a",
            kind: "interactive",
            startedAt: 1,
            sessionId: "sA",
            status: "waiting",
            waitingFor: "dialog open",
          },
        ],
        [dirB]: [{ pid: 2, cwd: "/b", kind: "interactive", startedAt: 2, sessionId: "sB" }],
      });

      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const { ev } = await u.readEventUntil("agents");
        const agents = ev.agents;
        const sids = agents.map((a) => a.sessionId).sort();
        expect(sids).toEqual(["sA", "sB"]);
        const dirs = agents.map((a) => a.config_dir).sort();
        expect(dirs).toEqual([dirA, dirB].sort());
        expect(agents.find((a) => a.sessionId === "sA")).toMatchObject({
          kind: "interactive",
          startedAt: 1,
          status: "waiting",
          waitingFor: "dialog open",
        });
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // DR-0034 §2: the sessions on the machine talk to the daemon at the default
  // state dir; one at another state dir lists none of them.
  test("既定でない state dir の daemon は $HOME/.claude* を読まない", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      const dirA = path.join(home, ".claude-a");
      fs.mkdirSync(dirA);
      writeMockClaude(binDir, callLog, {
        [dirA]: [{ pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "sA" }],
      });
      const ctx = await startAgentsTestDaemon(home, binDir, {
        XDG_STATE_HOME: path.join(base, "elsewhere"),
      });
      try {
        const u = await userConn(ctx);
        for (;;) {
          const res = await u.requestOk({ op: "agents" });
          if (res.polled_at !== null) {
            expect(res.agents).toEqual([]);
            break;
          }
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        expect(callCount(callLog)).toBe(0);
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("config dir が1つも無い場合、agents は空のまま", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      writeMockClaude(binDir, callLog, {});
      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        const u = await userConn(ctx);
        const res = await u.requestOk({ op: "agents" });
        expect(res.agents).toEqual([]);
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("agents polling: permission (user role only)", () => {
  test("session role からの op:'agents' は bad_request", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      writeMockClaude(binDir, callLog, {});
      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        const s = await sessionConn(ctx, SID_A);
        const res = await s.requestError({ op: "agents" });
        expect(res.ok).toBe(false);
        expect(res.error.code).toBe("bad_request");
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("agents polling: lifecycle", () => {
  test("webui が一度も繋がらなくても daemon 起動直後から poll する", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      const dirA = path.join(home, ".claude-a");
      fs.mkdirSync(dirA);
      writeMockClaude(binDir, callLog, {
        [dirA]: [{ pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "sA" }],
      });
      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        // A session-role conn only asks for peers; nothing here starts a poll.
        const s = await sessionConn(ctx, SID_S);
        for (;;) {
          const res = await s.requestOk({ op: "peers" });
          if (res.peers.some((p) => p.sid === "sA")) break;
          await new Promise((r) => setTimeout(r, POLL_MS));
        }
        expect(callCount(callLog)).toBeGreaterThan(0);
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("user subscribe で ev:'agents' が届き、op:'agents' で同じ結果が読める", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      const dirA = path.join(home, ".claude-a");
      fs.mkdirSync(dirA);
      writeMockClaude(binDir, callLog, {
        [dirA]: [{ pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "sA" }],
      });
      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        const { ev } = await u.readEventUntil("agents");
        expect(ev.agents.map((a) => a.sessionId)).toEqual(["sA"]);
        expect(ev.polled_at).not.toBeNull();

        const cached = await u.requestOk({ op: "agents" });
        expect(cached.agents.map((a) => a.sessionId)).toEqual(["sA"]);
        // >= rather than === : the poller keeps ticking every POLL_MS in the
        // background, so a poll cycle can legitimately land between the ev
        // above and this request — the result is unchanged (still just sA)
        // but polled_at may have advanced. Exact-timestamp equality would be
        // over-asserting a timing coincidence the op contract never promised.
        expect(cached.polled_at).not.toBeNull();
        expect(new Date(cached.polled_at ?? "").getTime()).toBeGreaterThanOrEqual(
          new Date(ev.polled_at).getTime(),
        );
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  test("claude agents --json が変わらない限り、2 回目以降の poll では ev:'agents' が再配信されない", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      const dirA = path.join(home, ".claude-a");
      fs.mkdirSync(dirA);
      writeMockClaude(binDir, callLog, {
        [dirA]: [{ pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "sA" }],
      });
      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        await u.readEventUntil("agents"); // first (only) agents event

        // Let several more poll cycles actually run underneath (proves this
        // isn't just "the second poll hasn't happened yet").
        await new Promise((r) => setTimeout(r, POLL_MS * 4));
        expect(callCount(callLog)).toBeGreaterThan(1);

        // Drive a distinguishable event through the same subscribe stream (a
        // say from a fresh session) and confirm no "agents" event snuck in
        // among the events collected while waiting for it — proves the
        // unchanged poll result was suppressed, not just unlucky timing.
        const s = await sessionConn(ctx, SID_S);
        const seen = await sayMarker(s, u, "marker");
        expect(seen.some(isKind("agents"))).toBe(false);
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // Regression (adversarial review, agents.ts minor finding): the poll
  // interval and POLL_TIMEOUT_MS both being ~5s (here shrunk via
  // CCMSG_AGENTS_POLL_MS) means a slow `claude agents --json` call can still
  // be in flight when the next tick fires. Without an in-flight guard, two
  // overlapping polls can be running at once — the mock `claude` below marks
  // that directly (a lock file already present when it starts) instead of
  // inferring it from timing.
  test("in-flight guard: 前回の poll がまだ完了していない間は次の tick が新しい claude 呼び出しを開始しない", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      const dirA = path.join(home, ".claude-a");
      fs.mkdirSync(dirA);
      const lockFile = path.join(base, "poll.lock");
      const overlapLog = path.join(base, "overlap.log");
      fs.writeFileSync(overlapLog, "");
      // Each invocation holds `lockFile` for well longer than POLL_MS (150ms
      // interval, held here for 400ms) — if a second tick starts a second
      // `claude` process while the first is still running, it observes the
      // lock file already present and records an overlap.
      const file = path.join(binDir, "claude");
      // Emits a fixed non-empty row (not `[]`) so the very first poll
      // counts as a "change" against the poller's initial empty cache and
      // actually fires the ev:"agents" awaited below — an unchanging `[]`
      // result would never trigger onChange at all (stableKey([]) equals
      // stableKey(initial cache)) and the test would just hang.
      const script = `#!/usr/bin/env bash
set -e
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  echo "$CLAUDE_CONFIG_DIR $(date +%s%N)" >> "${callLog}"
  if [ -e "${lockFile}" ]; then
    echo "overlap" >> "${overlapLog}"
  fi
  : > "${lockFile}"
  sleep 0.4
  rm -f "${lockFile}"
  echo '[{"pid":1,"cwd":"/a","kind":"interactive","startedAt":1,"sessionId":"sA"}]'
  exit 0
fi
exit 1
`;
      writeMockBin(file, script);

      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        const u = await userConn(ctx);
        await u.request({ op: "subscribe" });
        await u.readEventUntil("agents"); // first poll landed

        // Let several POLL_MS periods elapse while the mock is still busy
        // (each call takes 400ms, interval is 150ms) — proves several
        // ticks fired without the guard triggering an overlap.
        await new Promise((r) => setTimeout(r, 1200));
        expect(callCount(callLog)).toBeGreaterThan(1); // ticks did keep firing
        expect(fs.readFileSync(overlapLog, "utf-8").trim()).toBe(""); // never overlapped
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });

  // Smoke test for pollOne's stderr draining (adversarial review finding —
  // NOTE the review's proposed failure mode, "unread stderr past the OS pipe
  // buffer blocks the child's write() and stalls every poll until
  // POLL_TIMEOUT_MS's SIGKILL", was checked empirically against
  // Bun.spawn/Bun.Subprocess directly (not just this test) and did NOT
  // reproduce here: even 50MB of never-awaited stderr resolved in ~170ms, no
  // timeout. Bun appears to drain "pipe" stdio internally regardless of
  // whether JS ever reads it, unlike plain Node.js child_process. The
  // concurrent-drain change is kept anyway — it's what makes `errText`
  // available for the diagnostic log line below, and costs nothing — but
  // this test only proves heavy stderr output doesn't break a poll, not that
  // it fixes a reproduced deadlock.
  test("stderr の大量出力があっても poll は問題なく完了する (診断目的の drain 確認)", async () => {
    const { base, home, binDir, callLog } = mkFixture();
    try {
      const dirA = path.join(home, ".claude-a");
      fs.mkdirSync(dirA);
      const file = path.join(binDir, "claude");
      // 200KB of stderr noise — comfortably over any common OS pipe buffer
      // size (64KB on Linux, similar order on macOS) — before ever writing
      // to stdout.
      // Emits a fixed non-empty row so this first poll counts as a "change"
      // against the poller's initial empty cache and fires ev:"agents" —
      // see the in-flight-guard test above for why `[]` would never do that.
      const script = `#!/usr/bin/env bash
set -e
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  echo "$CLAUDE_CONFIG_DIR $(date +%s%N)" >> "${callLog}"
  head -c 200000 /dev/zero | tr '\\0' 'e' 1>&2
  echo '[{"pid":1,"cwd":"/a","kind":"interactive","startedAt":1,"sessionId":"sA"}]'
  exit 0
fi
exit 1
`;
      writeMockBin(file, script);

      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        const u = await userConn(ctx);
        const start = Date.now();
        await u.request({ op: "subscribe" });
        await u.readEventUntil("agents");
        const elapsedMs = Date.now() - start;
        // POLL_TIMEOUT_MS is 5000ms; a blocked-on-stderr child would only
        // resolve after that full timeout + SIGKILL. A generous margin
        // below it (3000ms) still clearly distinguishes "drained
        // concurrently" from "blocked until timeout".
        expect(elapsedMs).toBeLessThan(3000);
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});

/** Mock `claude` whose rows per config dir are read from `<rowsDir>/<dir
 *  basename>.json` on every call, so a test can change what the harness lists
 *  between polls. A file holding `FAIL` makes that dir's call exit non-zero. */
function writeFileDrivenMockClaude(binDir: string, rowsDir: string): void {
  const script = `#!/usr/bin/env bash
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  f="${rowsDir}/$(basename "$CLAUDE_CONFIG_DIR").json"
  if [ ! -f "$f" ]; then echo '[]'; exit 0; fi
  if [ "$(cat "$f")" = "FAIL" ]; then echo boom >&2; exit 1; fi
  cat "$f"
  exit 0
fi
exit 1
`;
  writeMockBin(path.join(binDir, "claude"), script);
}

function row(sessionId: string, cwd: string, extra: Record<string, unknown> = {}): unknown {
  return { pid: 1, cwd, kind: "interactive", startedAt: 1, sessionId, ...extra };
}

describe("session registry derived from the agents poll (DR-0034)", () => {
  async function withRegistryFixture(
    body: (f: {
      ctx: DaemonCtx;
      dirA: string;
      setRows: (dir: string, rows: unknown[] | "FAIL") => void;
      cwd: string;
      base: string;
      binDir: string;
    }) => Promise<void>,
  ): Promise<void> {
    const { base, home, binDir } = mkFixture();
    const rowsDir = path.join(base, "rows");
    fs.mkdirSync(rowsDir);
    const dirA = path.join(home, ".claude-a");
    fs.mkdirSync(dirA);
    const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agents-cwd-")));
    const setRows = (dir: string, rows: unknown[] | "FAIL"): void => {
      const file = path.join(rowsDir, `${path.basename(dir)}.json`);
      fs.writeFileSync(`${file}.tmp`, rows === "FAIL" ? "FAIL" : JSON.stringify(rows));
      fs.renameSync(`${file}.tmp`, file);
    };
    writeFileDrivenMockClaude(binDir, rowsDir);
    try {
      const ctx = await startAgentsTestDaemon(home, binDir);
      try {
        await body({ ctx, dirA, setRows, cwd, base, binDir });
      } finally {
        await stopAgentsTestDaemon(ctx);
      }
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
      fs.rmSync(cwd, { recursive: true, force: true });
    }
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
      // No dir answers until the row is there, so no round in between
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
  // poll never lists (one the harness does not know, or one whose harness is
  // gone) is forgotten by the first round begun after the hello.
  test("hello だけで登録された sid は、hello の後に始まった poll に載らなければ peers から消える", async () => {
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

  test("hello の後に poll に載った sid は、poll から消えるまで peers に残る", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      // Rounds in which no dir answers forget nothing: the hello waits for
      // the row.
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

  test("hello だけで登録された sid は、名乗った config dir が poll に答えない間は消えない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      const dirB = path.join(path.dirname(dirA), ".claude-b");
      fs.mkdirSync(dirB);
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
      // Its dir answering without it is what forgets it.
      setRows(dirB, []);
      await u.readEventUntil("peers", lacksPeer(SID_HELLO));
    });
  });

  test("poll に失敗した config dir のセッションは消さない", async () => {
    await withRegistryFixture(async ({ ctx, dirA, setRows, cwd }) => {
      const u = await watcher(ctx);
      const dirB = path.join(path.dirname(dirA), ".claude-b");
      fs.mkdirSync(dirB);
      setRows(dirA, [row("sA", cwd)]);
      setRows(dirB, [row("sB", cwd)]);
      await u.readEventUntil("peers", (e) => hasPeer("sA")(e) && hasPeer("sB")(e));
      // dirA fails while dirB drops sB: only the answered dir's loss counts.
      setRows(dirA, "FAIL");
      setRows(dirB, []);
      // The push that follows the registry update for a poll in which dirA
      // failed and dirB listed nothing.
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
      const other = 999_999;
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
