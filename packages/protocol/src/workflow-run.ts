// What Claude Code records about one workflow run, as schemas (DR-0038 §3):
//
// - `<sidDir>/workflows/<runId>.json`, the run's state, written when the run
//   ends: the phases the script declared and the progress of every agent.
// - `<sidDir>/subagents/workflows/<runId>/journal.jsonl`, written while the
//   run goes: a line when an agent starts and one when it returns.
//
// Both are Claude Code's, so the schemas list the fields ccmsg reads and let
// the rest through, and a kind of entry not known yet reads as other.
// Required fields are the ones every file observed carries (209 state files
// and 209 journals across two config dirs, 2026-10-11).
import * as v from "valibot";
import { JsonValueSchema } from "./json-value.ts";
import { jsonText, otherThan, type Output } from "./parse.ts";

/** A phase the run's script declared. Its index is its place in the list,
 * from 1. */
export const WorkflowDeclaredPhaseSchema = v.looseObject({
  title: v.string(),
});

/** A phase the run entered, in the progress list. */
export const WorkflowPhaseProgressSchema = v.looseObject({
  type: v.literal("workflow_phase"),
  index: v.number(),
  title: v.string(),
});

/** One agent of the run, in the progress list. */
export const WorkflowAgentProgressSchema = v.looseObject({
  type: v.literal("workflow_agent"),
  /** Absent for an agent that never started (blocked before it ran). */
  agentId: v.optional(v.string()),
  /** "done" / "error" / "progress", an open set. */
  state: v.string(),
  label: v.optional(v.string()),
  model: v.optional(v.string()),
  agentType: v.optional(v.string()),
  tokens: v.optional(v.number()),
  toolCalls: v.optional(v.number()),
  phaseIndex: v.optional(v.number()),
  phaseTitle: v.optional(v.string()),
  lastToolName: v.optional(v.string()),
  lastToolSummary: v.optional(v.string()),
  resultPreview: v.optional(v.string()),
  error: v.optional(v.string()),
  /** Epoch ms. */
  startedAt: v.optional(v.number()),
  durationMs: v.optional(v.number()),
});
export type WorkflowAgentProgress = Output<typeof WorkflowAgentProgressSchema>;

const KNOWN_PROGRESS = [WorkflowPhaseProgressSchema, WorkflowAgentProgressSchema] as const;
const KNOWN_PROGRESS_TYPES = KNOWN_PROGRESS.map((option) => option.entries.type.literal);
const KNOWN_PROGRESS_TYPE_SET: ReadonlySet<string> = new Set<string>(KNOWN_PROGRESS_TYPES);

/** A progress entry of a kind not read here, its fields as JSON. */
const OtherWorkflowProgressSchema = v.objectWithRest(
  { type: otherThan(KNOWN_PROGRESS_TYPES) },
  JsonValueSchema,
);

export const WorkflowProgressEntrySchema = v.variant("type", [
  ...KNOWN_PROGRESS,
  OtherWorkflowProgressSchema,
]);
export type WorkflowProgressEntry = Output<typeof WorkflowProgressEntrySchema>;
export type KnownWorkflowProgressEntry = Output<(typeof KNOWN_PROGRESS)[number]>;

/** Whether a progress entry is of a kind read here (and so narrows by its
 * `type`), rather than other — as isKnownTranscriptRow. */
export function isKnownWorkflowProgressEntry(
  entry: WorkflowProgressEntry,
): entry is KnownWorkflowProgressEntry {
  return KNOWN_PROGRESS_TYPE_SET.has(entry.type);
}

/** `workflows/<runId>.json`. */
export const WorkflowStateSchema = v.looseObject({
  phases: v.array(WorkflowDeclaredPhaseSchema),
  workflowProgress: v.array(WorkflowProgressEntrySchema),
});
export type WorkflowState = Output<typeof WorkflowStateSchema>;

/** A `workflows/<runId>.json` file's text. */
export const WorkflowStateTextSchema = jsonText(WorkflowStateSchema);

/** A journal line: an agent started. */
export const WorkflowJournalStartedSchema = v.looseObject({
  type: v.literal("started"),
  agentId: v.string(),
});

/** A journal line: an agent returned. `result` is what the agent's script
 * step returned: text, or a value of the script's own shape. */
export const WorkflowJournalResultSchema = v.looseObject({
  type: v.literal("result"),
  agentId: v.string(),
  result: JsonValueSchema,
});

const KNOWN_JOURNAL_ROWS = [WorkflowJournalStartedSchema, WorkflowJournalResultSchema] as const;
const KNOWN_JOURNAL_ROW_TYPES = KNOWN_JOURNAL_ROWS.map((option) => option.entries.type.literal);
const KNOWN_JOURNAL_ROW_TYPE_SET: ReadonlySet<string> = new Set<string>(KNOWN_JOURNAL_ROW_TYPES);

/** A journal line of a kind not read here, its fields as JSON. */
const OtherWorkflowJournalRowSchema = v.objectWithRest(
  { type: otherThan(KNOWN_JOURNAL_ROW_TYPES) },
  JsonValueSchema,
);

export const WorkflowJournalRowSchema = v.variant("type", [
  ...KNOWN_JOURNAL_ROWS,
  OtherWorkflowJournalRowSchema,
]);
export type WorkflowJournalRow = Output<typeof WorkflowJournalRowSchema>;
export type KnownWorkflowJournalRow = Output<(typeof KNOWN_JOURNAL_ROWS)[number]>;

/** Whether a journal line is of a kind read here, rather than other. */
export function isKnownWorkflowJournalRow(row: WorkflowJournalRow): row is KnownWorkflowJournalRow {
  return KNOWN_JOURNAL_ROW_TYPE_SET.has(row.type);
}

/** A `journal.jsonl` line. */
export const WorkflowJournalRowTextSchema = jsonText(WorkflowJournalRowSchema);
