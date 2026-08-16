// Filesystem layout (DR-0002 §1). runtime (state) and data are separated so that
// "the thing you must not lose is only data/" is expressed structurally.
//
//   state: ${CCMSG_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/ccmsg}
//            daemon.sock / daemon.lock / daemon.pid / daemon.log
//   data:  ${CCMSG_DATA_DIR:-${XDG_DATA_HOME:-~/.local/share}/ccmsg}
//            rooms/<room-id>.jsonl
//            dumps/<sid>-<YYYYMMDD-HHmmss>.jsonl
//
// CCMSG_STATE_DIR / CCMSG_DATA_DIR are direct overrides (tests depend on them).
import * as os from "node:os";
import * as path from "node:path";

export interface Paths {
  stateDir: string;
  dataDir: string;
  roomsDir: string;
  sock: string;
  lock: string;
  pid: string;
  log: string;
  /** Correlated component-boundary timestamps for transcript latency diagnosis. */
  trace: string;
  /** persisted extra allowed `Origin` values (JSON string[]), managed by
   * `ccmsg origins add/remove/list` and read by the daemon's Origin check.
   * Lives in data/ (not state/) because it is user configuration that must
   * survive daemon restarts — unlike CCMSG_HTTP_ALLOW_ORIGIN, which vanishes
   * whenever a client respawns the daemon without that env set. */
  allowedOrigins: string;
  /** DR-0018 session launcher and future daemon user configuration. Lives in
   * data/ beside allowedOrigins because user configuration must survive daemon
   * restarts; state/ remains disposable runtime state. */
  config: string;
  /** Session dumps written for a human to hand to another session
   * (`ccmsg dump --out`, the webui's dump action). Lives in data/ because the
   * path is meant to be pasted somewhere and read back later, possibly after
   * a daemon restart. */
  dumps: string;
}

function home(): string {
  return os.homedir();
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCMSG_STATE_DIR) return env.CCMSG_STATE_DIR;
  const base = env.XDG_STATE_HOME || path.join(home(), ".local", "state");
  return path.join(base, "ccmsg");
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCMSG_DATA_DIR) return env.CCMSG_DATA_DIR;
  const base = env.XDG_DATA_HOME || path.join(home(), ".local", "share");
  return path.join(base, "ccmsg");
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const stateDir = resolveStateDir(env);
  const dataDir = resolveDataDir(env);
  return {
    stateDir,
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock: path.join(stateDir, "daemon.sock"),
    lock: path.join(stateDir, "daemon.lock"),
    pid: path.join(stateDir, "daemon.pid"),
    log: path.join(stateDir, "daemon.log"),
    trace: path.join(stateDir, "trace.jsonl"),
    allowedOrigins: path.join(dataDir, "allowed-origins.json"),
    config: path.join(dataDir, "config.json"),
    dumps: path.join(dataDir, "dumps"),
  };
}
