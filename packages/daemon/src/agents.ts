// The live sessions on this machine as Claude Code records them, one
// `<config dir>/sessions/<pid>.json` per harness process (read by
// session-runs.ts), across the CLAUDE_CONFIG_DIRs whose sessions the daemon
// serves (servedConfigDirs, DR-0034 §2): the register the daemon's session
// registry is derived from (DR-0034 §5), and the agents rows the webui shows.
//
// A round reads the files when a watched `sessions/` dir changes (a session
// starts, ends, moves to another id, or Claude Code rewrites its status) and
// on every tick of the poll interval besides: a process that dies without
// removing its file changes nothing on disk, a config dir can appear, and a
// watch can stop telling (its directory removed).
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
import { errorText, resolveStateDir, type AgentInfo } from "@ccmsg/protocol";
import { isProcessAlive } from "./sidecar-call.ts";
import { readSessionsDir } from "./session-runs.ts";

/** Poll period, for what no watch tells (module doc). `CCMSG_AGENTS_POLL_MS`
 *  override exists purely for test determinism; it is not part of the wire
 *  protocol. */
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

/** The rows of one config dir's live sessions, each tagged with
 * `config_dir`, or null when the dir could not be read whole (a record that
 * does not read, or lacks what a row carries): such a dir says nothing this
 * round rather than "no sessions", since the registry forgets a session that
 * vanishes from its dir, and a record caught mid-write would otherwise end a
 * running session. */
async function pollOne(configDir: string, log: AgentsLog): Promise<AgentInfo[] | null> {
  const read = await readSessionsDir(configDir, isProcessAlive);
  if (read.unread !== undefined) {
    log.error(`agents poll: ${configDir} not read: ${read.unread.join("; ")}`);
    return null;
  }
  const rows: AgentInfo[] = [];
  for (const {
    pid,
    sessionId,
    cwd,
    kind,
    startedAt,
    version,
    name,
    status,
    waitingFor,
  } of read.live) {
    if (cwd === undefined || kind === undefined || startedAt === undefined) {
      log.error(
        `agents poll: ${configDir} not read: sessions/${String(pid)}.json lacks cwd, kind or startedAt`,
      );
      return null;
    }
    rows.push({
      pid,
      cwd,
      kind,
      startedAt,
      sessionId,
      config_dir: configDir,
      ...(version !== undefined ? { version } : {}),
      ...(name !== undefined ? { name } : {}),
      ...(status !== undefined ? { status } : {}),
      ...(waitingFor !== undefined ? { waitingFor } : {}),
    });
  }
  return rows;
}

export interface AgentsPoll {
  agents: AgentInfo[];
  /** Config dirs read whole this round. A session missing from one of these
   *  is known to have ended; a session whose dir is not here is simply
   *  unobserved this round. */
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
  /** The watch on each config dir's `sessions/`, by config dir. */
  watches: Map<string, SessionsWatch>;
}

/** A watch on one `sessions/` dir, and which directory it watches (its
 * inode): one removed and made again is another directory, which the watch
 * does not see. */
interface SessionsWatch {
  watcher: fs.FSWatcher;
  ino: number;
}

export function createAgentsPoller(): AgentsPoller {
  return { cache: { agents: [], polledAt: null }, timer: null, watches: new Map() };
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

  // One round at a time: overlapping rounds can resolve out of order, and a
  // slower (stale) round's result would overwrite a newer one in
  // poller.cache, which then looks like a "change" on the next round and
  // flaps back and forth. A round asked for while one runs (a watch firing,
  // the interval) runs once that one is done, however many times it was
  // asked: what it reads is the files as they are then.
  let inFlight = false;
  let again = false;
  const round = (): void => {
    if (inFlight) {
      again = true;
      return;
    }
    inFlight = true;
    void (async () => {
      try {
        const current = scope();
        watchSessionsDirs(poller, current.dirs, round, log);
        const poll = await pollAgents(current, log);
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
        if (again && poller.timer !== null) {
          again = false;
          round();
        }
      }
    })();
  };

  poller.timer = setInterval(round, resolvePollIntervalMs());
  poller.timer.unref?.();
  round();
}

/** Watch the `sessions/` dir of each of `dirs`, and of no other: a change in
 * one asks for a round. A dir without `sessions/` yet is watched once a
 * later round finds it. */
function watchSessionsDirs(
  poller: AgentsPoller,
  dirs: readonly string[],
  onChange: () => void,
  log: AgentsLog,
): void {
  for (const [dir, watch] of poller.watches) {
    if (!dirs.includes(dir)) {
      watch.watcher.close();
      poller.watches.delete(dir);
    }
  }
  for (const dir of dirs) {
    const sessionsDir = path.join(dir, "sessions");
    const held = poller.watches.get(dir);
    let ino: number;
    try {
      ino = fs.statSync(sessionsDir).ino;
    } catch {
      held?.watcher.close();
      poller.watches.delete(dir);
      continue;
    }
    if (held?.ino === ino) continue;
    held?.watcher.close();
    try {
      const watcher = fs.watch(sessionsDir, () => onChange());
      watcher.on("error", () => {
        watcher.close();
        if (poller.watches.get(dir)?.watcher === watcher) poller.watches.delete(dir);
      });
      watcher.unref();
      poller.watches.set(dir, { watcher, ino });
    } catch (e) {
      poller.watches.delete(dir);
      log.error(`agents poll: cannot watch ${sessionsDir}: ${errorText(e)}`);
    }
  }
}

/** Unconditional stop, for daemon shutdown. */
export function stopAgentsPoller(poller: AgentsPoller): void {
  if (poller.timer !== null) {
    clearInterval(poller.timer);
    poller.timer = null;
  }
  for (const { watcher } of poller.watches.values()) watcher.close();
  poller.watches.clear();
}
