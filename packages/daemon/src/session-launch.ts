// DR-0018 session launch boundary: validate administrator-controlled roots and
// command selection, construct opaque env + explicit shell argv, then execute
// with bounded output capture and two-stage timeout termination.
import {
  ErrorCode,
  LAUNCHER_CWD_PARAM,
  type SessionLaunchRequest,
  type SessionLauncherConfig,
  type SessionLaunchResponse,
} from "@ccmsg/protocol";
import { containedInRoots } from "./launcher-paths.ts";

export type SessionLaunchValidation =
  | {
      ok: true;
      cwd: string;
      env: Record<string, string>;
      shellArgv: string[];
      cleanEnv: string[];
      keepEnv: string[];
    }
  | { ok: false; code: ErrorCode; msg: string };

type ValidatedSessionLaunch = Extract<SessionLaunchValidation, { ok: true }>;

const FORCE_KILL_GRACE_MS = 500;

/** After the direct child exits, wait at most this long for the stdout/stderr
 * pipes to reach EOF before returning what was captured so far. A launcher
 * command that backgrounds/detaches a grandchild (the DR-0018 template does
 * exactly this via `hyoui run --dettach`) can leave that grandchild holding
 * the inherited pipe write end, so EOF may never arrive — without this bound
 * the reply would stall until the grandchild dies. On a clean exit every fd
 * is closed at exit time, EOF races ahead of the timer, and this grace adds
 * zero latency. */
const PIPE_DRAIN_GRACE_MS = 500;

/** Accumulate a spawned pipe without `Response.text()` — that helper resolves
 * only at EOF, which an orphaned grandchild can postpone forever (see
 * PIPE_DRAIN_GRACE_MS). `finish` waits for EOF up to `graceMs`, then cancels
 * the reader and returns whatever bytes arrived. */
function collectStream(stream: ReadableStream<Uint8Array>): {
  finish: (graceMs: number) => Promise<string>;
} {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  const drained = (async () => {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  })();
  return {
    finish: async (graceMs: number): Promise<string> => {
      await Promise.race([
        drained.catch(() => {}),
        new Promise((resolve) => setTimeout(resolve, graceMs)),
      ]);
      await reader.cancel().catch(() => {});
      await drained.catch(() => {});
      return Buffer.concat(chunks).toString("utf-8");
    },
  };
}

export function shellArgv(shell: "bash" | "zsh", command: string): string[] {
  if (shell === "bash") return ["bash", "-eu", "-o", "pipefail", "-c", command];
  return ["zsh", "-e", "-u", "-o", "pipefail", "-c", command];
}

/** The transport environment variable that carries one parameter's value into
 * the launcher shell. Parameter names are shell identifiers (config.ts checks),
 * so the carrier is one too; the lowercase `ccmsg_new_session_param_` namespace
 * is what the shell erases from its environment before running the command, and
 * the prefix makes the mapping injective (no two parameters share a carrier). */
export function launchVarCarrier(name: string): string {
  return `ccmsg_new_session_param_${name}`;
}

/** Shell prologue that moves each launch value out of the environment and into
 * a plain (non-exported) shell variable, so nothing the command starts — the
 * claude session and its whole process tree — inherits it. Per parameter:
 *
 *   unset -v CWD; CWD="$ccmsg_new_session_param_CWD"; unset -v ccmsg_new_session_param_CWD
 *
 * The leading `unset -v` matters twice: it drops any same-named variable the
 * daemon itself inherited (which would otherwise survive as a stale export,
 * since the launch values no longer overwrite it), and it clears the export
 * attribute so the following assignment creates a shell-local variable.
 *
 * The prologue and the command run in *one* shell — a nested `bash -c` would
 * defeat the whole design, because non-exported variables do not cross into a
 * child shell and re-exporting them would put the values right back into the
 * environment we are trying to keep clean.
 *
 * Exactly the template's declared parameters are defined, each always defined
 * (empty rather than absent when neither request nor default supplies a value)
 * so a `set -u` command never aborts on a parameter the user left blank. Only
 * validated identifiers appear here; no request value is ever interpolated into
 * shell text, so the prologue cannot be injected through. */
