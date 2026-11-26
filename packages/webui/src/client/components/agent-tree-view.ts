// AgentTreePanel の描画から切り出した純関数 (リンク先の組み立てと dot 色語彙の
// 正規化)。JSX を含まないので bun test から直接叩ける
// (timeline-item-markdown.ts と同じ分離)。
import type {
  AgentTreeGroups,
  AgentTreeNode,
  AgentTreeWorkflowGroup,
  AgentTreeWorkflowPhase,
  SessionStatusSnapshot,
} from "@ccmsg/protocol";
import { agentTimelineHref, type AgentRef } from "../locator.ts";
import { dedupeWorkflowRunsByRunId, shortModel } from "../session-status-view.ts";

/** Timeline の 🤖 バブルが名前の右に出す model と effort の綴り
 * (`(fable-5-1/low)`、ctx 行と同じ shortModel)。実際に答えている model
 * (`running_model`、agent の transcript の最新の assistant 行) を優先し、
 * 無い時は meta.json の model。effort は running_model と同じ行の値なので、
 * それが無ければ model だけ。 */
export function agentEngineLabel(node: AgentTreeNode): string | undefined {
  const model = node.running_model ?? node.model;
  if (model === undefined) return undefined;
  const effort = node.running_model !== undefined ? node.effort : undefined;
  return `(${shortModel(model)}${effort !== undefined ? `/${effort}` : ""})`;
}

/** 区画の中の 1 行: ノードと、行に出す effort (分からなければ無し)。 */
export interface AgentModelRow {
  node: AgentTreeNode;
  effort?: string;
}

/** 区画の中の model の見出し 1 つ分。`model` は見出しの語 (行の model の表示
 * と同じ shortModel の綴り)、分からない agent の見出しは無し。 */
export interface AgentModelGroup {
  model?: string;
  rows: AgentModelRow[];
}

// 見出しの並びの上位の model の系統。これ以外の model はこの後に名前の順。
const MODEL_FAMILY_ORDER = ["mythos", "fable", "opus", "sonnet", "haiku"];
const EFFORT_ORDER = ["max", "xhigh", "high", "medium", "low"];

function modelRank(model: string): number {
  const rank = MODEL_FAMILY_ORDER.findIndex((f) => model === f || model.startsWith(`${f}-`));
  return rank === -1 ? MODEL_FAMILY_ORDER.length : rank;
}

function effortRank(effort: string | undefined): number {
  const rank = effort === undefined ? -1 : EFFORT_ORDER.indexOf(effort);
  return rank === -1 ? EFFORT_ORDER.length : rank;
}

/** 区画の中の行を model の見出しで分ける (DR-0020 Addendum 2026-11-06)。model は
 * `agentEngineLabel` と同じく running_model、無ければ meta.json の model で、
 * effort は running_model と同じ行の値。見出しは mythos・fable・opus・sonnet・
 * haiku の順、それ以外を名前の順、最後に model の分からないもの。見出しの中は
 * effort の高い順、同じ effort の中は渡された順。 */
export function groupByModel(nodes: readonly AgentTreeNode[]): AgentModelGroup[] {
  const byModel = new Map<string | undefined, AgentModelRow[]>();
  for (const node of nodes) {
    const raw = node.running_model ?? node.model;
    const model = raw === undefined ? undefined : shortModel(raw);
    const effort = node.running_model !== undefined ? node.effort : undefined;
    const row: AgentModelRow = effort === undefined ? { node } : { node, effort };
    const rows = byModel.get(model);
    if (rows) rows.push(row);
    else byModel.set(model, [row]);
  }
  const groups = [...byModel].map(([model, rows]): AgentModelGroup => {
    const sorted = rows.toSorted((a, b) => effortRank(a.effort) - effortRank(b.effort));
    return model === undefined ? { rows: sorted } : { model, rows: sorted };
  });
  return groups.toSorted((a, b) => {
    if (a.model === undefined || b.model === undefined) {
      return (a.model === undefined ? 1 : 0) - (b.model === undefined ? 1 : 0);
    }
    const byName = a.model < b.model ? -1 : a.model > b.model ? 1 : 0;
    return modelRank(a.model) - modelRank(b.model) || byName;
  });
}

/** spawn の Agent call が渡した model (preset の alias) を同じ綴りにする。
 * 実物 (agent tree のノード) が取れない時だけ使う。 */
export function spawnModelLabel(model: string): string {
  return `(${shortModel(model)})`;
}

function* allAgentNodes(tree: AgentTreeGroups): Generator<AgentTreeNode> {
  function* walk(nodes: readonly AgentTreeNode[]): Generator<AgentTreeNode> {
    for (const node of nodes) {
      yield node;
      yield* walk(node.children);
    }
  }
  yield* walk(tree.agents);
  for (const run of tree.workflows) {
    for (const phase of run.phases) yield* walk(phase.members);
    yield* walk(run.unassigned);
  }
}

