// agents polling (DR-0009-agents addendum): CLAUDE_CONFIG_DIR auto-detection
// under a fake $HOME, per-dir `claude agents --json` merge, poll-while-watched
// lifecycle driven by user-role subscriber count, and the user-only permission
// gate. Each test spawns a real daemon over UDS with a mock `claude` binary on
// PATH so no real Claude CLI or real ~/.claude* dirs are ever touched.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  connect,
  spawnDaemonProc,
  waitConnectable,
  type DaemonCtx,
  type TestClient,
} from "./helpers.ts";

const T = 15000;
// Short poll period so tests don't wait a real 5s per cycle; still exercised
// via event-driven waits (readEventUntil), never a blind sleep for the "did
// something happen" assertions.
const POLL_MS = 150;

/** Build a fake $HOME containing config-dir candidates, a mock `claude` binary
 *  on its own PATH-prepend dir, and a call-log file the mock appends one line
 *  to per invocation (so tests can observe "did/didn't poll again" without
 *  reaching into daemon internals). */
function mkFixture(): {
  base: string;
  home: string;
  binDir: string;
  callLog: string;
} {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agents-"));
  const home = path.join(base, "home");
  fs.mkdirSync(home);
  const binDir = path.join(base, "bin");
  fs.mkdirSync(binDir);
  const callLog = path.join(base, "calls.log");
  fs.writeFileSync(callLog, "");
  return { base, home, binDir, callLog };
}

/** Write the mock `claude` script: on `agents --json`, appends one line to
 *  callLog (so call count is observable) and echoes rows tagged with which
 *  CLAUDE_CONFIG_DIR it saw — the same shape agents.ts expects from the real
 *  CLI (camelCase fields, no `config_dir` — the daemon adds that itself). */
function writeMockClaude(
  binDir: string,
  callLog: string,
  rowsByConfigDir: Record<string, unknown[]>,
): void {
  const file = path.join(binDir, "claude");
  const script = `#!/usr/bin/env bash
set -e
if [ "$1" = "agents" ] && [ "$2" = "--json" ]; then
  echo "$CLAUDE_CONFIG_DIR $(date +%s%N)" >> "${callLog}"
  case "$CLAUDE_CONFIG_DIR" in
${Object.entries(rowsByConfigDir)
  .map(([dir, rows]) => `    "${dir}") echo '${JSON.stringify(rows)}' ;;`)
  .join("\n")}
    *) echo '[]' ;;
  esac
  exit 0
fi
exit 1
`;
  fs.writeFileSync(file, script, { mode: 0o755 });
}

async function startAgentsTestDaemon(
  home: string,
  binDir: string,
  extraEnv: Record<string, string> = {},
): Promise<DaemonCtx> {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "ccmsg-agents-daemon-"));
  const stateDir = path.join(base, "s");
  const dataDir = path.join(base, "d");
  fs.mkdirSync(stateDir);
  fs.mkdirSync(dataDir);
  const env: Record<string, string> = {
    CCMSG_STATE_DIR: stateDir,
    CCMSG_DATA_DIR: dataDir,
    CCMSG_HTTP_BIND: "off",
    CCMSG_AGENTS_POLL_MS: String(POLL_MS),
    HOME: home,
    PATH: `${binDir}:${process.env.PATH ?? ""}`,
    ...extraEnv,
  };
  const proc = spawnDaemonProc(stateDir, dataDir, env);
  const sock = path.join(stateDir, "daemon.sock");
  await waitConnectable(sock);
  return { base, stateDir, dataDir, roomsDir: path.join(dataDir, "rooms"), sock, proc, env };
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

async function userConn(ctx: DaemonCtx): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "user" });
  return c;
}
async function sessionConn(ctx: DaemonCtx, sid: string): Promise<TestClient> {
  const c = await connect(ctx.sock);
  await c.hello({ role: "session", sid, repo: "r", ws: "w", cwd: "/tmp" });
  return c;
}

function callCount(callLog: string): number {
  const text = fs.readFileSync(callLog, "utf-8");
  return text.split("\n").filter((l) => l.trim() !== "").length;
}

