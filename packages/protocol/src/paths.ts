// Filesystem layout (DR-0002 §1). runtime (state), user configuration (config)
// and data are separated so that "the thing you must not lose is only data/" is
// expressed structurally, and "the thing you may hand-edit is only config/".
//
//   state:  ${CCMSG_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/ccmsg}
//             daemon.sock / daemon.lock / daemon.pid / daemon.log
//             sidecars/<sid>.<run id>.sock (DR-0035 §3)
//   config: ${CCMSG_CONFIG_DIR:-${XDG_CONFIG_HOME:-~/.config}/ccmsg}
//             config.ts / config.js / config.json
//             allowed-origins.json
//   data:   ${CCMSG_DATA_DIR:-${XDG_DATA_HOME:-~/.local/share}/ccmsg}
//             rooms/<room-id>.jsonl
//             dumps/<sid>-<YYYYMMDD-HHmmss>.{txt,jsonl}
//
// CCMSG_STATE_DIR / CCMSG_CONFIG_DIR / CCMSG_DATA_DIR are direct overrides
// (tests depend on them).
import * as os from "node:os";
import * as path from "node:path";
import { isSessionIdShape } from "./ccmsg-address.ts";
import { parseWith } from "./parse.ts";
import { SidecarRunIdSchema } from "./sidecar.ts";

export interface Paths {
  stateDir: string;
  configDir: string;
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
   * Lives in config/ because it is declarative user configuration that must
   * survive daemon restarts — unlike CCMSG_HTTP_ALLOW_ORIGIN, which vanishes
   * whenever a client respawns the daemon without that env set. */
  allowedOrigins: string;
  /** DR-0018 session launcher and the rest of the daemon's user configuration
   * (hand-edited JSON). Lives in config/ beside allowedOrigins; state/ remains
   * disposable runtime state and data/ holds only what must not be lost. */
  config: string;
  /** The same configuration written as an ES module (`export default {…}`),
   * which is what the daemon prefers when both files exist. A module can build
   * values JSON can only spell out literally, and it is the form every JS tool
   * now offers for hand-written configuration. */
  configJs: string;
  /** The same configuration written as a TypeScript ES module, evaluated the
   * same way as configJs (Bun's ESM loader strips types without a build step)
   * and preferred over it when both exist. The only reason to reach for this
   * over configJs is wanting type annotations on the default export — the
   * daemon writes `<configDir>/ccmsg-config.d.ts` at startup so config.ts can
   * `import type { CcmsgConfig }` from it — the accepted shape is otherwise
   * identical. */
  configTs: string;
  /** Session dumps written for a human to hand to another session
   * (`ccmsg dump --out`, the webui's dump action). Lives in data/ because the
   * path is meant to be pasted somewhere and read back later, possibly after
   * a daemon restart. */
  dumps: string;
  /** `<stateDir>/sidecars`: where each session run's sidecar binds
   * `<sid>.<run id>.sock` (DR-0035 §3). */
  sidecars: string;
  /** `<stateDir>/launches`: the output of a launch command too long to answer
   * with, one `<launch id>/stdout|stderr` per launch, kept 7 days (DR-0018
   * §3.6). */
  launches: string;
}

/** The directory under the state dir where sidecars bind.
 *
 * Plural on purpose: kawaz/ccmsg (v2) keeps its own sidecars in `sidecar/`
 * under the same `~/.local/state/ccmsg` this daemon uses, and both plugins can
 * be loaded into one session run. Sharing a directory would have the two
 * sidecars of one run unlink each other's socket (DR-0035 §3). */
export const SIDECAR_DIR = "sidecars";

/** `<sid>.<run id>.sock`: one socket per run of a session, so two runs of one
 * session (a resume started twice) do not take each other's socket. */
export function sidecarSocketName(sid: string, runId: string): string {
  if (!isSessionIdShape(sid)) throw new RangeError(`not a session id: ${sid}`);
  if (!parseWith(SidecarRunIdSchema, runId).ok) throw new RangeError(`not a run id: ${runId}`);
  return `${sid}.${runId}.sock`;
}

function home(): string {
  return os.homedir();
}

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCMSG_STATE_DIR) return env.CCMSG_STATE_DIR;
  const base = env.XDG_STATE_HOME || path.join(home(), ".local", "state");
  return path.join(base, "ccmsg");
}

export function resolveConfigDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCMSG_CONFIG_DIR) return env.CCMSG_CONFIG_DIR;
  const base = env.XDG_CONFIG_HOME || path.join(home(), ".config");
  return path.join(base, "ccmsg");
}

export function resolveDataDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CCMSG_DATA_DIR) return env.CCMSG_DATA_DIR;
  const base = env.XDG_DATA_HOME || path.join(home(), ".local", "share");
  return path.join(base, "ccmsg");
}

export function resolvePaths(env: NodeJS.ProcessEnv = process.env): Paths {
  const stateDir = resolveStateDir(env);
  const configDir = resolveConfigDir(env);
  const dataDir = resolveDataDir(env);
  return {
    stateDir,
    configDir,
    dataDir,
    roomsDir: path.join(dataDir, "rooms"),
    sock: path.join(stateDir, "daemon.sock"),
    lock: path.join(stateDir, "daemon.lock"),
    pid: path.join(stateDir, "daemon.pid"),
    log: path.join(stateDir, "daemon.log"),
    trace: path.join(stateDir, "trace.jsonl"),
    allowedOrigins: path.join(configDir, "allowed-origins.json"),
    config: path.join(configDir, "config.json"),
    configJs: path.join(configDir, "config.js"),
    configTs: path.join(configDir, "config.ts"),
    dumps: path.join(dataDir, "dumps"),
    sidecars: path.join(stateDir, SIDECAR_DIR),
    launches: path.join(stateDir, "launches"),
  };
}

/** Where the session is working, as Claude Code fixed it when the session
 * started (`CLAUDE_PROJECT_DIR`, exported to hooks and to the subprocesses of
 * the Bash/Monitor tools alike).
 *
 * This is one of the three sources allowed to name a session's location (see
 * DR-0003 §3 「所在の正本」); `process.cwd()` is not among them, because a
 * command a session runs is run wherever its last Bash tool went.
 *
 * Absolute or nothing: a relative path is read against the working directory,
 * which is the very thing this exists not to depend on.
 */
export function sessionProjectDir(env: NodeJS.ProcessEnv = process.env): string | undefined {
  const dir = env.CLAUDE_PROJECT_DIR;
  return dir !== undefined && dir !== "" && path.isAbsolute(dir) ? dir : undefined;
}
