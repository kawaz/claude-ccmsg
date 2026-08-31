// Daemon user configuration (DR-0018 §3.1).
//
// The DR presents the shape in YAML, but this daemon already persists user
// configuration as JSON (`allowed-origins.json`) and has no YAML dependency.
// `<configDir>/config.json` keeps that established zero-dependency convention;
// malformed user edits degrade to an unavailable launcher, never daemon crash.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DEFAULT_DIR_TREE_DEPTH,
  DEFAULT_LAUNCH_TIMEOUT_SECONDS,
  DEFAULT_LAUNCHER_TEMPLATE_NAME,
  LAUNCHER_CWD_PARAM,
  type LauncherParam,
  type SessionLauncherConfig,
  type SessionLauncherTemplate,
} from "@ccmsg/protocol";

export interface DaemonConfig {
  session_launcher?: SessionLauncherConfig;
  /** Web gateway (hyoui) の base URL — SessionView の Terminal タブが
   * `${terminal_gateway_url}/sessions/<HYOUI_SESSION_ID>?embed=1` を iframe に
   * 埋める (issue 2026-07-21-webui-terminal-tab-embed)。http:// / https:// の
   * 絶対 URL のみ受け付け、それ以外は warn + 未設定扱い (= webui 側で
   * Terminal タブ自体を出さない)。 */
  terminal_gateway_url?: string;
  /** LLM gateway の usage endpoint URL — webui の Usage 画面が `llm_usage` op
   * 経由でここの JSON を読む (endpoint が CORS ヘッダを返さないため browser
   * 直 fetch は不可、daemon が proxy する)。terminal_gateway_url と同じく
   * http:// / https:// の絶対 URL のみ受け付け、それ以外は warn + 未設定扱い
   * (= webui 側で Usage メニュー自体を出さない)。 */
  llm_usage_url?: string;
  /** LLM gateway の stats endpoint URL — webui の Usage 画面の使用量セクション
   * が `llm_stats` op 経由でここの JSON を読む。llm_usage_url と同じ理由で
   * daemon proxy 経由 (CORS ヘッダ無し)、同じ検証 (http:// / https:// の絶対
   * URL のみ) を通す。集計期間は op の `days` が query parameter として上書き
   * するので、ここには days を付けても付けなくてもよい。 */
  llm_stats_url?: string;
  /** 外部プロデューサからの `POST /webhook/<source>` 受け口 (webhook.ts)。
   * source 名 (`[a-z0-9-]{1,64}`) → その source 専用の bearer token を置いた
   * ファイルパス。token 値をここに直書きしないのは、config.json が token より
   * 緩い権限で置かれがちなため — 秘密はファイル側 (mode 600) に置き、config は
   * その在り処だけを持つ。未設定の source は 404 (= 存在しない) 扱い。 */
  webhooks?: Record<string, WebhookSourceConfig>;
  /** 非信頼コンテンツを配信する sandbox origin の URL テンプレート (DR-0030
   * §7.1)。`{gid}` を **ホスト名部分に** 含む http:// / https:// の絶対 URL
   * のみ受け付ける (例:
   * `https://ccmsg-files-{gid}.host.example`)。`{gid}` が path にあっても
   * 全 grant が同一 origin に載って origin 分離が成立しないので不正扱い。
   * 未設定 / 不正なら warn + 未設定扱い = sandbox 配信そのものが無効になり、
   * webui は導線を出さない (押せば必ず失敗するボタンを置かない)。 */
  sandbox_origin_template?: string;
}

export interface WebhookSourceConfig {
  /** bearer token を格納したファイル。先頭の `~` は展開し、読めた内容は
   * trim して使う (エディタが付ける改行で認証が落ちるのを避ける)。 */
  token_file: string;
}

/** Validate one absolute-http(s)-URL config field. Both URL-valued keys
 * degrade identically — a malformed URL disables just that feature, never the
 * whole config — so the rule lives in one place and the field name only
 * shapes the warning text. */
function parseHttpUrl(raw: unknown, field: string, file: string, log: Log): string | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== "string" || raw.trim() === "") {
    warn(log, file, `${field} must be a non-empty string; ignoring`);
    return undefined;
  }
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    warn(log, file, `${field} is not a valid URL: ${trimmed}; ignoring`);
    return undefined;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    warn(log, file, `${field} must be http:// or https://: ${trimmed}; ignoring`);
    return undefined;
  }
  return trimmed;
}

