// Pure display-derivations for the Status tab + TL mini panel + sidebar
// mini badge (DR-0020 Phase 2/3). Kept out of utils.ts as a standalone
// module (same rationale as rooms-filter.ts): these fold a single
// SessionStatusSnapshot into section/summary/badge shapes and are exercised
// in isolation by session-status-view.test.ts — no store/DOM dependency.
import type {
  SessionBackgroundStatus,
  SessionStatusSnapshot,
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

/** TL 下ミニパネル (DR-0020 §2.1) の 1 行分。`kind:"more"` は
 * MINI_SUMMARY_MAX_LINES を超えた残数を畳んだ表示専用で、実データを持たない。 */
export type MiniSummaryLineKind = "workflow" | "todo" | "more";
export interface MiniSummaryLine {
  kind: MiniSummaryLineKind;
  text: string;
}

/** ミニパネルは「要約 1-2 行」(DR-0020 §2.1) — この上限を超えた分は個別の
 * text を並べず、最終行を残数の "more" 行に差し替える。 */
const MINI_SUMMARY_MAX_LINES = 2;

/** 走行中 workflow 名 + in_progress TODO の subject だけを、TL 下ミニパネル
 * 向けに並べる。ゼロ件なら空配列 (呼び出し側はこれをパネル非表示の合図にす
 * る、DR-0020 §2.1 "ゼロ件なら非表示")。workflow を todo より先に並べるのは
 * 「今まさに自走している大きい単位」を目立たせるため。 */
export function miniSummaryLines(snapshot: SessionStatusSnapshot): MiniSummaryLine[] {
  const items: MiniSummaryLine[] = [
    ...snapshot.workflows
      .filter((w) => w.status === "running")
      .map((w): MiniSummaryLine => ({ kind: "workflow", text: w.name })),
    ...snapshot.todos
      .filter((t) => t.status === "in_progress")
      .map((t): MiniSummaryLine => ({ kind: "todo", text: t.subject })),
  ];
  if (items.length <= MINI_SUMMARY_MAX_LINES) return items;
  const shown = items.slice(0, MINI_SUMMARY_MAX_LINES - 1);
  return [...shown, { kind: "more", text: `他 ${items.length - shown.length} 件` }];
}

/** サイドバー SESSIONS 行のミニバッジ文字列 (DR-0020 §2.1: "wf:1 bg:2
 * todo:3/5" 形式、走行中のみカウント、ゼロは省略)。`snapshot` 不在 (= まだ
 * subscribe していない/データ未着) は null (バッジなし)。
 *
 * todo の分母は「まだ完了していない件数」(pending+in_progress) — 完了済みは
 * 母数からも外す。badge は「今動いている/残っている量」の要約であって進捗率
 * 表示ではないため、"3/5" は「5 件残っていて 3 件が今 in_progress」の意味に
 * なる (completed を含めた総数ではない)。 */
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
