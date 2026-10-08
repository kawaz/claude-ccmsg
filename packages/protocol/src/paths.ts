// Filesystem layout (DR-0002 §1). runtime (state), user configuration (config)
// and data are separated so that "the thing you must not lose is only data/" is
// expressed structurally, and "the thing you may hand-edit is only config/".
//
//   state:  ${CCMSG_STATE_DIR:-${XDG_STATE_HOME:-~/.local/state}/ccmsg}
//             daemon.sock / daemon.lock / daemon.pid / daemon.log
//             sidecars/<sid>.<pid>.sock (DR-0035 §3)
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
   * which is what the daemon prefers when both files exist. JSON cannot carry a
   * multi-line launcher command without escaping every newline; a module can
   * (template literals), and it is the form every JS tool now offers for
   * hand-written configuration. */
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
  /** Where each session run's sidecar binds `<sid>.<pid>.sock` (DR-0035 §3);
   * see resolveSidecarDir. */
  sidecars: string;
}

/** macOS `sun_path` holds 104 bytes including the terminating NUL. */
const MAX_SOCKET_PATH = 104;

/** The directory under the state dir where sidecars bind.
 *
 * Plural on purpose: kawaz/ccmsg (v2) keeps its own sidecars in `sidecar/`
 * under the same `~/.local/state/ccmsg` this daemon uses, and both plugins can
 * be loaded into one session run. Sharing a directory would have the two
 * sidecars of one run unlink each other's `<sid>.<pid>.sock` (DR-0035 §3). */
export const SIDECAR_DIR = "sidecars";

/** A session id as it may become part of a socket name: a separator in it
 * would name a file outside the directory. */
const SID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isSessionIdShape(sid: string): boolean {
  return SID_SHAPE.test(sid);
}

/** `<sid>.<pid>.sock`: one socket per run of a session, the pid being the
 * harness process's, so two runs of one session (a resume started twice) do
 * not take each other's socket. */
export function sidecarSocketName(sid: string, pid: number): string {
  if (!isSessionIdShape(sid)) throw new RangeError(`not a session id: ${sid}`);
  if (!Number.isSafeInteger(pid) || pid <= 0) throw new RangeError(`not a pid: ${String(pid)}`);
  return `${sid}.${String(pid)}.sock`;
}

/** The harness pid a socket name in the sidecar directory carries for `sid`,
 * or undefined when the name belongs to another session or is not a socket
 * name at all. */
export function sidecarSocketPid(name: string, sid: string): number | undefined {
  const prefix = `${sid}.`;
  if (!name.startsWith(prefix)) return undefined;
  const match = /^([1-9][0-9]*)\.sock$/.exec(name.slice(prefix.length));
  if (match === null) return undefined;
  const pid = Number(match[1]);
  return Number.isSafeInteger(pid) ? pid : undefined;
}

/** `<stateDir>/sidecars`, or the short per-uid directory under `/tmp` when the
 * widest socket name would not fit in `sun_path` there. The daemon and every
 * sidecar derive it from the same state dir, so neither registers anything
 * with the other — which is why the widest name is judged by the largest pid
 * a name can carry rather than by any one run's pid: a run whose pid happened
 * to fit would bind where a run with a longer pid could not, and the daemon
 * would have to look in both. */
export function resolveSidecarDir(stateDir: string): string {
  const beside = path.join(stateDir, SIDECAR_DIR);
  const widest = path.join(
    beside,
    sidecarSocketName("00000000-0000-0000-0000-000000000000", Number.MAX_SAFE_INTEGER),
  );
  if (Buffer.byteLength(widest) < MAX_SOCKET_PATH) return beside;
  return path.join("/tmp", `claude-ccmsg-${String(process.getuid?.() ?? 0)}`, SIDECAR_DIR);
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
    sidecars: resolveSidecarDir(stateDir),
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
