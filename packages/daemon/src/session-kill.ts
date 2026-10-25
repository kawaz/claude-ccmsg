// DR-0028 session_kill boundary: resolve sid→pid fresh, verify the pid still
// belongs to a claude process, then run the two-shot SIGTERM sequence. Pure
// logic split out of server.ts (same division of labor as session-launch.ts)
// with every external effect injectable so tests can drive all branches
// without a real `claude`/`ps`, and the integration test can keep real
// signals while faking only the state files and `ps`.
import { isProcessAlive } from "./sidecar-call.ts";
import { readSessionsDir } from "./session-runs.ts";

/** Wait after the first SIGTERM before deciding a second is needed. The
 * claude TUI's first SIGTERM only arms its quit-confirmation guard; too short
 * risks the second arriving before the guard transition (collapsing to "one
 * shot"), too long makes the button feel dead (DR-0028). */
export const SECOND_SIGNAL_AFTER_MS = 1000;

/** Liveness poll period. The guard transition is unobservable from outside
 * the process, so polling `kill(pid, 0)` is the sanctioned exception
 * (DR-0028 / sloppy-ai-patterns "polling しか無い外部対象"). */
export const POLL_INTERVAL_MS = 200;

/** Total observation window from the first SIGTERM. Expiring alive returns
 * `terminated: false` — signals were delivered, confirmation just didn't
 * arrive in time. Never escalates to SIGKILL (DR-0028: the daemon must not
 * auto-choose an irreversible kill that can break transcript flush). */
export const TOTAL_GRACE_MS = 3000;

/** What a config dir's `sessions/<pid>.json` says of one session that the
 * kill and a restart (DR-0028 「restart」) read. */
export interface SessionRecord {
  sessionId: string;
  pid: number;
  /** The process's working directory, as a realpath. */
  cwd?: string;
  /** The name the session was given (`--name`, a rename). */
  name?: string;
}

/** Injectable effects. Production defaults in `productionKillDeps` below;
 * tests replace any subset (structural, no class needed). */
export interface SessionKillDeps {
  /** The CLAUDE_CONFIG_DIRs to look the session up in. */
  configDirs(): string[];
  /** The live sessions one config dir records (`sessions/<pid>.json`). */
  sessionsIn(configDir: string): Promise<readonly SessionRecord[]>;
  /** Run `ps -p <pid> -o command=` and return stdout. Must reject when ps
   * fails (which includes "no such pid"). */
  runPs(pid: number): Promise<string>;
  /** process.kill(pid, sig) — throws when the pid is gone. SIGKILL is only
   * dispatched from the force path (DR-0028 addendum r38 mid=6); the default
   * two-shot sequence remains SIGTERM-only so the "never irreversibly kill
   * without opt-in" invariant lives at the type level. */
  sendSignal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
  /** `process.kill(pid, 0)` liveness probe. */
  isAlive(pid: number): boolean;
  sleep(ms: number): Promise<void>;
  /** Timing knobs — production uses the exported constants; tests shrink them. */
  timing: {
    secondSignalAfterMs: number;
    pollIntervalMs: number;
    totalGraceMs: number;
  };
}

/** Resolve session_id → pid by reading Claude Code's state files afresh in
 * every config dir (DR-0028: the poller cache can be a round stale and a
 * stale pid is a mis-kill). Config dirs are scanned in order and the FIRST
 * matching record wins — session UUIDs don't collide across config dirs in
 * practice, and a deterministic pick beats failing the whole request on a
 * hypothetical duplicate. A dir that cannot be read skips that dir. Returns
 * null when no dir yields a match. */
export async function resolvePid(sessionId: string, deps: SessionKillDeps): Promise<number | null> {
  return (await resolveRecord(sessionId, deps))?.pid ?? null;
}

