// session_kill contract (DR-0028): fresh sid→pid resolution across config
// dirs, argv[0] verification (pid-reuse guard), and the two-shot SIGTERM
// sequence with a bounded observation grace and NO SIGKILL — ever. These
// tests are the executable spec: fake-deps cases pin the decision logic
// byte-for-byte, and the real-process cases prove the production argv[0]
// read and signal path (readArgv0/sendSignal/isAlive) against live children
// while faking only the state files, so no real claude session is ever
// touched.
import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import {
  killSession,
  killSessionForce,
  productionKillDeps,
  readArgv0,
  resolveRecord,
  sessionKill,
  verifyPid,
  type SessionKillDeps,
} from "../src/session-kill.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";
import { startInProcessDaemon, stopInProcessDaemon, sessionConn, userConn } from "./helpers.ts";

const tmp = perTestTmpDir();

/** Fake-deps factory: every effect is inert/instant by default so each test
 * overrides exactly the behavior its case is about. Timing is shrunk 10x
 * (100ms second-shot / 20ms poll / 300ms grace) — the sequence logic is
 * ratio-driven (constants are injected, DR-0028 fixes the production values
 * at 1s/200ms/3s), so short timings exercise identical branch structure
 * without slow tests. */
function fakeDeps(overrides: Partial<SessionKillDeps> = {}): SessionKillDeps {
  return {
    configDirs: () => ["/fake/.claude"],
    sessionsIn: () => Promise.resolve([]),
    readArgv0: () => Promise.resolve("claude"),
    sendSignal: () => {},
    isAlive: () => false,
    sleep: () => Promise.resolve(),
    timing: { secondSignalAfterMs: 100, pollIntervalMs: 20, totalGraceMs: 300 },
    ...overrides,
  };
}

const AGENTS_ROW = (sid: string, pid: number) => [{ sessionId: sid, pid }];

describe("resolveRecord (fresh sid→pid resolution)", () => {
  // A matching sessionId row yields its pid: the daemon's only trusted
  // pid source is its own fresh read of the state files (DR-0028 —
  // never the ≤5s-stale poller cache, never a client-asserted pid).
  test("returns the pid of the row whose sessionId matches", async () => {
    const deps = fakeDeps({ sessionsIn: () => Promise.resolve(AGENTS_ROW("sid-a", 4242)) });
    expect((await resolveRecord("sid-a", deps))?.pid).toBe(4242);
  });

  // No matching row = null: killing must be impossible without a positive
  // identification; server.ts maps this to not_found.
  test("returns null when no row matches the sessionId", async () => {
    const deps = fakeDeps({ sessionsIn: () => Promise.resolve(AGENTS_ROW("sid-other", 4242)) });
    expect(await resolveRecord("sid-a", deps)).toBeNull();
  });

  // A dir that cannot be read must degrade to "not found", never to a
  // guessed pid.
  test("returns null when the config dir cannot be read", async () => {
    const deps = fakeDeps({ sessionsIn: () => Promise.reject(new Error("exited 1")) });
    expect(await resolveRecord("sid-a", deps)).toBeNull();
  });

  // Multi config-dir scan: dirs are checked in configDirs() order and the
  // FIRST match wins (deterministic pick, DR-0028); a failing earlier dir
  // must not abort the scan (per-dir isolation, same posture as the agents
  // poller).
  test("scans config dirs in order and returns the first match", async () => {
    const calls: string[] = [];
    const deps = fakeDeps({
      configDirs: () => ["/dir1", "/dir2", "/dir3"],
      sessionsIn: (dir) => {
        calls.push(dir);
        if (dir === "/dir1") return Promise.reject(new Error("unreadable dir"));
        if (dir === "/dir2") return Promise.resolve(AGENTS_ROW("sid-a", 1111));
        return Promise.resolve(AGENTS_ROW("sid-a", 9999));
      },
    });
    expect((await resolveRecord("sid-a", deps))?.pid).toBe(1111);
    // dir3 is never reached — the first match short-circuits the scan.
    expect(calls).toEqual(["/dir1", "/dir2"]);
  });

  // A row with a matching sessionId but a non-integer pid is untrustworthy —
  // skip it rather than signalling a garbage value.
  test("ignores a matching row whose pid is not an integer", async () => {
    const deps = fakeDeps({
      sessionsIn: () => Promise.resolve([{ sessionId: "sid-a", pid: 4242.5 }]),
    });
    expect(await resolveRecord("sid-a", deps)).toBeNull();
  });

  // pid ≤ 1 is refused at the source: process.kill(0) would signal the
  // daemon's OWN process group (suicide), negative pids signal whole groups,
  // and 1 is init/launchd. A corrupted registry row must never reach any of
  // them, independently of the later argv[0] verification.
  test("ignores matching rows whose pid is 0, negative, or 1", async () => {
    for (const pid of [0, -1, 1]) {
      const deps = fakeDeps({
        sessionsIn: () => Promise.resolve([{ sessionId: "sid-a", pid }]),
      });
      expect(await resolveRecord("sid-a", deps)).toBeNull();
    }
  });
});

