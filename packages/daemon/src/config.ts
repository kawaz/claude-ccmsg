// Daemon user configuration (DR-0018 §3.1).
//
// The DR presents the shape in YAML, but this daemon already persists user
// configuration as JSON (`allowed-origins.json`) and has no YAML dependency.
// `<dataDir>/config.json` keeps that established zero-dependency convention;
// malformed user edits degrade to an unavailable launcher, never daemon crash.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_DIR_TREE_DEPTH,
  DEFAULT_LAUNCH_TIMEOUT_SECONDS,
  type SessionLauncherConfig,
} from "@ccmsg/protocol";

export interface DaemonConfig {
  session_launcher?: SessionLauncherConfig;
}

interface Log {
  warn(msg: string): void;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function warn(log: Log, file: string, msg: string): void {
  log.warn(`config: ${file}: ${msg}`);
}

function expandRoot(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

function positiveNumber(
  value: unknown,
  fallback: number,
  field: string,
  file: string,
  log: Log,
): number {
  if (value === undefined) return fallback;
  if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
  warn(log, file, `session_launcher.${field} must be a positive finite number; using ${fallback}`);
  return fallback;
}

function parseSessionLauncher(
  raw: unknown,
  file: string,
  log: Log,
): SessionLauncherConfig | undefined {
  if (!isObject(raw)) {
    warn(log, file, "session_launcher must be a JSON object; launcher disabled");
    return undefined;
  }

  const rawRoots = raw.root_dirs;
  if (!Array.isArray(rawRoots) || rawRoots.length === 0) {
    warn(
      log,
      file,
      "session_launcher.root_dirs must be a non-empty string array; launcher disabled",
    );
    return undefined;
  }

  const rootDirs: string[] = [];
  for (const root of rawRoots) {
    if (typeof root !== "string" || root === "") {
      warn(
        log,
        file,
        "session_launcher.root_dirs entries must be non-empty strings; entry ignored",
      );
      continue;
    }
    const expanded = expandRoot(root);
    if (!path.isAbsolute(expanded)) {
      warn(
        log,
        file,
        `session_launcher.root_dirs entry must be absolute or start with ~/: ${root}`,
      );
      continue;
    }
    rootDirs.push(path.resolve(expanded));
  }
  if (rootDirs.length === 0) {
    warn(log, file, "session_launcher.root_dirs has no usable absolute paths; launcher disabled");
    return undefined;
  }

  if (typeof raw.command !== "string" || raw.command === "") {
    warn(log, file, "session_launcher.command must be a non-empty string; launcher disabled");
    return undefined;
  }

  let shell: SessionLauncherConfig["shell"] = "bash";
  if (raw.shell !== undefined) {
    if (raw.shell === "bash" || raw.shell === "zsh") shell = raw.shell;
    else warn(log, file, "session_launcher.shell must be 'bash' or 'zsh'; using bash");
  }

  let defaultPrompt = "";
  if (raw.default_prompt !== undefined) {
    if (typeof raw.default_prompt === "string") defaultPrompt = raw.default_prompt;
    else warn(log, file, "session_launcher.default_prompt must be a string; using empty string");
  }

  return {
    root_dirs: rootDirs,
    default_prompt: defaultPrompt,
    shell,
    command: raw.command,
    timeout_seconds: positiveNumber(
      raw.timeout_seconds,
      DEFAULT_LAUNCH_TIMEOUT_SECONDS,
      "timeout_seconds",
      file,
      log,
    ),
    dir_tree_depth: positiveNumber(
      raw.dir_tree_depth,
      DEFAULT_DIR_TREE_DEPTH,
      "dir_tree_depth",
      file,
      log,
    ),
  };
}

/** Read daemon configuration once at startup (LN-Q4). Missing is the normal
 * unconfigured state; malformed content logs and collapses to an empty config. */
export function loadConfig(file: string, log: Log): DaemonConfig {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return {};
    warn(log, file, `unreadable (${String(e)}); treating as empty`);
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    warn(log, file, `invalid JSON (${String(e)}); treating as empty`);
    return {};
  }
  if (!isObject(parsed)) {
    warn(log, file, "top level must be a JSON object; treating as empty");
    return {};
  }
  if (parsed.session_launcher === undefined) return {};

  const sessionLauncher = parseSessionLauncher(parsed.session_launcher, file, log);
  return sessionLauncher ? { session_launcher: sessionLauncher } : {};
}
