// `fork.ask` and `fork.stop` (DR-0060 §2): the daemon asks a btw of the
// session, and the module answers it with a fork of the main conversation —
// `$.agent.spawn({ subagentType: "fork" })`, a background subagent that starts
// from the conversation, its tools and model, and reads the session's prompt
// cache. The fork's report is taken here (`agent.report`, `{ consumed }`), so
// the main conversation is told nothing and waits for nothing; what the fork
// cost comes with its `turn.complete`. It runs on the session's model and
// effort (a fork takes neither); the level its first request went at is
// kept for the answer's record. `fork.stop` stops one as the TaskStop tool
// stops a background agent.
//
// After `/compact` or `/clear`, until the main thread sends its next request,
// no fork is started (`not_ready`): measured on 2.1.330, a fork then wrote
// the prompt cache anew and had the session's instructions put after its
// prompt, and one in three lost the btw's prompt
// (2026-11-23-btw-via-agent-fork §8).
//
// The forks are known by the agent id the spawn resolves with. A fork's first
// events can come before that (its turn.start, its first turn.step): a hook
// that meets an agent it does not know while a spawn of this module is in
// flight waits for the spawn before it decides.
import * as v from "valibot";
import { errorText, type Output, parseWith } from "@ccmsg/protocol/parse";
import {
  type ForkAskArgs,
  type ForkAskResult,
  type ForkEffort,
  ForkEffortSchema,
  type ForkStopArgs,
  type ForkStopResult,
  type ForkUsage,
  ForkUsageSchema,
} from "@ccmsg/protocol/sidecar";
import type { Engine, ReportTaken } from "./engine.ts";

/** What a btw's fork shows as among the session's agents. */
export const FORK_DESCRIPTION = "ccmsg btw";

/** The first Claude Code whose `$.agent.spawn` forks the main conversation
 * for a plugin (`subagentType: "fork"`) and raises `agent.report`. */
export const FORK_ENGINE_SINCE = [2, 1, 330] as const;

/** How long a fork's end waits, once its report came, for its turn.complete
 * (what it cost): on 2.1.330 the turn.complete came just before the report
 * each time it was measured. Past it the answer goes back without its usage. */
export const FORK_TURN_WAIT_MS = 2_000;

/** How a fork's run ended, as its report says. */
const ForkReportSchema = v.object({
  status: v.picklist(["completed", "failed", "stopped"]),
  text: v.string(),
});
type ForkReport = Output<typeof ForkReportSchema>;

/** agent.report's input, as far as the module reads it. */
export const AgentReportInputSchema = v.looseObject({
  agentId: v.string(),
  ...ForkReportSchema.entries,
});

/** turn.complete's input for a fork: the loop it ran in and what it cost. A
 * usage that does not read is left out rather than failing the event. */
export const ForkTurnInputSchema = v.looseObject({
  agentId: v.optional(v.string()),
  usage: v.fallback(v.optional(ForkUsageSchema), undefined),
});

/** turn.step's input for a fork: the loop the request is made in, and the
 * effort the engine resolved for it (a number on internal builds alone). */
export const ForkStepInputSchema = v.looseObject({
  agentId: v.optional(v.string()),
  effort: v.optional(v.union([ForkEffortSchema, v.number()])),
});

/** One fork of this load, while it runs. */
interface Fork {
  /** The effort its first request went at, as a level. */
  ranAt?: ForkEffort;
  /** What its turn cost, once its turn.complete came. */
  turn?: { usage?: ForkUsage };
  /** Its report, once it came. */
  report?: ForkReport;
  /** Waits for the turn.complete after the report. */
  wait?: { cancel(): void };
  /** Resolved with the report once the fork ended. */
  ended: PromiseWithResolvers<ForkReport>;
}

