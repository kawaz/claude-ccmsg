// DR-0025 Phase 1: fold one workflow run's phases + agent list from the
// on-disk artifacts under `<sidDir>/workflows/` and
// `<sidDir>/subagents/workflows/<runId>/`.
//
// Two data sources, in priority order:
//   1. `<sidDir>/workflows/<runId>.json` — the workflow's state json, written
//      when the run completes (`status: "completed" | "killed" | "failed"`).
//      Carries `phases` (declared phase list) and `workflowProgress` (interleaved
//      `workflow_phase` + `workflow_agent` entries) with a rich per-agent shape
//      (model, tokens, tool_calls, phase index, result_preview, ...). All fields
//      are optional bar `runId` — some variants omit `tokens`/`agent_type`/
//      `duration_ms`/`resultPreview` and error variants replace `resultPreview`
//      with `error`.
//   2. `<sidDir>/subagents/workflows/<runId>/journal.jsonl` — always present
//      during a run. Two row types (`started` and `result`); we infer agent
//      state as `"done"` (result observed) or `"running"` (started only) and
//      pick `agent_type` up from the sibling `agent-<id>.meta.json` when
//      present. Phases are unknowable here (script's phase declaration is not
//      journaled).
//
// Every fs / parse error is swallowed and the affected field left undefined —
// the snapshot's `workflow` entry still folds, this drilldown just goes missing.
// The caller (session-status.ts) treats an `undefined` return the same as
// "no drilldown for this workflow yet".

import * as fs from "node:fs";
import * as path from "node:path";
import type { WorkflowAgentStatus, WorkflowPhaseStatus } from "@ccmsg/protocol";
import { RUN_ID_RE } from "./agent-transcripts.ts";

