// A btw's fork (DR-0060 §2): the daemon asks the hooks module of a live run of
// the session for `model.fork`, and the module answers with `$.model.fork`'s
// result — the main thread's last request with the btw's prompt after it, no
// tools, nothing written to the transcript. What this file owns is which run
// is asked, and what each way the request can end means for the btw: its
// answer, or the failure's words the person reads (what happened, and what to
// do next). The request and its reply go through sidecar-call.ts.
import type {
  LaunchEffort,
  ModelForkReason,
  ModelForkResult,
  ModelForkUsage,
} from "@ccmsg/protocol";
import { callSidecar, type SidecarDeps } from "./sidecar-call.ts";
import type { SessionRunsView } from "./user-prompt.ts";

/** How long a run's module has to say which ops it runs (`describe`: one
 * `ccmsg version`, about 0.3 s, and the reply). */
export const BTW_DESCRIBE_DEADLINE_MS = 5_000;

/** How long the daemon waits for a fork's answer: one completion, which a
 * long answer at a high effort can take minutes over. Past it the btw is
 * failed, and an answer that comes later is dropped. */
export const BTW_FORK_DEADLINE_MS = 15 * 60_000;

export interface BtwForkDeps extends SidecarDeps {
  runs: SessionRunsView;
  describeDeadlineMs: number;
  forkDeadlineMs: number;
}

/** How a btw's fork came out. `reason` is the word daemon.log gives a failure
 * (the engine's, or the daemon's own: `no_module`, `old_module`, ...);
 * `usage` and `effort` are what the module said the fork cost and ran at. */
export type BtwForkEnd =
  | { status: "done"; text: string; usage: ModelForkUsage; effort?: string }
  | { status: "failed"; reason: string; error: string; usage?: ModelForkUsage; effort?: string };

/** The words of a fork that gave no answer, as the engine said why. */
function notAnsweredError(
  reason: ModelForkReason,
  status: number | null | undefined,
  kind: string | undefined,
): string {
  switch (reason) {
    case "nothing-to-fork":
      return "本体がまだ 1 回も応答していないので聞けない (resume の直後や /clear の後)。本体に何か送ってからもう一度";
    case "api-error":
      return `API がエラーを返した (${status === null || status === undefined ? "応答なし" : `status ${String(status)}`}${kind !== undefined ? `, ${kind}` : ""})。少し待ってからもう一度`;
    case "empty-reply":
      return "答えに文が無かった (tool を使おうとしただけの応答など。btw は tool を使えない)。聞き方を変えてもう一度";
    case "aborted":
      return "fork が中断された。もう一度";
  }
}

/** A `model.fork` result as the btw's end. */
function endOf(result: ModelForkResult): BtwForkEnd {
  const effort = result.effort !== undefined ? { effort: result.effort } : {};
  if (result.outcome === "answered") {
    return { status: "done", text: result.text, usage: result.usage, ...effort };
  }
  return {
    status: "failed",
    reason: result.reason,
    error: notAnsweredError(result.reason, result.status, result.error),
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...effort,
  };
}

/** What one run's module says it can do for a btw. */
type RunAbility = "forks" | "old" | "silent";

async function abilityOf(sid: string, socket: string, deps: BtwForkDeps): Promise<RunAbility> {
  const call = await callSidecar(socket, sid, "describe", {}, deps.describeDeadlineMs, deps);
  if (call.write === "not_written" || call.reply === undefined) return "silent";
  if (!call.reply.ok || !call.reply.value.ok) return "silent";
  return call.reply.value.result.ops.includes("model.fork") ? "forks" : "old";
}

/** Ask a live run of `sid` to fork its main thread with `prompt` (the btw's
 * whole prompt, its prefix before it) at `effort` (absent for the session's
 * own level), and wait for the answer. The first run whose module says it
 * runs `model.fork` is asked; no other route is tried (a session without
 * such a module cannot be asked a btw). */
export async function askModelFork(
  sid: string,
  prompt: string,
  effort: LaunchEffort | undefined,
  deps: BtwForkDeps,
): Promise<BtwForkEnd> {
  const runs = deps.runs.liveOf(sid);
  if (runs.length === 0) {
    return deps.runs.movedOn(sid)
      ? {
          status: "failed",
          reason: "session_changed",
          error:
            "セッションが別の id に移った (/clear か /resume) ので聞けない。移った先のセッションで聞く",
        }
      : {
          status: "failed",
          reason: "no_module",
          error:
            "no_module: このセッションには ccmsg の hooks module が無いので btw を聞けない。ccmsg を読み込んだセッションで聞く",
        };
  }
  let old = false;
  for (const { socket } of runs) {
    const ability = await abilityOf(sid, socket, deps);
    if (ability === "old") old = true;
    if (ability !== "forks") continue;
    const args = { prompt, ...(effort !== undefined ? { effort } : {}) };
    const call = await callSidecar(socket, sid, "model.fork", args, deps.forkDeadlineMs, deps);
    if (call.write === "not_written") continue;
    if (call.reply === undefined) {
      return {
        status: "failed",
        reason: "timeout",
        error: `fork の答えが ${String(Math.round(deps.forkDeadlineMs / 60_000))} 分の内に返らなかった。もう一度`,
      };
    }
    if (!call.reply.ok) {
      return {
        status: "failed",
        reason: "unreadable",
        error: `module の答えが読めなかった (${call.reply.failure.summary})。セッションを再起動してからもう一度`,
      };
    }
    const reply = call.reply.value;
    if (!reply.ok) {
      return {
        status: "failed",
        reason: reply.error.code,
        error: `module で fork が失敗した: ${reply.error.message}`,
      };
    }
    return endOf(reply.result);
  }
  return old
    ? {
        status: "failed",
        reason: "old_module",
        error:
          "このセッションの ccmsg の module が古く、btw の fork を知らない。セッションを再起動すると聞けるようになる",
      }
    : {
        status: "failed",
        reason: "no_answer",
        error: `このセッションの ccmsg の module が ${String(deps.describeDeadlineMs / 1000)} 秒の内に答えなかった。少し待ってからもう一度`,
      };
}