/** The forks this load started and the spawns it has in flight. */
export interface ForkState {
  forks: {
    /** The running forks, by agent id. */
    byAgent: Map<string, Fork>;
    /** Each fork the daemon asked for and is not answered yet, by its key:
     * its agent id once it started, and whether a stop came before that. */
    byKey: Map<string, { agentId?: string; isStopAsked: boolean }>;
    /** The spawns of this module not yet resolved. */
    spawning: Set<Promise<unknown>>;
    /** Whether the main conversation was compacted or cleared and has sent
     * no request since. */
    isNotReady: boolean;
  };
}

export function newForkState(): ForkState {
  return {
    forks: { byAgent: new Map(), byKey: new Map(), spawning: new Set(), isNotReady: false },
  };
}

/** Whether the engine named by `spelled` (`2.1.330`, `2.1.330-dev`) forks
 * the main conversation for a plugin. */
export function forksForPlugins(spelled: string): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(spelled);
  if (match === null) return false;
  const parts = [match[1], match[2], match[3]].map(Number);
  for (const [i, since] of FORK_ENGINE_SINCE.entries()) {
    const part = parts[i] ?? 0;
    if (part !== since) return part > since;
  }
  return true;
}

/** The fork running under `agentId`; when there is none, once the spawns in
 * flight have resolved, so a fork whose event beat its spawn's answer is
 * still found. */
async function forkOf(state: ForkState, agentId: string): Promise<Fork | undefined> {
  const known = state.forks.byAgent.get(agentId);
  if (known !== undefined || state.forks.spawning.size === 0) return known;
  await Promise.allSettled(state.forks.spawning);
  return state.forks.byAgent.get(agentId);
}

function settle(fork: Fork, report: ForkReport): void {
  fork.wait?.cancel();
  fork.ended.resolve(report);
}

/** What the fork came to, from its report and what its turn cost. */
function resultOf(fork: Fork, report: ForkReport): ForkAskResult {
  const extra = {
    ...(fork.turn?.usage !== undefined ? { usage: fork.turn.usage } : {}),
    ...(fork.ranAt !== undefined ? { effort: fork.ranAt } : {}),
  };
  switch (report.status) {
    case "completed":
      return report.text.trim() !== ""
        ? { outcome: "answered", text: report.text, ...extra }
        : { outcome: "not_answered", reason: "empty", ...extra };
    case "failed":
      return {
        outcome: "not_answered",
        reason: "failed",
        ...(report.text.trim() !== "" ? { message: report.text } : {}),
        ...extra,
      };
    case "stopped":
      return { outcome: "not_answered", reason: "stopped", ...extra };
  }
}

/** fork.ask: fork the main conversation with `args.prompt`, and answer once
 * the fork ended. A stop that came while the spawn was in flight stops the
 * fork once it started. */
export async function askFork(
  $: Engine,
  state: ForkState,
  args: ForkAskArgs,
): Promise<ForkAskResult> {
  const asked: { agentId?: string; isStopAsked: boolean } = { isStopAsked: false };
  state.forks.byKey.set(args.key, asked);
  try {
    return await runFork($, state, args, asked);
  } finally {
    state.forks.byKey.delete(args.key);
    if (asked.agentId !== undefined) state.forks.byAgent.delete(asked.agentId);
  }
}

async function runFork(
  $: Engine,
  state: ForkState,
  args: ForkAskArgs,
  asked: { agentId?: string; isStopAsked: boolean },
): Promise<ForkAskResult> {
  const engine = await $.session.version();
  if (!forksForPlugins(engine.base ?? engine.version)) {
    return { outcome: "not_answered", reason: "old_engine", message: engine.version };
  }
  if (state.forks.isNotReady) {
    return {
      outcome: "not_answered",
      reason: "not_ready",
      message: "the main conversation has sent no request since /compact or /clear",
    };
  }
  if (asked.isStopAsked) return { outcome: "not_answered", reason: "stopped" };
  const spawning = $.agent.spawn({
    subagentType: "fork",
    prompt: args.prompt,
    description: FORK_DESCRIPTION,
  });
  state.forks.spawning.add(spawning);
  let spawned: Awaited<typeof spawning>;
  try {
    spawned = await spawning;
  } finally {
    state.forks.spawning.delete(spawning);
  }
  if (spawned.deny !== undefined) {
    return { outcome: "not_answered", reason: "denied", message: spawned.deny };
  }
  const { agentId } = spawned;
  if (agentId === undefined) {
    return { outcome: "not_answered", reason: "denied", message: "no agent was started" };
  }
  const fork: Fork = { ended: Promise.withResolvers<ForkReport>() };
  state.forks.byAgent.set(agentId, fork);
  asked.agentId = agentId;
  if (asked.isStopAsked) {
    stopAgent($, agentId).then(
      (stopped) =>
        $.ui.log(`ccmsg: fork ${agentId} stopped as asked: ${stopped.outcome}`, { to: "debug" }),
      (e: unknown) =>
        $.ui.log(`ccmsg: fork ${agentId} not stopped: ${errorText(e)}`, { to: "debug" }),
    );
  }
  return resultOf(fork, await fork.ended.promise);
}

