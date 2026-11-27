// The tool `agy` (DR-0066): an agent's conversations with agy, kept by the
// daemon. The tool is answered at `tool.run`, after the call went through
// permission (K12): `tool.check`, PreToolUse, the dialog, the auto mode
// classifier, or a project's exact allow of the tool's name (C15, C16). Its
// calls go to the daemon's `agy_run` / `agy_status` / `agy_abort`.
//
// A response comes back later as the daemon's `notice.append`: appended into
// the conversation that asked (K11, K14). A waiting teammate or an ended
// subagent refuses the append; its text is kept here and appended at that
// agent's next `turn.start`, before `next` (K15), which the daemon's wake that
// follows starts.
import * as v from "valibot";
import {
  AgyAbortResponseTextSchema,
  AgyFieldsSchema,
  AgyRunResponseTextSchema,
  AgyStatusResponseTextSchema,
  agyRefusalText,
  readAgyCall,
} from "@ccmsg/protocol/agy";
import { errorText, type Output, parseWith } from "@ccmsg/protocol/parse";
import { RefusalTextSchema } from "@ccmsg/protocol/peer-tools";
import type { NoticeAppendArgs, NoticeAppendResult } from "@ccmsg/protocol/sidecar";
import { type DaemonOpOutcome, daemonOp } from "./daemon-op.ts";
import type { Engine } from "./engine.ts";
import { type ForkState, isBtwFork } from "./fork-ask.ts";

/** The texts kept for agents whose append was refused, by agent id, appended
 * in order at the agent's next turn.start (K15). */
export interface AgyNoticeState {
  agyHeld: Map<string, string[]>;
}

export function newAgyNoticeState(): AgyNoticeState {
  return { agyHeld: new Map() };
}

/** What Claude Code says when the id names no running loop (C10). */
const NO_RUNNING_LOOP = "no running loop";

/** notice.append: the response under its mark, into the main conversation
 * or the agent's. An agent whose loop does not run keeps it for its next
 * turn.start, and the answer says so (`not_running`). */
export async function appendNotice(
  $: Engine,
  state: AgyNoticeState,
  args: NoticeAppendArgs,
): Promise<NoticeAppendResult> {
  const text = `${args.mark}\n${args.text}`;
  try {
    await $.session.append({
      message: { type: "user", content: [{ type: "text", text }] },
      ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    });
    return { outcome: "appended" };
  } catch (e) {
    const why = errorText(e);
    if (args.agentId !== undefined && why.includes(NO_RUNNING_LOOP)) {
      const held = state.agyHeld.get(args.agentId) ?? [];
      state.agyHeld.set(args.agentId, [...held, text]);
      return { outcome: "not_delivered", reason: "not_running" };
    }
    $.ui.log(`ccmsg: notice.append refused: ${why}`, { to: "debug" });
    return {
      outcome: "not_delivered",
      reason: why.includes(NO_RUNNING_LOOP) ? "not_running" : "refused",
    };
  }
}

export const AgyTurnInputSchema = v.looseObject({ agentId: v.optional(v.string()) });

/** An agent's turn starts: what was kept for it goes in now, so the turn's
 * first request carries it, ahead of the wake (K15, C10). */
export async function agyTurnStarted(
  $: Engine,
  state: AgyNoticeState,
  input: Output<typeof AgyTurnInputSchema>,
): Promise<void> {
  const agentId = input.agentId;
  if (agentId === undefined) return;
  const held = state.agyHeld.get(agentId);
  if (held === undefined) return;
  state.agyHeld.delete(agentId);
  for (const text of held) {
    try {
      await $.session.append({
        message: { type: "user", content: [{ type: "text", text }] },
        agentId,
      });
    } catch (e) {
      $.ui.log(`ccmsg: an agy response for ${agentId} was not appended: ${errorText(e)}`, {
        to: "debug",
      });
    }
  }
}

// --- the tool ------------------------------------------------------------------

/** A call read for the tool's fields alone (as launch's: the engine's own
 * fields beside the input are left out). */
const AgyToolCallSchema = v.object(AgyFieldsSchema.entries);

/** The engine's field a subagent's call carries. */
const CallerSchema = v.object({ agentId: v.optional(v.string()) });

const START_DAEMON = "daemon を起こす (`ccmsg daemon start`)";
const UPDATE_DAEMON = "daemon を更新する (`ccmsg daemon restart`)";
const RUN_UNCONFIRMED = "受け付けたか確かめられなかった。同じ依頼を投げ直さず、status で確かめる";

function notTheInput(summary: string): string {
  return `agy の入力が形に合わないので何もしていない: ${summary}`;
}

/** The tool `agy`: read the call, ask the daemon, and say what came of it.
 * Never rejects. */
export async function agyTool<E>($: Engine, state: ForkState, e: E): Promise<string> {
  const fields = parseWith(AgyToolCallSchema, e);
  if (!fields.ok) return notTheInput(fields.failure.summary);
  const call = readAgyCall(fields.value);
  if (!call.ok) return notTheInput(call.failure.summary);
  const caller = parseWith(CallerSchema, e);
  const agentId = caller.ok ? caller.value.agentId : undefined;
  const value = call.value;
  let asked: DaemonOpOutcome;
  if (value.op === "run") {
    // A btw's fork ends once it answers: no conversation is left for the
    // response (DR-0066 §11).
    if (agentId !== undefined && (await isBtwFork($, state, agentId))) {
      return "この btw の横道からは agy の run を使えない (応答の届け先が残らない)。何もしていない";
    }
    asked = await daemonOp($, {
      op: "agy_run",
      run: value.run,
      ...(agentId !== undefined ? { agent_id: agentId } : {}),
    });
  } else if (value.op === "status") {
    asked = await daemonOp($, { op: "agy_status", status: value.status });
  } else {
    asked = await daemonOp($, { op: "agy_abort", abort: value.abort });
  }
  switch (asked.kind) {
    case "no_daemon":
      return `ccmsg の daemon が居ないので何もしていない。${START_DAEMON}`;
    case "outdated":
      return `ccmsg の daemon がこの plugin より古いので何もしていない。${UPDATE_DAEMON}`;
    case "unanswered":
      $.ui.log(`ccmsg: agy unanswered: ${asked.reason}`, { to: "debug" });
      return call.value.op === "run"
        ? `ccmsg の daemon から返事が無かった: ${asked.reason}。${RUN_UNCONFIRMED}`
        : `ccmsg の daemon から返事が無かった: ${asked.reason}`;
    case "answered":
      break;
  }
  const schema =
    call.value.op === "run"
      ? AgyRunResponseTextSchema
      : call.value.op === "status"
        ? AgyStatusResponseTextSchema
        : AgyAbortResponseTextSchema;
  const answered = parseWith(schema, asked.text);
  if (answered.ok) {
    const { ok: _ok, ...result } = answered.value;
    return JSON.stringify(result);
  }
  const refusal = parseWith(RefusalTextSchema, asked.text);
  if (refusal.ok) return agyRefusalText(refusal.value.error.code, refusal.value.error.msg);
  $.ui.log(`ccmsg: agy answered what is not its reply: ${asked.text}`, { to: "debug" });
  return call.value.op === "run"
    ? `ccmsg が agy の結果を返さなかった。${RUN_UNCONFIRMED}`
    : "ccmsg が agy の結果を返さなかった";
}
