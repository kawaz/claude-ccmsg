// turn_abort (DR-0044): stop the turn a session's main loop is running now,
// by handing a `turn.abort` request to the hooks module of every live run of
// the session at once, and reading what they say into the op's one answer.
//
// Which runs a session has is sidecar-runs.ts's; the request and its reply go
// through sidecar-call.ts. What the module does is hooks/turn-abort.ts.
import { ErrorCode } from "@ccmsg/protocol";
import { callSidecar, type SidecarDeps } from "./sidecar-call.ts";
import type { SessionRunsView } from "./user-prompt.ts";

/** How long the daemon waits for the modules to answer `turn.abort`: the
 * write, then one `ccmsg sidecar reply` (about 0.3 s measured, DR-0035 §3) —
 * the bound request.override has. */
export const TURN_ABORT_DEADLINE_MS = 5_000;

export interface TurnAbortDeps extends SidecarDeps {
  deadlineMs: number;
  runs: SessionRunsView;
  /** Whether the daemon still counts `sid` among the running sessions. */
  isRunning(sid: string): boolean;
}

export function productionTurnAbortDeps(
  deps: SidecarDeps,
  runs: SessionRunsView,
  isRunning: (sid: string) => boolean,
): TurnAbortDeps {
  return { ...deps, deadlineMs: TURN_ABORT_DEADLINE_MS, runs, isRunning };
}

/** What became of the request at one run, for the daemon log. */
export interface TurnAbortTry {
  id: string;
  socket: string;
  result:
    | "unwritten"
    | "write_uncertain"
    | "unconfirmed"
    | "unreadable"
    | "aborted"
    | "no_turn"
    | "refused";
}

/** turn_abort's answer: stopped, or the error the op replies with. */
export type TurnAbortOutcome =
  | { ok: true }
  | {
      ok: false;
      code:
        | typeof ErrorCode.session_not_found
        | typeof ErrorCode.no_module
        | typeof ErrorCode.no_turn
        | typeof ErrorCode.abort_failed;
      msg: string;
    };

/** One run's try, and for a module's `refused` the engine's words, which
 * the reply carries. */
interface RunAnswer {
  attempt: TurnAbortTry;
  refusal?: string;
}

/** One run's try: the module's answer, or why there is none. */
async function tryRun(sid: string, socket: string, deps: TurnAbortDeps): Promise<RunAnswer> {
  const call = await callSidecar(socket, sid, "turn.abort", {}, deps.deadlineMs, deps);
  const { id } = call;
  if (call.write === "not_written") return { attempt: { id, socket, result: "unwritten" } };
  if (call.reply === undefined) {
    const result = call.write === "uncertain" ? "write_uncertain" : "unconfirmed";
    return { attempt: { id, socket, result } };
  }
  // A failure, or a result not of turn.abort's shape (a module of another
  // ccmsg), says nothing of the turn.
  if (!call.reply.ok || !call.reply.value.ok) {
    return { attempt: { id, socket, result: "unreadable" } };
  }
  const result = call.reply.value.result;
  if (result.outcome === "refused") {
    return { attempt: { id, socket, result: "refused" }, refusal: result.message };
  }
  return { attempt: { id, socket, result: result.outcome } };
}

/** Ask every live run of `sid` to stop its main loop's turn, all at once: a
 * session whose two runs both run a turn has both stopped, which is what
 * stopping the session's turn means. Stopped when one module says so. Else a
 * refusal or a missing answer is `abort_failed` (whether the turn stopped is
 * then not known, so it is not `no_turn`), and `no_turn` when every module
 * said it runs none. No run to write to is `no_module` for a session the
 * daemon counts as running, `session_not_found` for one it does not or whose
 * run moved to another id (/clear, /resume); no other route is tried
 * (DR-0039 §7). */
export async function abortTurn(
  sid: string,
  deps: TurnAbortDeps,
): Promise<{ outcome: TurnAbortOutcome; tries: TurnAbortTry[] }> {
  const answered = await Promise.all(
    deps.runs.liveOf(sid).map(({ socket }) => tryRun(sid, socket, deps)),
  );
  const tries = answered.map((a) => a.attempt);
  const outcome = (): TurnAbortOutcome => {
    if (tries.some((t) => t.result === "aborted")) return { ok: true };
    const [refusal] = answered.flatMap((a) => (a.refusal !== undefined ? [a.refusal] : []));
    if (refusal !== undefined) {
      return {
        ok: false,
        code: ErrorCode.abort_failed,
        msg: `the session refused to stop its turn: ${refusal}`,
      };
    }
    if (tries.some((t) => t.result !== "unwritten" && t.result !== "no_turn")) {
      return {
        ok: false,
        code: ErrorCode.abort_failed,
        msg: `no hooks module of session ${sid} answered within ${String(deps.deadlineMs / 1000)}s (a session started on an older plugin cannot be asked this); whether its turn stopped is not known`,
      };
    }
    if (tries.some((t) => t.result === "no_turn")) {
      return {
        ok: false,
        code: ErrorCode.no_turn,
        msg: `session ${sid} is running no turn (it had ended)`,
      };
    }
    if (deps.isRunning(sid) && !deps.runs.movedOn(sid)) {
      return {
        ok: false,
        code: ErrorCode.no_module,
        msg: `session ${sid} has no hooks module to stop its turn; stop it from its terminal (Esc)`,
      };
    }
    return { ok: false, code: ErrorCode.session_not_found, msg: `no running session ${sid}` };
  };
  return { outcome: outcome(), tries };
}
