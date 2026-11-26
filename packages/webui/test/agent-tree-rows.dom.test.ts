// agent tree パネルの行 (kawaz 2026-11-06): 区画の中の model の見出しと
// `[effort] 名前`、子の行の `(model/effort)`、最終活動からの経過時間、状態語なし、
// idle 区画は既定で開。
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
  test("model の見出しの下に [effort] 名前 と経過時間を出し、状態語は出さない", async () => {
    const root = await mount({
      agents: [
        mate({ agent_id: "a2", teammate_name: "worker-b", model: "claude-opus-5-5" }),
        mate({
          agent_id: "a1",
          teammate_name: "worker-a",
          model: "claude-opus-5-5[1m]",
          running_model: "claude-opus-5-5",
          effort: "high",
          last_activity_ms: Date.now() - 190_000,
        }),
      ],
      workflows: [],
    });
    const headings = [...root.querySelectorAll(".agent-tree-model-heading")].map(
      (e) => e.textContent,
    );
    expect(headings).toEqual(["opus-5-5"]);
    const rows = [...root.querySelectorAll(".agent-tree-row")].slice(1);
    expect(rows.map((r) => r.querySelector(".agent-tree-label")?.textContent)).toEqual([
      "worker-a",
      "worker-b",
    ]);
    expect(rows[0]?.querySelector(".agent-tree-effort")?.textContent).toBe("[high]");
    expect(rows[0]?.querySelector(".agent-tree-model")).toBeNull();
    expect(rows[0]?.querySelector(".agent-tree-elapsed")?.textContent).toMatch(/^3m\d+s$/);
    expect(rows[0]?.querySelector(".agent-tree-state-note")).toBeNull();
    expect(rows[0]?.textContent).not.toContain("idle");
    expect(rows[1]?.querySelector(".agent-tree-effort")).toBeNull();
    expect(rows[1]?.querySelector(".agent-tree-model")).toBeNull();
    expect(rows[1]?.querySelector(".agent-tree-elapsed")).toBeNull();
  });

  test("model の分からない行は最後の見出しに入り、[effort] を出さない", async () => {
    const root = await mount({
      agents: [
        mate({ agent_id: "a1", teammate_name: "nomodel" }),
        mate({
          agent_id: "a2",
          teammate_name: "s",
          running_model: "claude-sonnet-5-5",
          effort: "low",
        }),
      ],
      workflows: [],
    });
    const headings = [...root.querySelectorAll(".agent-tree-model-heading")].map(
      (e) => e.textContent,
    );
    expect(headings).toEqual(["sonnet-5-5", "model 不明"]);
    const rows = [...root.querySelectorAll(".agent-tree-row")].slice(1);
    expect(rows[1]?.querySelector(".agent-tree-label")?.textContent).toBe("nomodel");
    expect(rows[1]?.querySelector(".agent-tree-effort")).toBeNull();
  });

  test("子の行は見出しに入らず、今のまま (model/effort) を出す", async () => {
    const root = await mount({
      agents: [
        mate({
          agent_id: "a1",
          teammate_name: "parent",
          running_model: "claude-opus-5-5",
          effort: "high",
          children: [
            mate({
              agent_id: "c1",
              kind: "subagent",
              spawn_depth: 1,
              description: "child",
              running_model: "claude-haiku-5-5",
              effort: "low",
            }),
          ],
        }),
      ],
      workflows: [],
    });
    const headings = [...root.querySelectorAll(".agent-tree-model-heading")].map(
      (e) => e.textContent,
    );
    expect(headings).toEqual(["opus-5-5"]);
    const child = root.querySelector(".agent-tree-children .agent-tree-row");
    expect(child?.querySelector(".agent-tree-model")?.textContent).toBe("(haiku-5-5/low)");
    expect(child?.querySelector(".agent-tree-effort")).toBeNull();
  });

  test("idle の区画は既定で開く、stopped は畳む", async () => {
    const root = await mount({
      agents: [
        mate({ agent_id: "a1", teammate_name: "idle-one", state: "idle" }),
        mate({ agent_id: "a2", teammate_name: "done-one", state: "stopped" }),
      ],
      workflows: [],
    });
    const labels = [...root.querySelectorAll(".agent-tree-label")].map((e) => e.textContent);
    expect(labels).toContain("idle-one");
    expect(labels).not.toContain("done-one");
  });

  // spawned (起動の指令で動いている) は active (2 度目以降の指令で動いている) と
  // 同じ区画に入り、同じドットで描く (kawaz 2026-11-24)。spawned の区画は無い。
  test("spawned の行は active の区画に、active と同じドットで並ぶ", async () => {
    const root = await mount({
      agents: [
        mate({ agent_id: "a1", teammate_name: "first-prompt", state: "spawned" }),
        mate({ agent_id: "a2", teammate_name: "later-prompt", state: "active" }),
        mate({ agent_id: "a3", teammate_name: "waiting", state: "idle" }),
      ],
      workflows: [],
    });
    const groups = [...root.querySelectorAll(".agent-tree-completed-toggle")].map((e) =>
      e.textContent?.trim(),
    );
    expect(groups).toEqual(["▽ active (2)", "▽ idle (1)"]);
    const activeRows = [...root.querySelectorAll(".agent-tree-state-group")][0];
    const dots = [...(activeRows?.querySelectorAll(".agent-tree-row .status-teammate-dot") ?? [])];
    expect(dots.map((d) => d.getAttribute("class"))).toEqual([
      "status-teammate-dot status-teammate-dot-active",
      "status-teammate-dot status-teammate-dot-active",
    ]);
  });
});

