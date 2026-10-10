// What a tool call returned, as Claude Code records it in a transcript, as
// schemas (DR-0038 §3).
//
// A user row that answers a tool call carries the tool's result twice: the
// `tool_result` block the model saw, and `toolUseResult` beside it, the
// structured result the harness keeps. The shape of `toolUseResult` is the
// tool's, and nothing in the row says which tool that is: the row holds it as
// a JSON value, and a reader that has matched the result to its `tool_use`
// (by the block's `tool_use_id`) reads it here, with the schema of the tool
// that was called. A call that failed records the error's text instead of the
// tool's result (its `tool_result` block then says `is_error`), so each
// schema reads text as well.
//
// Each schema lists the fields ccmsg reads and lets the rest through, like the
// rows. A field is required where every result of its tool observed carries
// it (30 to 120 days of transcripts, three config dirs).
import * as v from "valibot";
import { otherThan, type Output } from "./parse.ts";

/** The result `result` reads, or the text a failed call records instead. */
function toolResult<const TResult extends v.GenericSchema>(result: TResult) {
  return v.union([v.string(), result]);
}

/** An agent-teams teammate the call spawned. Its name is the teammate's
 * address (SendMessage `to`, TaskStop `task_id`). */
export const TeammateSpawnedResultSchema = v.looseObject({
  status: v.literal("teammate_spawned"),
  name: v.string(),
  agent_type: v.optional(v.string()),
  color: v.string(),
});
export type TeammateSpawnedResult = Output<typeof TeammateSpawnedResultSchema>;

/** A subagent the call ran: `async_launched` (with `isAsync`) when it runs in
 * the background and reports its end by a task notification, or the status it
 * finished with when the call waited for it. A result with no status is of a
 * call that waited. */
export const SubagentResultSchema = v.looseObject({
  status: v.optional(otherThan(["teammate_spawned"]), "completed"),
  agentId: v.string(),
  isAsync: v.optional(v.boolean()),
});
export type SubagentResult = Output<typeof SubagentResultSchema>;

export const AgentToolResultSchema = toolResult(
  v.union([TeammateSpawnedResultSchema, SubagentResultSchema]),
);
export type AgentToolResult = Output<typeof AgentToolResultSchema>;

/** Whether an Agent call's result is of a teammate it spawned (and so has
 * the teammate's fields), rather than of a subagent. A subagent's `status` is a
 * string, which TypeScript cannot tell apart from `teammate_spawned`; this
 * tells them apart by the value the subagent's excludes. */
export function isTeammateSpawnedResult(
  result: TeammateSpawnedResult | SubagentResult,
): result is TeammateSpawnedResult {
  return result.status === "teammate_spawned";
}

/** `success` is false when the recipient could not be reached. */
export const SendMessageToolResultSchema = toolResult(
  v.looseObject({
    success: v.boolean(),
  }),
);
export type SendMessageToolResult = Output<typeof SendMessageToolResultSchema>;

/** The task the call created, with the id the task list knows it by. */
export const TaskCreateToolResultSchema = toolResult(
  v.looseObject({
    task: v.looseObject({
      id: v.string(),
      subject: v.string(),
    }),
  }),
);
export type TaskCreateToolResult = Output<typeof TaskCreateToolResultSchema>;

/** `success` is false (with an `error`) when the update was refused. */
export const TaskUpdateToolResultSchema = toolResult(
  v.looseObject({
    success: v.boolean(),
  }),
);
export type TaskUpdateToolResult = Output<typeof TaskUpdateToolResultSchema>;

/** What the call stopped: `task_type` names its kind (`in_process_teammate`
 * for a teammate, stopped by its name). */
export const TaskStopToolResultSchema = toolResult(
  v.looseObject({
    task_type: v.string(),
  }),
);
export type TaskStopToolResult = Output<typeof TaskStopToolResultSchema>;

/** The background task the monitor runs as. */
export const MonitorToolResultSchema = toolResult(
  v.looseObject({
    taskId: v.string(),
  }),
);
export type MonitorToolResult = Output<typeof MonitorToolResultSchema>;

/** `backgroundTaskId` is there when the command runs in the background. */
export const BashToolResultSchema = toolResult(
  v.looseObject({
    backgroundTaskId: v.optional(v.string()),
  }),
);
export type BashToolResult = Output<typeof BashToolResultSchema>;

/** A workflow the call launched: the background task it runs as, and the run
 * whose state and journal hold its progress. */
export const WorkflowToolResultSchema = toolResult(
  v.looseObject({
    taskId: v.string(),
    workflowName: v.string(),
    status: v.string(),
    runId: v.string(),
    summary: v.string(),
  }),
);
export type WorkflowToolResult = Output<typeof WorkflowToolResultSchema>;