// 「動いている」とみなす state (グループ分類の active 昇格判定と、働いている
// agent の数に使う)。idle (仕事待ちの teammate) と完了系は含めない。
const WORKING_STATES = new Set(["active", "running", "progress"]);

/** 区画分けと数え方で active と同じに扱う state。spawned は起動の指令で動いて
 * いる teammate で、2 度目以降の指令で動いている active との違いはそれだけ
 * (kawaz 2026-11-24「区別する意味はほとんどない」)。daemon の state の値は
 * そのまま。 */
function groupedState(state: string): string {
  return state === "spawned" ? "active" : state || "unknown";
}

/** グループ分類に使う実効 state (spawned は active)。自分は idle 等でも子孫に
 * active/running/progress/spawned がいれば、その働いている state に昇格させる (kawaz r55 m44:
 * サブサブエージェントが active なのに親が idle でグループが idle タブに
 * 沈み、普段閉じているタブのせいで「仕事していない」ように見える)。
 * 行単位の state 表示 (dot / state note) は node.state のまま — 昇格は
 * どのサブグループに入れるかの分類だけに効かせる。 */
export function effectiveState(node: AgentTreeNode): string {
  const own = groupedState(node.state);
  if (WORKING_STATES.has(own)) return own;
  for (const child of node.children) {
    const eff = effectiveState(child);
    if (WORKING_STATES.has(eff)) return eff;
  }
  return own;
}

/** エージェントのリストの Agents の節の区画 (DR-0020 Addendum 2026-11-06)。
 * 上から active / idle / completed / unknown の順に並ぶ。 */
export type AgentListSection = "active" | "idle" | "completed" | "unknown";

/** 終わった state。失敗したもの (failed / error) もここに入り、点の色だけが
 * 失敗を示す。 */
const ENDED_STATES = new Set(["completed", "done", "stopped", "killed", "failed", "error"]);

/** 行が入る区画。実効 state (`effectiveState`) で決める: 働いている state
 * (active / running / progress、spawned は active) は active、idle は idle、
 * 終わった state は completed、そのどれでもないものは unknown。 */
export function agentListSection(node: AgentTreeNode): AgentListSection {
  const state = effectiveState(node);
  if (WORKING_STATES.has(state)) return "active";
  if (state === "idle") return "idle";
  if (ENDED_STATES.has(state)) return "completed";
  return "unknown";
}

/** セッションの agent・workflow の run のうち、今動いているものの数 (DR-0054
 * §4 の末尾の active agent の数)。エージェントのリストと同じ分け方で数える:
 * Agents の節は最上位の行のうち active の区画 (`agentListSection`) に入る行、
 * Workflows の節は live の側に入る run (`isRunLive`) を 1 つ 1 と数える。子の
 * agent は親の行に、run の中の agent は run に含めて別に数えない。仕事待ち
 * (idle) と完了したものは数えない。 */
export function workingAgentCount(tree: AgentTreeGroups | undefined): number {
  if (tree === undefined) return 0;
  const agents = tree.agents.filter((node) => agentListSection(node) === "active").length;
  return agents + tree.workflows.filter(isRunLive).length;
}

/** 名前 (spawn の name、teammate の名前) → `agentEngineLabel`。バブルは名前
 * (SendMessage の宛先、spawn の name、relay の送り手) で agent を引く。同じ
 * 名前の agent が複数いれば last_activity_ms の新しい方。 */
export function agentEngineLabelsByName(
  tree: AgentTreeGroups | undefined,
): ReadonlyMap<string, string> {
  const picked = new Map<string, { at: number; label: string }>();
  if (tree === undefined) return new Map();
  for (const node of allAgentNodes(tree)) {
    const name = node.name ?? node.teammate_name;
    const label = agentEngineLabel(node);
    if (name === undefined || label === undefined) continue;
    const at = node.last_activity_ms ?? 0;
    const current = picked.get(name);
    if (current === undefined || at > current.at) picked.set(name, { at, label });
  }
  return new Map([...picked].map(([name, { label }]) => [name, label]));
}

/** Timeline の 🤖 カードの名前 → その agent の TL (DR-0025 §6)。teammate は
 * 名前で、workflow の agent は掘り下げの `label` で引く。teammate の名前と
 * 重なる label と、複数の agent に同じ label があるものはリンクにしない。
 * pause / resume で同じ run が複数の Workflow の結果を持つ時は、agent tree
 * と同じく run_id ごとに 1 つにまとめてから数える (同じ agent を 2 回数えて
 * 同じ label の別の agent と取り違えない)。 */
