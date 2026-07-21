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
  SessionWorkflowStatus,
} from "@ccmsg/protocol";
import { useState } from "preact/hooks";
import { agentTimelineHref } from "../locator.ts";
import {
  buildWorkflowDrilldown,
  canonicalModelId,
  dedupeWorkflowRunsByRunId,
  type WorkflowDrilldownAgentView,
} from "../session-status-view.ts";

/** issue 2026-07-21 (workflow TUI parity): agentId → workflow drilldown view の
 * 逆引き。同一 agentId が複数 run に出現する事はない (workflows/<runId>/ の
 * 一意 subagent id) が、pause→resume で同じ run が複数 Workflow toolUseResult
 * を持つ場合に備えて dedup 後の workflows から作る。呼び出し側 (TimelinePanes)
 * が snapshot.workflows を渡さない場合は空 Map (enrichment 無し)。 */
function buildAgentDrillLookup(
  workflows: SessionWorkflowStatus[] | undefined,
): Map<string, WorkflowDrilldownAgentView> {
  const map = new Map<string, WorkflowDrilldownAgentView>();
  if (!workflows) return map;
  for (const wf of dedupeWorkflowRunsByRunId(workflows)) {
    const drill = buildWorkflowDrilldown(wf);
    if (!drill) continue;
    for (const a of drill.agents) {
      if (!map.has(a.agentId)) map.set(a.agentId, a);
    }
  }
  return map;
}

