// r46 m8 / m12: セッションツリーの左ペイン (TimelinePanes 内)。
// daemon 側で 3 グループ (Teammates / Agents / Workflows) に分けた
// AgentTreeGroups を受け取り、以下のルールで描画する:
//
// - グループヘッダは "Teammates (N live / M)" 形式。空グループはヘッダごと非表示。
// - Teammates / Agents グループ内は、live 状態 (active/idle/spawned/running) と
//   完了 (completed/stopped/done/killed/failed) を 2 分し、完了は
//   「完了 (N)」の折りたたみ (default 閉) に格納する。
// - Workflows は run 単位でネスト。run ヘッダに done/total、run の下に
//   フェーズ (title + done/total)、フェーズの下に member agent を並べる。
//   フェーズ情報が取れない (run 中で state.json 未 landing) 場合は unassigned
//   バケットに直接 member を並べる。
//
// ノード 1 行は [caret? live-dot label] の 3 要素 (r46 m3 の設計を継承)。
// 種別バッジ・description 併記は廃止。
import type {
  AgentTreeGroups,
  AgentTreeNode,
  AgentTreeWorkflowGroup,
  AgentTreeWorkflowPhase,
} from "@ccmsg/protocol";
import { useState } from "preact/hooks";
import { agentTimelineHref } from "../locator.ts";

/** live vs 完了 の 2 分類。open-set の state 語彙から live 側を列挙し、
 * それ以外はすべて完了扱い (状態未知の "unknown" も控えめに完了へ)。 */
// live 側: state.background 由来 (active/idle/spawned/running) と、workflow
// drilldown 由来 (running/progress) を包含。それ以外 (done/completed/stopped/
// killed/failed/unknown) はすべて完了扱い。
const LIVE_STATES = new Set(["active", "idle", "spawned", "running", "progress"]);
function isLive(state: string): boolean {
  return LIVE_STATES.has(state);
}

function displayLabel(node: AgentTreeNode): string {
  return node.teammate_name ?? node.description ?? node.agent_type ?? node.agent_id;
}

function dotClass(state: string): string {
  return `status-teammate-dot status-teammate-dot-${state}`;
}

