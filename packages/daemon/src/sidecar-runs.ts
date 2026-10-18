// The live runs of each session, as their sidecars name them (DR-0035 §3).
//
// A session's hooks module starts a sidecar, which binds `<sid>.<run id>.sock`
// and names the run to the daemon (sidecar_hello) on a connection it keeps
// open. The run is live while that connection is: a name is how a run arrives
// and a close is how it goes, so nothing here watches the sidecar directory or
// looks at processes to find runs.
//
// The sidecar does not know its harness's pid (finding it needs `ps`, which a
// sandboxed session cannot run). The daemon ties a run to its harness process
// itself, from Claude Code's register (`claude agents --json`, as the agents
// poll reads it): the session's row whose start is nearest the run's. The pid
// is what tells a run whose harness died, with its sidecar still connected
// (a sidecar whose output is not a socket notices only when a write to its
// module fails), from a live one.
import * as path from "node:path";
import { sidecarSocketName } from "@ccmsg/protocol";

/** A run as its sidecar named it. */
export interface SidecarRunHello {
  sid: string;
  /** SidecarRunIdSchema: drawn by the module when it was loaded, the same for
   * every sidecar of that load and every session id it serves. */
  runId: string;
  /** When the module was loaded, epoch ms. */
  startedAt: number;
  /** The run's CLAUDE_CONFIG_DIR, spelled as the agents poll's rows are. */
  configDir?: string;
  /** The terminal the run's module presses Enter on. */
  hyouiSessionId?: string;
}

/** A live run: what its sidecar named, where its socket is, and its harness
 * process once one is found. */
export interface SidecarRun extends SidecarRunHello {
  socket: string;
  pid?: number;
}

/** A row of `claude agents --json`, as far as tying a run to a process reads
 * it. `configDir` is the poll's, spelled as SidecarRunHello's. */
export interface AgentRow {
  sessionId: string;
  pid: number;
  startedAt: number;
  configDir: string;
}

/** What one round of the agents poll changed: the runs whose pid it found,
 * and the runs it found gone. */
export interface Reconciled {
  found: SidecarRun[];
  dropped: SidecarRun[];
}

/** One round of the agents poll. */
export interface AgentsRound {
  agents: readonly AgentRow[];
  /** The config dirs that answered: a session not listed by one of these has
   * no process. */
  answeredDirs: readonly string[];
}

export interface SidecarRunsDeps {
  sidecarDir: string;
  isAlive(pid: number): boolean;
  now(): number;
}

interface Held {
  owner: object;
  run: SidecarRun;
  namedAt: number;
}

/** What a run id has served, kept past the run's sidecars so a session that
 * changed its id can be told from one that never had a module. */
interface Served {
  sids: Set<string>;
  /** When the run's last sidecar left, while none is named. */
  leftAt?: number;
}

export class SidecarRuns {
  readonly #deps: SidecarRunsDeps;
  /** By `<sid>.<run id>`: one sidecar names a run of a session at a time. */
  readonly #runs = new Map<string, Held>();
  /** The run each connection named. */
  readonly #byOwner = new Map<object, string>();
  readonly #served = new Map<string, Served>();

  constructor(deps: SidecarRunsDeps) {
    this.#deps = deps;
  }

