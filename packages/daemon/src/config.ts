// Daemon user configuration (DR-0018 §3.1).
//
// The DR presents the shape in YAML, but this daemon already persists user
// configuration as JSON (`allowed-origins.json`) and has no YAML dependency.
// `<configDir>/config.json` keeps that established zero-dependency convention;
// malformed user edits degrade to an unavailable launcher, never daemon crash.
//
// `<configDir>/config.js` — an ES module whose default export is that same
// object (or a Promise resolving to one, letting the module use top-level
// `await` or build the config asynchronously) — is accepted as well, and wins
// over config.json when both files exist. Launcher commands are multi-line
// shell snippets, which JSON can only express as one string with every
// newline escaped; a module writes them as template literals.
// `<configDir>/config.ts` is the same acceptance path with type annotations
// available on the default export (Bun's ESM loader evaluates it directly,
// stripping types with no build step) and wins over both when present. The
// file is a config format, not a plugin: it is evaluated once at startup
// (LN-Q4, extended to "once, awaited if async") and its default export goes
// through exactly the validation the JSON path goes through, so no key can
// mean something different depending on which file it came from.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_DIR_TREE_DEPTH,
  DEFAULT_LAUNCH_TIMEOUT_SECONDS,
  LAUNCHER_CWD_PARAM,
  type LauncherParam,
  type SessionLauncherConfig,
  type SessionLauncherTemplate,
} from "@ccmsg/protocol";

export interface ResolvedCcmsgConfig {
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
  /** LLM gateway の status endpoint URL (gateway 側 DR-0021) — webui の Usage
   * 画面の service status strip と topbar の badge が `llm_status` op 経由で
   * ここの JSON を読む。llm_usage_url と同じ理由で daemon proxy 経由 (CORS
   * ヘッダ無し)、同じ検証 (http:// / https:// の絶対 URL のみ) を通す。
   *
   * Design rationale: usage URL から `/usage` → `/status` を導出する案は採ら
   * ない。3 つの endpoint は「同じ gateway の隣り合う path」である保証がなく
   * (reverse proxy の path prefix / 別ホスト運用)、導出は operator が書いて
   * いない URL を daemon が組み立てて叩くことになる。加えて status を出せる
   * gateway かどうかは usage を出せるかと独立 (古い gateway は usage だけ
   * 返す) で、capability を独立に持てないと「押せば必ずエラー」の strip が
   * 出る。llm_usage_url / llm_stats_url が既に独立キーなのと同じ理由。 */
  llm_status_url?: string;
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

/** One `session_launcher.templates` entry as a hand-authored config.ts /
 * config.js / config.json may declare it — `params` is the ergonomic
 * name-to-default record documented in the runbook, not the resolved
 * `LauncherParam[]` `SessionLauncherTemplate.params` becomes after
 * `parseLauncherTemplates`/`withCwdParam` run. */
export interface CcmsgConfigLauncherTemplate {
  name: string;
  command: string;
  shell?: "bash" | "zsh";
  /** Parameter name → form default value, in declaration order. The
   * declaration is the only source of truth for which inputs the form shows;
   * a template that omits it is unusable and gets skipped at parse time. */
  params: Record<string, string>;
}

/** `session_launcher` as a hand-authored config file may declare it — the
 * pre-parse counterpart of `SessionLauncherConfig` (protocol). Every field
 * `parseSessionLauncher` accepts is optional here because the daemon fills
 * in defaults or degrades the launcher entirely; the type only shapes what a
 * value must look like *if present*, not the cross-field rules (non-empty
 * `root_dirs`, unique template names, …) that stay runtime-only. */
export interface CcmsgConfigLauncher {
  root_dirs: string[];
  /** Default for templates that omit their own `shell`. */
  shell?: "bash" | "zsh";
  timeout_seconds?: number;
  dir_tree_depth?: number;
  clean_env?: string[];
  keep_env?: string[];
  templates: CcmsgConfigLauncherTemplate[];
}

/** The shape a hand-authored `config.ts` / `config.js` / `config.json` may
 * declare — every field `loadConfig` accepts before validation and
 * defaulting run, as opposed to `ResolvedCcmsgConfig` (this module's internal
 * post-parse representation, held on `Daemon.config` and shaped by what the
 * daemon actually uses at runtime, e.g. `session_launcher.templates[].params`
 * as a resolved array rather than a record). `writeConfigTypesFile`
 * re-exports this one — a config.ts author `satisfies`-checks against it, not
 * against `ResolvedCcmsgConfig` — so authoring gets real feedback without forcing
 * the config to be written in the resolved internal shape. It is a
 * convenience, not a full validator: everything `loadConfig`'s `parse*`
 * helpers warn-and-degrade on individually (a bad shell identifier as a
 * param name, an entry with no usable command, …) still only surfaces as a
 * startup warning, exactly as it does for config.json. */
export interface CcmsgConfig {
  session_launcher?: CcmsgConfigLauncher;
  terminal_gateway_url?: string;
  llm_usage_url?: string;
  llm_stats_url?: string;
  llm_status_url?: string;
  webhooks?: Record<string, WebhookSourceConfig>;
  sandbox_origin_template?: string;
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

/** A config.js/config.ts default export may be a `Promise<object>` rather
 * than the object itself; this is the narrowing `readJsConfig` needs to
 * `await` only when that's actually the case (a plain object with no `then`
 * must never be awaited). */
function isThenable(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then: unknown }).then === "function"
  );
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

