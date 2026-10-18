// Daemon user configuration (DR-0018 §3.1).
//
// The DR presents the shape in YAML, but this daemon already persists user
// configuration as JSON (`allowed-origins.json`) and has no YAML dependency.
// `<configDir>/config.json` keeps that established zero-dependency convention.
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
// (LN-Q4, extended to "once, awaited if async") and its default export is read
// by the same schema as the JSON, so no key can mean something different
// depending on which file it came from.
//
// The configuration is read whole by one schema (DR-0038 §6): a file that does
// not read stops the daemon at startup with every reason, rather than starting
// with parts of it silently left out.
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  DEFAULT_DIR_TREE_DEPTH,
  DEFAULT_LAUNCH_TIMEOUT_SECONDS,
  errorText,
  jsonText,
  LAUNCHER_CWD_PARAM,
  parseWith,
  type LauncherParam,
  type Output,
  type ParseFailure,
} from "@ccmsg/protocol";
import * as v from "valibot";

/** The schema a launch request's `params` are read with, for one template:
 * one text field per declared parameter but CWD (which travels as the
 * request's `cwd`), each optional with its declared default. A name the
 * template does not declare fails the read. */
export type LaunchParamsSchema = v.StrictObjectSchema<
  Record<string, v.OptionalSchema<v.StringSchema<undefined>, string>>,
  undefined
>;

/** One named launch recipe in the parsed normal form of `session_launcher`.
 * Every field is fully resolved at parse time (an inherited `shell` and the
 * implicit CWD parameter are normalized here), so nothing downstream has to
 * re-apply fallbacks. Built by `launcherTemplate`, which derives `readParams`
 * from `params`.
 *
 * `command` is a shell program, not an argv: its vocabulary is the shell
 * variables this template declares in `params`, which the launcher shell
 * defines from the request before running this text. The daemon never
 * substitutes anything into it. */
export interface SessionLauncherTemplate {
  /** Non-empty, unique within one launcher config. Shown verbatim in the
   * webui's template picker and named by SessionLaunchRequest.template. */
  readonly name: string;
  readonly command: string;
  /** Declared parameters in config order; always contains LAUNCHER_CWD_PARAM. */
  readonly params: readonly LauncherParam[];
  readonly shell: "bash" | "zsh";
  /** `params` as the schema a launch request's values are read with. */
  readonly readParams: LaunchParamsSchema;
}

/** A template of these fields, with the schema of its launch values built
 * from its declaration once, here. */
export function launcherTemplate(
  fields: Omit<SessionLauncherTemplate, "readParams">,
): SessionLauncherTemplate {
  const entries = Object.fromEntries(
    fields.params
      .filter((param) => param.name !== LAUNCHER_CWD_PARAM)
      .map((param): [string, v.OptionalSchema<v.StringSchema<undefined>, string>] => [
        param.name,
        v.optional(v.string(), param.default),
      ]),
  );
  return { ...fields, readParams: v.strictObject(entries) };
}

/** Parsed normal form of `<configDir>/config.json`'s `session_launcher` key
 * (DR-0018 §3.1). Paths are home-expanded and absolute; shell is a deliberate
 * built-in choice so launch never falls through to an implicit `sh -c`.
 *
 * `templates` is always non-empty — a config that yields no usable template
 * disables the launcher entirely. `templates[0]` is the launcher's default
 * recipe. */
export interface SessionLauncherConfig {
  readonly root_dirs: readonly string[];
  readonly templates: readonly SessionLauncherTemplate[];
  readonly timeout_seconds: number;
  readonly dir_tree_depth: number;
  /** DR-0018 §3.1: wildcard patterns naming environment
   * variables to REMOVE from the daemon's own environment before a launched
   * child inherits it. The daemon itself is typically started from inside a
   * Claude session's shell, so its process.env carries that origin session's
   * variables (CLAUDE_CODE_SESSION_ID, CLAUDE_CODE_CHILD_SESSION, ANTHROPIC_*
   * …) which would silently reconfigure every launched session. `*` matches
   * any substring of a key name (no separator semantics); everything else is
   * literal, case-sensitive. Absent/empty = no cleaning.
   * The launcher's own `ccmsg_new_session_*` carriers (which the launcher
   * shell turns into the template variables) are layered on AFTER
   * cleaning, so they can never be removed by a pattern. */
  readonly clean_env?: readonly string[];
  /** DR-0018 §3.1: wildcard patterns naming
   * environment variables to KEEP even when a `clean_env` pattern matches
   * them — keep_env takes precedence over clean_env. Same pattern grammar as
   * clean_env (`*` = any substring, otherwise literal, case-sensitive,
   * anchored whole-key match). Motivation: a broad clean pattern like
   * `CLAUDE*` also removes CLAUDE_CONFIG_DIR, which the launched session
   * needs for config-plane isolation; the allowlist carves such exceptions
   * out of the broad removal. A key matching only keep_env (and no
   * clean_env pattern) is a no-op — it would have survived anyway. */
  readonly keep_env?: readonly string[];
}

