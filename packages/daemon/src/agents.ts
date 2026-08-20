// `claude agents --json` polling across every detected CLAUDE_CONFIG_DIR
// candidate (webui "Agents" panel).
//
// Detection re-scans `$HOME/.claude*` on every poll instead of trusting a
// fixed env var: the daemon process's own environment can lose a
// CLAUDE_CONFIG_DIR-style setting across a respawn (known issue), so disk is
// the only durable source here. kawaz's own `~/.claude` is a regular file by
// design (claude-config-dir-isolation rule) — it's excluded naturally by the
// isDirectory() check below, no special-casing needed.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentInfo } from "@ccmsg/protocol";

/** Per-`claude agents --json` child process budget; a hung/slow CLI in one
 *  config dir must not stall the poll of the others or the poll cycle itself. */
const POLL_TIMEOUT_MS = 5000;

/** Default poll period while at least one user-role subscriber is connected
 *  (DR-0009-agents addendum). `CCMSG_AGENTS_POLL_MS` override exists purely
 *  for test determinism (real usage never needs sub-5s freshness); it is not
 *  part of the wire protocol. */
function resolvePollIntervalMs(): number {
  const raw = process.env.CCMSG_AGENTS_POLL_MS;
  if (raw) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 5000;
}

export interface AgentsLog {
  info(msg: string): void;
  error(msg: string): void;
}

/** `$HOME/.claude*` entries that are directories, sorted for stable poll
 *  output. Re-scanned fresh on every call — see module doc for why this
 *  can't be cached across polls. */
export function detectConfigDirs(): string[] {
  const home = os.homedir();
  let names: string[];
  try {
    names = fs.readdirSync(home);
  } catch {
    return [];
  }
  const dirs: string[] = [];
  for (const name of names) {
    if (!name.startsWith(".claude")) continue;
    const full = path.join(home, name);
    try {
      if (fs.statSync(full).isDirectory()) dirs.push(full);
    } catch {
      // vanished between readdir and stat; skip rather than fail the whole poll
    }
  }
  dirs.sort();
  return dirs;
}

/** Extract one `KEY=value` env token from a `ps eww -o command= -p <pid>`
 *  output line (macOS format: command + args followed by space-separated
 *  `KEY=VALUE` env tokens). Returns null when the key is absent, or the value
 *  contains characters that shouldn't appear (we split on spaces, so a value
 *  with an embedded space would look like the next token starts a new env
 *  entry — we defensively bail rather than return a truncated string). */
function parsePsEnvToken(psLine: string, key: string): string | null {
  const marker = ` ${key}=`;
  const idx = psLine.indexOf(marker);
  if (idx < 0) return null;
  const rest = psLine.slice(idx + marker.length);
  // env entries are separated by a single space; a value with no spaces ends
  // at the next space (or end of string).
  const end = rest.indexOf(" ");
  const value = end < 0 ? rest : rest.slice(0, end);
  const trimmed = value.replace(/[\r\n]+$/, "");
  return trimmed.length > 0 ? trimmed : null;
}

/** Extract `HYOUI_SESSION_ID` from a `ps eww` line. Exported for unit testing
 *  without spawning `ps`. */
export function parseHyouiSessionId(psLine: string): string | null {
  return parsePsEnvToken(psLine, "HYOUI_SESSION_ID");
}

/** Extract `HYOUI_NAMESPACE` from a `ps eww` line — the daemon's own env is
 *  NOT this session's namespace (a session launched under a business overlay
 *  runs its hyoui wrapper in that overlay's namespace, e.g. "emeradaco",
 *  while the daemon itself runs under whatever launched it, typically
 *  "default"). Sending `hyoui input` without this returns a false ENOENT —
 *  the session id is real, just not visible in the namespace the daemon
 *  guessed (kawaz r135m40/41, reproduced: `hyoui list` under the daemon's own
 *  namespace shows nothing for a live emeradaco-namespace session). Exported
 *  for unit testing without spawning `ps`. */
export function parseHyouiNamespace(psLine: string): string | null {
  return parsePsEnvToken(psLine, "HYOUI_NAMESPACE");
}

/** Run `ps eww -o command= -p <pid>` and extract the hyoui env pair from the
 *  target process's environment. Returns nulls on any failure (no such pid,
 *  permission denied on other users' processes, timeout, env vars absent).
 *  Root/sudo is not required — macOS permits reading env for processes owned
 *  by the same uid. */
