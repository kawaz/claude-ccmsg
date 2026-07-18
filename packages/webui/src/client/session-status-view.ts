// Pure display-derivations for the Status tab + TL mini panel + sidebar
// mini badge (DR-0020 Phase 2/3). Kept out of utils.ts as a standalone
// module (same rationale as rooms-filter.ts): these fold a single
// SessionStatusSnapshot into section/summary/badge shapes and are exercised
// in isolation by session-status-view.test.ts — no store/DOM dependency.
import type {
  SessionBackgroundStatus,
  SessionContextUsage,
  SessionStatusSnapshot,
  SessionTeammate,
  SessionTodo,
  SessionWorkflowStatus,
} from "@ccmsg/protocol";

/** TODO items split by status (DR-0020 §2.1: "pending / in_progress /
 * completed 別に表示"). Order within each bucket is preserved from the
 * snapshot (daemon-side fold order, itself TaskCreate/TaskUpdate order). */
export interface TodoSections {
  pending: SessionTodo[];
  inProgress: SessionTodo[];
  completed: SessionTodo[];
}

export function splitTodos(todos: SessionTodo[]): TodoSections {
  return {
    pending: todos.filter((t) => t.status === "pending"),
    inProgress: todos.filter((t) => t.status === "in_progress"),
    completed: todos.filter((t) => t.status === "completed"),
  };
}

/** Running/terminal split shared by workflows and background tasks — both
 * protocol shapes document their `status` field the same way ("running" |
 * terminal task-notification values, open set). Anything not literally
 * "running" is terminal, so an upstream-added terminal value (e.g. a new
 * failure kind) still lands in `done` without this module needing to know
 * its name. */
export interface RunSections<T> {
  running: T[];
  done: T[];
}

export function splitWorkflows(
  workflows: SessionWorkflowStatus[],
): RunSections<SessionWorkflowStatus> {
  return {
    running: workflows.filter((w) => w.status === "running"),
    done: workflows.filter((w) => w.status !== "running"),
  };
}

export function splitBackground(
  background: SessionBackgroundStatus[],
): RunSections<SessionBackgroundStatus> {
  return {
    running: background.filter((b) => b.status === "running"),
    done: background.filter((b) => b.status !== "running"),
  };
}

/** Status タブ本体向けの一括 fold (DR-0020 §2.1: 3 セクション一覧)。 */
export interface StatusSections {
  todos: TodoSections;
  workflows: RunSections<SessionWorkflowStatus>;
  background: RunSections<SessionBackgroundStatus>;
}

export function buildStatusSections(snapshot: SessionStatusSnapshot): StatusSections {
  return {
    todos: splitTodos(snapshot.todos),
    workflows: splitWorkflows(snapshot.workflows),
    background: splitBackground(snapshot.background),
  };
}

/** Transcript model values omit launch-only [1m] suffixes, so the 200k/1M
 * denominator cannot be recovered directly. Exceeding 200k is positive
 * evidence for a 1M session; values at or below it remain a 200k estimate. */
export function estimateContextLimit(tokens: number): 200_000 | 1_000_000 {
  return tokens > 200_000 ? 1_000_000 : 200_000;
}

/** Display shortening for model names: drops the redundant `claude-` prefix
 * ("claude-fable-5" → "fable-5"). Values without the prefix pass through
 * unchanged, and a `[1m]` suffix is kept — it carries real information
 * (launch-time 1M context pin). */
export function shortModel(model: string): string {
  return model.startsWith("claude-") ? model.slice("claude-".length) : model;
}

export function formatContextUsage(ctx: SessionContextUsage): { text: string; title: string } {
  const limit = estimateContextLimit(ctx.tokens);
  const limitLabel = limit === 1_000_000 ? "1M" : "200k";
  const percentage = Math.round((ctx.tokens / limit) * 100);
  // model is always appended (DR-0020 addendum 2026-07-18); effort only when
  // the transcript row carried one (older CC rows lack the field).
  const effortSuffix = ctx.effort ? ` · ${ctx.effort}` : "";
  return {
    text:
      `ctx ${Math.round(ctx.tokens / 1000)}k/${limitLabel}* (${percentage}%)` +
      ` · ${shortModel(ctx.model)}${effortSuffix}`,
    title:
      `${ctx.tokens.toLocaleString("en-US")} tokens / model ${ctx.model}` +
      (ctx.effort ? ` / effort ${ctx.effort}` : "") +
      ` / context limit ${limit.toLocaleString("en-US")} is estimated; transcript cannot observe environment overrides`,
  };
}