interface AgentsOk {
  ok: true;
  agents: Array<{ pid: number; sessionId: string; config_dir: string }>;
  polled_at: string | null;
}
interface ErrLite {
  ok: false;
  error: { code: string };
}

describe("agents polling: config dir detection", () => {
  test(
    "$HOME/.claude* のうちディレクトリのみ検出され、regular file の ~/.claude は除外される",
    async () => {
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
          [dirA]: [{ pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "sA" }],
          [dirB]: [{ pid: 2, cwd: "/b", kind: "interactive", startedAt: 2, sessionId: "sB" }],
        });

        const ctx = await startAgentsTestDaemon(home, binDir);
        try {
          const u = await userConn(ctx);
          await u.request({ op: "subscribe" });
          const { ev } = await u.readEventUntil<{ ev: string; agents: unknown[] }>(
            (e) => e.ev === "agents",
          );
          const agents = (ev as unknown as AgentsOk & { ev: string }).agents;
          const sids = agents.map((a) => a.sessionId).sort();
          expect(sids).toEqual(["sA", "sB"]);
          const dirs = agents.map((a) => a.config_dir).sort();
          expect(dirs).toEqual([dirA, dirB].sort());
        } finally {
          await stopAgentsTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "config dir が1つも無い場合、subscribe しても agents は空のまま (poll 自体は起動する)",
    async () => {
      const { base, home, binDir, callLog } = mkFixture();
      try {
        writeMockClaude(binDir, callLog, {});
        const ctx = await startAgentsTestDaemon(home, binDir);
        try {
          const u = await userConn(ctx);
          const res = await u.request<AgentsOk>({ op: "agents" });
          expect(res.agents).toEqual([]);
          expect(res.polled_at).toBeNull(); // nothing polled yet: no subscriber has connected
        } finally {
          await stopAgentsTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    T,
  );
});

describe("agents polling: permission (user role only)", () => {
  test(
    "session role からの op:'agents' は bad_request",
    async () => {
      const { base, home, binDir, callLog } = mkFixture();
      try {
        writeMockClaude(binDir, callLog, {});
        const ctx = await startAgentsTestDaemon(home, binDir);
        try {
          const s = await sessionConn(ctx, "A");
          const res = await s.request<ErrLite>({ op: "agents" });
          expect(res.ok).toBe(false);
          expect(res.error.code).toBe("bad_request");
        } finally {
          await stopAgentsTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "session role の subscribe は agents poller を起動しない (op:'agents' は空キャッシュのまま)",
    async () => {
      const { base, home, binDir, callLog } = mkFixture();
      try {
        const dirA = path.join(home, ".claude-a");
        fs.mkdirSync(dirA);
        writeMockClaude(binDir, callLog, {
          [dirA]: [{ pid: 1, cwd: "/a", kind: "interactive", startedAt: 1, sessionId: "sA" }],
        });
        const ctx = await startAgentsTestDaemon(home, binDir);
        try {
          const s = await sessionConn(ctx, "A");
          await s.request({ op: "subscribe" });
          // give the (absent) poller a few periods worth of time to prove it never fired
          await new Promise((r) => setTimeout(r, POLL_MS * 3));
          expect(callCount(callLog)).toBe(0);
        } finally {
          await stopAgentsTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    T,
  );
});

describe("agents polling: lifecycle driven by subscriber count", () => {
  test(
    "user subscribe で即時 1 回 poll + ev:'agents' が届き、op:'agents' で同じ結果が読める",
    async () => {
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
          const { ev } = await u.readEventUntil<AgentsOk & { ev: string }>(
            (e) => e.ev === "agents",
          );
          expect(ev.agents.map((a) => a.sessionId)).toEqual(["sA"]);
          expect(ev.polled_at).not.toBeNull();

          const cached = await u.request<AgentsOk>({ op: "agents" });
          expect(cached.agents.map((a) => a.sessionId)).toEqual(["sA"]);
          // >= rather than === : the poller keeps ticking every POLL_MS in the
          // background, so a poll cycle can legitimately land between the ev
          // above and this request — the result is unchanged (still just sA)
          // but polled_at may have advanced. Exact-timestamp equality would be
          // over-asserting a timing coincidence the op contract never promised.
          expect(cached.polled_at).not.toBeNull();
          expect(new Date(cached.polled_at as string).getTime()).toBeGreaterThanOrEqual(
            new Date(ev.polled_at as string).getTime(),
          );
        } finally {
          await stopAgentsTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "最後の user subscriber が切断すると poll が止まる (切断後の呼び出し回数が増え続けない)",
    async () => {
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
          await u.readEventUntil((e) => e.ev === "agents"); // confirm polling really started
          u.close();

          // poller teardown happens synchronously inside the socket close handler
          // (removeConn -> maybeStopAgentsPoller); give the OS a moment to deliver
          // the close event, then sample the call count twice a poll-period apart —
          // two equal samples is the observable proof the interval stopped, not
          // just that it hasn't fired yet by luck.
          await new Promise((r) => setTimeout(r, POLL_MS * 2));
          const sample1 = callCount(callLog);
          await new Promise((r) => setTimeout(r, POLL_MS * 3));
          const sample2 = callCount(callLog);
          expect(sample2).toBe(sample1);
        } finally {
          await stopAgentsTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    T,
  );

  test(
    "claude agents --json が変わらない限り、2 回目以降の poll では ev:'agents' が再配信されない",
    async () => {
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
          await u.readEventUntil((e) => e.ev === "agents"); // first (only) agents event

          // Let several more poll cycles actually run underneath (proves this
          // isn't just "the second poll hasn't happened yet").
          await new Promise((r) => setTimeout(r, POLL_MS * 4));
          expect(callCount(callLog)).toBeGreaterThan(1);

          // Drive a distinguishable event through the same subscribe stream (a
          // msg from a fresh session in a fresh room) and confirm no "agents"
          // event snuck in among the events collected while waiting for it —
          // proves the unchanged poll result was suppressed, not just unlucky
          // timing.
          const s = await sessionConn(ctx, "S");
          const created = await s.request<{ room: string }>({ op: "create_room", members: [] });
          await s.request({ op: "post", room: created.room, msg: "marker" });
          const { seen } = await u.readEventUntil((e) => e.type === "msg" && e.msg === "marker");
          expect(seen.some((e: any) => e.ev === "agents")).toBe(false);
        } finally {
          await stopAgentsTestDaemon(ctx);
        }
      } finally {
        fs.rmSync(base, { recursive: true, force: true });
      }
    },
    T,
  );

  // Regression (adversarial review, agents.ts minor finding): the poll
  // interval and POLL_TIMEOUT_MS both being ~5s (here shrunk via
  // CCMSG_AGENTS_POLL_MS) means a slow `claude agents --json` call can still
  // be in flight when the next tick fires. Without an in-flight guard, two
  // overlapping polls can be running at once — the mock `claude` below marks
  // that directly (a lock file already present when it starts) instead of
  // inferring it from timing.
  test(
    "in-flight guard: 前回の poll がまだ完了していない間は次の tick が新しい claude 呼び出しを開始しない",
    async () => {
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
        fs.writeFileSync(file, script, { mode: 0o755 });

        const ctx = await startAgentsTestDaemon(home, binDir);
        try {
          const u = await userConn(ctx);
          await u.request({ op: "subscribe" });
          await u.readEventUntil((e) => e.ev === "agents"); // first poll landed

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
    },
    T,
  );

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
  test(
    "stderr の大量出力があっても poll は問題なく完了する (診断目的の drain 確認)",
    async () => {
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
        fs.writeFileSync(file, script, { mode: 0o755 });

        const ctx = await startAgentsTestDaemon(home, binDir);
        try {
          const u = await userConn(ctx);
          const start = Date.now();
          await u.request({ op: "subscribe" });
          await u.readEventUntil((e) => e.ev === "agents");
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
    },
    T,
  );
});
