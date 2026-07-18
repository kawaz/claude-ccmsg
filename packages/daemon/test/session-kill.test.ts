// session_kill contract (DR-0028): fresh sid→pid resolution across config
// dirs, ps command-line verification (pid-reuse guard), and the two-shot
// SIGTERM sequence with a bounded observation grace and NO SIGKILL — ever.
// These tests are the executable spec: fake-deps cases pin the decision
// logic byte-for-byte, and the real-process cases prove the production
// signal path (sendSignal/isAlive) against live children while faking only
// the two command runners (`claude agents` / `ps`), so no real claude
// session is ever touched.
import { describe, expect, test } from "bun:test";
import {
  killSession,
  resolvePid,
  sessionKill,
  verifyPid,
  type SessionKillDeps,
} from "../src/session-kill.ts";
import { connect, startTestDaemon, stopTestDaemon } from "./helpers.ts";

/** Fake-deps factory: every effect is inert/instant by default so each test
 * overrides exactly the behavior its case is about. Timing is shrunk 10x
 * (100ms second-shot / 20ms poll / 300ms grace) — the sequence logic is
 * ratio-driven (constants are injected, DR-0028 fixes the production values
 * at 1s/200ms/3s), so short timings exercise identical branch structure
 * without slow tests. */
function fakeDeps(overrides: Partial<SessionKillDeps> = {}): SessionKillDeps {
  return {
    configDirs: () => ["/fake/.claude"],
    runAgents: () => Promise.resolve("[]"),
    runPs: () => Promise.resolve("claude\n"),
    sendSignal: () => {},
    isAlive: () => false,
    sleep: () => Promise.resolve(),
    timing: { secondSignalAfterMs: 100, pollIntervalMs: 20, totalGraceMs: 300 },
    ...overrides,
  };
}

const AGENTS_ROW = (sid: string, pid: number) => JSON.stringify([{ sessionId: sid, pid }]);

describe("resolvePid (fresh sid→pid resolution)", () => {
  // A matching sessionId row yields its pid: the daemon's only trusted
  // pid source is its own fresh `claude agents --json --all` run (DR-0028 —
  // never the ≤5s-stale poller cache, never a client-asserted pid).
  test("returns the pid of the row whose sessionId matches", async () => {
    const deps = fakeDeps({ runAgents: () => Promise.resolve(AGENTS_ROW("sid-a", 4242)) });
    expect(await resolvePid("sid-a", deps)).toBe(4242);
  });

  // No matching row = null: killing must be impossible without a positive
  // identification; server.ts maps this to not_found.
  test("returns null when no row matches the sessionId", async () => {
    const deps = fakeDeps({ runAgents: () => Promise.resolve(AGENTS_ROW("sid-other", 4242)) });
    expect(await resolvePid("sid-a", deps)).toBeNull();
  });

  // Broken CLI output must degrade to "not found", never to a guessed pid:
  // invalid JSON and a rejecting run (non-zero exit / spawn failure /
  // timeout in production) both skip the dir.
  test("returns null on invalid JSON output", async () => {
    const deps = fakeDeps({ runAgents: () => Promise.resolve("not json {") });
    expect(await resolvePid("sid-a", deps)).toBeNull();
  });

  test("returns null when the agents command fails (non-zero exit)", async () => {
    const deps = fakeDeps({ runAgents: () => Promise.reject(new Error("exited 1")) });
    expect(await resolvePid("sid-a", deps)).toBeNull();
  });

  // Multi config-dir scan: dirs are checked in configDirs() order and the
  // FIRST match wins (deterministic pick, DR-0028); a failing earlier dir
  // must not abort the scan (per-dir isolation, same posture as the agents
  // poller).
  test("scans config dirs in order and returns the first match", async () => {
    const calls: string[] = [];
    const deps = fakeDeps({
      configDirs: () => ["/dir1", "/dir2", "/dir3"],
      runAgents: (dir) => {
        calls.push(dir);
        if (dir === "/dir1") return Promise.reject(new Error("broken CLI"));
        if (dir === "/dir2") return Promise.resolve(AGENTS_ROW("sid-a", 1111));
        return Promise.resolve(AGENTS_ROW("sid-a", 9999));
      },
    });
    expect(await resolvePid("sid-a", deps)).toBe(1111);
    // dir3 is never reached — the first match short-circuits the scan.
    expect(calls).toEqual(["/dir1", "/dir2"]);
  });

  // A row with a matching sessionId but a non-integer pid is untrustworthy —
  // skip it rather than signalling a garbage value.
  test("ignores a matching row whose pid is not an integer", async () => {
    const deps = fakeDeps({
      runAgents: () => Promise.resolve(JSON.stringify([{ sessionId: "sid-a", pid: "4242" }])),
    });
    expect(await resolvePid("sid-a", deps)).toBeNull();
  });

  // pid ≤ 1 is refused at the source: process.kill(0) would signal the
  // daemon's OWN process group (suicide), negative pids signal whole groups,
  // and 1 is init/launchd. A corrupted registry row must never reach any of
  // them, independently of the later ps verification.
  test("ignores matching rows whose pid is 0, negative, or 1", async () => {
    for (const pid of [0, -1, 1]) {
      const deps = fakeDeps({
        runAgents: () => Promise.resolve(JSON.stringify([{ sessionId: "sid-a", pid }])),
      });
      expect(await resolvePid("sid-a", deps)).toBeNull();
    }
  });
});

