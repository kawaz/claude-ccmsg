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
  /** Web gateway (hyoui) の base URL — SessionView の Terminal タブが
   * `${terminal_gateway_url}/sessions/<HYOUI_SESSION_ID>?embed=1` を iframe に
   * 埋める (issue 2026-07-21-webui-terminal-tab-embed)。http:// / https:// の
   * 絶対 URL のみ受け付け、それ以外は warn + 未設定扱い (= webui 側で
   * Terminal タブ自体を出さない)。 */
  terminal_gateway_url?: string;
}

function parseTerminalGatewayUrl(raw: unknown, file: string, log: Log): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    warn(log, file, "terminal_gateway_url must be a non-empty string; ignoring");
    return undefined;
  }
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    warn(log, file, `terminal_gateway_url is not a valid URL: ${trimmed}; ignoring`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    warn(log, file, `terminal_gateway_url must be http:// or https://: ${trimmed}; ignoring`);
    return undefined;
  }
  return trimmed;
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

/** Parse one env-pattern list field (clean_env / keep_env — same grammar,
 * same degrade rules): undefined → [], non-array → warn + [], non-string or
 * empty entries → warn + skip while good patterns survive. */
function parseEnvPatternList(
  raw: unknown,
  field: "clean_env" | "keep_env",
  file: string,
  log: Log,
): string[] {
  const patterns: string[] = [];
  if (raw === undefined) return patterns;
  if (!Array.isArray(raw)) {
    warn(log, file, `session_launcher.${field} must be a string array; ignoring`);
    return patterns;
  }
  for (const pattern of raw) {
    if (typeof pattern !== "string" || pattern === "") {
      warn(log, file, `session_launcher.${field} entries must be non-empty strings; entry ignored`);
      continue;
    }
    patterns.push(pattern);
  }
  return patterns;
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

  // clean_env / keep_env (DR-0018 §3.1 addendum 2026-07-18): wildcard
  // patterns of env keys to strip before launch, and the allowlist that
  // overrides the stripping (keep wins over clean). Malformed shapes degrade
  // to an empty list — for clean_env that means "no cleaning", for keep_env
  // "no exceptions" — rather than disabling the launcher; a bad pattern list
  // is repairable while sessions keep launching.
  const cleanEnv = parseEnvPatternList(raw.clean_env, "clean_env", file, log);
  const keepEnv = parseEnvPatternList(raw.keep_env, "keep_env", file, log);

  return {
    root_dirs: rootDirs,
    clean_env: cleanEnv,
    keep_env: keepEnv,
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
  const sessionLauncher =
    parsed.session_launcher === undefined
      ? undefined
      : parseSessionLauncher(parsed.session_launcher, file, log);
  const terminalGatewayUrl = parseTerminalGatewayUrl(parsed.terminal_gateway_url, file, log);
  const cfg: DaemonConfig = {};
  if (sessionLauncher) cfg.session_launcher = sessionLauncher;
  if (terminalGatewayUrl) cfg.terminal_gateway_url = terminalGatewayUrl;
  return cfg;
}
