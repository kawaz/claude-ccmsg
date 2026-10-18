// `claude agents --json` polling across the CLAUDE_CONFIG_DIRs whose sessions
// the daemon serves (servedConfigDirs, DR-0034 §2): the harness's own register
// of live sessions, which the daemon's session registry is derived from
// (DR-0034) and the webui "Agents" panel shows.
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
import {
  ClaudeAgentsTextSchema,
  errorText,
  parseWith,
  resolveStateDir,
  type AgentInfo,
} from "@ccmsg/protocol";

/** Per-`claude agents --json` child process budget; a hung/slow CLI in one
 *  config dir must not stall the poll of the others or the poll cycle itself. */
const POLL_TIMEOUT_MS = 5000;

/** Poll period. `CCMSG_AGENTS_POLL_MS` override exists purely for test
 *  determinism (real usage never needs sub-5s freshness); it is not part of
 *  the wire protocol. */
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

/** The config dirs whose sessions the daemon at `stateDir` serves: it lists
 * them, registers them and delivers to them.
 *
 * - `CCMSG_CLAUDE_CONFIG_DIRS` (absolute paths joined by `:`) names them; set
 *   but empty, it names none.
 * - Otherwise the daemon at the default state dir serves every
 *   `$HOME/.claude*` directory (detectConfigDirs): it is the daemon the
 *   sessions on this machine talk to.
 * - A daemon at any other state dir (one started for a test or a /verify run)
 *   serves none: the sessions on the machine talk to the default daemon, and
 *   what another daemon delivered to them would be a test's messages in
 *   someone's conversation.
 *
 * A session that announces its config dir to the daemon (hello,
 * sidecar_hello) is served in that dir besides, alone (server.ts
 * sessionScope). */
export function servedConfigDirs(
  stateDir: string,
  env: NodeJS.ProcessEnv = process.env,
  detect: () => string[] = detectConfigDirs,
): string[] {
  const named = env.CCMSG_CLAUDE_CONFIG_DIRS;
  if (named !== undefined) {
    return named.split(":").filter((dir) => dir !== "" && path.isAbsolute(dir));
  }
  const defaultStateDir = resolveStateDir({ ...env, CCMSG_STATE_DIR: undefined });
  return realpathOrSelf(stateDir) === realpathOrSelf(defaultStateDir) ? detect() : [];
}

function realpathOrSelf(dir: string): string {
  try {
    return fs.realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/** Run `claude agents --json` with CLAUDE_CONFIG_DIR=configDir, tag every row
 *  with `config_dir`. Any failure (spawn error, non-zero exit, timeout,
 *  unparseable output) logs and returns null — one bad config dir must not
 *  fail the merged poll, and must not read as "that dir has no sessions"
 *  either: the registry forgets a session when it vanishes from its dir. */
async function pollOne(configDir: string, log: AgentsLog): Promise<AgentInfo[] | null> {
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
    log.error(`agents poll: failed to spawn 'claude' for ${configDir}: ${errorText(e)}`);
    return null;
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
      `agents poll: failed reading 'claude agents --json' output for ${configDir}: ${errorText(e)}`,
    );
    return null;
  }
  if (code !== 0) {
    const errSnippet = errText.trim().slice(0, 500);
    log.error(
      `agents poll: 'claude agents --json' exited ${code} for ${configDir}` +
        (errSnippet ? `: ${errSnippet}` : ""),
    );
    return null;
  }
  // One row that does not read fails the whole dir rather than being left
  // out: a session missing from a dir that answered reads as ended.
  const rows = parseWith(ClaudeAgentsTextSchema, text);
  if (!rows.ok) {
    log.error(
      `agents poll: unreadable output from 'claude agents --json' for ${configDir}: ${rows.failure.summary}`,
    );
    return null;
  }
  return rows.value.map((row) => ({ ...row, config_dir: configDir }));
}

export interface AgentsPoll {
  agents: AgentInfo[];
  /** Config dirs whose `claude agents --json` answered this round. A session
   *  missing from one of these is known to have ended; a session whose dir is
   *  not here is simply unobserved this round. */
  answeredDirs: string[];
}