/** Stop the agent `agentId` with the TaskStop tool, as the main
 * conversation's own call. */
async function stopAgent($: Engine, agentId: string): Promise<ForkStopResult> {
  const stopped = await $.agent.call({ tool: "TaskStop", input: { task_id: agentId } });
  if (stopped.deny !== undefined) return { outcome: "refused", message: stopped.deny };
  if (stopped.isError === true) return { outcome: "refused", message: stopped.text ?? "" };
  return { outcome: "stopped" };
}

/** fork.stop: stop the fork the daemon asked under `args.key`; one whose
 * spawn is still in flight is stopped once it started. */
export async function stopFork(
  $: Engine,
  state: ForkState,
  args: ForkStopArgs,
): Promise<ForkStopResult> {
  const asked = state.forks.byKey.get(args.key);
  if (asked === undefined) return { outcome: "not_running" };
  asked.isStopAsked = true;
  if (asked.agentId === undefined) return { outcome: "stopped" };
  return stopAgent($, asked.agentId);
}

/** A request goes out: a fork's first one's effort level is kept, and the
 * main thread's makes the conversation ready for a fork again. */
export async function forkStepRequested(
  state: ForkState,
  input: Output<typeof ForkStepInputSchema>,
): Promise<void> {
  if (input.agentId === undefined) {
    state.forks.isNotReady = false;
    return;
  }
  const fork = await forkOf(state, input.agentId);
  if (fork !== undefined && typeof input.effort === "string") fork.ranAt ??= input.effort;
}

/** The main conversation was compacted or cleared: no fork until its next
 * request. */
export function forksNotReady(state: ForkState): void {
  state.forks.isNotReady = true;
}

/** A fork's turn ended: what it cost is kept, and the fork ends here when
 * its report came first. */
export async function forkTurnEnded(
  state: ForkState,
  input: Output<typeof ForkTurnInputSchema>,
): Promise<void> {
  if (input.agentId === undefined) return;
  const fork = await forkOf(state, input.agentId);
  if (fork === undefined) return;
  fork.turn = input.usage !== undefined ? { usage: input.usage } : {};
  if (fork.report !== undefined) settle(fork, fork.report);
}

/** A report of an agent: a fork of this load's is taken, so the main
 * conversation is told nothing of it, and the fork ends once its turn's end
 * came too (or FORK_TURN_WAIT_MS later). Any other report is not this
 * module's: undefined, and it goes on. */
export async function forkReported<E>(
  $: Engine,
  state: ForkState,
  e: E,
): Promise<ReportTaken | undefined> {
  const read = parseWith(AgentReportInputSchema, e);
  if (!read.ok) return undefined;
  const fork = await forkOf(state, read.value.agentId);
  if (fork === undefined) return undefined;
  const report: ForkReport = { status: read.value.status, text: read.value.text };
  fork.report = report;
  if (fork.turn !== undefined) settle(fork, report);
  else fork.wait = $.clock.after(FORK_TURN_WAIT_MS, () => settle(fork, report));
  return { consumed: "ccmsg: a btw's answer goes to the web UI, not to the conversation" };
}