function expandRoot(value: string): string {
  if (value === "~") return os.homedir();
  if (value.startsWith(`~${path.sep}`)) return path.join(os.homedir(), value.slice(2));
  return value;
}

/** An absolute URL, or undefined for text that is not one.
 * A pipe runs its checks on after one fails, so the checks below meet text
 * `v.url` has already refused. */
function urlOf(value: string): URL | undefined {
  return URL.canParse(value) ? new URL(value) : undefined;
}

/** An absolute http(s) URL, as written but trimmed. */
const HttpUrlSchema = v.pipe(
  v.string(),
  v.trim(),
  v.url("must be an absolute URL"),
  v.check(
    (value) => urlOf(value) === undefined || /^https?:$/.test(urlOf(value)?.protocol ?? ""),
    "must be http:// or https://",
  ),
);

/** sandbox origin テンプレート (DR-0030 §7.1)。URL としての妥当性は他の URL キーと
 * 共通だが、追加で「`{gid}` がホスト名部分にちょうど 1 個ある」ことを要求する —
 * grant ごとに origin が分かれることが本機能の前提なので、`{gid}` が path に
 * あっても全 grant が同一 origin に載って origin 分離が成立しない。 */
const SandboxOriginTemplateSchema = v.pipe(
  HttpUrlSchema,
  v.check(
    (value) => urlOf(value)?.hostname.split("{gid}").length === 2,
    "must contain exactly one {gid} in its hostname",
  ),
);

const ShellSchema = v.picklist(["bash", "zsh"]);

/** A parameter name has to be a shell identifier: the launcher shell defines it
 * with a fixed prologue (`NAME="$carrier"`), so anything else would be a syntax
 * error at launch instead of a config error at startup. */
const PARAM_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Shell identifiers a parameter may not be named: the names an object's
 * prototype answers to. A launch request's values are read by a schema built
 * from the declared names (`launcherTemplate`), and an object schema does not
 * read these keys. */
const RESERVED_PARAM_NAMES = ["__proto__", "constructor", "prototype"] as const;

/** Whether a declaration names a reserved parameter.
 *
 * Design rationale: this looks at the value before it is read, against the
 * rule that only a schema looks inside an unread value. valibot's record
 * passes over these three keys without a word, so after the read a declared
 * `constructor` would be gone rather than refused; the check has to run on the
 * value the record is given. It is a step of the params schema itself. */
function declaresReservedName(input: unknown): boolean {
  return (
    typeof input === "object" &&
    input !== null &&
    RESERVED_PARAM_NAMES.some((name) => Object.hasOwn(input, name))
  );
}

/** Parameter name → form default value, in declaration order (the order the
 * form renders). */
const LauncherParamsSchema = v.pipe(
  v.custom<Record<string, string>>(
    (input) => !declaresReservedName(input),
    `must not declare ${RESERVED_PARAM_NAMES.join(" / ")}`,
  ),
  v.record(v.pipe(v.string(), v.regex(PARAM_NAME_RE, "is not a shell identifier")), v.string()),
);

const LauncherTemplateSchema = v.strictObject({
  name: v.pipe(v.string(), v.nonEmpty("must be a non-empty string")),
  command: v.pipe(v.string(), v.nonEmpty("must be a non-empty string")),
  /** Absent: the launcher-level `shell`. */
  shell: v.optional(ShellSchema),
  /** The declaration is the only source of truth for which inputs the form
   * shows. */
  params: LauncherParamsSchema,
});