export function agentTimelineHrefsByName(
  sid: string,
  sessionStatus: SessionStatusSnapshot | undefined,
): ReadonlyMap<string, string> {
  const hrefs = new Map<string, string>();
  if (!sessionStatus) return hrefs;

  const teammateNames = new Set<string>();
  for (const teammate of sessionStatus.teammates ?? []) {
    teammateNames.add(teammate.name);
    hrefs.set(teammate.name, agentTimelineHref(sid, { teammate: teammate.name }));
  }

  const ambiguousWorkflowNames = new Set<string>();
  for (const workflow of dedupeWorkflowRunsByRunId(sessionStatus.workflows)) {
    if (!workflow.run_id) continue;
    for (const workflowAgent of workflow.agents ?? []) {
      const name = workflowAgent.label;
      if (!name || teammateNames.has(name) || ambiguousWorkflowNames.has(name)) continue;
      if (hrefs.has(name)) {
        hrefs.delete(name);
        ambiguousWorkflowNames.add(name);
        continue;
      }
      hrefs.set(
        name,
        agentTimelineHref(sid, {
          runId: workflow.run_id,
          agentId: workflowAgent.agent_id,
        }),
      );
    }
  }
  return hrefs;
}

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
// fold の spawned (起動の指令で動いている teammate) は区画と同じく active の
// 色と動き。spawned の色は、まだ始まっていない workflow member (pending) が使う。
// 正規化せずに `status-teammate-dot-${state}` を組むと、workflow member は
// 全部が未定義 class になって running と done が同じ見た目になる。
const DOT_STATE_ALIASES: Record<string, string> = {
  running: "active",
  progress: "active",
  spawned: "active",
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
export function countNodeErrors(
  nodes: readonly AgentTreeNode[],
  resolveState: NodeStateResolver,
): number {
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
  runs: readonly AgentTreeWorkflowGroup[],
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

/** An agent's name by its agent id: the spawn's or the teammate's. Without a
 * node for the id (the tree not in yet, or the agent gone from it) the id
 * stands in. */
export function agentNameById(tree: AgentTreeGroups | undefined, agentId: string): string {
  const node =
    tree === undefined ? undefined : [...allAgentNodes(tree)].find((n) => n.agent_id === agentId);
  return node?.name ?? node?.teammate_name ?? agentId;
}

/** The states of a workflow's agent that say it has ended (its run's record:
 * the state json, or the journal's `result` row). */
const WORKFLOW_AGENT_ENDED = new Set(["done", "error"]);

/** Whether the thread a Timeline shows is known to answer no turn now: the
 * session's main thread when `agent` is null, else that agent. False when it
 * runs one, and when nothing says (no hooks module, the status not in yet, an
 * agent the status does not name): the Timeline then guesses nothing.
 *
 * - the main thread: the module's `turn` is `idle` (DR-0035 §3)
 * - a subagent or a teammate: the module names the loops running a turn now
 *   (`subagents`, DR-0039 §6), the in-process teammates among them, and this
 *   agent is not one. A teammate is named by its name, so its id is looked up
 *   in the agent tree
 * - a workflow's agent: its run's record says it ended (`done` / `error`) and
 *   the module does not name it running. A run's agents are not shown to be
 *   among the module's loops, so the module's silence alone says nothing */
export function answersNoTurn(
  snapshot: SessionStatusSnapshot | undefined,
  agent: AgentRef | null,
): boolean {
  if (snapshot === undefined) return false;
  if (agent === null) return snapshot.turn?.state === "idle";
  const id =
    agent.agentId ??
    (agent.teammate === undefined || snapshot.agent_tree === undefined
      ? undefined
      : [...allAgentNodes(snapshot.agent_tree)].find((n) => n.teammate_name === agent.teammate)
          ?.agent_id);
  if (id === undefined) return false;
  const running = snapshot.subagents;
  if (running?.some((a) => a.id === id)) return false;
  if (agent.runId !== undefined) {
    const run = dedupeWorkflowRunsByRunId(snapshot.workflows).find((w) => w.run_id === agent.runId);
    const state = run?.agents?.find((a) => a.agent_id === id)?.state;
    return state !== undefined && WORKFLOW_AGENT_ENDED.has(state);
  }
  return running !== undefined;
}

/** The sender a subagent's or teammate's say shows in the main Timeline
 * (DR-0050 §10): `🤖 <name> (model/effort)`, by its agent id. Without a model
 * the label is the name alone. */
export function agentSayerLabel(tree: AgentTreeGroups | undefined, agentId: string): string {
  const node =
    tree === undefined ? undefined : [...allAgentNodes(tree)].find((n) => n.agent_id === agentId);
  const name = agentNameById(tree, agentId);
  const engine = node === undefined ? undefined : agentEngineLabel(node);
  return engine === undefined ? `🤖 ${name}` : `🤖 ${name} ${engine}`;
}
