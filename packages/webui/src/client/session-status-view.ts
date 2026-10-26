// Pure display-derivations for the Status tab + TL mini panel + sidebar
// mini badge (DR-0020 Phase 2/3). Kept out of utils.ts as a standalone
// module (same rationale as rooms-filter.ts): these fold a single
// SessionStatusSnapshot into section/summary/badge shapes and are exercised
// in isolation by session-status-view.test.ts — no store/DOM dependency.
import type {
  AgentInfo,
  ErrorResponse,
  SessionBackgroundStatus,
  RequestOverrideState,
  SessionContextUsage,
  SessionRestartResponse,
  SessionStatusSnapshot,
  SessionTeammate,
  SessionTodo,
  SessionWorkflowStatus,
} from "@ccmsg/protocol";
import { requestValueViews, type RequestValueView } from "./request-override-view.ts";

/** TODO items split by status (DR-0020 §2.1: "pending / in_progress /
 * completed 別に表示"). Order within each bucket is preserved from the
 * snapshot (daemon-side fold order, itself TaskCreate/TaskUpdate order). */
export interface TodoSections {
  pending: SessionTodo[];
  inProgress: SessionTodo[];
  completed: SessionTodo[];
}

export function splitTodos(todos: readonly SessionTodo[]): TodoSections {
  return {
    pending: todos.filter((t) => t.status === "pending"),
    inProgress: todos.filter((t) => t.status === "in_progress"),
    completed: todos.filter((t) => t.status === "completed"),
  };
}

/** Running/terminal split for background tasks — the protocol shape documents
 * its `status` field as "running" | terminal task-notification values (open
 * set). Anything not literally "running" is terminal, so an upstream-added
 * terminal value (e.g. a new failure kind) still lands in `done` without this
 * module needing to know its name. */
export interface RunSections<T> {
  running: T[];
  done: T[];
}

export function splitBackground(
  background: readonly SessionBackgroundStatus[],
): RunSections<SessionBackgroundStatus> {
  return {
    running: background.filter((b) => b.status === "running"),
    done: background.filter((b) => b.status !== "running"),
  };
}

/** Status タブ本体向けの一括 fold (DR-0020 §2.1)。workflow / agent 構造は
 * Timeline のエージェントツリー (`AgentTreePanel`) が担うので含めない。 */
export interface StatusSections {
  todos: TodoSections;
  background: RunSections<SessionBackgroundStatus>;
}

export function buildStatusSections(snapshot: SessionStatusSnapshot): StatusSections {
  return {
    todos: splitTodos(snapshot.todos),
    background: splitBackground(snapshot.background),
  };
}

/** A context window as the ctx line spells it: whole millions as `1M`,
 * anything else in thousands (`200k`, `300k`). */
export function formatContextWindow(window: number): string {
  return window % 1_000_000 === 0 ? `${window / 1_000_000}M` : `${Math.round(window / 1000)}k`;
}

/** Display shortening for model names: drops the redundant `claude-` prefix
 * ("claude-fable-5" → "fable-5"). Values without the prefix pass through
 * unchanged, and a `[1m]` suffix is kept — it carries real information
 * (launch-time 1M context pin). */
export function shortModel(model: string): string {
  return model.startsWith("claude-") ? model.slice("claude-".length) : model;
}

/** issue 2026-07-21 (workflow ID 表示ゆれ #6): workflow の workflowProgress や
 * meta.json では `model` が短縮エイリアス ("haiku") と full ID
 * ("claude-haiku-4-5-20251001") で混在することがある (呼び出し側が渡した値
 * をそのまま記録するため)。kawaz 裁定 (2026-07-21): 表示名 ("Haiku 4.5") への
 * 正規化は情報を減らすため行わない — エイリアスだけを full ID に寄せて混在を
 * 解消する。未知の値はそのまま通す (open-set: 新しいモデル alias が増えた時に
 * 沈黙で切り落とさない)。 */
const MODEL_ALIAS_TO_CANONICAL: Record<string, string> = {
  haiku: "claude-haiku-4-5-20251001",
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-4-7",
  fable: "claude-fable-5",
};
export function canonicalModelId(raw: string): string {
  return MODEL_ALIAS_TO_CANONICAL[raw] ?? raw;
}

