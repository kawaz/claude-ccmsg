// claude_update (DR-0043 §6): run `claude update` with the daemon's PATH, then
// read the version back from `claude --version`. The update's own output is
// for people and is not read: the version comes from `--version` alone.
// Pure logic split out of server.ts with the external effects injectable,
// the same division of labor as session-kill.ts.
import { ErrorCode } from "@ccmsg/protocol";

/** How long one claude_update may run, `claude update` and `claude --version`
 * together, before it is stopped and answered with claude_update_timeout.
 * The native binary is 264 MB (DR-0043 Context); see DR-0043 §6 for the
 * measured run this bounds. */
export const CLAUDE_UPDATE_TIMEOUT_MS = 300_000;

/** How much of a failing command's stderr goes into the msg: the last
 * non-empty lines, each clipped, so the webui can show it under the version
 * without the full installer log. */
const GIST_LINES = 2;
const GIST_LINE_CHARS = 160;

/** A version as `claude --version` starts its line with ("2.1.312"), with an
 * optional pre-release or build suffix. */
const VERSION_WORD = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;

/** How one command ended: its exit code and output, or that it was stopped
 * at the deadline. */
export type CommandRun =
  | { kind: "exited"; code: number; stdout: string; stderr: string }
  | { kind: "timed_out" };

export interface ClaudeUpdateDeps {
  /** The `claude` the daemon's PATH names, or null when it names none. */
  which(): string | null;
  /** Run `argv` with stdin closed, stopping it once `deadline` (epoch ms)
   * passes. */
  run(argv: readonly string[], deadline: number): Promise<CommandRun>;
  now(): number;
}

export interface ClaudeUpdateFailure {
  ok: false;
  code: ErrorCode;
  msg: string;
  /** `claude update`'s exit code when it ran to an end. */
  exitCode?: number;
}

export type ClaudeUpdateOutcome =
  | { ok: true; version: string; observedAt: number }
  | ClaudeUpdateFailure;

/** The last non-empty lines of `text`, each clipped, joined by a newline. */
export function outputGist(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line !== "")
    .slice(-GIST_LINES)
    .map((line) => (line.length > GIST_LINE_CHARS ? `${line.slice(0, GIST_LINE_CHARS)}…` : line))
    .join("\n");
}

/** The first word of `claude --version`'s output when it is a version
 * (`2.1.312 (Claude Code)` → `2.1.312`), else null. */
export function versionWord(stdout: string): string | null {
  const first = stdout.trim().split(/\s+/)[0] ?? "";
  return VERSION_WORD.test(first) ? first : null;
}

function timedOut(what: string): ClaudeUpdateFailure {
  return {
    ok: false,
    code: ErrorCode.claude_update_timeout,
    msg: `${what} did not finish within ${CLAUDE_UPDATE_TIMEOUT_MS / 1000} s and was stopped`,
  };
}

/** Update this host's Claude Code and read its version back. */
export async function runClaudeUpdate(deps: ClaudeUpdateDeps): Promise<ClaudeUpdateOutcome> {
  const claude = deps.which();
  if (claude === null) {
    return {
      ok: false,
      code: ErrorCode.claude_not_found,
      msg: "claude is not on the daemon's PATH",
    };
  }
  const deadline = deps.now() + CLAUDE_UPDATE_TIMEOUT_MS;
  const update = await deps.run([claude, "update"], deadline);
  if (update.kind === "timed_out") return timedOut("claude update");
  if (update.code !== 0) {
    const gist = outputGist(update.stderr);
    return {
      ok: false,
      code: ErrorCode.claude_update_failed,
      msg: `claude update exited ${update.code}${gist !== "" ? `: ${gist}` : ""}`,
      exitCode: update.code,
    };
  }
  const read = await deps.run([claude, "--version"], deadline);
  if (read.kind === "timed_out") return { ...timedOut("claude --version"), exitCode: 0 };
  const version = read.code === 0 ? versionWord(read.stdout) : null;
  if (version === null) {
    const gist = read.code !== 0 ? outputGist(read.stderr) : outputGist(read.stdout).split("\n")[0];
    return {
      ok: false,
      code: ErrorCode.claude_version_unreadable,
      msg: `claude --version ${read.code !== 0 ? `exited ${read.code}` : "named no version"}${gist ? `: ${gist}` : ""}`,
      exitCode: 0,
    };
  }
  return { ok: true, version, observedAt: deps.now() };
}

/** Send SIGKILL to the process group led by `pid`. A group that is already
 * gone is nothing to stop. */
function killGroup(pid: number): void {
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    // ESRCH: every member has exited.
  }
}

/** The real host: `Bun.which` over the daemon's PATH, and a child in its own
 * process group (setsid) whose output is drained concurrently (a child
 * writing past a pipe's buffer to an unread stream would block forever, as
 * session-kill.ts's runCommand notes). At the deadline the whole group is
 * killed: a process the command started keeps its pipes open, and the reads
 * would otherwise wait for it after the command itself is gone. */
export function productionClaudeUpdateDeps(
  env: Readonly<Record<string, string | undefined>>,
): ClaudeUpdateDeps {
  return {
    which: () => Bun.which("claude", { PATH: env.PATH ?? "" }),
    run: async (argv, deadline) => {
      const proc = Bun.spawn([...argv], {
        env: { ...env },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        detached: true,
      });
      let exited = false;
      let timedOut = false;
      const timer = setTimeout(
        () => {
          timedOut = !exited;
          killGroup(proc.pid);
        },
        Math.max(0, deadline - Date.now()),
      );
      try {
        const [code, stdout, stderr] = await Promise.all([
          proc.exited.then((c) => {
            exited = true;
            return c;
          }),
          new Response(proc.stdout).text(),
          new Response(proc.stderr).text(),
        ]);
        return timedOut ? { kind: "timed_out" } : { kind: "exited", code, stdout, stderr };
      } finally {
        clearTimeout(timer);
      }
    },
    now: () => Date.now(),
  };
}