function AgentTreeNodeRow({
  sid,
  node,
  workflowId,
}: {
  sid: string;
  node: AgentTreeNode;
  workflowId?: string;
}) {
  const [open, setOpen] = useState(true);
  const label = displayLabel(node);
  const href = node.teammate_name
    ? agentTimelineHref(sid, { teammate: node.teammate_name })
    : agentTimelineHref(sid, { agentId: node.agent_id });
  const hasChildren = node.children.length > 0;
  return (
    <li class="agent-tree-node" data-workflow-id={workflowId}>
      <div class="agent-tree-row">
        {hasChildren ? (
          <button
            type="button"
            class="agent-tree-caret"
            aria-expanded={open}
            aria-label={open ? "折りたたむ" : "展開する"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▽" : "▶"}
          </button>
        ) : (
          <span class="agent-tree-caret agent-tree-caret-empty" aria-hidden="true" />
        )}
        <span class={dotClass(node.state)} aria-hidden="true">
          ●
        </span>
        <a class="agent-tree-label" href={href} title={label}>
          {label}
        </a>
      </div>
      {hasChildren && open ? (
        <ul class="agent-tree-children">
          {node.children.map((child) => (
            <AgentTreeNodeRow key={child.agent_id} sid={sid} node={child} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function StandardGroup({
  sid,
  label,
  nodes,
}: {
  sid: string;
  label: string;
  nodes: AgentTreeNode[];
}) {
  const [showCompleted, setShowCompleted] = useState(false);
  if (nodes.length === 0) return null;
  const live: AgentTreeNode[] = [];
  const completed: AgentTreeNode[] = [];
  for (const n of nodes) (isLive(n.state) ? live : completed).push(n);
  return (
    <section class="agent-tree-group">
      <h3 class="agent-tree-group-header">
        {label}
        <span class="agent-tree-group-count">
          {" "}
          ({live.length} live / {nodes.length})
        </span>
      </h3>
      {live.length > 0 ? (
        <ul class="agent-tree-root">
          {live.map((n) => (
            <AgentTreeNodeRow key={n.agent_id} sid={sid} node={n} />
          ))}
        </ul>
      ) : null}
      {completed.length > 0 ? (
        <div class="agent-tree-completed">
          <button
            type="button"
            class="agent-tree-completed-toggle"
            aria-expanded={showCompleted}
            onClick={() => setShowCompleted((v) => !v)}
          >
            {showCompleted ? "▽" : "▶"} 完了 ({completed.length})
          </button>
          {showCompleted ? (
            <ul class="agent-tree-root agent-tree-completed-list">
              {completed.map((n) => (
                <AgentTreeNodeRow key={n.agent_id} sid={sid} node={n} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

function WorkflowPhaseRow({
  sid,
  phase,
  workflowId,
}: {
  sid: string;
  phase: AgentTreeWorkflowPhase;
  workflowId: string;
}) {
  const [open, setOpen] = useState(true);
  return (
    <li class="agent-tree-phase">
      <div class="agent-tree-phase-row">
        <button
          type="button"
          class="agent-tree-caret"
          aria-expanded={open}
          aria-label={open ? "折りたたむ" : "展開する"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▽" : "▶"}
        </button>
        <span class="agent-tree-phase-title">{phase.title}</span>
        <span class="agent-tree-phase-progress">
          {phase.done}/{phase.total}
        </span>
      </div>
      {open && phase.members.length > 0 ? (
        <ul class="agent-tree-children">
          {phase.members.map((m) => (
            <AgentTreeNodeRow key={m.agent_id} sid={sid} node={m} workflowId={workflowId} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function WorkflowRunRow({ sid, run }: { sid: string; run: AgentTreeWorkflowGroup }) {
  const [open, setOpen] = useState(true);
  return (
    <li class="agent-tree-workflow-run">
      <div class="agent-tree-workflow-run-row">
        <button
          type="button"
          class="agent-tree-caret"
          aria-expanded={open}
          aria-label={open ? "折りたたむ" : "展開する"}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "▽" : "▶"}
        </button>
        <span class="agent-tree-workflow-run-id" title={run.workflow_id}>
          {run.workflow_id}
        </span>
        <span class="agent-tree-workflow-run-progress">
          {run.done}/{run.total}
        </span>
      </div>
      {open ? (
        <ul class="agent-tree-children">
          {run.phases.map((p) => (
            <WorkflowPhaseRow key={p.index} sid={sid} phase={p} workflowId={run.workflow_id} />
          ))}
          {run.unassigned.length > 0 ? (
            <li class="agent-tree-phase agent-tree-phase-unassigned">
              <div class="agent-tree-phase-row">
                <span class="agent-tree-caret agent-tree-caret-empty" aria-hidden="true" />
                <span class="agent-tree-phase-title">(phase 未確定)</span>
              </div>
              <ul class="agent-tree-children">
                {run.unassigned.map((m) => (
                  <AgentTreeNodeRow
                    key={m.agent_id}
                    sid={sid}
                    node={m}
                    workflowId={run.workflow_id}
                  />
                ))}
              </ul>
            </li>
          ) : null}
        </ul>
      ) : null}
    </li>
  );
}

function WorkflowsGroup({ sid, runs }: { sid: string; runs: AgentTreeWorkflowGroup[] }) {
  const [showCompleted, setShowCompleted] = useState(false);
  if (runs.length === 0) return null;
  const liveRuns: AgentTreeWorkflowGroup[] = [];
  const completedRuns: AgentTreeWorkflowGroup[] = [];
  for (const r of runs) {
    // done < total = まだ動いている run、done === total = 完了。
    (r.total === 0 || r.done < r.total ? liveRuns : completedRuns).push(r);
  }
  return (
    <section class="agent-tree-group">
      <h3 class="agent-tree-group-header">
        Workflows
        <span class="agent-tree-group-count">
          {" "}
          ({liveRuns.length} live / {runs.length})
        </span>
      </h3>
      {liveRuns.length > 0 ? (
        <ul class="agent-tree-root">
          {liveRuns.map((r) => (
            <WorkflowRunRow key={r.workflow_id} sid={sid} run={r} />
          ))}
        </ul>
      ) : null}
      {completedRuns.length > 0 ? (
        <div class="agent-tree-completed">
          <button
            type="button"
            class="agent-tree-completed-toggle"
            aria-expanded={showCompleted}
            onClick={() => setShowCompleted((v) => !v)}
          >
            {showCompleted ? "▽" : "▶"} 完了 ({completedRuns.length})
          </button>
          {showCompleted ? (
            <ul class="agent-tree-root agent-tree-completed-list">
              {completedRuns.map((r) => (
                <WorkflowRunRow key={r.workflow_id} sid={sid} run={r} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function AgentTreePanel({ sid, tree }: { sid: string; tree: AgentTreeGroups }) {
  return (
    <div class="agent-tree-panel">
      <StandardGroup sid={sid} label="Teammates" nodes={tree.teammates} />
      <StandardGroup sid={sid} label="Agents" nodes={tree.agents} />
      <WorkflowsGroup sid={sid} runs={tree.workflows} />
    </div>
  );
}
