// A session's folded status (DR-0020 Phase 1), as schemas (DR-0038): what the
// daemon reads off a session's transcript and the files beside it, answered
// to `session_status` / `session_status_subscribe` and pushed as
// `ev:"session_status"`.
import * as v from "valibot";
import type { Output } from "./parse.ts";
import { SessionTurnStateSchema } from "./sidecar.ts";

/** DR-0020 Phase 1: folded current status of a session's transcript. */
export const SessionTodoSchema = v.object({
  id: v.string(),
  subject: v.string(),
  /** "pending" | "in_progress" | "completed" — open set (upstream may add values). */
  status: v.string(),
  owner: v.optional(v.string()),
  /** DR-0020: task ID list this task is blocked by, folded
   * from TaskUpdate's `addBlockedBy` input (or task_reminder attachment when
   * present). Sorted numerically-first (id は文字列だが実データは "1", "2" 形式
   * が主なので数値順に見せた方が読み手が直感的)。Empty array is omitted
   * (undefined) — the UI treats no field / empty the same way. */
  blocked_by: v.optional(v.array(v.string())),
  /** Same shape as `blocked_by` but for tasks this task blocks (TaskUpdate の
   * `addBlocks`)。UI では現状表示していないが、fold は対称に保つ。 */
  blocks: v.optional(v.array(v.string())),
});
export type SessionTodo = Output<typeof SessionTodoSchema>;

/** DR-0025 Phase 1: one row of a workflow's phase progress (name + done/total
 * count). Present only when the workflow's state json (written on completion)
 * carries a `workflowProgress` array — a still-running workflow has no such
 * file, so `phases` is intentionally undefined for it (running-workflow
 * agents alone are folded from the run directory's journal.jsonl). */
export const WorkflowPhaseStatusSchema = v.object({
  title: v.string(),
  done: v.number(),
  total: v.number(),
});
export type WorkflowPhaseStatus = Output<typeof WorkflowPhaseStatusSchema>;

/** DR-0025 Phase 1: one agent belonging to a workflow. `agent_id` is the
 * `a<...>` slug that `transcript_read`'s `agent_id`/`run_id` resolver accepts
 * (see `AgentTranscriptRequest` doc). Every rich field is optional because
 * the underlying `workflowProgress` entries carry different shapes for
 * `state === "done"`/`"error"`/`"progress"` (some omit `tokens`, `agent_type`,
 * `duration_ms`, etc.) and journal-only running rows expose almost nothing
 * beyond agentId + running flag. */
export const WorkflowAgentStatusSchema = v.object({
  agent_id: v.string(),
  label: v.optional(v.string()),
  model: v.optional(v.string()),
  agent_type: v.optional(v.string()),
  /** "done" | "error" | "progress" | "running" — open set: `done`/`error`/
   * `progress` come from the state json's workflow_agent entries, `running`
   * is synthesized when a journal `started` row has no matching `result`. */
  state: v.string(),
  tokens: v.optional(v.number()),
  tool_calls: v.optional(v.number()),
  phase_index: v.optional(v.number()),
  phase_title: v.optional(v.string()),
  last_tool: v.optional(v.string()),
  result_preview: v.optional(v.string()),
  error: v.optional(v.string()),
  /** epoch ms as recorded in the state json (numbers, not ISO strings). */
  started_at: v.optional(v.number()),
  duration_ms: v.optional(v.number()),
});
export type WorkflowAgentStatus = Output<typeof WorkflowAgentStatusSchema>;