async function readHyouiEnvForPid(
  pid: number,
): Promise<{ sessionId: string | null; namespace: string | null }> {
  const none = { sessionId: null, namespace: null };
  if (!Number.isInteger(pid) || pid <= 0) return none;
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["ps", "eww", "-o", "command=", "-p", String(pid)], {
      stdout: "pipe",
      stderr: "pipe",
      timeout: 2000,
      killSignal: "SIGKILL",
    });
  } catch {
    return none;
  }
  try {
    const [code, text] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
    if (code !== 0) return none;
    return { sessionId: parseHyouiSessionId(text), namespace: parseHyouiNamespace(text) };
  } catch {
    return none;
  }
}

/** Module-level pid → hyoui env cache. A pid's env doesn't change over the
 *  process's lifetime (execve resets the process image but not while the
 *  same pid keeps running for our purposes), so we only call `ps eww` once
 *  per pid. Entries for pids no longer present in the merged poll result are
 *  pruned to bound memory and to force re-lookup if the same pid number
 *  appears again for a different process later. A cached null field means
 *  "looked up and the env var wasn't present" — we cache negatives so we
 *  don't re-`ps` every poll for agents that never had the var. */
const pidHyouiCache = new Map<number, { sessionId: string | null; namespace: string | null }>();

async function augmentWithHyoui(agents: AgentInfo[]): Promise<AgentInfo[]> {
  // 1) prune entries for pids not in the current poll
  const seen = new Set<number>();
  for (const a of agents) if (typeof a.pid === "number") seen.add(a.pid);
  for (const cachedPid of pidHyouiCache.keys()) {
    if (!seen.has(cachedPid)) pidHyouiCache.delete(cachedPid);
  }
  // 2) fill misses in parallel
  const missing: number[] = [];
  for (const pid of seen) {
    if (!pidHyouiCache.has(pid)) missing.push(pid);
  }
  await Promise.all(
    missing.map(async (pid) => {
      pidHyouiCache.set(pid, await readHyouiEnvForPid(pid));
    }),
  );
  // 3) annotate rows
  return agents.map((a) => {
    if (typeof a.pid !== "number") return a;
    const env = pidHyouiCache.get(a.pid);
    if (!env?.sessionId) return a;
    return {
      ...a,
      hyoui_session_id: env.sessionId,
      ...(env.namespace ? { hyoui_namespace: env.namespace } : {}),
    };
  });
}

/** Test-only: drop cache between tests so pid reuse across fixtures doesn't
 *  leak stale env lookups from prior runs. */
export function _resetPidHyouiCacheForTests(): void {
  pidHyouiCache.clear();
}

/** Run `claude agents --json` with CLAUDE_CONFIG_DIR=configDir, tag every row
 *  with `config_dir`. Any failure (spawn error, non-zero exit, timeout,
 *  unparseable output) logs and returns `[]` — one bad config dir must not
 *  fail the merged poll. */
async function pollOne(configDir: string, log: AgentsLog): Promise<AgentInfo[]> {
  let proc: Bun.Subprocess<"ignore", "pipe", "pipe">;
  try {
    proc = Bun.spawn(["claude", "agents", "--json"], {
      env: { ...process.env, CLAUDE_CONFIG_DIR: configDir },
      stdout: "pipe",
      stderr: "pipe",
      timeout: POLL_TIMEOUT_MS,
      killSignal: "SIGKILL",
    });
  } catch (e) {
    log.error(`agents poll: failed to spawn 'claude' for ${configDir}: ${String(e)}`);
    return [];
  }
  let code: number | null;
  let text: string;
  let errText: string;
  try {
    // stderr must be drained concurrently with stdout, not left unread: a
    // child that writes more than the OS pipe buffer (~64KB) to stderr would
    // otherwise block on that write forever (the parent never reads it),
    // stalling until POLL_TIMEOUT_MS's SIGKILL on every single poll
    // (adversarial review finding). Reading it here also gives the error
    // logs below real diagnostic content instead of just an exit code.
    [code, text, errText] = await Promise.all([
      proc.exited,
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ]);
  } catch (e) {
    log.error(
      `agents poll: failed reading 'claude agents --json' output for ${configDir}: ${String(e)}`,
    );
    return [];
  }
  if (code !== 0) {
    const errSnippet = errText.trim().slice(0, 500);
    log.error(
      `agents poll: 'claude agents --json' exited ${code} for ${configDir}` +
        (errSnippet ? `: ${errSnippet}` : ""),
    );
    return [];
  }
  let rows: unknown;
  try {
    rows = JSON.parse(text);
  } catch {
    log.error(`agents poll: invalid JSON from 'claude agents --json' for ${configDir}`);
    return [];
  }
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r): r is Record<string, unknown> => typeof r === "object" && r !== null)
    .map((r) => ({ ...r, config_dir: configDir }) as AgentInfo);
}