function teammateActivity(teammate: SessionTeammate): number {
  return Math.max(
    Date.parse(teammate.spawned_at ?? "") || 0,
    Date.parse(teammate.last_sent_at ?? "") || 0,
    Date.parse(teammate.last_received_at ?? "") || 0,
  );
}

/** Teammates are shown by their latest transcript-observed activity. A copied
 * array keeps protocol snapshot order immutable for other consumers. */
export function splitTeammates(teammates: SessionTeammate[]): SessionTeammate[] {
  return [...teammates].sort((a, b) => teammateActivity(b) - teammateActivity(a));
}

/** TL 下ミニパネル (DR-0020 §2.1、issue 2026-07-17 #1/#5 で拡張) の 1 行分。
 * `kind:"more"` は MINI_SUMMARY_MAX_LINES を超えた workflow/todo の残数を
 * 畳んだ表示専用で実データを持たない。`kind:"context"`/`"teammate"` は
 * workflow/todo の 2 行キャップとは独立の追加行 (下記 miniSummaryLines
 * のコメント参照)。 */
export type MiniSummaryLineKind = "workflow" | "todo" | "more" | "context" | "teammate";
export interface MiniSummaryLine {
  kind: MiniSummaryLineKind;
  text: string;
}

/** 走行中 workflow/in_progress todo の要約は「1-2 行」(DR-0020 §2.1) —
 * この上限を超えた分は個別の text を並べず、最終行を残数の "more" 行に
 * 差し替える。 */
const MINI_SUMMARY_MAX_LINES = 2;

/** 活動中 (state === "active") と判定する teammate だけを要約行にまとめる
 * (workflow が status === "running" だけをカウントするのと同じ「厳密一致」
 * 方針)。3 名を超えたら残数を畳んで 1 行に収める。 */
function formatTeammatesLine(teammates: SessionTeammate[]): string | null {
  const active = teammates.filter((t) => t.state === "active");
  if (active.length === 0) return null;
  if (active.length <= 3) return active.map((t) => t.name).join(", ");
  return `${active
    .slice(0, 2)
    .map((t) => t.name)
    .join(", ")} 他 ${active.length - 2} 名`;
}

/** 走行中 workflow 名 + in_progress TODO の subject を要約した上に、
 * context 消費 (issue 2026-07-17 #1) と活動中 teammates (issue 2026-07-17 #5)
 * を追加行として付与する。workflow/todo がゼロかつ context/teammates も
 * 無ければ空配列 (呼び出し側はこれをパネル非表示の合図にする、DR-0020
 * §2.1 "ゼロ件なら非表示")。workflow を todo より先に並べるのは「今まさに
 * 自走している大きい単位」を目立たせるため。
 *
 * context/teammates は「走行中タスク」ではなく常時/継続観測値という性質が
 * workflow/todo と異なるため、2 行キャップの対象には含めず必ず追加行として
 * 出す (workflow/todo の "more" 集約とは独立)。 */
export function miniSummaryLines(snapshot: SessionStatusSnapshot): MiniSummaryLine[] {
  const items: MiniSummaryLine[] = [
    ...snapshot.workflows
      .filter((w) => w.status === "running")
      .map((w): MiniSummaryLine => ({ kind: "workflow", text: w.name })),
    ...snapshot.todos
      .filter((t) => t.status === "in_progress")
      .map((t): MiniSummaryLine => ({ kind: "todo", text: t.subject })),
  ];
  const capped =
    items.length <= MINI_SUMMARY_MAX_LINES
      ? items
      : [
          ...items.slice(0, MINI_SUMMARY_MAX_LINES - 1),
          { kind: "more" as const, text: `他 ${items.length - (MINI_SUMMARY_MAX_LINES - 1)} 件` },
        ];

  const extra: MiniSummaryLine[] = [];
  if (snapshot.context) {
    extra.push({ kind: "context", text: formatContextUsage(snapshot.context).text });
  }
  const teammatesLine = formatTeammatesLine(snapshot.teammates ?? []);
  if (teammatesLine !== null) extra.push({ kind: "teammate", text: teammatesLine });

  return [...capped, ...extra];
}