describe("verifyPid (pid-reuse guard)", () => {
  // The `claude agents` snapshot (and the CLI's own registry) can be stale;
  // a recycled pid must never be signalled. Pass only when ps shows argv[0]
  // whose basename is exactly `claude` — both the bare PATH-launched form
  // and an absolute-path form must pass.
  test("passes when argv[0] basename is claude (bare and absolute forms)", async () => {
    for (const cmd of [
      "claude --model fable --effort low --name x\n",
      "/opt/homebrew/bin/claude --resume\n",
    ]) {
      const deps = fakeDeps({ runPs: () => Promise.resolve(cmd) });
      expect(await verifyPid(123, deps)).toBe(true);
    }
  });

  test("refuses when ps output shows an unrelated command (pid reused)", async () => {
    const deps = fakeDeps({ runPs: () => Promise.resolve("/usr/bin/vim notes.txt\n") });
    expect(await verifyPid(123, deps)).toBe(false);
  });

  // Anti-suicide: a substring test would pass ANY process whose command line
  // merely mentions a .claude* path — on the dev machine that includes the
  // ccmsg daemon itself (bun .../.claude-personal/plugins/cache/ccmsg/...),
  // every Claude Code-spawned zsh (source .../.claude-personal/
  // shell-snapshots/...), and the subscribe helpers. All of these must be
  // refused: "claude" appearing in an argument is not a claude process.
  test("refuses processes that only mention claude-ish paths in arguments", async () => {
    const impostors = [
      "/nix/store/xxx-bun-1.3.13/bin/bun /Users/u/.claude-personal/plugins/cache/ccmsg/ccmsg/0.59.0/packages/cli/src/index.ts daemon run\n",
      "/bin/zsh -c source /Users/u/.claude-personal/shell-snapshots/snapshot.sh && eval 'ccmsg subscribe'\n",
      "vim /Users/u/notes/claude-tips.md\n",
      // Prefix/suffix name collisions on argv[0] itself.
      "/usr/local/bin/claude-wrapper --help\n",
      "/usr/local/bin/notclaude\n",
    ];
    for (const cmd of impostors) {
      const deps = fakeDeps({ runPs: () => Promise.resolve(cmd) });
      expect(await verifyPid(123, deps)).toBe(false);
    }
  });

  // ps failing (typically: no such pid → non-zero exit) also refuses —
  // "already gone" and "not claude anymore" are the same outcome (not_found)
  // for the caller (DR-0028).
  test("refuses when ps fails", async () => {
    const deps = fakeDeps({ runPs: () => Promise.reject(new Error("ps exited 1")) });
    expect(await verifyPid(123, deps)).toBe(false);
  });
});