describe("verifyPid (pid-reuse guard)", () => {
  // The state file read (and a file a crashed session left) can be stale;
  // a recycled pid must never be signalled. Pass only when the process's
  // argv[0] has the basename `claude` exactly — the bare PATH-launched form,
  // an absolute path, and the desktop app's path with spaces in it must all
  // pass.
  test("passes when argv[0] basename is claude (bare, absolute and spaced forms)", async () => {
    for (const argv0 of [
      "claude",
      "/opt/homebrew/bin/claude",
      "/Users/u/Library/Application Support/Claude/claude-code/2.1.321/ddbdf2b334e1/claude.app/Contents/MacOS/claude",
    ]) {
      const deps = fakeDeps({ readArgv0: () => Promise.resolve(argv0) });
      expect(await verifyPid(123, deps)).toBe(true);
    }
  });

  test("refuses when argv[0] is an unrelated command (pid reused)", async () => {
    const deps = fakeDeps({ readArgv0: () => Promise.resolve("/usr/bin/vim") });
    expect(await verifyPid(123, deps)).toBe(false);
  });

  // Anti-suicide: a substring test would pass ANY process whose command line
  // merely mentions a .claude* path — on the dev machine that includes the
  // ccmsg daemon itself (bun .../.claude-personal/plugins/cache/ccmsg/...),
  // every Claude Code-spawned zsh (source .../.claude-personal/
  // shell-snapshots/...), and the subscribe helpers. All of these must be
  // refused: "claude" appearing in an argument is not a claude process. The
  // arguments never reach verifyPid (readArgv0 reads argv[0] alone; the
  // real-process case below proves that of the production read), so what is
  // left to pin here is their argv[0]s, and names that merely contain
  // `claude`.
  test("refuses processes whose argv[0] is not claude though claude is in their command line", async () => {
    const impostors = [
      "/nix/store/xxx-bun-1.3.13/bin/bun",
      "/bin/zsh",
      "vim",
      // Prefix/suffix name collisions on argv[0] itself.
      "/usr/local/bin/claude-wrapper",
      "/usr/local/bin/notclaude",
    ];
    for (const argv0 of impostors) {
      const deps = fakeDeps({ readArgv0: () => Promise.resolve(argv0) });
      expect(await verifyPid(123, deps)).toBe(false);
    }
  });

  // A path with spaces is matched by its basename alone, as any other: a
  // directory named like claude, or a basename that starts with claude and
  // goes on past a space, is not claude.
  test("refuses spaced paths whose basename is not claude", async () => {
    for (const argv0 of [
      "/x/my claude/vim",
      "/Users/u/Library/Application Support/Claude/claude-code/claude.app/Contents/MacOS/Claude Helper",
      "/Applications/Tools/claude helper",
      "/x/claude/",
    ]) {
      const deps = fakeDeps({ readArgv0: () => Promise.resolve(argv0) });
      expect(await verifyPid(123, deps)).toBe(false);
    }
  });

  // The read failing (typically: no such pid) also refuses — "already gone"
  // and "not claude anymore" are the same outcome (not_found) for the caller
  // (DR-0028).
  test("refuses when argv[0] cannot be read", async () => {
    const deps = fakeDeps({ readArgv0: () => Promise.reject(new Error("ps exited 1")) });
    expect(await verifyPid(123, deps)).toBe(false);
  });
});