/** A root the launcher may start sessions under: absolute, or `~/…`. */
const RootDirSchema = v.pipe(
  v.string(),
  v.transform(expandRoot),
  v.check((value) => path.isAbsolute(value), "must be absolute or start with ~/"),
  v.transform((value) => path.resolve(value)),
);

const PositiveNumberSchema = v.pipe(v.number(), v.finite(), v.gtValue(0));
const EnvPatternsSchema = v.array(v.pipe(v.string(), v.nonEmpty("must be a non-empty string")));

/** Every template needs CWD (it is where the process runs), so a declaration
 * that omits it gets it first — the form then always has its directory picker
 * and the daemon always has a path to containment-check. */
function withCwdParam(params: readonly LauncherParam[]): readonly LauncherParam[] {
  if (params.some((p) => p.name === LAUNCHER_CWD_PARAM)) return params;
  return [{ name: LAUNCHER_CWD_PARAM, default: "" }, ...params];
}

/** `session_launcher`, read into its normal form: each template resolved in
 * full (its `shell` inherited from the launcher's, CWD declared), so nothing
 * downstream re-applies defaults. The schema of each template's launch values
 * is built from the read value afterwards (`resolveConfig`). */
const SessionLauncherSchema = v.pipe(
  v.strictObject({
    root_dirs: v.pipe(v.array(RootDirSchema), v.minLength(1, "must list at least one root")),
    /** Default for templates that omit their own `shell`. */
    shell: v.optional(ShellSchema, "bash"),
    timeout_seconds: v.optional(PositiveNumberSchema, DEFAULT_LAUNCH_TIMEOUT_SECONDS),
    dir_tree_depth: v.optional(PositiveNumberSchema, DEFAULT_DIR_TREE_DEPTH),
    clean_env: v.optional(EnvPatternsSchema, []),
    keep_env: v.optional(EnvPatternsSchema, []),
    templates: v.pipe(
      v.array(LauncherTemplateSchema),
      v.minLength(1, "must list at least one template"),
      v.check(
        (templates) => new Set(templates.map((t) => t.name)).size === templates.length,
        "template names must be unique",
      ),
    ),
  }),
  v.transform(({ templates, shell, ...rest }) => ({
    ...rest,
    templates: templates.map(
      (template): Omit<SessionLauncherTemplate, "readParams"> => ({
        name: template.name,
        command: template.command,
        params: withCwdParam(
          Object.entries(template.params).map(([name, value]) => ({ name, default: value })),
        ),
        shell: template.shell ?? shell,
      }),
    ),
  })),
);

/** 外部プロデューサからの `POST /webhook/<source>` 受け口 (webhook.ts)。source 名
 * → その source 専用の bearer token を置いたファイルパス。token 値をここに直書き
 * しないのは、config.json が token より緩い権限で置かれがちなため — 秘密は
 * ファイル側 (mode 600) に置き、config はその在り処だけを持つ。source 名を狭く
 * 縛るのは、この名前が URL path segment とそのまま対応するため。 */
const WebhooksSchema = v.record(
  v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/, "is not a source name ([a-z0-9-]{1,64})")),
  v.strictObject({
    /** bearer token を格納したファイル。先頭の `~` は展開する。 */
    token_file: v.pipe(
      v.string(),
      v.trim(),
      v.nonEmpty("must be a non-empty string"),
      v.transform(expandRoot),
    ),
  }),
);