/** issue 2026-07-21 (#5): 同一 workflow run が pause→resume を経ると transcript
 * に `Workflow` toolUseResult が複数回出現する。Fold は taskId をキーにするため
 * (毎回異なる taskId で追記される) 同じ run_id を持つ workflow が WORKFLOWS
 * セクションに複数行並ぶ。表示層でこれを畳む: run_id が同じ entry は 1 件に
 * 集約する。集約規則:
 *   - running が 1 件でもあれば running のうち最新 (started_at 降順) を採用
 *   - すべて terminal なら started_at が最新のものを採用
 * run_id 未設定 (旧型 workflow / RUN_ID_RE 不合致) は元の entry を落とさず並列で通す。
 * 出現順は「run_id グループの初回登場位置」を保つ (fold 順を大きく崩さない)。 */
export function dedupeWorkflowRunsByRunId(
  workflows: readonly SessionWorkflowStatus[],
): SessionWorkflowStatus[] {
  const groupsByRun = new Map<string, SessionWorkflowStatus[]>();
  const orderKeys: string[] = [];
  const passthrough: { key: string; wf: SessionWorkflowStatus }[] = [];
  for (const wf of workflows) {
    if (!wf.run_id) {
      const key = `#task:${wf.task_id}`;
      orderKeys.push(key);
      passthrough.push({ key, wf });
      continue;
    }
    const key = `#run:${wf.run_id}`;
    const bucket = groupsByRun.get(key);
    if (bucket) {
      bucket.push(wf);
    } else {
      groupsByRun.set(key, [wf]);
      orderKeys.push(key);
    }
  }
  const startedAtMs = (s: string): number => Date.parse(s) || 0;
  const pickRep = (bucket: SessionWorkflowStatus[]): SessionWorkflowStatus => {
    const running = bucket.filter((w) => w.status === "running");
    const candidates = running.length > 0 ? running : bucket;
    return candidates.reduce((best, w) =>
      startedAtMs(w.started_at) > startedAtMs(best.started_at) ? w : best,
    );
  };
  const result: SessionWorkflowStatus[] = [];
  const passthroughByKey = new Map(passthrough.map((p) => [p.key, p.wf] as const));
  for (const key of orderKeys) {
    const bucket = groupsByRun.get(key);
    if (bucket) result.push(pickRep(bucket));
    else {
      const wf = passthroughByKey.get(key);
      if (wf) result.push(wf);
    }
  }
  return result;
}

/** When the session's main thread started the turn it is answering now, or
 * null when it is not answering one or nothing has said (a session without
 * the hooks module). From the module's turn start and end (DR-0035 §3), which
 * reach the daemon as they happen. */
export function respondingSince(snapshot: SessionStatusSnapshot | undefined): string | null {
  const turn = snapshot?.turn;
  return turn?.state === "responding" ? turn.since : null;
}

/** What the session is doing, for a row's live dot and the Status tab:
 * `waiting` (with what for, verbatim: an upstream-controlled open set) while
 * Claude Code says a dialog waits for the person, else `responding` / `idle`
 * as the session's hooks module said (`turn`, DR-0035 §3). Null when no
 * module has said: the session's activity is then not known. */
export function formatAgentLiveState(agent: AgentInfo | undefined): string | null {
  if (agent?.status === "waiting") {
    return agent.waitingFor ? `waiting (${agent.waitingFor})` : "waiting";
  }
  return agent?.turn?.state ?? null;
}

/** Whether the Status tab offers a restart for the session whose agents row
 * is `agent` (DR-0028 「restart」): the daemon can launch, the session's
 * process is there, and it runs in the config dir the launch command starts
 * claude in (hello's `launch_config_dir`) — resumed in any other, claude has
 * no transcript of it. */
export function restartOffered(
  agent: AgentInfo | undefined,
  launchAvailable: boolean,
  launchConfigDir: string | null,
): boolean {
  return (
    launchAvailable &&
    agent !== undefined &&
    launchConfigDir !== null &&
    agent.config_dir === launchConfigDir
  );
}

/** What a restart came to, as the Status tab says it under the LIVE row: the
 * line, and the launch command's output when it did not resume. */
export function restartResultText(reply: SessionRestartResponse | ErrorResponse): {
  text: string;
  output?: { stdout: string; stderr: string };
} {
  if (reply.ok) {
    if (reply.exit_code === 0) return { text: "再起動しました" };
    return {
      text: `停止したが、起動コマンドが ${String(reply.exit_code)} で終わった (resume していない)`,
      output: { stdout: reply.stdout, stderr: reply.stderr },
    };
  }
  if (reply.error.code === "restart_timeout") {
    return { text: "停止を確認できなかったので起動していない" };
  }
  return { text: `再起動できなかった (${reply.error.code}): ${reply.error.msg}` };
}

