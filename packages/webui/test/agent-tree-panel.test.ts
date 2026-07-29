import type { AgentTreeNode } from "@ccmsg/protocol";
import { describe, expect, test } from "bun:test";
import { agentNodeHref, dotProps, isRunLive } from "../src/client/components/agent-tree-view.ts";

function node(over: Partial<AgentTreeNode> & Pick<AgentTreeNode, "agent_id">): AgentTreeNode {
  return {
    kind: "subagent",
    spawn_depth: 0,
    state: "unknown",
    children: [],
    ...over,
  };
}

describe("agentNodeHref (workflow member の TL リンク)", () => {
  // kawaz r76 m66 で報告された不具合の再現: workflow 配下の agent へ
  // `agent/sub/<id>` を張ると、transcript は
  // `subagents/workflows/<runId>/agent-<id>.jsonl` にあるため daemon が
  // 解決できず "agent transcript not found" になる。
  test("workflow_member は runId 付きの wf 形になる", () => {
    expect(
      agentNodeHref(
        "c6acf819-3bc6-4055-955b-b49f67f7afe8",
        node({
          agent_id: "aa9b5766228ee68a7",
          kind: "workflow_member",
          workflow_id: "wf_aa34c49a-9f1",
        }),
      ),
    ).toBe(
      "/s/c6acf819-3bc6-4055-955b-b49f67f7afe8/timeline/agent/wf/wf_aa34c49a-9f1/aa9b5766228ee68a7",
    );
  });

  test("workflow_id を持たない subagent は従来通り sub 形", () => {
    expect(agentNodeHref("s1", node({ agent_id: "a123456" }))).toBe(
      "/s/s1/timeline/agent/sub/a123456",
    );
  });

  // teammate は agentId ではなく teammate 名が観測可能な identity (locator.ts)。
  test("teammate は workflow_id の有無に関わらず tm 形", () => {
    expect(agentNodeHref("s1", node({ agent_id: "a123456", teammate_name: "reviewer" }))).toBe(
      "/s/s1/timeline/agent/tm/reviewer",
    );
  });
});

describe("dotProps (state → dot 色語彙の正規化)", () => {
  // 同じく r76 m66: workflow drilldown の state 語彙 (running/done/…) は
  // CSS の status-teammate-dot-* に無く、正規化前は全部が未定義 class に
  // なって running と done が同じ見た目だった。
  test("running と done が別の class になる", () => {
    const running = dotProps("running").class;
    const done = dotProps("done").class;
    expect(running).toBe("status-teammate-dot status-teammate-dot-active");
    expect(done).toBe("status-teammate-dot status-teammate-dot-stopped");
    expect(running).not.toBe(done);
  });

  test("progress は active、pending は spawned に寄る", () => {
    expect(dotProps("progress").class).toBe("status-teammate-dot status-teammate-dot-active");
    expect(dotProps("pending").class).toBe("status-teammate-dot status-teammate-dot-spawned");
  });

  // error は対応する dot class が CSS に無いので色だけ直接当てる。
  test("error / failed は danger 色", () => {
    for (const state of ["error", "failed"]) {
      expect(dotProps(state)).toEqual({
        class: "status-teammate-dot",
        style: "color: var(--danger)",
      });
    }
  });

  test("CSS に class がある state はそのまま通す", () => {
    for (const state of ["active", "idle", "spawned", "stopped", "unknown"]) {
      expect(dotProps(state).class).toBe(`status-teammate-dot status-teammate-dot-${state}`);
    }
  });

  // state は open-set。未知語彙が来ても無色 (= 区別不能) に落ちないよう
  // unknown へ寄せる。
  test("未知の state は unknown に寄る", () => {
    expect(dotProps("brand-new-state").class).toBe(
      "status-teammate-dot status-teammate-dot-unknown",
    );
  });
});

describe("isRunLive (run 行 dot と live/完了 振り分けの共有判定)", () => {
  test("done < total は走行中", () => {
    expect(
      isRunLive({ workflow_id: "wf_a1b2c3d4-e5f", done: 2, total: 6, phases: [], unassigned: [] }),
    ).toBe(true);
  });

  test("done === total は完了", () => {
    expect(
      isRunLive({ workflow_id: "wf_a1b2c3d4-e5f", done: 6, total: 6, phases: [], unassigned: [] }),
    ).toBe(false);
  });

  // state.json 未 landing の run は total 0 で観測される (完了ではない)。
  test("total 0 は走行中扱い", () => {
    expect(
      isRunLive({ workflow_id: "wf_a1b2c3d4-e5f", done: 0, total: 0, phases: [], unassigned: [] }),
    ).toBe(true);
  });
});