/** resolvePid's lookup, answering the whole record it matched. */
export async function resolveRecord(
  sessionId: string,
  deps: SessionKillDeps,
): Promise<SessionRecord | null> {
  for (const dir of deps.configDirs()) {
    let rows: readonly SessionRecord[];
    try {
      rows = await deps.sessionsIn(dir);
    } catch {
      continue;
    }
    for (const row of rows) {
      // pid must be an integer > 1: process.kill(0) signals the daemon's OWN
      // process group and negative pids signal whole groups — a corrupted
      // registry row must never be able to reach either (ps verification
      // would also refuse, but an irreversible op deserves the explicit
      // gate at the source).
      if (row.sessionId === sessionId && Number.isInteger(row.pid) && row.pid > 1) {
        return row;
      }
    }
  }
  return null;
}

/** Pid-reuse guard (DR-0028): between the state file's read (plus a file a
 * crashed session left behind) and our kill, the pid could have been
 * recycled to an unrelated process. Only pass when `ps -p <pid> -o command=`
 * shows argv[0] whose basename is exactly `claude` (with or without a
 * directory prefix: TUI sessions show `claude --model ...`, PATH-resolved
 * ones `/opt/homebrew/bin/claude ...`). A bare substring test would be
 * useless here — on this machine the ccmsg daemon itself, every Claude
 * Code-spawned zsh, and the subscribe helpers all carry ".claude-personal/"
 * somewhere in their command line, so `includes("claude")` would wave
 * through the daemon committing suicide via a recycled pid. A failing ps
 * (pid already gone) also refuses — the caller maps refusal to not_found,
 * "already gone" and "not claude anymore" are the same outcome for the
 * user. */
export async function verifyPid(pid: number, deps: SessionKillDeps): Promise<boolean> {
  let out: string;
  try {
    out = await deps.runPs(pid);
  } catch {
    return false;
  }
  const argv0 = out.trimStart().split(/\s/, 1)[0] ?? "";
  const base = argv0.slice(argv0.lastIndexOf("/") + 1);
  return base === "claude";
}

/** Two-shot SIGTERM sequence (DR-0028):
 *
 *   SIGTERM → poll liveness every pollIntervalMs → if still alive at
 *   secondSignalAfterMs, SIGTERM again → keep polling → give up at
 *   totalGraceMs from the FIRST signal.
 *
 * The second shot exists because the claude TUI's first SIGTERM only arms a
 * quit-confirmation guard; guard-less processes (e.g. background sessions)
 * die on the first shot, in which case the second is intentionally never
 * sent. SIGKILL is never used. `terminated` reports whether the process was
 * observed gone within the grace — false means "2 signals delivered,
 * termination unconfirmed", not an error. */
/** "The pid no longer exists" — the ONLY sendSignal failure that means
 * success. Everything else (notably EPERM: the process exists but we may not
 * signal it) must surface as an error, or the UI would report "終了を確認"
 * about a process that is demonstrably still alive. */
function isGone(e: unknown): boolean {
  return e instanceof Error && "code" in e && e.code === "ESRCH";
}

export async function killSession(
  pid: number,
  deps: SessionKillDeps,
): Promise<{ terminated: boolean }> {
  const { secondSignalAfterMs, pollIntervalMs, totalGraceMs } = deps.timing;
  try {
    deps.sendSignal(pid, "SIGTERM");
  } catch (e) {
    // ESRCH: vanished between verify and kill (the residual TOCTOU window
    // the DR accepts) — gone is exactly what the caller wanted. Any other
    // failure (EPERM etc.) propagates to the server's internal-error path.
    if (isGone(e)) return { terminated: true };
    throw e;
  }
  let elapsed = 0;
  let secondSent = false;
  while (elapsed < totalGraceMs) {
    await deps.sleep(pollIntervalMs);
    elapsed += pollIntervalMs;
    if (!deps.isAlive(pid)) return { terminated: true };
    if (!secondSent && elapsed >= secondSignalAfterMs) {
      secondSent = true;
      try {
        deps.sendSignal(pid, "SIGTERM");
      } catch (e) {
        if (isGone(e)) return { terminated: true };
        throw e;
      }
    }
  }
  return { terminated: !deps.isAlive(pid) };
}