function formatTokens(tokens: number | undefined): string | null {
  if (tokens === undefined) return null;
  if (tokens < 1000) return `${tokens}`;
  return `${Math.round(tokens / 1000)}k`;
}

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
  drillLookup,
}: {
  sid: string;
  node: AgentTreeNode;
  workflowId?: string;
  /** issue 2026-07-21 (workflow TUI parity): agentId → drilldown view lookup。
   * Workflows section の member 行にモデル名/tokens/state 注記を出すためだけに
   * 参照する (teammate / agent section の node には無い情報)。 */
  drillLookup?: Map<string, WorkflowDrilldownAgentView>;
}) {
  const [open, setOpen] = useState(true);
  const label = displayLabel(node);
  const href = node.teammate_name
    ? agentTimelineHref(sid, { teammate: node.teammate_name })
    : agentTimelineHref(sid, { agentId: node.agent_id });
  const hasChildren = node.children.length > 0;
  // Drill enrichment は workflow_member (workflowId prop 経由) 限定。
  // teammate/agent 側 node には tokens 情報が無いので drillLookup を引かない
  // (agentId 衝突は理論上無いが、責務境界を UI 側にも残す)。
  const drill = workflowId ? drillLookup?.get(node.agent_id) : undefined;
  const modelRaw = node.model ?? drill?.model;
  const modelDisplay = modelRaw ? canonicalModelId(modelRaw) : null;
  const tokensLabel = formatTokens(drill?.tokens);
  // state 注記: workflow member は drill.state (done / running / error /
  // progress / pending) を優先。それ以外は node.state (fold 由来)。
  const stateNote = drill?.state ?? node.state;
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
        {modelDisplay ? <span class="agent-tree-model">{modelDisplay}</span> : null}
        {tokensLabel ? <span class="agent-tree-tokens">{tokensLabel} tok</span> : null}
        {stateNote ? <span class="agent-tree-state-note">{stateNote}</span> : null}
      </div>
      {hasChildren && open ? (
        <ul class="agent-tree-children">
          {node.children.map((child) => (
            <AgentTreeNodeRow
              key={child.agent_id}
              sid={sid}
              node={child}
              drillLookup={drillLookup}
            />
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
  drillLookup,
}: {
  sid: string;
  phase: AgentTreeWorkflowPhase;
  workflowId: string;
  drillLookup?: Map<string, WorkflowDrilldownAgentView>;
}) {
  // kawaz r46 mid=27: workflow 配下は内部含めて default 全閉
  const [open, setOpen] = useState(false);
  // issue 2026-07-21 (#3): 宣言済みだが member 0 & total 0 の phase は「未開始」
  // として淡色表示 (index + title、TUI の「3 Finalize」形式)。members が居るが
  // 未 done は running 側なので dim にしない (done < total は進行中)。
  const isEmpty = phase.members.length === 0 && phase.total === 0;
  const cls = "agent-tree-phase" + (isEmpty ? " agent-tree-phase-empty" : "");
  return (
    <li class={cls}>
      <div class="agent-tree-phase-row">
        {isEmpty ? (
          <span class="agent-tree-caret agent-tree-caret-empty" aria-hidden="true" />
        ) : (
          <button
            type="button"
            class="agent-tree-caret"
            aria-expanded={open}
            aria-label={open ? "折りたたむ" : "展開する"}
            onClick={() => setOpen((v) => !v)}
          >
            {open ? "▽" : "▶"}
          </button>
        )}
        <span class="agent-tree-phase-index">{phase.index}</span>
        <span class="agent-tree-phase-title">{phase.title}</span>
        {isEmpty ? null : (
          <span class="agent-tree-phase-progress">
            {/* kawaz r46 mid=27: 全完了は頭に ✓ */}
            {phase.done >= phase.total && phase.total > 0 ? "✓ " : ""}
            {phase.done}/{phase.total}
          </span>
        )}
      </div>
      {open && phase.members.length > 0 ? (
        <ul class="agent-tree-children">
          {phase.members.map((m) => (
            <AgentTreeNodeRow
              key={m.agent_id}
              sid={sid}
              node={m}
              workflowId={workflowId}
              drillLookup={drillLookup}
            />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

function WorkflowRunRow({
  sid,
  run,
  drillLookup,
}: {
  sid: string;
  run: AgentTreeWorkflowGroup;
  drillLookup?: Map<string, WorkflowDrilldownAgentView>;
}) {
  // kawaz r46 mid=27: workflow 配下は内部含めて default 全閉
  const [open, setOpen] = useState(false);
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
          {/* kawaz r46 mid=27: 全完了は頭に ✓ */}
          {run.done >= run.total && run.total > 0 ? "✓ " : ""}
          {run.done}/{run.total}
        </span>
      </div>
      {open ? (
        <ul class="agent-tree-children">
          {run.phases.map((p) => (
            <WorkflowPhaseRow
              key={p.index}
              sid={sid}
              phase={p}
              workflowId={run.workflow_id}
              drillLookup={drillLookup}
            />
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
                    drillLookup={drillLookup}
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

function WorkflowsGroup({
  sid,
  runs,
  drillLookup,
}: {
  sid: string;
  runs: AgentTreeWorkflowGroup[];
  drillLookup?: Map<string, WorkflowDrilldownAgentView>;
}) {
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
            <WorkflowRunRow key={r.workflow_id} sid={sid} run={r} drillLookup={drillLookup} />
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
                <WorkflowRunRow key={r.workflow_id} sid={sid} run={r} drillLookup={drillLookup} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}

export function AgentTreePanel({
  sid,
  tree,
  workflows,
}: {
  sid: string;
  tree: AgentTreeGroups;
  /** issue 2026-07-21 (workflow TUI parity): Status タブの workflow drilldown と
   * 同じ SessionWorkflowStatus[] を渡すと、workflow member 行に model / tokens /
   * state 注記が付く (無ければ従来通り [dot label] だけ)。 */
  workflows?: SessionWorkflowStatus[];
}) {
  const drillLookup = buildAgentDrillLookup(workflows);
  return (
    <div class="agent-tree-panel">
      <StandardGroup sid={sid} label="Teammates" nodes={tree.teammates} />
      <StandardGroup sid={sid} label="Agents" nodes={tree.agents} />
      <WorkflowsGroup sid={sid} runs={tree.workflows} drillLookup={drillLookup} />
    </div>
  );
}
