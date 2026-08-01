// AgentTreePanel の描画から切り出した純関数 (リンク先の組み立てと dot 色語彙の
// 正規化)。JSX を含まないので bun test から直接叩ける
// (timeline-item-markdown.ts と同じ分離)。
import type {
  AgentTreeNode,
  AgentTreeWorkflowGroup,
  AgentTreeWorkflowPhase,
} from "@ccmsg/protocol";
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

export function isErrorState(state: string): boolean {
  return DOT_ERROR_STATES.has(state);
}

/** member 1 行の実効 state を返す解決関数。workflow member は drilldown 由来の
 * state (done/running/error/…) が node.state より正確なので、呼び出し側が
 * drillLookup を閉じ込めた resolver を渡す (行表示側と同じ優先順位)。 */
export type NodeStateResolver = (node: AgentTreeNode) => string;

/** 子孫を含む error 数。祖先行 (phase / run / セクション見出し) に「畳んだ
 * ままでも異常が分かる」表示を出すための集計 (kawaz r99 m34)。 */
export function countNodeErrors(nodes: AgentTreeNode[], resolveState: NodeStateResolver): number {
  let n = 0;
  for (const node of nodes) {
    if (isErrorState(resolveState(node))) n++;
    n += countNodeErrors(node.children, resolveState);
  }
  return n;
}

export function countPhaseErrors(
  phase: AgentTreeWorkflowPhase,
  resolveState: NodeStateResolver,
): number {
  return countNodeErrors(phase.members, resolveState);
}

/** run 配下 (全 phase + phase 未確定 bucket) の error 数。 */
export function countRunErrors(
  run: AgentTreeWorkflowGroup,
  resolveState: NodeStateResolver,
): number {
  let n = countNodeErrors(run.unassigned, resolveState);
  for (const phase of run.phases) n += countPhaseErrors(phase, resolveState);
  return n;
}

export function countRunsErrors(
  runs: AgentTreeWorkflowGroup[],
  resolveState: NodeStateResolver,
): number {
  return runs.reduce((n, run) => n + countRunErrors(run, resolveState), 0);
}

/** run 行の dot。
 *
 * Design rationale: 走行状態 (live/完了) と異常有無は直交する軸なので、error を
 * dot 色で塗り潰すと「走っているのか止まったのか」が読めなくなる。完了 run は
 * 走行状態の情報量が無いので danger 色に倒し、live run は live 色を保ったまま
 * danger の halo を重ねて両方読めるようにする (kawaz r99 m34 の受け入れ条件
 *「畳んだ状態で異常が分かる」を満たしつつ live 表示を壊さない)。 */
export function runDotProps(
  run: AgentTreeWorkflowGroup,
  errorCount: number,
): { class: string; style?: string } {
  const live = isRunLive(run);
  if (errorCount === 0) return dotProps(live ? "running" : "done");
  if (!live) return dotProps("error");
  const base = dotProps("running");
  return { ...base, class: `${base.class} status-teammate-dot-error-halo` };
}