describe("killSession sequence (fake deps)", () => {
  // Guard-less processes (e.g. background sessions) die on the first
  // SIGTERM. The second shot must then NOT be sent — a spurious second
  // signal could hit a recycled pid or re-trigger TUI state (DR-0028: "1 発目
  // の待機中に消滅したら 2 発目は送らない").
  test("process dies after the first SIGTERM → exactly 1 signal, terminated:true", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sendSignal: (_pid, sig) => signals.push(sig),
      // Dead from the very first liveness poll.
      isAlive: () => false,
    });
    expect(await killSession(42, deps)).toEqual({ terminated: true });
    expect(signals).toEqual(["SIGTERM"]);
  });

  // The claude TUI arms a quit-confirmation guard on the first SIGTERM and
  // only exits on the second (kawaz observation, DR-0028). Survives past the
  // second-shot deadline → second SIGTERM → dies → terminated:true.
  test("process survives 1s → second SIGTERM sent → dies → terminated:true", async () => {
    const signals: string[] = [];
    let alive = true;
    const deps = fakeDeps({
      sendSignal: (_pid, sig) => {
        signals.push(sig);
        // The second shot is what actually kills the guarded TUI.
        if (signals.length === 2) alive = false;
      },
      isAlive: () => alive,
    });
    expect(await killSession(42, deps)).toEqual({ terminated: true });
    expect(signals).toEqual(["SIGTERM", "SIGTERM"]);
  });

  // A process that outlives the whole grace: exactly 2 SIGTERMs (never a
  // third, NEVER a SIGKILL — DR-0028 refuses irreversible escalation that
  // could break transcript flush) and terminated:false, which is a report
  // ("signals delivered, unconfirmed"), not an error.
  test("process never dies → exactly 2 SIGTERMs, no SIGKILL, terminated:false", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sendSignal: (_pid, sig) => signals.push(sig),
      isAlive: () => true,
    });
    expect(await killSession(42, deps)).toEqual({ terminated: false });
    expect(signals).toEqual(["SIGTERM", "SIGTERM"]);
  });

  // Residual TOCTOU window (verify → kill): the process vanishing right
  // before the first signal makes sendSignal throw ESRCH — that is success
  // (gone is what was asked for), not an error path. The fake error carries
  // `code: "ESRCH"` because that is the real shape node/bun's process.kill
  // throws (verified on bun 1.3.13: `e.code === "ESRCH"`).
  test("pid vanished before the first signal (ESRCH) → terminated:true", async () => {
    const deps = fakeDeps({
      sendSignal: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    });
    expect(await killSession(42, deps)).toEqual({ terminated: true });
  });

  // EPERM is NOT "gone": the process exists but we may not signal it
  // (e.g. a pid recycled to another user's process inside the TOCTOU
  // window). Swallowing it as terminated:true would make the UI report
  // "終了を確認" about a live process — it must propagate to the server's
  // internal-error path instead.
  test("sendSignal EPERM (process exists, not ours) → propagates as an error", async () => {
    const deps = fakeDeps({
      sendSignal: () => {
        throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
      },
    });
    let thrown: unknown = null;
    try {
      await killSession(42, deps);
    } catch (e) {
      thrown = e;
    }
    expect(String(thrown)).toContain("EPERM");
  });
});

describe("killSession against real processes (real signals, fake runners)", () => {
  // Real-signal integration: sendSignal/isAlive are the production
  // process.kill; only timing is shrunk. `sleep 100` has no SIGTERM handler,
  // so this proves the one-shot path end-to-end against a live OS process.
  test("sleep child dies on the first SIGTERM (one-shot path)", async () => {
    const child = Bun.spawn(["sleep", "100"]);
    const signals: string[] = [];
    const deps = fakeDeps({
      sendSignal: (pid, sig) => {
        signals.push(sig);
        process.kill(pid, sig);
      },
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      timing: { secondSignalAfterMs: 200, pollIntervalMs: 50, totalGraceMs: 2000 },
    });
    const result = await killSession(child.pid, deps);
    expect(result.terminated).toBe(true);
    expect(signals).toEqual(["SIGTERM"]);
    await child.exited;
  });

  // Two-shot path with a real guarded child: the shell traps SIGTERM, counts
  // hits in a file, and exits only on the second — a faithful stand-in for
  // the claude TUI's quit-confirmation guard (we must not kill a real
  // claude session in tests).
  test("TERM-guarded child needs the second SIGTERM (two-shot path)", async () => {
    // `trap` increments a counter; the handler exits on the 2nd TERM. The
    // busy loop is short-sleep-based so the trap fires promptly (a long
    // blocking sleep would defer trap handling until it returns on some
    // shells; 0.05s keeps the reaction latency well under pollIntervalMs).
    // The child prints "ready" AFTER installing the trap and the test waits
    // for it — without this handshake the first SIGTERM can land before the
    // trap exists and kill the shell one-shot (observed flake in this test's
    // own first run).
    const script = `
      count=0
      trap 'count=$((count+1)); if [ "$count" -ge 2 ]; then exit 0; fi' TERM
      echo ready
      while :; do sleep 0.05; done
    `;
    const child = Bun.spawn(["bash", "-c", script], { stdout: "pipe" });
    const reader = child.stdout.getReader();
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    reader.releaseLock();
    const signals: string[] = [];
    const deps = fakeDeps({
      sendSignal: (pid, sig) => {
        signals.push(sig);
        process.kill(pid, sig);
      },
      isAlive: (pid) => {
        try {
          process.kill(pid, 0);
          return true;
        } catch {
          return false;
        }
      },
      sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
      timing: { secondSignalAfterMs: 300, pollIntervalMs: 50, totalGraceMs: 5000 },
    });
    const result = await killSession(child.pid, deps);
    expect(result.terminated).toBe(true);
    expect(signals).toEqual(["SIGTERM", "SIGTERM"]);
    await child.exited;
  });
});