/** DR-0025 Phase 2: `StatusPanel` の workflow 行展開に使うプレゼンテーション形。
 * `SessionWorkflowStatus` の phases / agents は daemon が集計した後の生値
 * (エージェント数は 100+ もありうる)、UI 側は「アイコン」「ラベル/model/tokens」
 * のような表示形に射影する。null を返す = 展開すべきデータが無い
 * (走行中で state json 未生成 かつ journal も空、または旧型で run_id が無い)。 */
export interface WorkflowDrilldownAgentView {
  agentId: string;
  label: string;
  model?: string;
  agentType?: string;
  state: string;
  tokens?: number;
  phaseTitle?: string;
  lastTool?: string;
  resultPreview?: string;
  error?: string;
  icon: "done" | "running" | "error" | "pending";
}

export interface WorkflowDrilldownView {
  phases: { title: string; done: number; total: number }[];
  agents: WorkflowDrilldownAgentView[];
}

function agentIcon(state: string): WorkflowDrilldownAgentView["icon"] {
  if (state === "done") return "done";
  if (state === "error") return "error";
  if (state === "running" || state === "progress") return "running";
  return "pending";
}

export function buildWorkflowDrilldown(wf: SessionWorkflowStatus): WorkflowDrilldownView | null {
  if (!wf.phases && !wf.agents) return null;
  return {
    phases: (wf.phases ?? []).map((p) => ({ title: p.title, done: p.done, total: p.total })),
    agents: (wf.agents ?? []).map((a): WorkflowDrilldownAgentView => {
      const label = a.label ?? a.agent_type ?? a.agent_id;
      return {
        agentId: a.agent_id,
        label,
        state: a.state,
        icon: agentIcon(a.state),
        ...(a.model !== undefined ? { model: a.model } : {}),
        ...(a.agent_type !== undefined ? { agentType: a.agent_type } : {}),
        ...(a.tokens !== undefined ? { tokens: a.tokens } : {}),
        ...(a.phase_title !== undefined ? { phaseTitle: a.phase_title } : {}),
        ...(a.last_tool !== undefined ? { lastTool: a.last_tool } : {}),
        ...(a.result_preview !== undefined ? { resultPreview: a.result_preview } : {}),
        ...(a.error !== undefined ? { error: a.error } : {}),
      };
    }),
  };
}

/** サイドバー SESSIONS 行のミニバッジ文字列 (DR-0020 §2.1: "wf:1 bg:2
 * todo:3/5" 形式、走行中のみカウント、ゼロは省略)。`snapshot` 不在 (= まだ
 * subscribe していない/データ未着) は null (バッジなし)。
 *
 * todo の分母は「まだ完了していない件数」(pending+in_progress) — 完了済みは
 * 母数からも外す。badge は「今動いている/残っている量」の要約であって進捗率
 * 表示ではないため、"3/5" は「5 件残っていて 3 件が今 in_progress」の意味に
 * なる (completed を含めた総数ではない)。Context 使用率は既存 3 軸に足すと
 * 高密度になり、走行中タスクの視認性を損なうため Status タブだけに表示する。 */
export function formatSidebarBadge(snapshot: SessionStatusSnapshot | undefined): string | null {
  if (!snapshot) return null;
  const parts: string[] = [];
  const wfRunning = snapshot.workflows.filter((w) => w.status === "running").length;
  if (wfRunning > 0) parts.push(`wf:${wfRunning}`);
  const bgRunning = snapshot.background.filter((b) => b.status === "running").length;
  if (bgRunning > 0) parts.push(`bg:${bgRunning}`);
  const inProgress = snapshot.todos.filter((t) => t.status === "in_progress").length;
  const open = snapshot.todos.filter((t) => t.status !== "completed").length;
  if (open > 0) parts.push(`todo:${inProgress}/${open}`);
  return parts.length > 0 ? parts.join(" ") : null;
}