  /** Take the name `hello` on the connection `owner`. A run named again (its
   * sidecar was started again) is held by the newer connection, and the
   * older one's close no longer takes it away. `rows` are the agents poll's
   * latest, for the run's pid; a run not listed there yet gets its pid from a
   * later poll (reconcile). */
  announce(owner: object, hello: SidecarRunHello, rows: readonly AgentRow[]): SidecarRun {
    this.leave(owner);
    const key = runKey(hello.sid, hello.runId);
    const run: SidecarRun = {
      ...hello,
      socket: path.join(this.#deps.sidecarDir, sidecarSocketName(hello.sid, hello.runId)),
    };
    const pid = this.#pidAmong(run, rows);
    if (pid !== undefined) run.pid = pid;
    const replaced = this.#runs.get(key);
    if (replaced !== undefined) this.#byOwner.delete(replaced.owner);
    this.#runs.set(key, { owner, run, namedAt: this.#deps.now() });
    this.#byOwner.set(owner, key);
    const served = this.#served.get(hello.runId) ?? { sids: new Set<string>() };
    served.sids.add(hello.sid);
    served.leftAt = undefined;
    this.#served.set(hello.runId, served);
    return run;
  }

  /** The connection `owner` closed: the run it named, if it still holds it,
   * is gone. True when a run went. */
  leave(owner: object): boolean {
    const key = this.#byOwner.get(owner);
    if (key === undefined) return false;
    this.#byOwner.delete(owner);
    const held = this.#runs.get(key);
    if (held === undefined || held.owner !== owner) return false;
    this.#drop(key, held.run);
    return true;
  }

  /** The live runs of `sid`, oldest first — the order user_prompt asks
   * them in. A run whose harness is known to have ended is not live. */
  liveOf(sid: string): SidecarRun[] {
    const live: SidecarRun[] = [];
    for (const { run } of this.#runs.values()) {
      if (run.sid !== sid) continue;
      if (run.pid !== undefined && !this.#deps.isAlive(run.pid)) continue;
      live.push(run);
    }
    return live.toSorted(
      (a, b) => a.startedAt - b.startedAt || (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0),
    );
  }

  /** Whether `sid` has no live run while a run that once served it is live
   * under another id: the session changed its id (/clear, /resume), and its
   * module now serves the new one. */
  movedOn(sid: string): boolean {
    if (this.liveOf(sid).length > 0) return false;
    for (const { run } of this.#runs.values()) {
      if (run.sid === sid) continue;
      if (run.pid !== undefined && !this.#deps.isAlive(run.pid)) continue;
      if (this.#served.get(run.runId)?.sids.has(sid) === true) return true;
    }
    return false;
  }

  /** Bring the runs in line with one round of the agents poll that began no
   * earlier than `begunAt`: find the pid of a run that has none yet, and
   * drop a run whose harness is gone — its pid no longer runs, or its config
   * dir answered a round begun after the run was named and listed no process
   * of its session. What a run once served is let go once a round begun after
   * the run's last sidecar left finds no sidecar of it named again. */
  reconcile(round: AgentsRound, begunAt: number): Reconciled {
    const found: SidecarRun[] = [];
    const dropped: SidecarRun[] = [];
    const answered = new Set(round.answeredDirs);
    for (const [key, held] of this.#runs) {
      const { run } = held;
      if (run.pid !== undefined) {
        if (!this.#deps.isAlive(run.pid)) {
          this.#byOwner.delete(held.owner);
          this.#drop(key, run);
          dropped.push(run);
        }
        continue;
      }
      const pid = this.#pidAmong(run, round.agents);
      if (pid !== undefined) {
        run.pid = pid;
        found.push(run);
        continue;
      }
      const listed = round.agents.some(
        (row) => row.sessionId === run.sid && inDir(row, run.configDir),
      );
      const dirAnswered =
        run.configDir === undefined ? answered.size > 0 : answered.has(run.configDir);
      if (held.namedAt < begunAt && dirAnswered && !listed) {
        this.#byOwner.delete(held.owner);
        this.#drop(key, run);
        dropped.push(run);
      }
    }
    for (const [runId, served] of this.#served) {
      if (served.leftAt !== undefined && served.leftAt < begunAt) this.#served.delete(runId);
    }
    return { found, dropped };
  }

  #drop(key: string, run: SidecarRun): void {
    this.#runs.delete(key);
    const stillNamed = [...this.#runs.values()].some((held) => held.run.runId === run.runId);
    const served = this.#served.get(run.runId);
    if (served !== undefined && !stillNamed) served.leftAt = this.#deps.now();
  }

  /** The pid of `run`: among the rows of its session (in its config dir, when
   * it names one) whose process no other live run of the session holds, the
   * one whose start is nearest the run's. */
  #pidAmong(run: SidecarRunHello, rows: readonly AgentRow[]): number | undefined {
    const taken = new Set<number>();
    for (const { run: other } of this.#runs.values()) {
      if (other.sid === run.sid && other.runId !== run.runId && other.pid !== undefined) {
        taken.add(other.pid);
      }
    }
    let best: AgentRow | undefined;
    for (const row of rows) {
      if (row.sessionId !== run.sid || !inDir(row, run.configDir) || taken.has(row.pid)) continue;
      if (
        best === undefined ||
        Math.abs(row.startedAt - run.startedAt) < Math.abs(best.startedAt - run.startedAt)
      ) {
        best = row;
      }
    }
    return best?.pid;
  }
}

function runKey(sid: string, runId: string): string {
  return `${sid}.${runId}`;
}

function inDir(row: AgentRow, configDir: string | undefined): boolean {
  return configDir === undefined || row.configDir === configDir;
}
