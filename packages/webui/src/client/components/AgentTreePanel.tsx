// r46 m8 / m12 / m17: セッションツリーの左ペイン (TimelinePanes 内)。
// daemon 側で 3 グループ (Teammates / Agents / Workflows) に分けた
// AgentTreeGroups を受け取り、以下のルールで描画する:
//
// - グループヘッダは "Teammates (N live / M)" 形式。空グループはヘッダごと非表示。
// - Teammates / Agents グループ内は、ノードを state 単位のサブグループに
//   分け、それぞれ折りたたみ可能に。default 開閉は「動いている系
//   (active/running/progress/spawned) = 開、idle = 閉、完了系 (stopped/
//   completed/done/killed/failed/unknown) = 閉」。数十体ぶら下がって縦に
//   伸びるのを畳むための r46 m17 対応。
// - Workflows は run 単位でネスト。run ヘッダに done/total、run の下に
//   フェーズ (title + done/total)、フェーズの下に member agent を並べる。
//   フェーズ情報が取れない (run 中で state.json 未 landing) 場合は unassigned
//   バケットに直接 member を並べる。Workflows は既にフェーズ構造で
//   ネストされているため state 別サブグループ化はしない。
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

// state サブグループの表示順。動いている系 → idle → 完了系 → その他 (未知)。
// 明示列挙外の state は末尾に出て、初回登場順を保つ。
const STATE_ORDER = [
  "active",
  "running",
  "progress",
  "spawned",
  "idle",
  "stopped",
  "completed",
  "done",
  "killed",
  "failed",
  "unknown",
];

// default 展開する state (動いている系のみ)。kawaz r46 m17 の指示に基づき、
// idle と 完了系はデフォルト畳む。
const DEFAULT_OPEN_STATES = new Set(["active", "running", "progress", "spawned"]);

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

/** state ごとにグループ化。STATE_ORDER に載っている state を先頭順で、
 * 載っていない state は初回登場順で末尾に並べる。 */
function groupByState(nodes: AgentTreeNode[]): Array<[string, AgentTreeNode[]]> {
  const buckets = new Map<string, AgentTreeNode[]>();
  for (const n of nodes) {
    const key = n.state || "unknown";
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = [];
      buckets.set(key, bucket);
    }
    bucket.push(n);
  }
  const ordered: Array<[string, AgentTreeNode[]]> = [];
  for (const s of STATE_ORDER) {
    const b = buckets.get(s);
    if (b) {
      ordered.push([s, b]);
      buckets.delete(s);
    }
  }
  // STATE_ORDER 外の未知 state は初回登場順で末尾へ。
  for (const [s, b] of buckets) ordered.push([s, b]);
  return ordered;
}

function StateSubgroup({
  sid,
  state,
  nodes,
  isCompleted,
}: {
  sid: string;
  state: string;
  nodes: AgentTreeNode[];
  isCompleted: boolean;
}) {
  const [open, setOpen] = useState(DEFAULT_OPEN_STATES.has(state));
  return (
    <div class={isCompleted ? "agent-tree-completed" : "agent-tree-state-group"}>
      <button
        type="button"
        class="agent-tree-completed-toggle"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {open ? "▽" : "▶"} {state} ({nodes.length})
      </button>
      {open ? (
        <ul class={isCompleted ? "agent-tree-root agent-tree-completed-list" : "agent-tree-root"}>
          {nodes.map((n) => (
            <AgentTreeNodeRow key={n.agent_id} sid={sid} node={n} />
          ))}
        </ul>
      ) : null}
    </div>
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
  if (nodes.length === 0) return null;
  const liveCount = nodes.reduce((acc, n) => acc + (isLive(n.state) ? 1 : 0), 0);
  const groups = groupByState(nodes);
  return (
    <section class="agent-tree-group">
      <h3 class="agent-tree-group-header">
        {label}
        <span class="agent-tree-group-count">
          {" "}
          ({liveCount} live / {nodes.length})
        </span>
      </h3>
      {groups.map(([state, ns]) => (
        <StateSubgroup
          key={state}
          sid={sid}
          state={state}
          nodes={ns}
          isCompleted={!isLive(state)}
        />
      ))}
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
