import type {
  AgentTreeNode,
  AgentTreeWorkflowGroup,
  AgentTreeWorkflowPhase,
} from "@ccmsg/protocol";
import { describe, expect, test } from "bun:test";
import {
  agentNodeHref,
  countNodeErrors,
  countPhaseErrors,
  countRunErrors,
  countRunsErrors,
  dotProps,
  isRunLive,
  runDotProps,
  type NodeStateResolver,
} from "../src/client/components/agent-tree-view.ts";

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

// kawaz r99 m34: 「ワークスペースの一部がエラーしてても、フォルド全て開くまで
// 分からない」。error は最下層 member 行にしか出ていなかったので、祖先行
// (phase / run / セクション) に伝播させる集計を純関数として検証する。
describe("error の祖先伝播 (畳んだ行から異常が分かる)", () => {
  // 行表示と同じ優先順位 (workflow drilldown 由来の state → node.state)。
  const byDrill = (drill: Record<string, string>): NodeStateResolver => {
    return (n) => drill[n.agent_id] ?? n.state;
  };
  const plain: NodeStateResolver = (n) => n.state;

  const phase = (index: number, members: AgentTreeNode[]): AgentTreeWorkflowPhase => ({
    index,
    title: `phase ${index}`,
    done: 0,
    total: members.length,
    members,
  });
  const run = (over: Partial<AgentTreeWorkflowGroup> = {}): AgentTreeWorkflowGroup => ({
    workflow_id: "wf_e1deb606-05d",
    done: 3,
    total: 4,
    phases: [],
    unassigned: [],
    ...over,
  });

  test("error / failed を数え、それ以外は数えない", () => {
    const nodes = [
      node({ agent_id: "a1", state: "error" }),
      node({ agent_id: "a2", state: "failed" }),
      node({ agent_id: "a3", state: "running" }),
      node({ agent_id: "a4", state: "done" }),
    ];
    expect(countNodeErrors(nodes, plain)).toBe(2);
  });

  test("孫以下の error も数える (children を再帰)", () => {
    const nodes = [
      node({
        agent_id: "parent",
        state: "running",
        children: [node({ agent_id: "child", state: "error" })],
      }),
    ];
    expect(countNodeErrors(nodes, plain)).toBe(1);
  });

  // member 行の state は drilldown 由来が優先 (node.state は fold 由来で
  // error を持たない)。集計が node.state だけを見ると 0 件になってしまう。
  test("drilldown 由来の state で判定する", () => {
    const members = [node({ agent_id: "a1", state: "stopped" })];
    expect(countPhaseErrors(phase(2, members), plain)).toBe(0);
    expect(countPhaseErrors(phase(2, members), byDrill({ a1: "error" }))).toBe(1);
  });

  test("run は全 phase と phase 未確定 bucket を合算する", () => {
    const r = run({
      phases: [
        phase(1, [node({ agent_id: "a1", state: "done" })]),
        phase(2, [node({ agent_id: "a2", state: "error" })]),
      ],
      unassigned: [node({ agent_id: "a3", state: "error" })],
    });
    expect(countRunErrors(r, plain)).toBe(2);
    expect(countRunsErrors([r, run()], plain)).toBe(2);
  });

  test("error が無ければ 0 (バッジ非表示の条件)", () => {
    expect(
      countRunErrors(run({ phases: [phase(1, [node({ agent_id: "a1", state: "done" })])] }), plain),
    ).toBe(0);
  });
});

describe("runDotProps (live と error の 2 軸を両方読ませる)", () => {
  const live = { workflow_id: "wf_x", done: 3, total: 4, phases: [], unassigned: [] };
  const finished = { workflow_id: "wf_x", done: 4, total: 4, phases: [], unassigned: [] };

  test("error 無しは従来通り live / 完了 の色分けのみ", () => {
    expect(runDotProps(live, 0)).toEqual(dotProps("running"));
    expect(runDotProps(finished, 0)).toEqual(dotProps("done"));
  });

  // 走行中の緑を error 色で塗り潰すと「走っているのか止まったのか」が読めなく
  // なるので、live 色 + halo で両方出す。
  test("live + error は live 色を保ったまま halo を足す", () => {
    const props = runDotProps(live, 1);
    expect(props.class).toContain("status-teammate-dot-active");
    expect(props.class).toContain("status-teammate-dot-error-halo");
  });

  test("完了 run の error は danger 色そのもの", () => {
    expect(runDotProps(finished, 1)).toEqual(dotProps("error"));
  });
});