export const SessionWorkflowStatusSchema = v.object({
  /** task-notification correlation id (Workflow result taskId). */
  task_id: v.string(),
  name: v.string(),
  summary: v.optional(v.string()),
  /** "running" | terminal task-notification values — open set. */
  status: v.string(),
  started_at: v.string(),
  ended_at: v.optional(v.string()),
  /** DR-0025 Phase 1: the workflow's runId (`wf_XXXXXXXX-XXX`) folded from
   * the transcript's Workflow toolUseResult. Feeds the `run_id` argument of
   * `transcript_read` for agents that belong to this run. */
  run_id: v.optional(v.string()),
  /** DR-0025 Phase 1: undefined while the workflow is running (no state json
   * yet); present once the completion-time state json exists. */
  phases: v.optional(v.array(WorkflowPhaseStatusSchema)),
  /** DR-0025 Phase 1: workflow agents (from state json when available; from
   * journal.jsonl fallback while still running). Undefined = fold could not
   * find anything readable in the run directory. */
  agents: v.optional(v.array(WorkflowAgentStatusSchema)),
});
export type SessionWorkflowStatus = Output<typeof SessionWorkflowStatusSchema>;

export const SessionBackgroundStatusSchema = v.object({
  /** Monitor/Bash taskId or Agent agentId. */
  task_id: v.string(),
  kind: v.picklist(["monitor", "bash", "agent"]),
  description: v.string(),
  /** "running" | terminal task-notification values — open set. */
  status: v.string(),
  started_at: v.string(),
  ended_at: v.optional(v.string()),
  /** For kind=="agent", the spawn's `subagent_type` (`general-purpose`,
   * `Explore`, custom agent name...). Absent when the input row omitted it,
   * or when kind is not "agent". Not present for monitor/bash entries. */
  agent_type: v.optional(v.string()),
});
export type SessionBackgroundStatus = Output<typeof SessionBackgroundStatusSchema>;

/** What the main context runs on and how full it is. Two sources: the latest
 * non-sidechain, non-synthetic assistant row of the transcript, and the facts
 * the session's hooks module sends (SessionFacts, DR-0035 §3), which say what
 * the transcript cannot — the window Claude Code uses, environment overrides
 * included. Where the module sent the window or the effort, it is the
 * module's; the model is always the transcript's. A session without the module has no `window`,
 * and a client shows the fill without one rather than guess it. */
export const SessionContextUsageSchema = v.object({
  /** input_tokens + cache_read_input_tokens + cache_creation_input_tokens of
   * the latest response. Absent before the first response. */
  tokens: v.optional(v.number()),
  /** The context window Claude Code uses for the session's model, from the
   * hooks module. Absent without the module. */
  window: v.optional(v.number()),
  /** The transcript's raw message.model: the model that answered
   * (`claude-fable-5-1`), without the launch-time `[1m]`. */
  model: v.string(),
  /** Top-level `effort` of the transcript assistant row. Rows from older CC
   * versions (observed absent at ≤2.1.211) do not carry it, so it stays
   * optional. Latest observed value, taken from the same row as `model`. */
  effort: v.optional(v.string()),
  /** When `tokens` was observed: the assistant row's timestamp, or the
   * module's measure when that is newer. */
  timestamp: v.string(),
  /** The session's own model and effort, as its hooks module has them
   * (DR-0041 §5, §6): what the session runs on where no override is in
   * force. `model` is the name the session was started or switched with
   * (`fable[1m]`, `claude-fable-5-1`), `effort` that of the main thread's
   * requests before an override replaced it. The overrides' marks and the
   * selects' 🏛️ are read against these, while `model` and `effort` above
   * are what the requests ran on (the transcript's `model` is the model that
   * answered, an override's included). Absent without the module's facts,
   * and each field until the module knows it. */
  engine: v.optional(
    v.object({
      model: v.optional(v.pipe(v.string(), v.nonEmpty())),
      effort: v.optional(v.pipe(v.string(), v.nonEmpty())),
    }),
  ),
});
export type SessionContextUsage = Output<typeof SessionContextUsageSchema>;

/** Last transcript-observed activity for one agent-teams teammate. The TUI's
 * internal liveness state is unavailable, so `state` is an open-set estimate. */
