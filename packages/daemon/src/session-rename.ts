// session_rename (DR-0047): rename a session by handing a `session.rename`
// request to the hooks module of every live run of the session at once; the
// module runs the built-in `/rename` with `$.command.run`. The modules'
// answers are read into the op's one answer.
//
// Which runs a session has is sidecar-runs.ts's; the request and its reply go
// through sidecar-call.ts. What the module does is hooks/session-rename.ts.
import { ErrorCode } from "@ccmsg/protocol";
import { callSidecar, type SidecarDeps } from "./sidecar-call.ts";
import type { SessionRunsView } from "./user-prompt.ts";

/** How long the daemon waits for the modules to answer `session.rename`:
 * the write, then the module's wait for `/rename` (RENAME_WAIT_MS, 2 s) and
 * its reply over `POST /op` (DR-0046). */
export const SESSION_RENAME_DEADLINE_MS = 5_000;

/** Title clamp: a session title shows up in the Sessions list's first line,
 * where anything longer is unreadable regardless of what the TUI would
 * accept. */
export const RENAME_TITLE_MAX_LEN = 200;

export type TitleValidation = { ok: true; title: string } | { ok: false; msg: string };

/** Validate + normalize a requested title before it is handed on.
 *
 * A title is one line the Sessions list shows: a newline or another control
 * character in it would end up in Claude Code's state file and break the
 * row. Rejecting is deliberate over stripping — silently renaming a session
 * to something the user did not type is worse than an error they can act
 * on. */
export function validateRenameTitle(raw: string): TitleValidation {
  const title = raw.trim();
  if (title === "") {
    return { ok: false, msg: "session_rename requires a non-empty title" };
  }
  if (title.length > RENAME_TITLE_MAX_LEN) {
    return {
      ok: false,
      msg: `session_rename title must be at most ${RENAME_TITLE_MAX_LEN} characters (got ${title.length}); shorten it`,
    };
  }
  // Scanned by code point rather than matched by regex: a control-character
  // class is exactly what the no-control-regex lint exists to catch, and the
  // predicate names the rule (C0 plus DEL) more plainly than an escape range.
  let hasControlChar = false;
  for (let i = 0; i < title.length; i++) {
    const code = title.charCodeAt(i);
    // Code units are enough here: every UTF-16 surrogate half is ≥ 0xd800, so
    // no astral character can be mistaken for a control character.
    if (code < 0x20 || code === 0x7f) {
      hasControlChar = true;
      break;
    }
  }
  if (hasControlChar) {
    return {
      ok: false,
      msg: "session_rename title must not contain control characters (newline, tab, escape); use a single-line title",
    };
  }
  return { ok: true, title };
}

export interface SessionRenameDeps extends SidecarDeps {
  deadlineMs: number;
  runs: SessionRunsView;
  /** Whether the daemon still counts `sid` among the running sessions. */
  isRunning(sid: string): boolean;
}

export function productionSessionRenameDeps(
  deps: SidecarDeps,
  runs: SessionRunsView,
  isRunning: (sid: string) => boolean,
): SessionRenameDeps {
  return { ...deps, deadlineMs: SESSION_RENAME_DEADLINE_MS, runs, isRunning };
}

/** What became of the request at one run, for the daemon log. */
export interface SessionRenameTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
    | "write_uncertain"
    | "unconfirmed"
    | "unreadable"
    | "renamed"
    | "queued"
    | "refused";
}

/** session_rename's answer: renamed or queued, or the error the op replies
 * with. */
export type SessionRenameOutcome =
  | { ok: true; outcome: "renamed" | "queued" }
  | {
      ok: false;
      code:
        | typeof ErrorCode.session_not_found
        | typeof ErrorCode.no_module
        | typeof ErrorCode.rename_failed;
      msg: string;
    };

/** One run's try, and for a module's `refused` the engine's words, which
 * the reply carries. */
interface RunAnswer {
  attempt: SessionRenameTry;
  refusal?: string;
}

/** One run's try: the module's answer, or why there is none. */
async function tryRun(
  sid: string,
  socket: string,
  name: string,
  deps: SessionRenameDeps,
): Promise<RunAnswer> {
  const call = await callSidecar(socket, sid, "session.rename", { name }, deps.deadlineMs, deps);
  const { id } = call;
  if (call.write === "not_written") return { attempt: { id, socket, result: "unwritten" } };
  if (call.reply === undefined) {
    const result = call.write === "uncertain" ? "write_uncertain" : "unconfirmed";
    return { attempt: { id, socket, result } };
  }
  // A failure, or a result not of session.rename's shape (a module of
  // another ccmsg), says nothing of the rename.
  if (!call.reply.ok || !call.reply.value.ok) {
    return { attempt: { id, socket, result: "unreadable" } };
  }
  const result = call.reply.value.result;
  if (result.outcome === "refused") {
    return { attempt: { id, socket, result: "refused" }, refusal: result.message };
  }
  return { attempt: { id, socket, result: result.outcome } };
}

/** Ask every live run of `sid` to rename the session to `title` (already
 * through validateRenameTitle), all at once. `renamed` when one module ran
 * `/rename`, else `queued` when one left it to the engine to run once the
 * session is idle. Else a refusal or a missing answer is `rename_failed`. No
 * run to write to is `no_module` for a session the daemon counts as running,
 * `session_not_found` for one it does not or whose run moved to another id
 * (/clear, /resume); no other route is tried (DR-0039 §7). */
export async function renameSession(
  sid: string,
  title: string,
  deps: SessionRenameDeps,
): Promise<{ outcome: SessionRenameOutcome; tries: SessionRenameTry[] }> {
  const answered = await Promise.all(
    deps.runs.liveOf(sid).map(({ socket }) => tryRun(sid, socket, title, deps)),
  );
  const tries = answered.map((a) => a.attempt);
  const outcome = (): SessionRenameOutcome => {
    if (tries.some((t) => t.result === "renamed")) return { ok: true, outcome: "renamed" };
    if (tries.some((t) => t.result === "queued")) return { ok: true, outcome: "queued" };
    const [refusal] = answered.flatMap((a) => (a.refusal !== undefined ? [a.refusal] : []));
    if (refusal !== undefined) {
      return {
        ok: false,
        code: ErrorCode.rename_failed,
        msg: `the session refused /rename: ${refusal}`,
      };
    }
    if (tries.some((t) => t.result !== "unwritten")) {
      return {
        ok: false,
        code: ErrorCode.rename_failed,
        msg: `no hooks module of session ${sid} answered within ${String(deps.deadlineMs / 1000)}s (a session started on an older plugin cannot be asked this); whether it will be renamed is not known`,
      };
    }
    if (deps.isRunning(sid) && !deps.runs.movedOn(sid)) {
      return {
        ok: false,
        code: ErrorCode.no_module,
        msg: `session ${sid} has no hooks module to rename it; rename it from its terminal (/rename)`,
      };
    }
    return { ok: false, code: ErrorCode.session_not_found, msg: `no running session ${sid}` };
  };
  return { outcome: outcome(), tries };
}