/** Parse `session_launcher.templates` (named launch recipes). Each entry
 * declares its own `command` and `params` in full; only `shell` inherits the
 * launcher-level default. The result is fully resolved so nothing downstream
 * re-applies fallbacks. A broken entry (not an object, blank/duplicate name,
 * missing command or params) is warned about and skipped on its own — one
 * unusable recipe must not take the other recipes down with it, same defensive
 * posture as the env-pattern lists. */
function parseLauncherTemplates(
  raw: unknown,
  inherited: { shell: "bash" | "zsh" },
  file: string,
  log: Log,
): SessionLauncherTemplate[] {
  const templates: SessionLauncherTemplate[] = [];
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
    if (typeof entry.command !== "string" || entry.command === "") {
      warn(
        log,
        file,
        `session_launcher.templates[${name}].command must be a non-empty string; entry ignored`,
      );
      continue;
    }
    if (entry.params === undefined) {
      warn(log, file, `session_launcher.templates[${name}] has no params; entry ignored`);
      continue;
    }
    names.add(name);
    templates.push({
      name,
      command: entry.command,
      params: withCwdParam(parseLauncherParams(entry.params, name, file, log)),
      shell: parseShell(entry.shell, inherited.shell, `templates[${name}].shell`, file, log),
    });
  }
  return templates;
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

  const shell = parseShell(raw.shell, "bash", "shell", file, log);

  const templates = parseLauncherTemplates(raw.templates, { shell }, file, log);
  if (templates.length === 0) {
    warn(log, file, "session_launcher has no usable command template; launcher disabled");
    return undefined;
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

/** The three files `loadConfig` chooses between. `Paths` satisfies this, so the
 * daemon hands its resolved paths straight over. */
export interface ConfigFiles {
  config: string;
  configJs: string;
  configTs: string;
}

/** Basename of the generated type-declaration file `writeConfigTypesFile`
 * refreshes in configDir on every startup, so `config.ts` can `import type`
 * `CcmsgConfig` from a name that sits right beside it. */
export const CONFIG_TYPES_BASENAME = "ccmsg-config.d.ts";

/** This module's own absolute path, resolved once from the running checkout
 * (not the caller's) — Bun's native ESM loader resolves `import.meta.url`
 * here to wherever this source file actually lives, so the generated
 * re-export always tracks the checkout that is validating config.ts. */
const thisModulePath = fileURLToPath(import.meta.url);

/** Write (or overwrite) `<configDir>/ccmsg-config.d.ts`: a one-line re-export
 * of `CcmsgConfig` (the hand-authored shape, not the internal
 * post-parse `ResolvedCcmsgConfig`) from this very module. It is not hand-maintained
 * and carries no independently-generated declarations to drift from the real
 * type — `config.ts` gets exactly the type this file's own validation logic
 * accepts, because it is that type. Refreshed unconditionally on every
 * startup (cheap, and the only way an upgrade's type changes reach a
 * checkout the user hasn't restarted); a write failure only costs editor
 * type-checking for config.ts; it must never block the daemon from starting. */
export function writeConfigTypesFile(configDir: string, version: string, log: Log): void {
  const target = path.join(configDir, CONFIG_TYPES_BASENAME);
  const content = [
    `// Generated by ccmsg v${version} at daemon startup.`,
    "// Do NOT edit — this file is overwritten every time the daemon starts,",
    "// and only re-exports the daemon's real config input type so it can never",
    "// drift from what the daemon actually accepts.",
    "//",
    "// Use from <configDir>/config.ts:",
    `//   import type { CcmsgConfig } from "./${CONFIG_TYPES_BASENAME}";`,
    "//   export default { ... } satisfies CcmsgConfig;",
    `export type { CcmsgConfig } from ${JSON.stringify(thisModulePath)};`,
    "",
  ].join("\n");
  try {
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(target, content);
  } catch (e) {
    warn(
      log,
      target,
      `could not write the generated config type declaration (${String(e)}); config.ts will type-check without CcmsgConfig`,
    );
  }
}

/** Evaluate `config.js` or `config.ts` and hand back its default export for
 * validation — the same code path for both, since Bun's ESM loader strips
 * `.ts` types before evaluating with no separate build step. A dynamic
 * `import()` (rather than `createRequire`) is what lets the default export be
 * a `Promise` and the module use top-level `await`: both are ordinary ESM
 * evaluation, not something a synchronous `require` can observe. Anything
 * that goes wrong — a syntax error, a module that throws, a rejected default
 * export, a missing or non-object default export — degrades to an empty
 * config with one warning, exactly as broken JSON does. Executing user
 * configuration is not a new exposure: this file already names the commands
 * the launcher runs. */
async function readJsConfig(file: string, log: Log): Promise<Record<string, unknown> | undefined> {
  let mod: { default?: unknown };
  try {
    mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
  } catch (e) {
    warn(log, file, `could not be loaded (${String(e)}); treating as empty`);
    return undefined;
  }
  let value = mod.default;
  if (isThenable(value)) {
    try {
      value = await value;
    } catch (e) {
      warn(log, file, `default export rejected (${String(e)}); treating as empty`);
      return undefined;
    }
  }
  if (value === undefined) {
    warn(log, file, "must `export default` an object (or a Promise of one); treating as empty");
    return undefined;
  }
  if (!isObject(value)) {
    warn(log, file, "default export must be an object (or a Promise of one); treating as empty");
    return undefined;
  }
  return value;
}

/** Read and parse `config.json`. */
function readJsonConfig(file: string, log: Log): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    warn(log, file, `unreadable (${String(e)}); treating as empty`);
    return undefined;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    warn(log, file, `invalid JSON (${String(e)}); treating as empty`);
    return undefined;
  }
  if (!isObject(parsed)) {
    warn(log, file, "top level must be a JSON object; treating as empty");
    return undefined;
  }
  return parsed;
}