export const SessionTeammateSchema = v.object({
  name: v.string(),
  /** Whether a successful Agent result with status:"teammate_spawned" was observed. */
  spawned: v.boolean(),
  agent_type: v.optional(v.string()),
  color: v.optional(v.string()),
  spawned_at: v.optional(v.string()),
  last_sent_at: v.optional(v.string()),
  last_received_at: v.optional(v.string()),
  /** "spawned" | "active" | "idle" | "stopped" — open set, based on the latest observed event. */
  state: v.string(),
  /** Model from `subagents/agent-*.meta.json` (fixed at spawn, raw value
   * including any `[1m]` suffix). Absent when no meta.json was found. */
  model: v.optional(v.string()),
});
export type SessionTeammate = Output<typeof SessionTeammateSchema>;

/** The fields of one agent tree node beside its children. */
const AgentTreeNodeFieldsSchema = v.object({
  /** stable id from the meta.json filename (`agent-<agentId>.meta.json`).
   * Used as the react key and as the `agentId` argument to
   * `agentTimelineHref`. */
  agent_id: v.string(),
  /** teammate name (agent-teams `name` from meta.json) — present only for
   * teammate nodes. When set, the TL link uses the teammate ref instead of
   * the agentId ref (they resolve the same transcript but the teammate
   * locator is the observable identity for agent-teams). */
  teammate_name: v.optional(v.string()),
  /** meta.json `agentType` — CC-side agent role (`Explore`, `general-purpose`,
   * a custom agent name, or the teammate role slug). Absent only when the
   * meta.json is malformed. */
  agent_type: v.optional(v.string()),
  /** meta.json `description` — the spawn call's description, verbatim. */
  description: v.optional(v.string()),
  /** teammate-only fields (mirror SessionTeammate). */
  color: v.optional(v.string()),
  model: v.optional(v.string()),
  team_name: v.optional(v.string()),
  /** meta.json `spawnDepth` (0-based; root's direct child = 0). */
  spawn_depth: v.number(),
  /** ノードの由来:
   *   - "teammate"        — agent-teams の長期在住メンバー (`taskKind ===
   *     "in_process_teammate"`)。
   *   - "subagent"        — 単発 Agent tool 起動 (sync/async 問わず)。
   *     plugin/skill 由来の `agentType`(`:` を含む) もこちらに含める。
   *   - "workflow_member" — `subagents/workflows/<runId>/agent-*.meta.json`
   *     配下のワークフロー構成員。ルート集約側では workflow run 単位に
   *     `AgentTreeGroups.workflows[]` としてネストされる。 */
  kind: v.picklist(["teammate", "subagent", "workflow_member"]),
  /** workflow_member 限定。所属 run の id (`wf_XXXXXXXX-XXX`)。 */
  workflow_id: v.optional(v.string()),
  /** Estimated liveness state, open-set: "active" | "idle" | "spawned" |
   * "stopped" | "completed" | "unknown". Depth-0 nodes reuse the fold's
   * background/teammate state (transcript-observed); deeper nodes fall back
   * to a transcript-mtime heuristic — see readAgentTree's Design rationale
   * for the limitation. */
  state: v.string(),
  /** transcript file mtime (ms since epoch), used both by the UI to show
   * relative age and by depth≥1's live heuristic. */
  last_activity_ms: v.optional(v.number()),
});

/** Recursive agent tree rooted at the session, one node per
 * `subagents/agent-<agentId>.meta.json`. Direct children of the root session
 * appear at the top level of `SessionStatusSnapshot.agent_tree`; deeper
 * subagents nest under `children`. Depth is capped at 5 (root's direct
 * children = depth 0), matching CC's own spawnDepth ceiling; nodes with
 * `spawn_depth > 5` are dropped. Nodes whose `meta.toolUseId` cannot be
 * located in any candidate parent transcript (orphan — parent already
 * rotated / never observed) are surfaced at the top level so they remain
 * navigable rather than silently disappearing.
 *
 * Design rationale: a type cannot be inferred from a schema that refers to
 * itself (TypeScript reports the circularity), so the recursive part — and
 * only it — is written as an interface that the schema is annotated with.
 * Every other field is the inferred type of AgentTreeNodeFieldsSchema. */