/** Which config dirs a round reads, and which sessions in them it keeps. */
export interface AgentsScope {
  dirs: readonly string[];
  has(configDir: string, sid: string): boolean;
}

/** Poll every config dir of `scope` in parallel and merge the rows of the
 * sessions it has. */
export async function pollAgents(scope: AgentsScope, log: AgentsLog): Promise<AgentsPoll> {
  const dirs = scope.dirs;
  const results = await Promise.all(dirs.map((d) => pollOne(d, log)));
  const answeredDirs = dirs.filter((_, i) => results[i] !== null);
  const agents = results
    .flatMap((r) => r ?? [])
    .filter((row) => scope.has(row.config_dir, row.sessionId));
  return { agents, answeredDirs };
}

/** Order-independent identity for change detection: sort by a stable key
 *  before stringifying so re-poll runs that return the same rows in a
 *  different order don't look like a change (JSON.stringify is
 *  insertion-order-sensitive on arrays). */
export function agentsKey(agents: readonly AgentInfo[]): string {
  const sorted = [...agents].sort((a, b) => {
    const ka = `${a.config_dir}\0${a.sessionId}\0${a.pid}`;
    const kb = `${b.config_dir}\0${b.sessionId}\0${b.pid}`;
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

/** `CCMSG_AGENTS_POLL=off` leaves the poller unstarted — the switch exists for
 *  test daemons, which would otherwise register every live session on the
 *  developer's machine into their own registry. */
export function agentsPollEnabled(): boolean {
  return process.env.CCMSG_AGENTS_POLL !== "off";
}

/**
 * Start polling for the daemon's whole lifetime. The poll is the source of
 * the session registry (DR-0034), and delivering a direct message needs that
 * registry whether or not a webui is watching — so unlike a display-only feed
 * it cannot wait for a viewer.
 *
 * `onChange` fires only when the merged rows differ from the previous poll
 * (order-independent compare), and is awaited before the next poll may start,
 * so a slow registry update can never interleave with a newer poll's.
 * `onPoll` fires after every poll, changed or not, for work whose input is
 * not in the rows themselves (a transcript file appearing on disk).
 */
export function startAgentsPoller(
  poller: AgentsPoller,
  scope: () => AgentsScope,
  log: AgentsLog,
  onChange: (poll: AgentsPoll, polledAt: string) => void | Promise<void>,
  onPoll?: (poll: AgentsPoll) => void | Promise<void>,
): void {
  if (poller.timer !== null) return;

  // In-flight guard: the poll interval and POLL_TIMEOUT_MS are the same 5s, so
  // a slow/hung `claude` call can still be running when the next tick fires.
  // Without this guard, overlapping polls can resolve out of order and a
  // slower (stale) poll's result overwrites a faster (newer) one already in
  // poller.cache, which then looks like a "change" on the next tick and flaps
  // back and forth.
  let inFlight = false;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = true;
    void (async () => {
      try {
        const poll = await pollAgents(scope(), log);
        const changed = agentsKey(poll.agents) !== agentsKey(poller.cache.agents);
        const polledAt = new Date().toISOString();
        // The cache moves only after onChange has pushed, so a subscriber
        // catching up from the cache in between is handed the rows the push
        // will not repeat.
        if (changed) await onChange(poll, polledAt);
        poller.cache = { agents: poll.agents, polledAt };
        await onPoll?.(poll);
      } catch (e) {
        log.error(`agents poll: ${errorText(e)}`);
      } finally {
        inFlight = false;
      }
    })();
  };

  poller.timer = setInterval(tick, resolvePollIntervalMs());
  poller.timer.unref?.();
  tick();
}

/** Unconditional stop, for daemon shutdown. */
export function stopAgentsPoller(poller: AgentsPoller): void {
  if (poller.timer !== null) {
    clearInterval(poller.timer);
    poller.timer = null;
  }
}
