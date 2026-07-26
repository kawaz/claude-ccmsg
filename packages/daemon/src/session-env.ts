// session_env boundary: resolve sid→pid with the same fresh `claude agents`
// lookup + ps verification session-kill.ts uses (kawaz r55m133: "普通に
// プロトコル追加で pid から取る" — the daemon's own subscribe-process env is
// not the session's env, Claude Code adds its own vars on the way down), then
// read that process's environment. Pure logic split out of server.ts with the
// external effects injectable, same division of labor as session-kill.ts.
import { resolvePid, verifyPid, type SessionKillDeps } from "./session-kill.ts";

/** `ps eww` on a large env is still a small read, but a wedged ps must not
 * hold the request open — same bounded-child posture as session-kill.ts. */
export const PS_TIMEOUT_MS = 5000;

/** The subset of SessionKillDeps this op needs (sid→pid resolution and the
 * pid-reuse guard) plus the env read itself. Typed as a widening of the kill
 * deps so `resolvePid`/`verifyPid` can be reused verbatim — deliberately NOT
 * a new pid-resolution mechanism (r55m133). */
export interface SessionEnvDeps extends SessionKillDeps {
  /** Read the process environment for `pid`. Resolves to the raw platform
   * output; rejects when the process is gone or the reader fails. */
  readEnv(pid: number): Promise<string>;
  /** Host platform, injectable so the parser branch is testable on either OS. */
  platform(): NodeJS.Platform;
}

/** Linux `/proc/<pid>/environ` is NUL-separated `KEY=VALUE` records — an
 * unambiguous encoding, so values containing spaces, newlines or `=` survive
 * intact. A trailing NUL leaves an empty final record, dropped by the filter. */
export function parseProcEnviron(raw: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const record of raw.split("\0")) {
    if (!record) continue;
    const eq = record.indexOf("=");
    // A record with no "=" is not a variable assignment; skipping beats
    // inventing an empty-named entry.
    if (eq <= 0) continue;
    env[record.slice(0, eq)] = record.slice(eq + 1);
  }
  return env;
}

/** A plausible variable NAME per POSIX 8.1 (`[A-Za-z_][A-Za-z0-9_]*`),
 * anchored so it matches a whole whitespace-delimited token's key part.
 * macOS `ps eww` prints `argv... KEY=VALUE KEY=VALUE ...` space-separated
 * with NO quoting, so a value containing a space is indistinguishable from
 * the start of the next variable by tokenizing alone (verified: `SPACEVAR=foo
 * bar baz EQVAR=a=b=c` prints exactly that). The recovery is to treat a token
 * as a new variable only when it looks like `NAME=`, and to append anything
 * else to the current variable's value — which reconstructs spaced values
 * correctly except for the genuinely ambiguous case where a value contains a
 * token that itself looks like `NAME=` (accepted limitation, documented for
 * the UI). */
const ENV_NAME_EQ = /^[A-Za-z_][A-Za-z0-9_]*=/;

/** macOS `ps eww -p <pid> -o command=` output: the command line, then the
 * environment, all space-separated on one logical line. The environment
 * starts at the FIRST token matching `NAME=`; everything before it is argv
 * and is discarded. Values are re-joined across tokens per ENV_NAME_EQ's
 * doc — an imperfect but faithful reconstruction of a lossy format.
 *
 * Returns an empty object when no `NAME=` token appears at all: macOS refuses
 * to show the environment for some processes (observed on a process started
 * with a scrubbed `env -i` environment), and reporting "no variables" beats
 * misparsing the argv as one. */
export function parsePsEnv(raw: string): Record<string, string> {
  const tokens = raw.trim().split(/\s+/);
  const env: Record<string, string> = {};
  let currentKey: string | null = null;
  for (const token of tokens) {
    if (ENV_NAME_EQ.test(token)) {
      const eq = token.indexOf("=");
      currentKey = token.slice(0, eq);
      env[currentKey] = token.slice(eq + 1);
    } else if (currentKey !== null) {
      // Continuation of the previous value: `ps` collapsed the original
      // separator to a single space, so that is what we restore.
      env[currentKey] += ` ${token}`;
    }
    // Tokens before the first NAME= are argv — dropped.
  }
  return env;
}

export function parseEnv(raw: string, platform: NodeJS.Platform): Record<string, string> {
  return platform === "linux" ? parseProcEnviron(raw) : parsePsEnv(raw);
}

/** Full request flow used by server.ts's dispatch: resolve → verify → read.
 * `found: false` covers "no agents row for this sid" and "pid failed the ps
 * verification" alike — as in session_kill, both mean the session's process
 * is not there, and the pid-reuse guard is never skipped (reading a recycled
 * pid's environment would leak an unrelated process's secrets). */
export async function sessionEnv(
  sessionId: string,
  deps: SessionEnvDeps,
): Promise<{ found: true; pid: number; env: Record<string, string> } | { found: false }> {
  const pid = await resolvePid(sessionId, deps);
  if (pid === null) return { found: false };
  if (!(await verifyPid(pid, deps))) return { found: false };
  const raw = await deps.readEnv(pid);
  return { found: true, pid, env: parseEnv(raw, deps.platform()) };
}

async function runPsEnv(pid: number): Promise<string> {
  const proc = Bun.spawn(["ps", "eww", "-p", String(pid), "-o", "command="], {
    env: process.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    timeout: PS_TIMEOUT_MS,
    killSignal: "SIGKILL",
  });
  // Drain both pipes concurrently: a full env can exceed the pipe buffer, and
  // a child blocked writing to an unread pipe never exits (same trap
  // session-kill.ts's runCommand documents).
  const [code, text, errText] = await Promise.all([
    proc.exited,
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  if (code !== 0) throw new Error(`ps exited ${code}: ${errText.trim().slice(0, 200)}`);
  return text;
}

export function productionEnvDeps(killDeps: SessionKillDeps): SessionEnvDeps {
  return {
    ...killDeps,
    platform: () => process.platform,
    readEnv: (pid) =>
      process.platform === "linux" ? Bun.file(`/proc/${pid}/environ`).text() : runPsEnv(pid),
  };
}