export interface AgentTreeNode extends Output<typeof AgentTreeNodeFieldsSchema> {
  /** child nodes, already depth-capped and dedup-guarded by transcript path. */
  readonly children: readonly AgentTreeNode[];
}
export const AgentTreeNodeSchema: v.GenericSchema<AgentTreeNode> = v.object({
  ...AgentTreeNodeFieldsSchema.entries,
  children: v.array(v.lazy(() => AgentTreeNodeSchema)),
});

/** workflow run 内の 1 フェーズ (title + 完了/総数 + 構成 member)。 */
export const AgentTreeWorkflowPhaseSchema = v.object({
  /** 1-based (readWorkflowDrilldown の canonical index を踏襲)。 */
  index: v.number(),
  title: v.string(),
  done: v.number(),
  total: v.number(),
  /** 当該フェーズに割当てられた member (順序は drilldown 出現順)。 */
  members: v.array(AgentTreeNodeSchema),
});
export type AgentTreeWorkflowPhase = Output<typeof AgentTreeWorkflowPhaseSchema>;

/** 1 workflow run 分の subgroup。フェーズ情報の出典は
 * `readWorkflowDrilldown` (state.json → journal.jsonl の 2 段フォールバック、
 * DR-0025 Phase 1)。既存 `SessionWorkflowStatus.phases` / `.agents` と同一
 * ソースを再利用する = TUI / SessionStatusView の phase 表示と数値が揃う。 */
export const AgentTreeWorkflowGroupSchema = v.object({
  /** `wf_XXXXXXXX-XXX` (RUN_ID_RE)。 */
  workflow_id: v.string(),
  /** run 全体の done/total (all agents 集計)。UI ヘッダの
   *「Workflow wf_xxx  4/6」表示に使う。 */
  done: v.number(),
  total: v.number(),
  /** 宣言済みフェーズ (state.json 由来)。run 中で state.json が未 landing の
   * 場合は空配列 (このとき agents は `unassigned` に流れる、フェーズ未知)。 */
  phases: v.array(AgentTreeWorkflowPhaseSchema),
  /** phase_index を持たない member (state.json 未 landing の run 中、または
   * drilldown が phase を割当てられなかった変則) の fallback bucket。
   * 通常は空。空でない場合 UI は「(phase 未確定)」ヘッダで並べる。 */
  unassigned: v.array(AgentTreeNodeSchema),
  /** run 内 member で最も新しい `last_activity_ms`。run 単位のソート用。 */
  last_activity_ms: v.optional(v.number()),
});
export type AgentTreeWorkflowGroup = Output<typeof AgentTreeWorkflowGroupSchema>;

/** エージェントツリーのルート集約。種別ごとに 3 グループに分ける
 * [kawaz]。同一種別のノードは (親子関係が
 * 通常はフラットなので) 各配列に並列で並ぶ。空カテゴリ (= 0 件) は空配列を
 * 返す — UI 側でヘッダごと非表示にする。 */
export const AgentTreeGroupsSchema = v.object({
  /** agent-teams の在住メンバー。root 直下 = depth 0。 */
  teammates: v.array(AgentTreeNodeSchema),
  /** 単発 Agent 起動 (plugin/skill 由来含む)。親子関係がある場合は
   * `children` にネストする。 */
  agents: v.array(AgentTreeNodeSchema),
  /** ワークフロー run 単位。1 run = 1 subgroup。 */
  workflows: v.array(AgentTreeWorkflowGroupSchema),
});
export type AgentTreeGroups = Output<typeof AgentTreeGroupsSchema>;