export function launchPrecode(paramNames: string[]): string {
  return paramNames
    .map((name) => {
      const carrier = launchVarCarrier(name);
      return `unset -v ${name}; ${name}="$${carrier}"; unset -v ${carrier}`;
    })
    .join("\n");
}

/** Join prologue and command with a newline rather than `;` so a command that
 * opens with a comment or a shell keyword parses exactly as the administrator
 * wrote it. Exported for tests. */
export function launchShellProgram(paramNames: string[], command: string): string {
  return `${launchPrecode(paramNames)}\n${command}`;
}

export function validateSessionLaunch(
  cfg: SessionLauncherConfig | undefined,
  req: SessionLaunchRequest,
): SessionLaunchValidation {
  if (!cfg) {
    return {
      ok: false,
      code: ErrorCode.launcher_not_configured,
      msg: "session launcher is not configured",
    };
  }

  const cwd = containedInRoots(cfg.root_dirs, req.cwd, "session_launch cwd");
  if (!cwd.ok) return cwd;
  // DR-0018 §3.2 addendum (2026-07-17): user role may override the shell
  // command template. Absent = use config's command verbatim (previous
  // behavior). Present but empty = invalid_args (an empty template runs
  // nothing meaningful and would mask a client bug). Present and non-empty =
  // use it as-is; still no variable substitution, same env vars are exposed.
  // The user-role gate is enforced upstream in server.ts's session_launch
  // handler — session role never reaches this override at all.
  if (req.command !== undefined) {
    if (typeof req.command !== "string" || req.command === "") {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: "session_launch command override must be a non-empty string",
      };
    }
  }
  // Template selection: absent = the launcher's default recipe (templates[0],
  // which for a flat config is the only one). An unknown name is an error
  // rather than a fallback — launching a different recipe than the one the
  // client asked for would run the wrong command silently.
  const template =
    req.template === undefined
      ? cfg.templates[0]
      : cfg.templates.find((t) => t.name === req.template);
  if (!template) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: `session_launch template not found: ${String(req.template)}`,
    };
  }
  // Parameter values stay opaque strings: the UI may offer a curated dropdown
  // for MODEL or EFFORT, but daemon enums would couple every new launcher
  // choice to a daemon release, and a template is free to declare parameters
  // the daemon has never heard of. Values may be empty (a prompt-less launch is
  // a valid `claude` invocation). What IS checked is that every value belongs
  // to a parameter this template declares — a value nothing will read means
  // the client and the config disagree about what the form is.
  const params = req.params ?? {};
  if (!isPlainObject(params)) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "session_launch params must be an object",
    };
  }
  const declared = new Map(template.params.map((p) => [p.name, p.default]));
  for (const [name, value] of Object.entries(params)) {
    if (name === LAUNCHER_CWD_PARAM) {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: `session_launch ${LAUNCHER_CWD_PARAM} belongs in the request's cwd field, not params`,
      };
    }
    if (!declared.has(name)) {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: `session_launch params has an undeclared parameter for template ${template.name}: ${name}`,
      };
    }
    if (typeof value !== "string") {
      return {
        ok: false,
        code: ErrorCode.invalid_args,
        msg: `session_launch params.${name} must be a string`,
      };
    }
  }
  const command = req.command ?? template.command;

  // One carrier per declared parameter, in declaration order: the request's
  // value when it sent one, the configured default otherwise. CWD is the
  // containment-checked realpath rather than anything the request said about
  // it, so the command and the spawn always see the same directory.
  const env: Record<string, string> = {};
  for (const { name, default: fallback } of template.params) {
    const value = name === LAUNCHER_CWD_PARAM ? cwd.data.realPath : (params[name] ?? fallback);
    env[launchVarCarrier(name)] = value;
  }
  return {
    ok: true,
    cwd: cwd.data.realPath,
    env,
    shellArgv: shellArgv(
      template.shell,
      launchShellProgram(
        template.params.map((p) => p.name),
        command,
      ),
    ),
    cleanEnv: cfg.clean_env ?? [],
    keepEnv: cfg.keep_env ?? [],
  };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Compile one clean_env wildcard pattern (DR-0018 §3.1 addendum 2026-07-18)
 * into an anchored RegExp: every regex metacharacter is escaped first so only
 * `*` carries meaning (any substring of the key name), then anchored so a
 * pattern without `*` is an exact, case-sensitive key match. The `\*` → `.*`
 * rewrite cannot collide with an escaped literal backslash: escaping maps a
 * source `\` to `\\` and a source `*` to `\*`, so every `\*` digram in the
 * escaped text (scanning left-to-right in non-overlapping steps, exactly how
 * replaceAll matches) comes from a source `*`. */
function cleanEnvPatternToRegExp(pattern: string): RegExp {
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped.replaceAll("\\*", ".*")}$`);
}