/** The ctx line, in its parts: the fill (`ctx 100k/1M (10%)`) and the model
 * and the effort the requests are sent with (DR-0041 §5). */
export interface ContextUsageView {
  text: string;
  title: string;
  fill: string;
  model: RequestValueView;
  effort: RequestValueView | null;
}

/** The ctx line: the fill over the window Claude Code reported through the
 * session's hooks module. Without that window (a session without the module)
 * the fill stands alone: the window depends on the model's default and on
 * environment overrides the transcript does not record, so it is not guessed.
 * Before the first response there is no fill, shown as `—`. The model and the
 * effort are the ones the requests are sent with: an override's, marked, else
 * the session's own (`overrides` is what ev:"request_override" says of the
 * session). */
export function formatContextUsage(
  ctx: SessionContextUsage,
  overrides?: RequestOverrideState,
): ContextUsageView {
  const { tokens, window } = ctx;
  const used = tokens !== undefined ? `${Math.round(tokens / 1000)}k` : "—";
  const limit = window !== undefined ? `/${formatContextWindow(window)}` : "";
  const percentage =
    tokens !== undefined && window !== undefined
      ? ` (${Math.round((tokens / window) * 100)}%)`
      : "";
  const fill = `ctx ${used}${limit}${percentage}`;
  // model is always appended (DR-0020 addendum 2026-07-18); effort only when
  // the transcript row carried one (older CC rows lack the field) or an
  // override names one.
  const { model, effort } = requestValueViews(ctx, overrides, shortModel);
  return {
    text: [fill, model.text, ...(effort ? [effort.text] : [])].join(" · "),
    title:
      (tokens !== undefined ? `${tokens.toLocaleString("en-US")} tokens` : "no response yet") +
      (window !== undefined
        ? ` / context window ${window.toLocaleString("en-US")}`
        : " / context window unknown (the session has no ccmsg hooks module)") +
      ` / ${model.title}` +
      (effort ? ` / ${effort.title}` : ""),
    fill,
    model,
    effort,
  };
}

/** 「そのセッションが何で走っているか」を 1 か所から読むための候補。sidebar の
 * 行ごとに供給元が違う (購読中セッションだけが持つ context 観測、gateway の
 * 直近リクエスト、検索ヒットに凍結された値) ので、生の
 * 綴りだけを共通の形にして渡す。 */
export interface ModelEffortSource {
  /** Raw transcript / gateway spelling, e.g. "claude-fable-5[1m]". */
  model?: string;
  /** Raw effort spelling, e.g. "low". Older CC rows carry none. */
  effort?: string;
}

/** Sidebar の session 行が sid の右に出す 2 要素と、その両方に付ける hover
 * 説明 (短縮前の model 名と effort)。 */
export interface ModelEffortInfo {
  /** `shortModel` で短縮した表示名。 */
  model: string;
  /** 報告されなかった行では null (古い CC 行や gateway 由来の候補)。 */
  effort: string | null;
  title: string;
}

/** Sidebar の session 行が sid の右に出す model と effort。
 *
 * 連結済みの 1 文字列ではなく 2 つに分けて返すのは、この行が
 * `[sid][コピー] [model] [effort]` の横並びで、幅が足りない時は要素ごとに
 * 別々へ省略される必要があるため (kawaz r259m5)。連結すると省略も 1 個所に
 * しか効かず、狭い幅では effort だけが丸ごと消える。
 *
 * 候補は優先順に渡し、**model を持つ最初の候補だけ**を採用する — effort は
 * model を報告したのと同じ観測に属する値なので、model を A から effort を B
 * から拾うと「その組み合わせで走ってはいない」表示になる。model が無ければ
 * 行に何も足さない (placeholder は出さない): 情報が無いことを示す文字列は、
 * 4 行しかない行の幅を潰すだけで読み手の判断を助けない。
 *
 * 短縮は `shortModel` — TL 下ミニパネル (formatContextUsage) と同じ表記に
 * 揃える。open set なので未知のモデル名も落とさずそのまま出す。 */
export function formatSessionModelEffort(
  sources: readonly (ModelEffortSource | undefined)[],
): ModelEffortInfo | null {
  const source = sources.find((s) => s?.model);
  if (!source?.model) return null;
  const effort = source.effort ?? null;
  return {
    model: shortModel(source.model),
    effort,
    title: `model ${source.model}` + (effort ? ` / effort ${effort}` : ""),
  };
}