describe("sessionKill (resolve → verify → kill composition)", () => {
  // The composed flow refuses at each gate: unresolved sid and failed ps
  // verification both surface as found:false (server.ts → not_found), and
  // no signal is ever sent in either case.
  test("unknown sid → found:false, no signal sent", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      runAgents: () => Promise.resolve("[]"),
      sendSignal: (_pid, sig) => signals.push(sig),
    });
    expect(await sessionKill("sid-x", deps)).toEqual({ found: false });
    expect(signals).toEqual([]);
  });

  test("pid fails ps verification → found:false, no signal sent", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      runAgents: () => Promise.resolve(AGENTS_ROW("sid-x", 555)),
      runPs: () => Promise.resolve("/usr/bin/vim\n"),
      sendSignal: (_pid, sig) => signals.push(sig),
    });
    expect(await sessionKill("sid-x", deps)).toEqual({ found: false });
    expect(signals).toEqual([]);
  });

  test("resolved + verified → kill runs and reports terminated", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      runAgents: () => Promise.resolve(AGENTS_ROW("sid-x", 555)),
      sendSignal: (_pid, sig) => signals.push(sig),
      isAlive: () => false,
    });
    expect(await sessionKill("sid-x", deps)).toEqual({ found: true, terminated: true });
    expect(signals).toEqual(["SIGTERM"]);
  });
});

describe("session_kill over the wire (role gate + not_found)", () => {
  // Role gate (DR-0028: session-role agents must never kill each other):
  // a session connection is rejected with bad_request BEFORE any pid
  // resolution work happens — same gate pattern as session_launch.
  test("session role is refused with bad_request", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "session", sid: "sid-agent" });
      const res = await c.request({
        op: "session_kill",
        request_id: "k1",
        session_id: "sid-victim",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });

  // user role + a sid no `claude agents` run can know: the 2-phase ack
  // arrives first (arrival-order contract), then the result event carries
  // not_found. This also covers environments where the `claude` CLI itself
  // is absent/failing — resolution failure and no-match are the same
  // not_found to the caller.
  test("user role with an unknown session_id gets ack then not_found result", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });
      const ack = await c.request({
        op: "session_kill",
        request_id: "k2",
        session_id: "00000000-0000-0000-0000-000000000000",
      });
      expect(ack.ok).toBe(true);
      expect(ack.accepted).toBe(true);
      expect(ack.request_id).toBe("k2");
      const { ev } = await c.readEventUntil<{
        ev: string;
        request_id: string;
        ok: boolean;
        error?: { code: string };
      }>((e) => e.ev === "session_kill_result");
      expect(ev.request_id).toBe("k2");
      expect(ev.ok).toBe(false);
      expect(ev.error?.code).toBe("not_found");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  }, 30000);

  // request_id is the 2-phase correlation key — an absent/empty one is a
  // synchronous invalid_args, mirroring acceptTwoPhase's contract for
  // translate/session_launch.
  test("missing request_id is refused with invalid_args", async () => {
    const ctx = await startTestDaemon();
    try {
      const c = await connect(ctx.sock);
      await c.hello({ role: "user" });
      const res = await c.request({ op: "session_kill", session_id: "sid-x" });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("invalid_args");
      c.close();
    } finally {
      await stopTestDaemon(ctx);
    }
  });
});