interface Log {
  warn(msg: string): void;
}

/** sandbox origin テンプレートの検証 (DR-0030 §7.1)。URL としての妥当性は
 * parseHttpUrl と共通だが、追加で「`{gid}` がホスト名部分にちょうど 1 個ある」
 * ことを要求する — grant ごとに origin が分かれることが本機能の前提なので、
 * これを満たさないテンプレートは無効化する方が「効いていないのに動いている
 * ように見える」より安全。 */
function parseSandboxOriginTemplate(raw: unknown, file: string, log: Log): string | undefined {
  const value = parseHttpUrl(raw, "sandbox_origin_template", file, log);
  if (value === undefined) return undefined;
  const host = new URL(value).hostname;
  if (host.split("{gid}").length !== 2) {
    warn(
      log,
      file,
      `sandbox_origin_template must contain exactly one {gid} in its hostname: ${value}; ignoring`,
    );
    return undefined;
  }
  return value;
}

/** source 名 → token ファイルの対応表を読む。source ごとに独立に degrade する
 * (壊れた 1 件で他の webhook まで無効にしない)。source 名を狭く縛るのは、この
 * 名前が URL path segment とそのまま対応するため。 */
function parseWebhooks(
  raw: unknown,
  file: string,
  log: Log,
): Record<string, WebhookSourceConfig> | undefined {
  if (raw === undefined) return undefined;
  if (!isObject(raw)) {
    warn(log, file, "webhooks must be a JSON object; ignoring");
    return undefined;
  }
  const out: Record<string, WebhookSourceConfig> = {};
  for (const [source, value] of Object.entries(raw)) {
    if (!/^[a-z0-9-]{1,64}$/.test(source)) {
      warn(log, file, `webhooks: invalid source name ${JSON.stringify(source)}; ignoring`);
      continue;
    }
    if (
      !isObject(value) ||
      typeof value.token_file !== "string" ||
      value.token_file.trim() === ""
    ) {
      warn(log, file, `webhooks.${source}: token_file must be a non-empty string; ignoring`);
      continue;
    }
    out[source] = { token_file: expandRoot(value.token_file.trim()) };
  }
  return Object.keys(out).length > 0 ? out : undefined;
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

/** Parse `shell`, shared by the launcher level and each template (a template
 * that omits it inherits the launcher-level value, which itself defaults to
 * bash). An unrecognized value degrades to the inherited default rather than
 * disabling anything — the wrong shell name is a repairable typo, and falling
 * through to an implicit `sh -c` is exactly what the fixed enum prevents. */
function parseShell(
  raw: unknown,
  fallback: "bash" | "zsh",
  field: string,
  file: string,
  log: Log,
): "bash" | "zsh" {
  if (raw === undefined) return fallback;
  if (raw === "bash" || raw === "zsh") return raw;
  warn(log, file, `session_launcher.${field} must be 'bash' or 'zsh'; using ${fallback}`);
  return fallback;
}

/** A parameter name has to be a shell identifier: the launcher shell defines it
 * with a fixed prologue (`NAME="$carrier"`), so anything else would be a syntax
 * error at launch instead of a config error at startup. */
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Legacy vocabulary of the pre-`params` config, in the order the form used to
 * render it. Normalizing an old config re-derives its parameter list by asking
 * which of these its command reads (`$VAR` / `${VAR}`), which is exactly the
 * rule the webui used to apply to the command text at render time — so an
 * un-migrated config keeps the form it had. Defaults match the values the form
 * itself used to seed those fields with. */
const LEGACY_PARAM_DEFAULTS: ReadonlyArray<{ name: string; default: string }> = [
  { name: "CWD", default: "" },
  { name: "MODEL", default: "fable" },
  { name: "EFFORT", default: "medium" },
  { name: "PROMPT", default: "" },
  { name: "RESUME_SID", default: "" },
  { name: "RESUME_AT", default: "" },
];

function commandReadsVar(command: string, name: string): boolean {
  return new RegExp(`\\$\\{?${name}\\b`).test(command);
}

/** The parameter list an old-form template implies: every legacy variable its
 * command actually reads, with PROMPT seeded from the inherited
 * `default_prompt`. CWD is added by `parseLauncherParams`' caller regardless,
 * so a command that never mentions `$CWD` still launches somewhere. */
function legacyParams(command: string, defaultPrompt: string): LauncherParam[] {
  return LEGACY_PARAM_DEFAULTS.filter((p) => commandReadsVar(command, p.name)).map((p) => ({
    name: p.name,
    default: p.name === "PROMPT" ? defaultPrompt : p.default,
  }));
}

/** Parse one template's `params` declaration: an object mapping parameter name
 * to its default value, whose key order is the order the form renders. Broken
 * entries degrade individually (bad name or non-string default → warn + skip)
 * for the same reason a broken template does — one typo should cost one input,
 * not the whole launcher. */
function parseLauncherParams(
  raw: unknown,
  templateName: string,
  file: string,
  log: Log,
): LauncherParam[] {
  const params: LauncherParam[] = [];
  if (!isObject(raw)) {
    warn(
      log,
      file,
      `session_launcher.templates[${templateName}].params must be a JSON object; ignoring`,
    );
    return params;
  }
  for (const [name, value] of Object.entries(raw)) {
    if (!PARAM_NAME_RE.test(name)) {
      warn(
        log,
        file,
        `session_launcher.templates[${templateName}].params: ${JSON.stringify(name)} is not a shell identifier; entry ignored`,
      );
      continue;
    }
    if (typeof value !== "string") {
      warn(
        log,
        file,
        `session_launcher.templates[${templateName}].params.${name} default must be a string; entry ignored`,
      );
      continue;
    }
    params.push({ name, default: value });
  }
  return params;
}

/** Every template needs CWD (it is where the process runs), so a declaration
 * that omits it gets it first — the form then always has its directory picker
 * and the daemon always has a path to containment-check. */
function withCwdParam(params: LauncherParam[]): LauncherParam[] {
  if (params.some((p) => p.name === LAUNCHER_CWD_PARAM)) return params;
  return [{ name: LAUNCHER_CWD_PARAM, default: "" }, ...params];
}

/** Parse `session_launcher.templates` (named launch recipes). Each entry may
 * omit `command` / `params` / `shell`; the first two then come from the legacy
 * launcher-level fields (see `legacyParams`) and the last inherits. The result
 * is fully resolved so nothing downstream re-applies fallbacks. A broken entry
 * (not an object, blank/duplicate name, no command from either level) is warned
 * about and skipped on its own — one unusable recipe must not take the other
 * recipes down with it, same defensive posture as the env-pattern lists. */
function parseLauncherTemplates(
  raw: unknown,
  inherited: { command: string | undefined; defaultPrompt: string; shell: "bash" | "zsh" },
  file: string,
  log: Log,
): SessionLauncherTemplate[] {
  const templates: SessionLauncherTemplate[] = [];
  if (raw === undefined) return templates;
  if (!Array.isArray(raw)) {
    warn(log, file, "session_launcher.templates must be an array; ignoring");
    return templates;
  }
  const names = new Set<string>();
  for (const entry of raw) {
    if (!isObject(entry)) {
      warn(log, file, "session_launcher.templates entries must be objects; entry ignored");
      continue;
    }
    if (typeof entry.name !== "string" || entry.name === "") {
      warn(log, file, "session_launcher.templates entry needs a non-empty name; entry ignored");
      continue;
    }
    const name = entry.name;
    if (names.has(name)) {
      warn(log, file, `session_launcher.templates has a duplicate name: ${name}; entry ignored`);
      continue;
    }
    let command = inherited.command;
    if (entry.command !== undefined) {
      if (typeof entry.command === "string" && entry.command !== "") command = entry.command;
      else
        warn(
          log,
          file,
          `session_launcher.templates[${name}].command must be a non-empty string; using the launcher-level command`,
        );
    }
    if (command === undefined) {
      warn(
        log,
        file,
        `session_launcher.templates[${name}] has no command and session_launcher.command is unset; entry ignored`,
      );
      continue;
    }
    let defaultPrompt = inherited.defaultPrompt;
    if (entry.default_prompt !== undefined) {
      if (typeof entry.default_prompt === "string") defaultPrompt = entry.default_prompt;
      else
        warn(
          log,
          file,
          `session_launcher.templates[${name}].default_prompt must be a string; using the launcher-level prompt`,
        );
    }
    names.add(name);
    templates.push({
      name,
      command,
      params: withCwdParam(
        entry.params === undefined
          ? legacyParams(command, defaultPrompt)
          : parseLauncherParams(entry.params, name, file, log),
      ),
      shell: parseShell(entry.shell, inherited.shell, `templates[${name}].shell`, file, log),
    });
  }
  return templates;
}

/** Tell the administrator once, at startup, that their launcher config is in
 * the pre-`params` form and what the current form looks like. The config still
 * works (it was normalized above, and only the normalized shape exists past
 * this point), so this is a nudge rather than a failure — but a config whose
 * inputs are inferred from command text cannot express "declare an input the
 * command doesn't mention yet", which is the whole point of `params`. */
function warnIfLegacyForm(raw: Record<string, unknown>, file: string, log: Log): void {
  const templates = Array.isArray(raw.templates) ? raw.templates : [];
  const legacy =
    raw.command !== undefined ||
    raw.default_prompt !== undefined ||
    raw.templates === undefined ||
    templates.some((t) => isObject(t) && t.params === undefined);
  if (!legacy) return;
  warn(
    log,
    file,
    "session_launcher uses the deprecated pre-`params` form (top-level command/default_prompt, or templates without `params`); " +
      'declare each recipe fully instead, e.g. "templates": [{"name": "new", "command": "…$CWD…$MODEL…$PROMPT…", ' +
      '"params": {"CWD": "", "MODEL": "fable", "EFFORT": "low", "PROMPT": ""}}]',
  );
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

  // The launcher-level command is the flat single-recipe form AND the value
  // templates inherit when they omit their own. It is therefore only required
  // when `templates` doesn't supply one — a config that names every command
  // inside its templates has nothing to put here.
  let command: string | undefined;
  if (raw.command !== undefined) {
    if (typeof raw.command === "string" && raw.command !== "") command = raw.command;
    else warn(log, file, "session_launcher.command must be a non-empty string; ignoring");
  }

  const shell = parseShell(raw.shell, "bash", "shell", file, log);

  let defaultPrompt = "";
  if (raw.default_prompt !== undefined) {
    if (typeof raw.default_prompt === "string") defaultPrompt = raw.default_prompt;
    else warn(log, file, "session_launcher.default_prompt must be a string; using empty string");
  }

  // Flat form (no `templates` key) = one implicit recipe built from the
  // launcher-level fields, so every pre-templates config keeps launching
  // exactly as before. With `templates` present the list is authoritative and
  // the launcher-level command is only the inheritance source.
  const templates: SessionLauncherTemplate[] =
    raw.templates === undefined
      ? command === undefined
        ? []
        : [
            {
              name: DEFAULT_LAUNCHER_TEMPLATE_NAME,
              command,
              params: withCwdParam(legacyParams(command, defaultPrompt)),
              shell,
            },
          ]
      : parseLauncherTemplates(raw.templates, { command, defaultPrompt, shell }, file, log);
  if (templates.length === 0) {
    warn(log, file, "session_launcher has no usable command template; launcher disabled");
    return undefined;
  }
  warnIfLegacyForm(raw, file, log);

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
    templates,
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
  const terminalGatewayUrl = parseHttpUrl(
    parsed.terminal_gateway_url,
    "terminal_gateway_url",
    file,
    log,
  );
  const llmUsageUrl = parseHttpUrl(parsed.llm_usage_url, "llm_usage_url", file, log);
  const llmStatsUrl = parseHttpUrl(parsed.llm_stats_url, "llm_stats_url", file, log);
  if (parsed.llm_events_url !== undefined) {
    // 旧: daemon が gateway の SSE を購読する方式。gateway が stable/unstable の
    // 2 プロセスで走るため 1 本の購読では掴んだ側のイベントしか見えず、向きを
    // 逆にした (gateway → daemon の webhook)。移行を促すため無視 + warn。
    warn(log, file, "llm_events_url is no longer used; configure `webhooks` instead (ignored)");
  }
  const webhooks = parseWebhooks(parsed.webhooks, file, log);
  const sandboxOriginTemplate = parseSandboxOriginTemplate(
    parsed.sandbox_origin_template,
    file,
    log,
  );
  const cfg: DaemonConfig = {};
  if (sandboxOriginTemplate) cfg.sandbox_origin_template = sandboxOriginTemplate;
  if (sessionLauncher) cfg.session_launcher = sessionLauncher;
  if (terminalGatewayUrl) cfg.terminal_gateway_url = terminalGatewayUrl;
  if (llmUsageUrl) cfg.llm_usage_url = llmUsageUrl;
  if (llmStatsUrl) cfg.llm_stats_url = llmStatsUrl;
  if (webhooks) cfg.webhooks = webhooks;
  return cfg;
}