/** Build the launcher shell's environment: daemon env minus clean_env matches
 * (except keys a keep_env pattern also matches — keep wins over clean, DR-0018
 * §3.1 addendum: a broad `CLAUDE*` clean must not remove CLAUDE_CONFIG_DIR),
 * with the launch's own `ccmsg_new_session_*` carriers layered on top
 * afterwards — so those four always win even if a pattern names them. The
 * carriers live only in this shell; `launchPrecode` unsets them before the
 * command runs. Exported for tests. */
export function buildLaunchEnv(
  baseEnv: Record<string, string | undefined>,
  cleanEnv: string[],
  launchEnv: Record<string, string>,
  keepEnv: string[] = [],
): Record<string, string | undefined> {
  const cleanRes = cleanEnv.map(cleanEnvPatternToRegExp);
  const keepRes = keepEnv.map(cleanEnvPatternToRegExp);
  const env: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (!keepRes.some((re) => re.test(key)) && cleanRes.some((re) => re.test(key))) continue;
    env[key] = value;
  }
  return { ...env, ...launchEnv };
}

/** Execute one validated launch and wait only for this child result. No pid is
 * retained after return and no restart/progress lifecycle is introduced. */
export async function executeSessionLaunch(
  launch: ValidatedSessionLaunch,
  timeoutSeconds: number,
): Promise<SessionLaunchResponse> {
  const proc = Bun.spawn(launch.shellArgv, {
    cwd: launch.cwd,
    env: buildLaunchEnv(process.env, launch.cleanEnv, launch.env, launch.keepEnv),
    stdout: "pipe",
    stderr: "pipe",
  });

  let timedOut = false;
  let settled = false;
  let forceKillTimer: ReturnType<typeof setTimeout> | undefined;
  const timeoutTimer = setTimeout(() => {
    if (settled || proc.exitCode !== null || proc.signalCode !== null) return;
    timedOut = true;
    proc.kill("SIGTERM");
    forceKillTimer = setTimeout(() => {
      if (settled || proc.exitCode !== null || proc.signalCode !== null) return;
      proc.kill("SIGKILL");
    }, FORCE_KILL_GRACE_MS);
  }, timeoutSeconds * 1000);

  const exited = proc.exited.then((code) => {
    settled = true;
    return code;
  });

  // Start draining both pipes before waiting for exit so output larger than a
  // pipe buffer cannot deadlock the child. After exit, wait only a bounded
  // grace for pipe EOF (see PIPE_DRAIN_GRACE_MS) — a detached grandchild
  // holding the write end must not stall the reply.
  const stdoutCollector = collectStream(proc.stdout);
  const stderrCollector = collectStream(proc.stderr);
  try {
    const exitCode = await exited;
    const [stdout, stderr] = await Promise.all([
      stdoutCollector.finish(PIPE_DRAIN_GRACE_MS),
      stderrCollector.finish(PIPE_DRAIN_GRACE_MS),
    ]);
    return {
      ok: true,
      stdout,
      stderr,
      exit_code: proc.signalCode === null ? exitCode : null,
      timed_out: timedOut,
    };
  } finally {
    settled = true;
    clearTimeout(timeoutTimer);
    if (forceKillTimer !== undefined) clearTimeout(forceKillTimer);
  }
}
