// DR-0025 Phase 1: fold one workflow run's phases + agent list from the
// on-disk artifacts under `<sidDir>/workflows/` and
// `<sidDir>/subagents/workflows/<runId>/`.
//
// Two data sources, in priority order:
//   1. `<sidDir>/workflows/<runId>.json` — the workflow's state json, written
//      when the run completes (`status: "completed" | "killed" | "failed"`).
//      Carries `phases` (declared phase list) and `workflowProgress` (interleaved
//      `workflow_phase` + `workflow_agent` entries) with a rich per-agent shape
//      (model, tokens, tool_calls, phase index, result_preview, ...). Some
//      agents omit `tokens`/`agentType`/`durationMs`/`resultPreview`, error
//      variants replace `resultPreview` with `error`, and an agent that never
//      started has no `agentId` (protocol's WorkflowStateSchema).
//   2. `<sidDir>/subagents/workflows/<runId>/journal.jsonl` — always present
//      during a run. Two row types (`started` and `result`); we infer agent
//      state as `"done"` (result observed) or `"running"` (started only) and
//      pick `agent_type` up from the sibling `agent-<id>.meta.json` when
//      present. Phases are unknowable here (script's phase declaration is not
//      journaled).
//
// A file that cannot be read, or does not read with its schema, counts as
// absent (a journal line that does not read, as that line absent) — the
// snapshot's `workflow` entry still folds, this drilldown just goes missing.
// The caller (session-status.ts) treats an `undefined` return the same as
// "no drilldown for this workflow yet".

import * as fs from "node:fs";
import * as path from "node:path";
import {
  AgentMetaTextSchema,
  isKnownWorkflowJournalRow,
  isKnownWorkflowProgressEntry,
  parseWith,
  WorkflowJournalRowTextSchema,
  WorkflowStateTextSchema,
  type AgentMeta,
  type WorkflowAgentProgress,
  type WorkflowAgentStatus,
  type WorkflowPhaseStatus,
  type WorkflowState,
  type Output,
} from "@ccmsg/protocol";
import type * as v from "valibot";
import { RUN_ID_RE } from "./agent-transcripts.ts";
import { createMtimeCache, type MtimeCache } from "./mtime-cache.ts";

/** What each file read as, per path, revalidated by that path's mtime. A
 * completed run's state json never changes again, and a running workflow's
 * journal only grows when a member starts or finishes — both are re-read far
 * less often than the once-per-transcript-line rate at which snapshots ask for
 * them. `null` is a file that does not read. */
const stateByPath = createMtimeCache<WorkflowState | null>(128);
const metaByPath = createMtimeCache<AgentMeta | null>(256);
const journalEntriesByPath = createMtimeCache<Map<string, JournalEntry>>(128);

export interface WorkflowDrilldownResult {
  phases?: WorkflowPhaseStatus[];
  agents?: WorkflowAgentStatus[];
}

/**
 * Fold one workflow run. `runId` is re-validated here (defense in depth): the
 * caller should already have run it through `RUN_ID_RE`, but the drilldown
 * writes it back into `path.join` so verifying twice costs nothing and keeps
 * this function safe to invoke from any future caller.
 */
export async function readWorkflowDrilldown(
  sidDir: string,
  runId: string,
): Promise<WorkflowDrilldownResult | undefined> {
  if (!RUN_ID_RE.test(runId)) return undefined;

  const stateJsonPath = path.join(sidDir, "workflows", `${runId}.json`);
  const state = await readCached(stateByPath, stateJsonPath, WorkflowStateTextSchema);
  if (state !== undefined) {
    return foldFromStateJson(state);
  }
  const journalPath = path.join(sidDir, "subagents", "workflows", runId, "journal.jsonl");
  const runDir = path.join(sidDir, "subagents", "workflows", runId);
  return foldFromJournal(journalPath, runDir);
}

/** `file` read with `schema`, through `cache`: undefined when it is missing,
 * cannot be read, or does not read. */
async function readCached<S extends v.GenericSchema>(
  cache: MtimeCache<Output<S> | null>,
  file: string,
  schema: S,
): Promise<Output<S> | undefined> {
  const read = await cache.get(file, async () => {
    let text: string;
    try {
      text = await fs.promises.readFile(file, "utf-8");
    } catch {
      return null;
    }
    const parsed = parseWith(schema, text);
    return parsed.ok ? parsed.value : null;
  });
  return read ?? undefined;
}

function agentStatus(row: WorkflowAgentProgress, agentId: string): WorkflowAgentStatus {
  const { lastToolName, lastToolSummary } = row;
  const lastTool =
    lastToolName !== undefined && lastToolSummary !== undefined
      ? `${lastToolName}: ${lastToolSummary}`
      : (lastToolName ?? lastToolSummary);
  return {
    agent_id: agentId,
    state: row.state,
    ...(row.label !== undefined ? { label: row.label } : {}),
    ...(row.model !== undefined ? { model: row.model } : {}),
    ...(row.agentType !== undefined ? { agent_type: row.agentType } : {}),
    ...(row.tokens !== undefined ? { tokens: row.tokens } : {}),
    ...(row.toolCalls !== undefined ? { tool_calls: row.toolCalls } : {}),
    ...(row.phaseIndex !== undefined ? { phase_index: row.phaseIndex } : {}),
    ...(row.phaseTitle !== undefined ? { phase_title: row.phaseTitle } : {}),
    ...(lastTool !== undefined ? { last_tool: lastTool } : {}),
    ...(row.resultPreview !== undefined ? { result_preview: row.resultPreview } : {}),
    ...(row.error !== undefined ? { error: row.error } : {}),
    ...(row.startedAt !== undefined ? { started_at: row.startedAt } : {}),
    ...(row.durationMs !== undefined ? { duration_ms: row.durationMs } : {}),
  };
}