/** The whole configuration, as an object. */
const CcmsgConfigObjectSchema = v.strictObject({
  session_launcher: v.optional(SessionLauncherSchema),
  /** Web gateway (hyoui) の base URL — SessionView の Terminal タブが
   * `${terminal_gateway_url}/sessions/<HYOUI_SESSION_ID>?embed=1` を iframe に
   * 埋める (issue 2026-07-21-webui-terminal-tab-embed)。未設定なら webui は
   * Terminal タブ自体を出さない。 */
  terminal_gateway_url: v.optional(HttpUrlSchema),
  /** LLM gateway の usage endpoint URL — webui の Usage 画面が `llm_usage` op
   * 経由でここの JSON を読む (endpoint が CORS ヘッダを返さないため browser
   * 直 fetch は不可、daemon が proxy する)。未設定なら webui は Usage メニュー
   * 自体を出さない。 */
  llm_usage_url: v.optional(HttpUrlSchema),
  /** LLM gateway の stats endpoint URL — webui の Usage 画面の使用量セクション
   * が `llm_stats` op 経由でここの JSON を読む。集計期間は op の `days` が query
   * parameter として上書きするので、ここには days を付けても付けなくてもよい。 */
  llm_stats_url: v.optional(HttpUrlSchema),
  /** LLM gateway の status endpoint URL (gateway 側 DR-0021) — webui の Usage
   * 画面の service status strip と topbar の badge が `llm_status` op 経由で
   * ここの JSON を読む。
   *
   * Design rationale: usage URL から `/usage` → `/status` を導出する案は採ら
   * ない。3 つの endpoint は「同じ gateway の隣り合う path」である保証がなく
   * (reverse proxy の path prefix / 別ホスト運用)、導出は operator が書いて
   * いない URL を daemon が組み立てて叩くことになる。加えて status を出せる
   * gateway かどうかは usage を出せるかと独立 (古い gateway は usage だけ
   * 返す) で、capability を独立に持てないと「押せば必ずエラー」の strip が
   * 出る。llm_usage_url / llm_stats_url が既に独立キーなのと同じ理由。 */
  llm_status_url: v.optional(HttpUrlSchema),
  /** LLM gateway の keepalive 停止 endpoint URL (`/llm-gateway/keepalive/pause`)
   * — webui のセッション行の停止操作が `llm_keepalive_pause` op 経由でここに
   * session_id を POST する。usage / stats / status と同じ理由で独立のキーに
   * し、URL を他から導かない。未設定なら webui は停止操作を出さない。 */
  llm_keepalive_pause_url: v.optional(HttpUrlSchema),
  webhooks: v.optional(WebhooksSchema),
  /** 非信頼コンテンツを配信する sandbox origin の URL テンプレート (DR-0030
   * §7.1)、例: `https://ccmsg-files-{gid}.host.example`。未設定なら sandbox
   * 配信そのものが無効になり、webui は導線を出さない。 */
  sandbox_origin_template: v.optional(SandboxOriginTemplateSchema),
});

/** The whole configuration. A JSON array is an object to valibot's object
 * schemas, so it is refused before them. */
export const CcmsgConfigSchema = v.pipe(
  v.custom<v.InferInput<typeof CcmsgConfigObjectSchema>>(
    (input) => !Array.isArray(input),
    "must be an object",
  ),
  CcmsgConfigObjectSchema,
);

type ReadConfig = Output<typeof CcmsgConfigSchema>;

/** The configuration as the daemon holds it (`Daemon.config`). */
export type ResolvedCcmsgConfig = Omit<ReadConfig, "session_launcher"> & {
  readonly session_launcher?: SessionLauncherConfig;
};

/** The read configuration with each launcher template's launch-value schema
 * built from its declaration. */
function resolveConfig({ session_launcher, ...rest }: ReadConfig): ResolvedCcmsgConfig {
  return session_launcher === undefined
    ? rest
    : {
        ...rest,
        session_launcher: {
          ...session_launcher,
          templates: session_launcher.templates.map(launcherTemplate),
        },
      };
}

/** The shape a hand-authored `config.ts` / `config.js` / `config.json` may
 * declare: what the schema reads, before its defaults and normalization.
 * `writeConfigTypesFile` re-exports this one, so a config.ts author
 * `satisfies`-checks against it. The rules a type cannot say (a URL's scheme,
 * unique template names, …) are still the schema's, and stop the daemon at
 * startup like any other. */
export type CcmsgConfig = v.InferInput<typeof CcmsgConfigSchema>;

interface Log {
  warn(msg: string): void;
}