function sub(over: Partial<AgentTreeNode> & Pick<AgentTreeNode, "agent_id">): AgentTreeNode {
  return { kind: "subagent", spawn_depth: 0, state: "active", children: [], ...over };
}

function toggleButtons(root: HTMLElement): HTMLButtonElement[] {
  return [...root.querySelectorAll<HTMLButtonElement>(".agent-tree-completed-toggle")];
}

function toggles(root: HTMLElement): string[] {
  return toggleButtons(root).map((e) => e.textContent?.trim() ?? "");
}

// 何を保証するか (DR-0020 Addendum 2026-11-06): teammate と subagent を分けずに
// 1 つの節に並べ、その中を active / idle / completed / unknown の 4 つの区画に
// 分ける。区画に入る state は固定で、spawned・running・progress は active、
// 失敗 (failed / error) も completed。active と idle は既定で開、completed と
// unknown は閉。空の区画は出さない。
describe("agent tree の区画", () => {
  const MIXED: AgentTreeGroups = {
    agents: [
      sub({ agent_id: "s1", description: "sub-running", state: "running" }),
      mate({ agent_id: "t1", teammate_name: "mate-spawned", state: "spawned" }),
      sub({ agent_id: "s2", description: "sub-done", state: "completed" }),
      mate({ agent_id: "t2", teammate_name: "mate-idle", state: "idle" }),
      sub({ agent_id: "s3", description: "sub-active", state: "active" }),
      sub({ agent_id: "s4", description: "sub-failed", state: "failed" }),
      mate({ agent_id: "t3", teammate_name: "mate-stopped", state: "stopped" }),
      sub({ agent_id: "s5", description: "sub-odd", state: "pending" }),
      sub({ agent_id: "s6", description: "sub-progress", state: "progress" }),
      sub({ agent_id: "s7", description: "sub-killed", state: "killed" }),
      sub({ agent_id: "s8", description: "sub-error", state: "error" }),
      sub({ agent_id: "s9", description: "sub-unknown", state: "unknown" }),
      sub({ agent_id: "s10", description: "sub-donestate", state: "done" }),
    ],
    workflows: [],
  };

  test("teammate と subagent は 1 つの節に入り、Teammates の節は出ない", async () => {
    const root = await mount(MIXED);
    const headers = [...root.querySelectorAll(".agent-tree-group-header")].map((e) =>
      e.textContent?.trim(),
    );
    expect(headers).toEqual(["Agents (5 live / 13)"]);
  });

  test("4 つの区画に分かれ、active と idle は開、completed と unknown は閉", async () => {
    const root = await mount(MIXED);
    expect(toggles(root)).toEqual([
      "▽ active (4)",
      "▽ idle (1)",
      "▶ completed (6)",
      "▶ unknown (2)",
    ]);
    const labels = [...root.querySelectorAll(".agent-tree-label")].map((e) => e.textContent);
    // 開いた区画の中は、daemon の並び (種類によらない) のまま
    expect(labels.slice(1)).toEqual([
      "sub-running",
      "mate-spawned",
      "sub-active",
      "sub-progress",
      "mate-idle",
    ]);
  });

  test("completed には失敗したものも入り、点は失敗の色のまま", async () => {
    const root = await mount(MIXED);
    const completed = toggleButtons(root)[2];
    await act(() => completed?.click());
    const section = completed?.parentElement;
    const rows = [...(section?.querySelectorAll(".agent-tree-row") ?? [])];
    expect(rows.map((r) => r.querySelector(".agent-tree-label")?.textContent)).toEqual([
      "sub-done",
      "sub-failed",
      "mate-stopped",
      "sub-killed",
      "sub-error",
      "sub-donestate",
    ]);
    const failed = rows[1]?.querySelector(".status-teammate-dot");
    expect(failed?.getAttribute("style")).toContain("color: var(--danger)");
    const error = rows[4]?.querySelector(".status-teammate-dot");
    expect(error?.getAttribute("style")).toContain("color: var(--danger)");
    const done = rows[0]?.querySelector(".status-teammate-dot");
    expect(done?.getAttribute("style") ?? "").not.toContain("--danger");
  });

  test("unknown には上のどれでもない state が入る", async () => {
    const root = await mount(MIXED);
    const unknown = toggleButtons(root)[3];
    await act(() => unknown?.click());
    const rows = [...(unknown?.parentElement?.querySelectorAll(".agent-tree-label") ?? [])];
    expect(rows.map((r) => r.textContent)).toEqual(["sub-odd", "sub-unknown"]);
  });

  test("空の区画は出さない", async () => {
    const root = await mount({
      agents: [
        mate({ agent_id: "t1", teammate_name: "m", state: "idle" }),
        sub({ agent_id: "s1", description: "d", state: "done" }),
      ],
      workflows: [],
    });
    expect(toggles(root)).toEqual(["▽ idle (1)", "▶ completed (1)"]);
  });

  // 子孫が働いていれば親の行は active の区画に入る (effectiveState)
  test("働いている子を持つ completed の親は active の区画", async () => {
    const root = await mount({
      agents: [
        sub({
          agent_id: "s1",
          description: "parent",
          state: "completed",
          children: [sub({ agent_id: "c1", spawn_depth: 1, state: "active" })],
        }),
      ],
      workflows: [],
    });
    expect(toggles(root)).toEqual(["▽ active (1)"]);
  });
});