/** Poll every detected config dir in parallel and merge the results. Each
 *  merged row is annotated with `hyoui_session_id` when the underlying
 *  process's env exposes it (`ps eww` lookup, cached per pid). */
export async function pollAgents(log: AgentsLog): Promise<AgentInfo[]> {
  const dirs = detectConfigDirs();
  const results = await Promise.all(dirs.map((d) => pollOne(d, log)));
  return await augmentWithHyoui(results.flat());
}

/** Order-independent identity for change detection: sort by a stable key
 *  before stringifying so re-poll runs that return the same rows in a
 *  different order don't look like a change (JSON.stringify is
 *  insertion-order-sensitive on arrays). */
function stableKey(agents: AgentInfo[]): string {
  const sorted = [...agents].sort((a, b) => {
    const ka = `${a.config_dir} ${a.sessionId} ${a.pid}`;
    const kb = `${b.config_dir} ${b.sessionId} ${b.pid}`;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  return JSON.stringify(sorted);
}

export interface AgentsCache {
  agents: AgentInfo[];
  polledAt: string | null;
}

export interface AgentsPoller {
  cache: AgentsCache;
  timer: ReturnType<typeof setInterval> | null;
}

export function createAgentsPoller(): AgentsPoller {
  return { cache: { agents: [], polledAt: null }, timer: null };
}

/** Minimal shape needed from a subscriber connection to count user-role
 *  subscribers — kept structural (same rationale as fs-access.ts's
 *  SessionLookup) so this module has no dependency edge back to server.ts. */
export interface SubscriberLike {
  identity: { role: string } | null;
}

export function userSubscriberCount(subscribers: Iterable<SubscriberLike>): number {
  let n = 0;
  for (const sub of subscribers) if (sub.identity?.role === "user") n++;
  return n;
}

/**
 * Start the poll timer iff it isn't already running AND at least one
 * user-role subscriber is connected (DR-0009-agents: the daemon never spawns
 * `claude` processes just because nobody happens to be watching). Runs one
 * poll immediately (not just on the first interval tick) so a fresh
 * subscriber doesn't wait a full period for its first `op:"agents"` /
 * `ev:"agents"` to have real data. `onChange` fires only when the merged
 * result differs from the previous poll (order-independent compare).
 */
export function maybeStartAgentsPoller(
  poller: AgentsPoller,
  subscribers: Iterable<SubscriberLike>,
  log: AgentsLog,
  onChange: (agents: AgentInfo[], polledAt: string) => void,
): void {
  if (poller.timer !== null) return;
  if (userSubscriberCount(subscribers) === 0) return;

  // In-flight guard (adversarial review finding): the poll interval and
  // POLL_TIMEOUT_MS are the same 5s, so a slow/hung `claude` call can still
  // be running when the next tick fires. Without this guard, overlapping
  // polls can resolve out of order and a slower (stale) poll's result
  // overwrites a faster (newer) one already in poller.cache, which then
  // looks like a "change" on the next tick and flaps ev:"agents" back and
  // forth. `let` (not part of AgentsPoller) is enough — this closure is the
  // only place that ever ticks this poller.
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const agents = await pollAgents(log);
        const changed = stableKey(agents) !== stableKey(poller.cache.agents);
        const polledAt = new Date().toISOString();
        poller.cache = { agents, polledAt };
        if (changed) onChange(agents, polledAt);
      } finally {
        inFlight = false;
      }
    })();
  };

  poller.timer = setInterval(tick, resolvePollIntervalMs());
  poller.timer.unref?.();
  tick();
}

/** Stop the poll timer iff it's running AND no user-role subscriber remains. */
export function maybeStopAgentsPoller(
  poller: AgentsPoller,
  subscribers: Iterable<SubscriberLike>,
): void {
  if (poller.timer === null) return;
  if (userSubscriberCount(subscribers) > 0) return;
  clearInterval(poller.timer);
  poller.timer = null;
}

/** Unconditional stop, for daemon shutdown. */
export function stopAgentsPoller(poller: AgentsPoller): void {
  if (poller.timer !== null) {
    clearInterval(poller.timer);
    poller.timer = null;
  }
}
