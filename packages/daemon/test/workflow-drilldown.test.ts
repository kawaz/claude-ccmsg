import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { readWorkflowDrilldown } from "../src/workflow-drilldown.ts";
import { perTestTmpDir } from "../../testkit/src/tmp.ts";

const tmpDir = perTestTmpDir();

function tmpSidDir(): string {
  // Sit realsome-projDir/some-sid — the resolver only cares that
  // `<sidDir>/workflows/` and `<sidDir>/subagents/workflows/` are readable.
  return tmpDir("wf-drill-");
}

const RUN_ID = "wf_abcdef01-234";

describe("readWorkflowDrilldown (DR-0025)", () => {
  test("state json あり: workflow_phase + workflow_agent を phases/agents に写像する", async () => {
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

    const result = await readWorkflowDrilldown(sidDir, RUN_ID);
    expect(result).toBeDefined();
    // Each phase keeps the index it was declared at, which its agents'
    // phaseIndex names (the agent tree places members by it).
    expect(result?.phases).toEqual([
      { index: 1, title: "Plan", done: 1, total: 1 },
      { index: 2, title: "Implement", done: 1, total: 1 },
      { index: 3, title: "Verify", done: 0, total: 1 },
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

  test("state json なし: journal.jsonl から started/result を running/done として畳む", async () => {
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

    const result = await readWorkflowDrilldown(sidDir, RUN_ID);
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

  test("dir 不在 / 壊れ JSON は undefined を返し throw しない", async () => {
    const sidDir = tmpSidDir();
    expect(await readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();

    fs.mkdirSync(path.join(sidDir, "workflows"), { recursive: true });
    fs.writeFileSync(path.join(sidDir, "workflows", `${RUN_ID}.json`), "{not json");
    // Broken json + no journal → undefined.
    expect(await readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();
  });

  // 何を保証するか (DR-0025 §5): 掘り下げが読むのも、途中のディレクトリの symlink
  // を解決した実体が <sid> のディレクトリの下にある通常のファイルだけ。外を指す
  // workflows/ や run のディレクトリ、外を指す state / journal / meta.json の
  // symlink は無いものとして扱う。
  describe("<sid> の外を指す symlink", () => {
    const stateJson = JSON.stringify({
      phases: [{ title: "Leak" }],
      workflowProgress: [
        { type: "workflow_agent", agentId: "a1111111111111111", state: "done", phaseIndex: 1 },
      ],
    });
    const journal = `${JSON.stringify({ type: "started", agentId: "a1111111111111111" })}\n`;

    test("workflows/ が外への symlink なら state を読まない", async () => {
      const sidDir = tmpSidDir();
      const outside = tmpDir("outside-");
      fs.writeFileSync(path.join(outside, `${RUN_ID}.json`), stateJson);
      fs.symlinkSync(outside, path.join(sidDir, "workflows"));
      expect(await readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();
    });

    test("state の file が外への symlink なら読まない", async () => {
      const sidDir = tmpSidDir();
      const outside = tmpDir("outside-");
      fs.writeFileSync(path.join(outside, "state.json"), stateJson);
      fs.mkdirSync(path.join(sidDir, "workflows"));
      fs.symlinkSync(
        path.join(outside, "state.json"),
        path.join(sidDir, "workflows", `${RUN_ID}.json`),
      );
      expect(await readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();
    });

    test("run のディレクトリが外への symlink なら journal を読まない", async () => {
      const sidDir = tmpSidDir();
      const outside = tmpDir("outside-");
      fs.writeFileSync(path.join(outside, "journal.jsonl"), journal);
      fs.mkdirSync(path.join(sidDir, "subagents", "workflows"), { recursive: true });
      fs.symlinkSync(outside, path.join(sidDir, "subagents", "workflows", RUN_ID));
      expect(await readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();
    });

    test("journal の file や meta.json が外への symlink なら読まない", async () => {
      const sidDir = tmpSidDir();
      const outside = tmpDir("outside-");
      const runDir = path.join(sidDir, "subagents", "workflows", RUN_ID);
      fs.mkdirSync(runDir, { recursive: true });
      fs.writeFileSync(path.join(outside, "journal.jsonl"), journal);
      fs.symlinkSync(path.join(outside, "journal.jsonl"), path.join(runDir, "journal.jsonl"));
      expect(await readWorkflowDrilldown(sidDir, RUN_ID)).toBeUndefined();

      fs.rmSync(path.join(runDir, "journal.jsonl"));
      fs.writeFileSync(path.join(runDir, "journal.jsonl"), journal);
      fs.writeFileSync(path.join(outside, "meta.json"), JSON.stringify({ agentType: "leak" }));
      fs.symlinkSync(
        path.join(outside, "meta.json"),
        path.join(runDir, "agent-a1111111111111111.meta.json"),
      );
      const result = await readWorkflowDrilldown(sidDir, RUN_ID);
      expect(result?.agents).toEqual([{ agent_id: "a1111111111111111", state: "running" }]);
    });
  });

  // 何を保証するか (DR-0025 §5): journal の agentId は file に書かれた値なので、
  // AGENT_ID_RE に合わなければ meta.json のパスに使わない (run のディレクトリの
  // 外の meta.json を読まない)。agent の行そのものは残る。
  test("journal の agentId が AGENT_ID_RE に合わなければ meta.json を引かない", async () => {
    const sidDir = tmpSidDir();
    const runDir = path.join(sidDir, "subagents", "workflows", RUN_ID);
    fs.mkdirSync(runDir, { recursive: true });
    fs.writeFileSync(
      path.join(sidDir, "subagents", "agent-x.meta.json"),
      JSON.stringify({ agentType: "leak" }),
    );
    const escaping = "x/../../../agent-x";
    fs.writeFileSync(
      path.join(runDir, "journal.jsonl"),
      `${JSON.stringify({ type: "started", agentId: escaping })}\n`,
    );
    const result = await readWorkflowDrilldown(sidDir, RUN_ID);
    expect(result?.agents).toEqual([{ agent_id: escaping, state: "running" }]);
  });

  test("invalid runId は undefined (defense in depth)", async () => {
    const sidDir = tmpSidDir();
    for (const bad of ["../etc", "wf_ZZZZZZZZ-123", "wf_ABCDEF01-234", ""]) {
      expect(await readWorkflowDrilldown(sidDir, bad)).toBeUndefined();
    }
  });
});
