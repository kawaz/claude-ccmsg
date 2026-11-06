// agent tree パネルの行 (kawaz 2026-11-06): `(model/effort)` と最終活動からの
// 経過時間、状態語なし、idle 区画は既定で開。
import { afterEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentTreeGroups, AgentTreeNode } from "@ccmsg/protocol";
import { AgentTreePanel } from "../src/client/components/AgentTreePanel.tsx";
import { withDom } from "./dom.ts";

withDom();

let container: HTMLElement | null = null;

afterEach(async () => {
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

function mate(over: Partial<AgentTreeNode> & Pick<AgentTreeNode, "agent_id">): AgentTreeNode {
  return { kind: "teammate", spawn_depth: 0, state: "idle", children: [], ...over };
}

async function mount(tree: AgentTreeGroups): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.appendChild(root);
  container = root;
  await act(() => render(h(AgentTreePanel, { sid: "s1", tree }), root));
  return root;
}

describe("agent tree の行", () => {
  test("(model/effort) と経過時間を出し、状態語は出さない", async () => {
    const root = await mount({
      teammates: [
        mate({
          agent_id: "a1",
          teammate_name: "worker-a",
          model: "claude-opus-5-5[1m]",
          running_model: "claude-opus-5-5",
          effort: "high",
          last_activity_ms: Date.now() - 190_000,
        }),
        mate({ agent_id: "a2", teammate_name: "worker-b", model: "claude-opus-5-5" }),
      ],
      agents: [],
      workflows: [],
    });
    const rows = [...root.querySelectorAll(".agent-tree-row")].slice(1);
    expect(rows[0]?.querySelector(".agent-tree-model")?.textContent).toBe("(opus-5-5/high)");
    expect(rows[0]?.querySelector(".agent-tree-elapsed")?.textContent).toMatch(/^3m\d+s$/);
    expect(rows[0]?.querySelector(".agent-tree-state-note")).toBeNull();
    expect(rows[0]?.textContent).not.toContain("idle");
    expect(rows[1]?.querySelector(".agent-tree-model")?.textContent).toBe("(opus-5-5)");
    expect(rows[1]?.querySelector(".agent-tree-elapsed")).toBeNull();
  });

  test("idle の区画は既定で開く、stopped は畳む", async () => {
    const root = await mount({
      teammates: [
        mate({ agent_id: "a1", teammate_name: "idle-one", state: "idle" }),
        mate({ agent_id: "a2", teammate_name: "done-one", state: "stopped" }),
      ],
      agents: [],
      workflows: [],
    });
    const labels = [...root.querySelectorAll(".agent-tree-label")].map((e) => e.textContent);
    expect(labels).toContain("idle-one");
    expect(labels).not.toContain("done-one");
  });
});