export interface WorkflowDrilldownResult {
  phases?: WorkflowPhaseStatus[];
  agents?: WorkflowAgentStatus[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string): string | undefined {
  const v = row[key];
  return typeof v === "string" && v.length > 0 ? v : undefined;
}
function numberField(row: Record<string, unknown>, key: string): number | undefined {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

/**
 * Fold one workflow run. `runId` is re-validated here (defense in depth): the
 * caller should already have run it through `RUN_ID_RE`, but the drilldown
 * writes it back into `path.join` so verifying twice costs nothing and keeps
 * this function safe to invoke from any future caller.
 */
export function readWorkflowDrilldown(
  sidDir: string,
  runId: string,
): WorkflowDrilldownResult | undefined {
  if (!RUN_ID_RE.test(runId)) return undefined;

  const stateJsonPath = path.join(sidDir, "workflows", `${runId}.json`);
  const stateJson = tryReadJson(stateJsonPath);
  if (stateJson !== undefined) {
    return foldFromStateJson(stateJson);
  }
  const journalPath = path.join(sidDir, "subagents", "workflows", runId, "journal.jsonl");
  const runDir = path.join(sidDir, "subagents", "workflows", runId);
  return foldFromJournal(journalPath, runDir);
}

function tryReadJson(file: string): unknown {
  let raw: string;
  try {
    raw = fs.readFileSync(file, "utf-8");
  } catch {
    return undefined;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
}

function foldFromStateJson(value: unknown): WorkflowDrilldownResult | undefined {
  if (!isRecord(value)) return undefined;
  const progress = value.workflowProgress;
  const declaredPhases = value.phases;

  // Phase skeleton: prefer the declared `phases` array (has each title's
  // canonical index); fall back to whatever `workflow_phase` entries the
  // progress array declares. `done`/`total` are always computed from the
  // agent entries below, since a phase with zero agents also has 0/0.
  const phaseTitleByIndex = new Map<number, string>();
  if (Array.isArray(declaredPhases)) {
    declaredPhases.forEach((phase, i) => {
      if (isRecord(phase)) {
        const title = stringField(phase, "title");
        if (title) phaseTitleByIndex.set(i + 1, title);
      }
    });
  }
  const agents: WorkflowAgentStatus[] = [];
  if (Array.isArray(progress)) {
    for (const row of progress) {
      if (!isRecord(row)) continue;
      if (row.type === "workflow_phase") {
        const index = numberField(row, "index");
        const title = stringField(row, "title");
        if (index !== undefined && title && !phaseTitleByIndex.has(index)) {
          phaseTitleByIndex.set(index, title);
        }
      } else if (row.type === "workflow_agent") {
        const agentId = stringField(row, "agentId");
        const state = stringField(row, "state");
        if (!agentId || !state) continue;
        const lastToolName = stringField(row, "lastToolName");
        const lastToolSummary = stringField(row, "lastToolSummary");
        const lastTool =
          lastToolName && lastToolSummary
            ? `${lastToolName}: ${lastToolSummary}`
            : (lastToolName ?? lastToolSummary);
        const agent: WorkflowAgentStatus = {
          agent_id: agentId,
          state,
          ...maybe("label", stringField(row, "label")),
          ...maybe("model", stringField(row, "model")),
          ...maybe("agent_type", stringField(row, "agentType")),
          ...maybe("tokens", numberField(row, "tokens")),
          ...maybe("tool_calls", numberField(row, "toolCalls")),
          ...maybe("phase_index", numberField(row, "phaseIndex")),
          ...maybe("phase_title", stringField(row, "phaseTitle")),
          ...maybe("last_tool", lastTool),
          ...maybe("result_preview", stringField(row, "resultPreview")),
          ...maybe("error", stringField(row, "error")),
          ...maybe("started_at", numberField(row, "startedAt")),
          ...maybe("duration_ms", numberField(row, "durationMs")),
        };
        agents.push(agent);
      }
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
  const phases: WorkflowPhaseStatus[] = [];
  const orderedIndices = [...phaseTitleByIndex.keys()].sort((a, b) => a - b);
  for (const idx of orderedIndices) {
    phases.push({
      title: phaseTitleByIndex.get(idx)!,
      done: doneByPhase.get(idx) ?? 0,
      total: totalByPhase.get(idx) ?? 0,
    });
  }

  if (phases.length === 0 && agents.length === 0) return undefined;
  return {
    ...(phases.length > 0 ? { phases } : {}),
    ...(agents.length > 0 ? { agents } : {}),
  };
}

function maybe<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Partial<Record<K, V>>);
}

/**
 * Journal fallback (running workflow — no state json yet). Two row types only:
 * `{"type":"started","agentId":"..."}` and `{"type":"result","agentId":"...","result":"..."}`.
 * A `result` row supersedes any earlier `started` row for the same agentId.
 */
function foldFromJournal(journalPath: string, runDir: string): WorkflowDrilldownResult | undefined {
  let raw: string;
  try {
    raw = fs.readFileSync(journalPath, "utf-8");
  } catch {
    return undefined;
  }
  interface JournalEntry {
    state: "running" | "done";
    resultPreview?: string;
  }
  const byAgent = new Map<string, JournalEntry>();
  for (const line of raw.split("\n")) {
    if (line.length === 0) continue;
    let row: unknown;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    if (!isRecord(row)) continue;
    const agentId = stringField(row, "agentId");
    if (!agentId) continue;
    if (row.type === "started") {
      if (!byAgent.has(agentId)) byAgent.set(agentId, { state: "running" });
    } else if (row.type === "result") {
      const result = row.result;
      const preview =
        typeof result === "string" && result.length > 0 ? result.slice(0, 200) : undefined;
      byAgent.set(agentId, {
        state: "done",
        ...(preview ? { resultPreview: preview } : {}),
      });
    }
  }
  if (byAgent.size === 0) return undefined;
  const agents: WorkflowAgentStatus[] = [];
  for (const [agentId, entry] of byAgent) {
    const meta = tryReadJson(path.join(runDir, `agent-${agentId}.meta.json`));
    const agentType = isRecord(meta) ? stringField(meta, "agentType") : undefined;
    agents.push({
      agent_id: agentId,
      state: entry.state,
      ...(agentType ? { agent_type: agentType } : {}),
      ...(entry.resultPreview ? { result_preview: entry.resultPreview } : {}),
    });
  }
  return { agents };
}