function warn(log: Log, file: string, msg: string): void {
  log.warn(`config: ${file}: ${msg}`);
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

/** What reading the configuration came to: the configuration, or every reason
 * it does not read, one line each (the file, where in it, and what was
 * expected). */
export type ConfigLoad =
  | { readonly ok: true; readonly config: ResolvedCcmsgConfig }
  | { readonly ok: false; readonly errors: readonly string[] };

const CcmsgConfigTextSchema = jsonText(CcmsgConfigSchema);

/** A config module as `import()` hands it over: its default export is the
 * configuration (or a Promise of it), read by CcmsgConfigSchema once awaited. */
const ConfigModuleSchema = v.looseObject({ default: v.unknown() });

function failed(file: string, failure: ParseFailure): ConfigLoad {
  return {
    ok: false,
    errors: failure.issues.map(
      ({ path: at, message }) => `config: ${file}: ${at === "" ? "" : `${at}: `}${message}`,
    ),
  };
}

function refused(file: string, why: string): ConfigLoad {
  return { ok: false, errors: [`config: ${file}: ${why}`] };
}

/** A syntax error bun found building a module: what, and where in the file
 * (the line's text included). Bun's own object; the fields read are listed
 * and the rest let through. */
const BuildMessageSchema = v.looseObject({
  message: v.string(),
  position: v.looseObject({
    line: v.number(),
    column: v.number(),
    lineText: v.optional(v.string()),
  }),
});

/** Why `import()` of a config module failed. A module that does not parse is
 * answered with each syntax error at its line and column, followed by the
 * text of that line: bun throws one
 * BuildMessage for a single error, and for several an AggregateError whose
 * message only counts them. Anything else thrown is answered as it is. */
function notLoaded(file: string, e: unknown): ConfigLoad {
  const thrown: unknown = e instanceof AggregateError ? e.errors : [e];
  const built = parseWith(v.array(BuildMessageSchema), thrown);
  if (!built.ok || built.value.length === 0) {
    return refused(file, `could not be loaded (${errorText(e)})`);
  }
  return {
    ok: false,
    errors: built.value.map(
      ({ message, position: { line, column, lineText } }) =>
        `config: ${file}:${String(line)}:${String(column)}: could not be loaded (${message})` +
        (lineText !== undefined && lineText.trim() !== "" ? `: ${lineText.trim()}` : ""),
    ),
  };
}

/** Evaluate `config.js` or `config.ts` and read its default export — the same
 * code path for both, since Bun's ESM loader strips `.ts` types before
 * evaluating with no separate build step. A dynamic `import()` (rather than
 * `createRequire`) is what lets the default export be a `Promise` and the
 * module use top-level `await`: both are ordinary ESM evaluation, not something
 * a synchronous `require` can observe. Executing user configuration is not a
 * new exposure: this file already names the commands the launcher runs. */
async function readJsConfig(file: string): Promise<ConfigLoad> {
  let loaded: unknown;
  try {
    loaded = await import(pathToFileURL(file).href);
  } catch (e) {
    return notLoaded(file, e);
  }
  const mod = parseWith(ConfigModuleSchema, loaded);
  if (!mod.ok) return refused(file, "must `export default` an object (or a Promise of one)");
  let value: unknown;
  try {
    value = await mod.value.default;
  } catch (e) {
    return refused(file, `default export rejected (${errorText(e)})`);
  }
  const config = parseWith(CcmsgConfigSchema, value);
  return config.ok
    ? { ok: true, config: resolveConfig(config.value) }
    : failed(file, config.failure);
}

/** Read `config.json`. A missing file is the unconfigured state. */
function readJsonConfig(file: string): ConfigLoad {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (e instanceof Error && "code" in e && e.code === "ENOENT") return { ok: true, config: {} };
    return refused(file, `unreadable (${errorText(e)})`);
  }
  const config = parseWith(CcmsgConfigTextSchema, text);
  return config.ok
    ? { ok: true, config: resolveConfig(config.value) }
    : failed(file, config.failure);
}

/** Read daemon configuration once at startup (LN-Q4). Missing is the normal
 * unconfigured state; a file that does not read is answered with why, and the
 * daemon does not start. Precedence is `config.ts` > `config.js` >
 * `config.json` when more than one is present — the same "the current location
 * is authoritative, say so and change nothing" rule that
 * `migrateLegacyConfigFiles` applies to a leftover copy, extended to three
 * candidates instead of two. Async because config.js / config.ts load through
 * a dynamic `import()` (see `readJsConfig`), which is the only way to let their
 * default export be a `Promise` or the module use top-level `await`; startup
 * awaits this once and nothing downstream is async. */
export async function loadConfig(files: ConfigFiles, log: Log): Promise<ConfigLoad> {
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
  return hasTs || hasJs ? await readJsConfig(file) : readJsonConfig(file);
}
