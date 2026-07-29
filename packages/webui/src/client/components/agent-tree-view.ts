// AgentTreePanel の描画から切り出した純関数 (リンク先の組み立てと dot 色語彙の
// 正規化)。JSX を含まないので bun test から直接叩ける
// (timeline-item-markdown.ts と同じ分離)。
import type { AgentTreeNode, AgentTreeWorkflowGroup } from "@ccmsg/protocol";
import { agentTimelineHref } from "../locator.ts";

/** ツリー 1 ノードの TL リンク先。workflow member の transcript は
 * `subagents/workflows/<runId>/agent-<id>.jsonl` にあり、runId を落とした
 * `agent/sub/<id>` 形では daemon 側が解決できず "agent transcript not found"
 * になる。node.workflow_id (daemon が workflow_member にだけ付ける) を
 * そのまま runId として渡す。 */
export function agentNodeHref(sid: string, node: AgentTreeNode): string {
  if (node.teammate_name) return agentTimelineHref(sid, { teammate: node.teammate_name });
  return agentTimelineHref(sid, {
    agentId: node.agent_id,
    ...(node.workflow_id ? { runId: node.workflow_id } : {}),
  });
}

// dot の色語彙は CSS 側の 5 種 (active / idle / spawned / stopped / unknown)
// だけ。一方 state は open-set で、fold 由来 (active/idle/spawned/stopped/…) と
// workflow drilldown 由来 (running/progress/pending/done/error) が混ざる。
// 正規化せずに `status-teammate-dot-${state}` を組むと、workflow member は
// 全部が未定義 class になって running と done が同じ見た目になる。
const DOT_STATE_ALIASES: Record<string, string> = {
  running: "active",
  progress: "active",
  pending: "spawned",
  done: "stopped",
  completed: "stopped",
  killed: "stopped",
};
const DOT_STATE_CLASSES = new Set(["active", "idle", "spawned", "stopped", "unknown"]);
// error / failed に対応する dot class は CSS に無いため色だけ直接当てる。
const DOT_ERROR_STATES = new Set(["error", "failed"]);

export function dotProps(state: string): { class: string; style?: string } {
  if (DOT_ERROR_STATES.has(state)) {
    return { class: "status-teammate-dot", style: "color: var(--danger)" };
  }
  const canonical = DOT_STATE_ALIASES[state] ?? (DOT_STATE_CLASSES.has(state) ? state : "unknown");
  return { class: `status-teammate-dot status-teammate-dot-${canonical}` };
}

/** done < total = まだ動いている run、done === total = 完了。total 0 は
 * member 未 landing の走行中扱い。run 行の dot と Workflows セクションの
 * live/完了 振り分けが食い違わないよう 1 箇所に置く。 */
export function isRunLive(run: AgentTreeWorkflowGroup): boolean {
  return run.total === 0 || run.done < run.total;
}