describe("readArgv0 and verifyPid against real processes", () => {
  /** A harmless resident process run as `argv0`: the running bun under a
   * symlink of that path, holding a timer (bun does not pick its program by
   * argv[0], where a multi-call coreutils such as uutils would die on
   * `claude`). `extraArgs` follow the script. Resolves once the child says it
   * is running its script, so argv[0] is the child's own when read. */
  async function resident(
    argv0: string,
    extraArgs: string[] = [],
  ): Promise<Bun.Subprocess<"ignore", "pipe", "inherit">> {
    fs.mkdirSync(path.dirname(argv0), { recursive: true });
    fs.symlinkSync(process.execPath, argv0);
    const child = Bun.spawn(
      [argv0, "-e", 'console.log("ready"); setTimeout(() => {}, 600_000)', ...extraArgs],
      { stdin: "ignore", stdout: "pipe", stderr: "inherit" },
    );
    const reader = child.stdout.getReader();
    const first = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(first.value)).toContain("ready");
    return child;
  }

  async function stop(child: Bun.Subprocess<"ignore", "pipe", "inherit">): Promise<void> {
    child.kill("SIGKILL");
    await child.exited;
  }

  // The desktop app's shape: a claude under directories with spaces in their
  // names. The production read answers the path whole, and the guard passes.
  test("a claude under a spaced path reads as that whole path and passes", async () => {
    const bin = path.join(tmp("argv0-"), "Application Support", "Claude", "MacOS", "claude");
    const child = await resident(bin);
    try {
      expect(await readArgv0(child.pid)).toBe(bin);
      expect(await verifyPid(child.pid, productionKillDeps)).toBe(true);
    } finally {
      await stop(child);
    }
  });

  // argv[0] alone is read: a process that is not claude but carries claude
  // paths and the word itself in its arguments is refused.
  test("arguments naming claude do not reach the read, and the guard refuses", async () => {
    const bin = path.join(tmp("argv0-"), "my claude", "bun");
    const child = await resident(bin, ["/Users/u/.claude-personal/plugins/claude", "claude"]);
    try {
      expect(await readArgv0(child.pid)).toBe(bin);
      expect(await verifyPid(child.pid, productionKillDeps)).toBe(false);
    } finally {
      await stop(child);
    }
  });

  // The whole flow on the production read and signals, with only the state
  // file faked: the spaced claude is found, verified and stopped.
  test("sessionKill stops a claude under a spaced path", async () => {
    const bin = path.join(tmp("argv0-"), "Application Support", "claude");
    const child = await resident(bin);
    try {
      const deps: SessionKillDeps = {
        ...productionKillDeps,
        configDirs: () => ["/fake/.claude"],
        sessionsIn: () => Promise.resolve(AGENTS_ROW("sid-spaced", child.pid)),
        timing: { secondSignalAfterMs: 200, pollIntervalMs: 50, totalGraceMs: 2000 },
      };
      expect(await sessionKill("sid-spaced", deps)).toEqual({ found: true, terminated: true });
      await child.exited;
      expect(child.signalCode).toBe("SIGTERM");
    } finally {
      await stop(child);
    }
  });

  test("a pid that is gone fails the read and the guard", async () => {
    const child = await resident(path.join(tmp("argv0-"), "claude"));
    const { pid } = child;
    await stop(child);
    const read = await readArgv0(pid).then(
      (argv0) => ({ read: argv0 }),
      (e: unknown) => ({ failed: String(e) }),
    );
    expect(read).toHaveProperty("failed");
    expect(await verifyPid(pid, productionKillDeps)).toBe(false);
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

describe("killSessionForce (DR-0028 addendum opt-in SIGKILL)", () => {
  // Force 経路の最小契約: SIGTERM でなく SIGKILL を 1 発、以降は通常経路と同じ
  // liveness poll。落ちたら terminated:true。SIGTERM の 2 連発 / 1s 待機は
  // 意味を成さないので排除する (SIGKILL は guard を持たない、即殺すのが仕事)。
  test("SIGKILL を 1 発だけ送り、死亡を観測すれば terminated:true", async () => {
    const signals: string[] = [];
    // 初回 isAlive で true、poll 後に false になる ping-pong (プロセスが SIGKILL
    // を受けてから 1 poll 分で消える現実的な流れ)。
    let alive = true;
    const deps = fakeDeps({
      sendSignal: (_pid, sig) => {
        signals.push(sig);
        alive = false;
      },
      isAlive: () => alive,
    });
    expect(await killSessionForce(42, deps)).toEqual({ terminated: true });
    expect(signals).toEqual(["SIGKILL"]);
  });

  // 死んでいない observable な zombie (uninterruptible sleep 等) は嘘をつかず
  // terminated:false を返す (SIGKILL を送ったのに pid が観測される、= UI 側で
  // 「SIGKILL 送信済みだがまだ pid が観測される」と正直に表示する契約)。
  test("SIGKILL 後も pid が観測され続けたら terminated:false", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sendSignal: (_pid, sig) => signals.push(sig),
      isAlive: () => true,
    });
    expect(await killSessionForce(42, deps)).toEqual({ terminated: false });
    expect(signals).toEqual(["SIGKILL"]);
  });

  // TOCTOU: SIGKILL 送信前にプロセスが消えていたら (ESRCH) 通常経路と同じく
  // terminated:true 扱い (「消えていることを望んだ結果と一致」)。
  test("SIGKILL 送信時に ESRCH なら terminated:true (既に消えていた)", async () => {
    const deps = fakeDeps({
      sendSignal: () => {
        throw Object.assign(new Error("kill ESRCH"), { code: "ESRCH" });
      },
    });
    expect(await killSessionForce(42, deps)).toEqual({ terminated: true });
  });

  // sessionKill(sid, deps, {force: true}) は resolveRecord + verifyPid を通した
  // 後で force 経路に入る (pid-reuse guard は force でも絶対に外れない契約)。
  test("sessionKill({force:true}) は verify を経てから SIGKILL 経路に入る", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sessionsIn: () => Promise.resolve(AGENTS_ROW("sid-x", 4242)),
      readArgv0: () => Promise.resolve("claude"),
      sendSignal: (_pid, sig) => signals.push(sig),
      isAlive: () => false,
    });
    expect(await sessionKill("sid-x", deps, { force: true })).toEqual({
      found: true,
      terminated: true,
    });
    expect(signals).toEqual(["SIGKILL"]);
  });

  // argv[0] 検証 (pid-reuse guard) が落ちたら force でも kill しない。
  test("sessionKill({force:true}) は verify 失敗時に SIGKILL を送らない", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sessionsIn: () => Promise.resolve(AGENTS_ROW("sid-x", 4242)),
      readArgv0: () => Promise.resolve("zsh"), // claude 以外 → verify fail
      sendSignal: (_pid, sig) => signals.push(sig),
    });
    expect(await sessionKill("sid-x", deps, { force: true })).toEqual({
      found: false,
      msg: "the process of session sid-x (pid 4242) could not be confirmed to be claude",
    });
    expect(signals).toEqual([]);
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
  // The composed flow refuses at each gate: unresolved sid and failed argv[0]
  // verification both surface as found:false (server.ts → not_found), and
  // no signal is ever sent in either case.
  test("unknown sid → found:false, no signal sent", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sessionsIn: () => Promise.resolve([]),
      sendSignal: (_pid, sig) => signals.push(sig),
    });
    expect(await sessionKill("sid-x", deps)).toEqual({
      found: false,
      msg: "no process for session sid-x",
    });
    expect(signals).toEqual([]);
  });

  test("pid fails argv[0] verification → found:false, no signal sent", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sessionsIn: () => Promise.resolve(AGENTS_ROW("sid-x", 555)),
      readArgv0: () => Promise.resolve("/usr/bin/vim"),
      sendSignal: (_pid, sig) => signals.push(sig),
    });
    expect(await sessionKill("sid-x", deps)).toEqual({
      found: false,
      msg: "the process of session sid-x (pid 555) could not be confirmed to be claude",
    });
    expect(signals).toEqual([]);
  });

  test("resolved + verified → kill runs and reports terminated", async () => {
    const signals: string[] = [];
    const deps = fakeDeps({
      sessionsIn: () => Promise.resolve(AGENTS_ROW("sid-x", 555)),
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
    const ctx = await startInProcessDaemon();
    try {
      const c = await sessionConn(ctx, "a9e47000-0000-4000-8000-000000000001", {
        repo: "",
        ws: "",
        cwd: "",
      });
      const res = await c.requestError({
        op: "session_kill",
        session_id: "sid-victim",
      });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      c.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });

  // user role + a sid no state file names. This also covers a daemon that
  // reaches no config dir — resolution failure and no-match are the same
  // not_found to the caller.
  test("user role with an unknown session_id is answered not_found", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await userConn(ctx);
      const reply = await c.requestError({
        op: "session_kill",
        session_id: "00000000-0000-0000-0000-000000000000",
      });
      expect(reply.ok).toBe(false);
      expect(reply.error?.code).toBe("not_found");
      c.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  }, 30000);

  // request_id is what a reply is paired with, so a request without one is
  // refused before dispatch (same for every op).
  test("missing request_id is refused with bad_request", async () => {
    const ctx = await startInProcessDaemon();
    try {
      const c = await userConn(ctx);
      const res = await c.requestRaw({ op: "session_kill", session_id: "sid-x" });
      expect(res.ok).toBe(false);
      expect(res.error.code).toBe("bad_request");
      c.close();
    } finally {
      await stopInProcessDaemon(ctx);
    }
  });
});