/** DR-0028 addendum (r38 mid=6): opt-in SIGKILL escalation. Runs the same
 * sid→pid resolution and ps verification as the SIGTERM path (pid-reuse
 * guard must never be bypassed), sends exactly one SIGKILL, then polls for
 * the process to disappear within the same grace window as the two-shot
 * path. `terminated: false` here would mean "SIGKILL delivered but pid still
 * observable" which in practice only happens for uninterruptible-sleep
 * zombies — surface it truthfully instead of pretending success. */
export async function killSessionForce(
  pid: number,
  deps: SessionKillDeps,
): Promise<{ terminated: boolean }> {
  const { pollIntervalMs, totalGraceMs } = deps.timing;
  try {
    deps.sendSignal(pid, "SIGKILL");
  } catch (e) {
    if (isGone(e)) return { terminated: true };
    throw e;
  }
  let elapsed = 0;
  while (elapsed < totalGraceMs) {
    await deps.sleep(pollIntervalMs);
    elapsed += pollIntervalMs;
    if (!deps.isAlive(pid)) return { terminated: true };
  }
  return { terminated: !deps.isAlive(pid) };
}

/** Full request flow used by server.ts's dispatch: resolve → verify → kill.
 * `found: false` covers both "no agents row for this sid" and "pid failed the
 * ps verification" — DR-0028 treats the latter as "already gone". `force`
 * routes to SIGKILL (DR-0028 addendum r38 mid=6) while keeping the same
 * verification prelude — force never bypasses the pid-reuse guard. */
export async function sessionKill(
  sessionId: string,
  deps: SessionKillDeps,
  opts: { force?: boolean } = {},
): Promise<{ found: true; terminated: boolean } | { found: false }> {
  const pid = await resolvePid(sessionId, deps);
  if (pid === null) return { found: false };
  if (!(await verifyPid(pid, deps))) return { found: false };
  const { terminated } = opts.force
    ? await killSessionForce(pid, deps)
    : await killSession(pid, deps);
  return { found: true, terminated };
}

/** Run one argv with bounded runtime, draining stdout and stderr
 * concurrently (a child writing >64KB to an unread stderr pipe would block
 * forever — same trap agents.ts's pollOne documents). Resolves with stdout on
 * exit 0, rejects otherwise. */
async function runCommand(
  argv: string[],
  env: Record<string, string | undefined>,
  timeoutMs: number,
): Promise<string> {
  const proc = Bun.spawn(argv, {
    env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: timeoutMs,
    killSignal: "SIGKILL",
  });
  const [code, text, errText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) {
    throw new Error(`${argv[0]} exited ${code}: ${errText.trim().slice(0, 200)}`);
  }
  return text;
}

import { detectConfigDirs } from "./agents.ts";

export const productionKillDeps: SessionKillDeps = {
  configDirs: detectConfigDirs,
  sessionsIn: async (configDir) => {
    const read = await readSessionsDir(configDir, isProcessAlive);
    return read.live;
  },
  runPs: (pid) => runCommand(["ps", "-p", String(pid), "-o", "command="], process.env, 2000),
  sendSignal: (pid, sig) => process.kill(pid, sig),
  isAlive: (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      // Only ESRCH means gone. EPERM means the process exists but is not
      // ours to signal — reporting it dead would fake a "終了を確認" for a
      // live process.
      return !isGone(e);
    }
  },
  sleep: (ms) => new Promise((res) => setTimeout(res, ms)),
  timing: {
    secondSignalAfterMs: SECOND_SIGNAL_AFTER_MS,
    pollIntervalMs: POLL_INTERVAL_MS,
    totalGraceMs: TOTAL_GRACE_MS,
  },
};