/** Read daemon configuration once at startup (LN-Q4). Missing is the normal
 * unconfigured state; malformed content logs and collapses to an empty config.
 * Precedence is `config.ts` > `config.js` > `config.json` when more than one
 * is present — the same "the current location is authoritative, say so and
 * change nothing" rule that `migrateLegacyConfigFiles` applies to a leftover
 * copy, extended to three candidates instead of two. Async because config.js
 * / config.ts load through a dynamic `import()` (see `readJsConfig`), which
 * is the only way to let their default export be a `Promise` or the module
 * use top-level `await`; startup awaits this once and nothing downstream is
 * async. */
export async function loadConfig(files: ConfigFiles, log: Log): Promise<ResolvedCcmsgConfig> {
  const hasTs = fs.existsSync(files.configTs);
  const hasJs = !hasTs && fs.existsSync(files.configJs);
  const file = hasTs ? files.configTs : hasJs ? files.configJs : files.config;
  const ignored = [files.configTs, files.configJs, files.config].filter(
    (f) => f !== file && fs.existsSync(f),
  );
  if (ignored.length > 0) {
    warn(
      log,
      file,
      `${ignored.join(" and ")} ${ignored.length > 1 ? "are" : "is"} also present and being ignored (delete ${ignored.length > 1 ? "them" : "it"}, or delete ${file} to fall back)`,
    );
  }
  const parsed = hasTs || hasJs ? await readJsConfig(file, log) : readJsonConfig(file, log);
  if (parsed === undefined) return {};

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
  const llmStatusUrl = parseHttpUrl(parsed.llm_status_url, "llm_status_url", file, log);
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
  const cfg: ResolvedCcmsgConfig = {};
  if (sandboxOriginTemplate) cfg.sandbox_origin_template = sandboxOriginTemplate;
  if (sessionLauncher) cfg.session_launcher = sessionLauncher;
  if (terminalGatewayUrl) cfg.terminal_gateway_url = terminalGatewayUrl;
  if (llmUsageUrl) cfg.llm_usage_url = llmUsageUrl;
  if (llmStatsUrl) cfg.llm_stats_url = llmStatsUrl;
  if (llmStatusUrl) cfg.llm_status_url = llmStatusUrl;
  if (webhooks) cfg.webhooks = webhooks;
  return cfg;
}