function foldFromStateJson(state: WorkflowState): WorkflowDrilldownResult | undefined {
  // Phase skeleton: prefer the declared `phases` array (has each title's
  // canonical index); fall back to whatever `workflow_phase` entries the
  // progress array declares. `done`/`total` are always computed from the
  // agent entries below, since a phase with zero agents also has 0/0.
  const phaseTitleByIndex = new Map<number, string>();
  state.phases.forEach((phase, i) => {
    if (phase.title !== "") phaseTitleByIndex.set(i + 1, phase.title);
  });
  const agents: WorkflowAgentStatus[] = [];
  for (const row of state.workflowProgress) {
    if (!isKnownWorkflowProgressEntry(row)) continue;
    if (row.type === "workflow_phase") {
      if (row.title !== "" && !phaseTitleByIndex.has(row.index)) {
        phaseTitleByIndex.set(row.index, row.title);
      }
    } else {
      // An agent that never started has no id to name it by.
      if (row.agentId === undefined) continue;
      agents.push(agentStatus(row, row.agentId));
    }
  }

  // done/total: count only agents that carry a matching `phase_index`.
  // Agents with no `phase_index` (defensive: not observed but permitted by
  // the shape) do not contribute to any phase's count.
  const doneByPhase = new Map<number, number>();
  const totalByPhase = new Map<number, number>();
  for (const agent of agents) {
    const idx = agent.phase_index;
    if (idx === undefined) continue;
    totalByPhase.set(idx, (totalByPhase.get(idx) ?? 0) + 1);
    if (agent.state === "done") doneByPhase.set(idx, (doneByPhase.get(idx) ?? 0) + 1);
  }
  const phases: WorkflowPhaseStatus[] = [...phaseTitleByIndex]
    .sort(([a], [b]) => a - b)
    .map(([idx, title]) => ({
      title,
      done: doneByPhase.get(idx) ?? 0,
      total: totalByPhase.get(idx) ?? 0,
    }));

  if (phases.length === 0 && agents.length === 0) return undefined;
  return {
    ...(phases.length > 0 ? { phases } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  };
}

/**
 * Journal fallback (running workflow — no state json yet). Two row types only:
 * `{"type":"started","agentId":"..."}` and `{"type":"result","agentId":"...","result":"..."}`.
 * A `result` row supersedes any earlier `started` row for the same agentId.
 */
async function foldFromJournal(
  journalPath: string,
  runDir: string,
): Promise<WorkflowDrilldownResult | undefined> {
  // The journal fold is memoized on the journal's own mtime; the per-agent
  // meta lookups below are not folded into it, because a member's meta.json
  // can land after the `started` row that announced it and would otherwise
  // stay invisible until the journal next grew.
  const byAgent = await journalEntriesByPath.get(journalPath, () => parseJournal(journalPath));
  if (!byAgent || byAgent.size === 0) return undefined;
  const agents: WorkflowAgentStatus[] = [];
  for (const [agentId, entry] of byAgent) {
    const meta = await readCached(
      metaByPath,
      path.join(runDir, `agent-${agentId}.meta.json`),
      AgentMetaTextSchema,
    );
    const agentType = meta?.agentType;
    agents.push({
      agent_id: agentId,
      state: entry.state,
      ...(agentType ? { agent_type: agentType } : {}),
      ...(entry.resultPreview ? { result_preview: entry.resultPreview } : {}),
    });
  }
  return { agents };
}

interface JournalEntry {
  state: "running" | "done";
  resultPreview?: string;
}

/** Fold `journal.jsonl` into agentId → state. An unreadable file yields an
 * empty map, which the caller reports as "no drilldown"; a line that does not
 * read is passed over. */
async function parseJournal(journalPath: string): Promise<Map<string, JournalEntry>> {
  const byAgent = new Map<string, JournalEntry>();
  let raw: string;
  try {
    raw = await fs.promises.readFile(journalPath, "utf-8");
  } catch {
    return byAgent;
  }
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    const read = parseWith(WorkflowJournalRowTextSchema, line);
    if (!read.ok) continue;
    const row = read.value;
    if (!isKnownWorkflowJournalRow(row)) continue;
    if (row.type === "started") {
      if (!byAgent.has(row.agentId)) byAgent.set(row.agentId, { state: "running" });
    } else {
      // Only a text result is shown; a value of the script's own shape has no
      // preview.
      const preview =
        typeof row.result === "string" && row.result.length > 0
          ? row.result.slice(0, 200)
          : undefined;
      byAgent.set(row.agentId, {
        state: "done",
        ...(preview ? { resultPreview: preview } : {}),
      });
    }
  }
  return byAgent;
}
