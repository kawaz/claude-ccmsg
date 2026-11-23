// A btw's fork (DR-0060 §1, §5): the daemon asks the hooks module of a live run of
// the session for `fork.ask`, and the module answers once a fork of the main
// conversation (a background subagent with the session's conversation, tools
// and model, whose report the module takes) ended. What this file owns is
// which run is asked, stopping the fork when the btw is stopped from here or
// runs out of time (`fork.stop`), and what each way the request can end means
// for the btw: its answer, or the failure's words the person reads (what
// happened, and what to do next). The requests and their replies go through
// sidecar-call.ts.
import type { ForkAskResult, ForkReason, ForkUsage } from "@ccmsg/protocol";
import { callSidecar, type SidecarDeps } from "./sidecar-call.ts";
import type { SessionRunsView } from "./user-prompt.ts";

/** How long a run's module has to say which ops it runs (`describe`: one
 * `ccmsg version`, about 0.3 s, and the reply), and to answer a `fork.stop`. */
export const BTW_DESCRIBE_DEADLINE_MS = 5_000;

/** How long the daemon waits for a fork's end: a run of the model with the
 * session's tools, which a long task with many tool calls can take a long
 * while over. The value is an estimate, not a measurement. Past it the fork
 * is stopped and the btw failed. */
export const BTW_FORK_DEADLINE_MS = 30 * 60_000;

export interface BtwForkDeps extends SidecarDeps {
  runs: SessionRunsView;
  describeDeadlineMs: number;
  forkDeadlineMs: number;
  log(msg: string): void;
}

/** How a btw's fork came out. `reason` is the word daemon.log gives a failure
 * (the module's, or the daemon's own: `no_module`, `old_module`, ...);
 * `usage` and `effort` are what the module said the fork cost and ran at. */
export type BtwForkEnd =
  | { status: "done"; text: string; usage?: ForkUsage; effort?: string }
  | { status: "failed"; reason: string; error: string; usage?: ForkUsage; effort?: string };

/** The words of a fork that gave no answer, as the module said why. */
function notAnsweredError(reason: ForkReason, message: string | undefined): string {
  switch (reason) {
    case "old_engine":
      return `このセッションの Claude Code (${message ?? "版は不明"}) は btw の fork を起こせない。Claude Code を 2.1.330 以降にすると聞けるようになる`;
    case "not_ready":
      return "本体が /compact か /clear の後まだ応答していないので聞けない。本体が次に応答した後にもう一度";
    case "denied":
      return `fork を起こせなかった (${message ?? "理由は不明"})。少し待ってからもう一度`;
    case "failed":
      return "fork が途中で失敗した。もう一度";
    case "stopped":
      return "fork がセッションの側で止められた。もう一度";
    case "empty":
      return "答えに文が無かった。聞き方を変えてもう一度";
  }
}

/** A `fork.ask` result as the btw's end. */
function endOf(result: ForkAskResult): BtwForkEnd {
  const extra = {
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
    ...(result.effort !== undefined ? { effort: result.effort } : {}),
  };
  if (result.outcome === "answered") return { status: "done", text: result.text, ...extra };
  return {
    status: "failed",
    reason: result.reason,
    error: notAnsweredError(result.reason, result.message),
    ...extra,
  };
}

/** What one run's module says it can do for a btw. */
type RunAbility = "forks" | "old" | "silent";

async function abilityOf(sid: string, socket: string, deps: BtwForkDeps): Promise<RunAbility> {
  const call = await callSidecar(socket, sid, "describe", {}, deps.describeDeadlineMs, deps);
  if (call.write === "not_written" || call.reply === undefined) return "silent";
  if (!call.reply.ok || !call.reply.value.ok) return "silent";
  return call.reply.value.result.ops.includes("fork.ask") ? "forks" : "old";
}

/** Stop the fork asked under `key` of the run behind `socket`, and log how
 * it went. Never rejects. */
async function stopFork(
  sid: string,
  socket: string,
  key: string,
  why: string,
  deps: BtwForkDeps,
): Promise<void> {
  const call = await callSidecar(socket, sid, "fork.stop", { key }, deps.describeDeadlineMs, deps);
  const outcome =
    call.write === "not_written"
      ? "not_written"
      : call.reply === undefined
        ? "no_answer"
        : !call.reply.ok
          ? "unreadable"
          : !call.reply.value.ok
            ? call.reply.value.error.code
            : call.reply.value.result.outcome;
  deps.log(`btw_fork_stop: session_id=${sid} key=${key} why=${why} outcome=${outcome}`);
}

/** Ask a live run of `sid` to fork its main conversation with `prompt` (the
 * btw's whole prompt, its prefix before it), and wait for the fork's end:
 * it runs on the session's model and effort. The first run whose
 * module says it runs `fork.ask` is asked; no other route is tried (a session
 * without such a module cannot be asked a btw). Once `stop` aborts, the fork
 * is stopped; what it ends with is the caller's to drop. */
export async function askBtwFork(
  sid: string,
  prompt: string,
  stop: AbortSignal,
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
    if (stop.aborted) return { status: "failed", reason: "canceled", error: "取り消した" };
    const key = deps.newId();
    const args = { key, prompt };
    const onStop = () => void stopFork(sid, socket, key, "canceled", deps);
    stop.addEventListener("abort", onStop, { once: true });
    const call = await callSidecar(socket, sid, "fork.ask", args, deps.forkDeadlineMs, deps);
    stop.removeEventListener("abort", onStop);
    if (call.write === "not_written") continue;
    if (call.reply === undefined) {
      if (!stop.aborted) void stopFork(sid, socket, key, "timeout", deps);
      return {
        status: "failed",
        reason: "timeout",
        error: `fork の答えが ${String(Math.round(deps.forkDeadlineMs / 60_000))} 分の内に返らなかった (fork は止めた)。もう一度`,
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
