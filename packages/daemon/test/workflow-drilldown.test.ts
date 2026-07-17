import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readWorkflowDrilldown } from "../src/workflow-drilldown.ts";

function tmpSidDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wf-drill-"));
  // Sit realsome-projDir/some-sid — the resolver only cares that
  // `<sidDir>/workflows/` and `<sidDir>/subagents/workflows/` are readable.
  return dir;
}

const RUN_ID = "wf_abcdef01-234";

describe("readWorkflowDrilldown (DR-0025)", () => {
  test("state json あり: workflow_phase + workflow_agent を phases/agents に写像する", () => {
    const sidDir = tmpSidDir();
    fs.mkdirSync(path.join(sidDir, "workflows"), { recursive: true });
    const stateJson = {
      runId: RUN_ID,
      workflowName: "example",
      status: "completed",
      phases: [
        { title: "Plan", detail: "planning" },
        { title: "Implement", detail: "code" },
        { title: "Verify", detail: "check" },
      ],
      workflowProgress: [
        { type: "workflow_phase", index: 1, title: "Plan" },
        {
          type: "workflow_agent",
          index: 1,
          label: "plan:fable",
          phaseIndex: 1,
          phaseTitle: "Plan",
          agentId: "a1111111111111111",
          agentType: "fable5-worker-low",
          model: "claude-fable-5[1m]",
          state: "done",
          startedAt: 1784179967995,
          tokens: 149564,
          toolCalls: 7,
          durationMs: 150268,
          lastToolName: "Bash",
          lastToolSummary: "jj status",
          resultPreview: "調査完了。",
        },
        { type: "workflow_phase", index: 2, title: "Implement" },
        {
          type: "workflow_agent",
          index: 2,
          label: "impl:sol",
          phaseIndex: 2,
          phaseTitle: "Implement",
          agentId: "a2222222222222222",
          state: "done",
          // No tokens/model/agent_type — asserts optional-field defensiveness.
        },
        { type: "workflow_phase", index: 3, title: "Verify" },
        {
          type: "workflow_agent",
          index: 3,
          label: "verify:sol",
          phaseIndex: 3,
          phaseTitle: "Verify",
          agentId: "a3333333333333333",
          state: "error",
          error: "assertion failed at step 4",
        },
      ],
    };
    fs.writeFileSync(path.join(sidDir, "workflows", `${RUN_ID}.json`), JSON.stringify(stateJson));

    const result = readWorkflowDrilldown(sidDir, RUN_ID);
    expect(result).toBeDefined();
    expect(result?.phases).toEqual([
      { title: "Plan", done: 1, total: 1 },
      { title: "Implement", done: 1, total: 1 },
      { title: "Verify", done: 0, total: 1 },
    ]);
    expect(result?.agents?.length).toBe(3);
    const plan = result?.agents?.find((a) => a.agent_id === "a1111111111111111");
    expect(plan?.model).toBe("claude-fable-5[1m]");
    expect(plan?.tokens).toBe(149564);
    expect(plan?.last_tool).toBe("Bash: jj status");
    expect(plan?.state).toBe("done");
    expect(plan?.phase_title).toBe("Plan");
    expect(plan?.duration_ms).toBe(150268);

    const impl = result?.agents?.find((a) => a.agent_id === "a2222222222222222");
    // Optional fields absent — should not appear on the object rather than be null.
    expect(impl?.model).toBeUndefined();
    expect(impl?.agent_type).toBeUndefined();
    expect(impl?.tokens).toBeUndefined();

    const verify = result?.agents?.find((a) => a.agent_id === "a3333333333333333");
    expect(verify?.state).toBe("error");
    expect(verify?.error).toBe("assertion failed at step 4");
    expect(verify?.result_preview).toBeUndefined();
  });

  test("state json なし: journal.jsonl から started/result を running/done として畳む", () => {
    const sidDir = tmpSidDir();
    const runDir = path.join(sidDir, "subagents", "workflows", RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    const journal = [
      { type: "started", key: "v2:aaa", agentId: "a1111111111111111" },
      { type: "started", key: "v2:bbb", agentId: "a2222222222222222" },
      {
        type: "result",
        key: "v2:aaa",
        agentId: "a1111111111111111",
        result: "実装完了。ci green。",
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n");
    fs.writeFileSync(path.join(runDir, "journal.jsonl"), journal);
    // Sibling meta for agent 1 to prove agentType lookup works.
    fs.writeFileSync(
      path.join(runDir, "agent-a1111111111111111.meta.json"),
      JSON.stringify({ agentType: "fable5-worker-low", spawnDepth: 1 }),
    );
    // Agent 2 has no meta — should still fold as running.

    const result = readWorkflowDrilldown(sidDir, RUN_ID);
    expect(result).toBeDefined();
    expect(result?.phases).toBeUndefined();
    const agents = result?.agents ?? [];
    expect(agents.length).toBe(2);
    const a1 = agents.find((a) => a.agent_id === "a1111111111111111");
    expect(a1?.state).toBe("done");
    expect(a1?.agent_type).toBe("fable5-worker-low");
    expect(a1?.result_preview).toBe("実装完了。ci green。");
    const a2 = agents.find((a) => a.agent_id === "a2222222222222222");
    expect(a2?.state).toBe("running");
    expect(a2?.agent_type).toBeUndefined();
  });

  test("dir 不在 / 壊れ JSON は undefined を返し throw しない", () => {
    const sidDir = tmpSidDir();
    expect(readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();

    fs.mkdirSync(path.join(sidDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(sidDir, "workflows", `${RUN_ID}.json`), "{not json");
    // Broken json + no journal → undefined.
    expect(readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();
  });

  test("invalid runId は undefined (defense in depth)", () => {
    const sidDir = tmpSidDir();
    for (const bad of ["../etc", "wf_ZZZZZZZZ-123", "wf_ABCDEF01-234", ""]) {
      expect(readWorkflowDrilldown(sidDir, bad)).toBeUndefined();
    }
  });
});