/** Which kind of transcript record named a DR-0024 external file. The webui
 * groups the "プロジェクト外" section by it; authorization ignores it (every
 * origin grants the same exact-path read). `tool` covers the file tools
 * (Read/Write/Edit/MultiEdit/NotebookEdit) and the `! <cmd>` persisted-output
 * sidecar; `attachment` covers file-shaped attachment rows. A path named by
 * both is reported as `tool`, whichever came first. */
export const ExternalFileOriginSchema = v.picklist(["tool", "attachment"]);
export type ExternalFileOrigin = Output<typeof ExternalFileOriginSchema>;

export const ExternalFileSchema = v.object({
  path: v.string(),
  origin: ExternalFileOriginSchema,
});
export type ExternalFile = Output<typeof ExternalFileSchema>;

/** The API error the session's latest main-context turn ended on, folded off
 * the transcript for every session (DR-0039 §2): a harness-synthesized
 * API-error row observed as the last thing the main context did
 * (`{"type":"assistant","isApiErrorMessage":true,...}` with
 * `message.model === "<synthetic>"`). Claude Code writes these in the agent's
 * own voice — "Prompt is too long", "API Error: 500 ...", "You're out of extra
 * usage · resets 7pm", "Please run /login" — but they are the CLI reporting a
 * stopped turn, not the agent speaking, and the session sits idle until the
 * user intervenes.
 *
 * Only the *latest* turn counts: a later real assistant row clears this, so a
 * session that hit a transient connection error and recovered is not flagged.
 * Sidechain (subagent) error rows never set it — a failed subagent does not
 * stop the main context. */
export const SessionApiErrorSchema = v.object({
  /** Verbatim error text, so a client can show *why* the session stopped: the
   * row's text blocks concatenated. May be multi-line. */
  text: v.string(),
  /** ISO timestamp of the error row. */
  timestamp: v.string(),
  /** Claude Code's classification of the error: the row's `error` (an open
   * set, see AssistantRowSchema); absent when the row carries none. */
  kind: v.optional(v.string()),
});
export type SessionApiError = Output<typeof SessionApiErrorSchema>;

/** One entry of the session-error list: which session is stopped, and on what. */
export const SessionErrorEntrySchema = v.object({
  ...SessionApiErrorSchema.entries,
  sid: v.string(),
});
export type SessionErrorEntry = Output<typeof SessionErrorEntrySchema>;

/** DR-0026 workspace folder descriptor: one entry from the `folders[]` array
 * of a `*.code-workspace` file discovered under the session cwd, resolved to
 * a realpath. `path` is the allowlist key fs_list_workspace / fs_read_workspace
 * check against; `name` is display-only. */
export const WorkspaceFolderSchema = v.object({
  /** display name — `folders[].name` from the workspace file, or the folder's
   * basename when `name` is absent. Never empty. */
  name: v.string(),
  /** absolute realpath of the folder — allowlist prefix for fs_list_workspace
   * / fs_read_workspace. Never a trailing separator (except at filesystem
   * root itself). */
  path: v.string(),
  /** this folder is the session's cwd (`"."` in the workspace file). Decided
   * by the daemon with both sides realpath'd, so a cwd announced through a
   * symlink still matches its folder; absent on every other folder. */
  is_cwd: v.optional(v.literal(true)),
});
export type WorkspaceFolder = Output<typeof WorkspaceFolderSchema>;

/** Whether a person's input (user_prompt, DR-0035) can reach the session
 * now, judged before anything is sent from what the send itself depends on.
 * One variant per reason, so a client says why and what to do next:
 *
 * - `ready`: a live run has a hooks module (its sidecar is bound) and a hyoui
 *   terminal to press Enter on
 * - `no_module`: no live run of the session has a sidecar — the session was
 *   started with a plugin without the hooks module
 * - `no_terminal`: runs have a sidecar, but none was started under hyoui, so
 *   the module has no terminal to send Enter to
 * - `session_changed`: the process the session ran in now serves another
 *   session id (/clear, /resume)
 * - `ended`: the session is no longer running
 *
 * A send can still fail for what only the moment of sending shows (a dialog
 * open, the text not submitted); those reasons come back on user_prompt. */