/** TL 下ミニパネル (DR-0020 §2.1、issue 2026-07-17 #1/#5 で拡張) の 1 行分。 */
export type MiniSummaryLineKind = "workflow" | "todo" | "context" | "teammate";
export interface MiniSummaryLine {
  kind: MiniSummaryLineKind;
  text: string;
  /** The ctx line's parts, when it has the context: the model and the effort
   * are drawn apart from the rest so a person can change the session
   * override from them (DR-0041 §5). `tail` is what follows them. */
  context?: {
    fill: string;
    model: RequestValueView;
    effort: RequestValueView | null;
    tail: string;
  };
}

/** 活動中 (state === "active") と判定する teammate だけを要約行にまとめる
 * (workflow が status === "running" だけをカウントするのと同じ「厳密一致」
 * 方針)。3 名を超えたら残数を畳んで 1 行に収める。 */
function formatTeammatesLine(teammates: readonly SessionTeammate[]): string | null {
  const active = teammates.filter((t) => t.state === "active");
  if (active.length === 0) return null;
  if (active.length <= 3) return active.map((t) => t.name).join(", ");
  return `${active
    .slice(0, 2)
    .map((t) => t.name)
    .join(", ")} 他 ${active.length - 2} 名`;
}

/** 走行中 workflow 名 + in_progress TODO を要約した上に、context 消費
 * (issue 2026-07-17 #1、末尾にプロセスの稼働時間と Claude Code の版) と活動中
 * teammates (issue 2026-07-17 #5) を追加行として付与する。workflow/todo がゼロかつ context/teammates も無ければ
 * 空配列 (呼び出し側はこれをパネル非表示の合図にする、DR-0020 §2.1
 * "ゼロ件なら非表示")。workflow を todo より先に並べるのは「今まさに
 * 自走している大きい単位」を目立たせるため。
 *
 * 走行中のものは件数によらず全件出す (kawaz r135m44: 「小出しにする必要性
 * ゼロ」) — このパネルの用途は「今このセッションが何を抱えているか」を一目で
 * 知ることなので、残数に畳んだ時点でその用途を果たさなくなる。todo に
 * `#{id}` を前置するのも同じ理由で、Status タブの TodoRow と同一表記にして
 * 両者を突き合わせられるようにしている。 */
export function miniSummaryLines(
  snapshot: SessionStatusSnapshot,
  processParts: readonly string[] = [],
  overrides?: RequestOverrideState,
): MiniSummaryLine[] {
  // issue 2026-07-21 (#5): pause→resume の重複を畳んでから数える
  // (Status タブの WORKFLOWS 表示と数値を一致させる)。
  const dedupedWorkflows = dedupeWorkflowRunsByRunId(snapshot.workflows);
  const items: MiniSummaryLine[] = [
    ...dedupedWorkflows
      .filter((w) => w.status === "running")
      .map((w): MiniSummaryLine => ({ kind: "workflow", text: w.name })),
    ...snapshot.todos
      .filter((t) => t.status === "in_progress")
      .map((t): MiniSummaryLine => ({ kind: "todo", text: `#${t.id} ${t.subject}` })),
  ];

  const extra: MiniSummaryLine[] = [];
  // The ctx line ends with what the session's process runs as (uptime,
  // Claude Code version: `processParts`), which stands alone before the
  // transcript has said anything of the context.
  const context = snapshot.context ? formatContextUsage(snapshot.context, overrides) : null;
  const contextParts = [...(context ? [context.text] : []), ...processParts];
  if (contextParts.length > 0) {
    extra.push({
      kind: "context",
      text: contextParts.join(" · "),
      ...(context
        ? {
            context: {
              fill: context.fill,
              model: context.model,
              effort: context.effort,
              tail: processParts.join(" · "),
            },
          }
        : {}),
    });
  }
  const teammatesLine = formatTeammatesLine(snapshot.teammates ?? []);
  if (teammatesLine !== null) extra.push({ kind: "teammate", text: teammatesLine });

  return [...items, ...extra];
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
  const dedupedWorkflows = dedupeWorkflowRunsByRunId(snapshot.workflows);
  const wfRunning = dedupedWorkflows.filter((w) => w.status === "running").length;
  if (wfRunning > 0) parts.push(`wf:${wfRunning}`);
  const bgRunning = snapshot.background.filter((b) => b.status === "running").length;
  if (bgRunning > 0) parts.push(`bg:${bgRunning}`);
  const inProgress = snapshot.todos.filter((t) => t.status === "in_progress").length;
  const open = snapshot.todos.filter((t) => t.status !== "completed").length;
  if (open > 0) parts.push(`todo:${inProgress}/${open}`);
  return parts.length > 0 ? parts.join(" ") : null;
}
