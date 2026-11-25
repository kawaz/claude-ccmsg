// The terminal this run presses keys on (DR-0035 §3): the hyoui terminal
// HYOUI_SESSION_ID names, once it is checked to be the one this claude runs
// in. The variable is passed down to every child, so a claude started from
// another session's Bash carries that session's terminal; the check keeps the
// keys of a prompt.send off it.
//
// The check asks whether this claude is the terminal's child (hyoui's
// status): the child is the session leader whose controlling terminal is the
// terminal's PTY. The claude's pid is the parent pid of a shell the module
// runs (the engine starts the child under the claude, measured on 2.1.332),
// which the shell prints without running anything else.
//
// Design rationale: the pids, not the process groups. A process group would
// also take a claude that a wrapper runs without exec, but reading one needs
// `ps`, which is setuid on macOS, and sandbox-exec refuses to run a setuid
// program: a session wrapped in sandbox-exec could not check at all
// (docs/findings/2026-11-25-prompt-send-enter-terminal-check.md). So a
// wrapper must exec claude for the session to have a terminal.
//
// A terminal that is not this claude's counts as none: the run is named to
// the daemon without a terminal, and prompt.send answers `no_terminal`. What
// the check found out is kept for the run, since neither pid changes while
// the processes live: the terminal is this claude's, or it is not (another
// child, or a child that has exited). A check that could not read either pid
// (hyoui or the shell failing, timing out, printing what does not read) finds
// out nothing: the run has no terminal for now, and the next prompt.send or
// sidecar start checks again (sidecar.ts names the terminal once a later
// check finds it).
import * as v from "valibot";
import { errorText, jsonText, parseWith } from "@ccmsg/protocol/parse";
import type { Engine } from "./engine.ts";

/** Budget for each of the two commands of the check, which run side by
 * side. Through `$.process.run`, `hyoui status` took 66 to 74 ms and the
 * shell 15 to 24 ms
 * (docs/findings/2026-11-25-prompt-send-enter-terminal-check.md), so this is
 * about 7 times the slowest seen. A check made again inside a prompt.send
 * adds this to its run, which for a bash mode command leaves 1 s to the
 * daemon's 12 s deadline (prompt-send.ts HYOUI_TIMEOUT_MS). */
export const TERMINAL_CHECK_TIMEOUT_MS = 500;

/** The terminal of this run, as checked. */
export interface TerminalState {
  /** What a check found out, kept for the run: the hyoui session id when the
   * terminal is this claude's, undefined when the run has none (no
   * HYOUI_SESSION_ID, or a terminal that is not this claude's). Absent until
   * a check finds out. */
  checked?: { terminal: string | undefined };
  /** The check running now, which a caller meanwhile waits for rather than
   * starting another. */
  checking?: Promise<string | undefined>;
}

/** What one check says. */
type Check = { kind: "found"; terminal: string | undefined } | { kind: "unread" };

/** hyoui's status of a terminal, as far as the check reads it: the pid of
 * its child, absent once the child has exited, and the child's state. */
const HyouiStatusTextSchema = jsonText(
  v.looseObject({
    child_pid: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1))),
    child_state: v.optional(v.string()),
  }),
);

/** The shell's output: one pid and a newline. */
const PidTextSchema = v.pipe(v.string(), v.trim(), v.regex(/^[1-9]\d*$/), v.transform(Number));

/** `hyoui status` of the terminal `hyouiSessionId`, as JSON. */
export function hyouiStatusArgv(hyouiSessionId: string): string[] {
  return ["hyoui", "status", hyouiSessionId, "--format", "json"];
}

/** The pid of the claude: the parent of a shell the module runs, which the
 * shell prints itself (`echo` is built in, so nothing else runs). */
export const PARENT_PID_ARGV: readonly string[] = ["/bin/sh", "-c", "echo $PPID"];

/** The terminal this run presses keys on: what a check found out, or a
 * check now when none has. */
export function ownTerminal($: Engine, state: TerminalState): Promise<string | undefined> {
  if (state.checked !== undefined) return Promise.resolve(state.checked.terminal);
  state.checking ??= checkTerminal($).then((check) => {
    state.checking = undefined;
    if (check.kind === "unread") return undefined;
    state.checked = { terminal: check.terminal };
    return check.terminal;
  });
  return state.checking;
}

/** The output of `argv` when it exits 0, otherwise why not. */
async function outputOf(
  $: Engine,
  argv: readonly string[],
): Promise<{ ok: true; stdout: string } | { ok: false; why: string }> {
  try {
    const run = await $.process.run(argv, { timeoutMs: TERMINAL_CHECK_TIMEOUT_MS });
    if (run.exitCode === 0) return { ok: true, stdout: run.stdout };
    return { ok: false, why: `exited ${String(run.exitCode)}: ${run.stderr.trim()}` };
  } catch (e) {
    return { ok: false, why: errorText(e) };
  }
}

/** Log why the terminal `hyouiSessionId` is not taken as this run's: `found`
 * when it is known not to be, `unread` when this check could not tell. */
function notTaken($: Engine, hyouiSessionId: string, kind: Check["kind"], why: string): Check {
  const now = kind === "found" ? "is not this session's" : "is not taken as this session's for now";
  $.ui.log(`ccmsg: terminal ${hyouiSessionId} ${now}: ${why}`, { to: "debug" });
  return kind === "found" ? { kind, terminal: undefined } : { kind };
}

/** Whether HYOUI_SESSION_ID names the terminal this claude runs in; why not
 * goes to the debug log. */
async function checkTerminal($: Engine): Promise<Check> {
  const hyouiSessionId = await $.env.get("HYOUI_SESSION_ID");
  if (!hyouiSessionId) return { kind: "found", terminal: undefined };
  const [status, parent] = await Promise.all([
    outputOf($, hyouiStatusArgv(hyouiSessionId)),
    outputOf($, PARENT_PID_ARGV),
  ]);
  if (!status.ok) return notTaken($, hyouiSessionId, "unread", `hyoui status ${status.why}`);
  if (!parent.ok) return notTaken($, hyouiSessionId, "unread", `the shell ${parent.why}`);
  const terminal = parseWith(HyouiStatusTextSchema, status.stdout);
  if (!terminal.ok) {
    const why = `hyoui status unreadable: ${terminal.failure.summary}`;
    return notTaken($, hyouiSessionId, "unread", why);
  }
  const claude = parseWith(PidTextSchema, parent.stdout);
  if (!claude.ok) {
    const why = `the shell's parent pid unreadable: ${claude.failure.summary}`;
    return notTaken($, hyouiSessionId, "unread", why);
  }
  // A terminal whose child has exited is not this claude's, which is alive,
  // and it gets no child back.
  if (terminal.value.child_state === "exited") {
    return notTaken($, hyouiSessionId, "found", "its child has exited");
  }
  const child = terminal.value.child_pid;
  if (child === undefined) {
    return notTaken($, hyouiSessionId, "unread", "hyoui status gives no child pid");
  }
  if (child !== claude.value) {
    const why = `its child is pid ${String(child)}, this claude is pid ${String(claude.value)}`;
    return notTaken($, hyouiSessionId, "found", why);
  }
  return { kind: "found", terminal: hyouiSessionId };
}