export const SessionInputReadinessSchema = v.variant("kind", [
  v.object({ kind: v.literal("ready") }),
  v.object({ kind: v.literal("no_module") }),
  v.object({ kind: v.literal("no_terminal") }),
  v.object({ kind: v.literal("session_changed") }),
  v.object({ kind: v.literal("ended") }),
]);
export type SessionInputReadiness = Output<typeof SessionInputReadinessSchema>;

/** Whether the session's main thread is answering a turn now, and since when
 * (ISO), as its hooks module said (DR-0035 §3). */
export const SessionTurnSchema = v.object({
  state: SessionTurnStateSchema,
  since: v.string(),
});
export type SessionTurn = Output<typeof SessionTurnSchema>;

/** A subagent of the session running a turn now, as its hooks module said
 * (DR-0039 §6): `since` is when that turn started (ISO), absent when the
 * module did not see it start. */
export const SessionSubagentSchema = v.object({
  id: v.string(),
  description: v.optional(v.string()),
  type: v.optional(v.string()),
  since: v.optional(v.string()),
});
export type SessionSubagent = Output<typeof SessionSubagentSchema>;

export const SessionStatusSnapshotSchema = v.object({
  todos: v.array(SessionTodoSchema),
  workflows: v.array(SessionWorkflowStatusSchema),
  background: v.array(SessionBackgroundStatusSchema),
  context: v.optional(SessionContextUsageSchema),
  /** Absent only for older/locally constructed snapshots; daemon snapshots carry an array. */
  teammates: v.optional(v.array(SessionTeammateSchema)),
  /** セッションが起点となるエージェントツリーの種別別集約。
   * `subagents/` が無い、または全カテゴリ空のセッションでは省略される。
   * カテゴリ内のノードは `AgentTreeNode` (深さ上限つきの再帰木) が並ぶ。
   * 完了 (state) 毎の 2 分割は UI 側で行い、daemon は state を保持して
   * そのまま返す。 */
  agent_tree: v.optional(AgentTreeGroupsSchema),
  /** DR-0024: absolute paths outside the session's containment root that the
   * transcript names. Existing targets are realpaths; missing/deleted targets
   * retain a normalized lexical path. This is exactly the allowlist accepted by
   * fs_read_external — one list, so an allowlist consumer cannot honour one
   * origin and forget another. */
  external_files: v.optional(v.array(ExternalFileSchema)),
  /** DR-0026: VS Code `.code-workspace` folders discovered directly under the
   * session's cwd. Each `path` is a realpath-resolved absolute directory —
   * the same absolute prefix accepted by fs_list_workspace / fs_read_workspace
   * as an allowlist for directory-scoped reads outside the containment root.
   * `name` mirrors the workspace file entry (falls back to basename when
   * `folders[].name` is absent). Deduplicated by realpath — the same folder
   * referenced twice (or via two different workspace files) appears once. */
  workspace_folders: v.optional(v.array(WorkspaceFolderSchema)),
  /** Present iff the session's latest main-context turn ended with a harness
   * API-error row — the session is stopped waiting for the user, not working.
   * Absent for a healthy session (see SessionApiError for the exact rule). */
  api_error: v.optional(SessionApiErrorSchema),
  /** Whether a person's input can reach the session (SessionInputReadiness).
   * Daemon snapshots carry it; absent only for locally constructed ones. */
  input_readiness: v.optional(SessionInputReadinessSchema),
  /** Whether the main thread is answering a turn. Absent for a session
   * without the hooks module, or before the module said. */
  turn: v.optional(SessionTurnSchema),
  /** The subagents running a turn now, which a person can add a message to
   * (user_message). Absent for a session without the hooks module, or before
   * the module said. */
  subagents: v.optional(v.array(SessionSubagentSchema)),
});
export type SessionStatusSnapshot = Output<typeof SessionStatusSnapshotSchema>;
