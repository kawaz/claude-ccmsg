import * as fs from "node:fs";
import * as path from "node:path";
import {
  ErrorCode,
  type SessionBackgroundStatus,
  type SessionContextUsage,
  type SessionStatusSnapshot,
  type SessionTeammate,
  type SessionTodo,
  type SessionWorkflowStatus,
} from "@ccmsg/protocol";
import {
  resolveTranscript,
  subscribeTranscriptLines,
  unsubscribeTranscriptLines,
  type SessionLookup as TranscriptSessionLookup,
  type TailConn,
  type TailLog,
  type TranscriptLineListener,
  type TranscriptResult,
  type TranscriptTailStore,
} from "./transcript.ts";
import { RUN_ID_RE } from "./agent-transcripts.ts";
import { readWorkflowDrilldown } from "./workflow-drilldown.ts";
import { discoverWorkspaceFolders } from "./workspace-folders.ts";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_TOOL_USES = 1000;

/** String prefilter before JSON.parse. Context usage and DR-0024 file path
 * inputs appear frequently, so they weaken the filter, but transcripts are only
 * a few thousand lines and parsing happens once plus incremental tail batches. */
const PREFILTER = [
  '"name":"TaskCreate"',
  '"name":"TaskUpdate"',
  '"name":"TaskStop"',
  '"name":"Workflow"',
  '"name":"Monitor"',
  '"name":"Agent"',
  '"name":"SendMessage"',
  '"msg_id"',
  '"run_in_background":true',
  '"task":{"id"',
  '"workflowName"',
  '"backgroundTaskId"',
  '"agentId"',
  '"updatedFields"',
  '"timeoutMs"',
  '"task_type"',
  '"teammate_spawned"',
  '"file_path":',
  '"notebook_path":',
  '"cache_read_input_tokens"',
  "<task-notification>",
  "<teammate-message",
] as const;

export function isSessionStatusCandidate(line: string): boolean {
  return PREFILTER.some((part) => line.includes(part));
}

interface PendingToolUse {
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
}

/** session_status needs the transcript fields plus the containment root metadata
 * used by DR-0024 external-file classification. Kept structural so server.ts's
 * registry remains the concrete owner. */
export interface SessionStatusLookup extends TranscriptSessionLookup {
  get(sid: string):
    | {
        meta: { transcript_path?: string; cwd: string; repo_root?: string };
        conns: { size: number };
      }
    | undefined;
}

type TeammateState = SessionTeammate;

export interface SessionStatusState {
  todos: Map<string, SessionTodo>;
  workflows: Map<string, SessionWorkflowStatus>;
  background: Map<string, SessionBackgroundStatus>;
  context?: SessionContextUsage;
  teammates: Map<string, TeammateState>;
  pendingToolUse: Map<string, PendingToolUse>;
  /** DR-0024 containment root, realpath-normalized. Undefined disables external
   * file collection fail-closed when the session root cannot be resolved. */
  externalRoot?: string;
  /** Exact read allowlist shared with SessionStatusSnapshot.external_files and
   * fs_read_external. Values are realpaths when the target exists, otherwise
   * normalized absolute lexical paths for Write-before-create/deleted files. */
  externalFiles: Set<string>;
}

export function createSessionStatusState(externalRoot?: string): SessionStatusState {
  return {
    todos: new Map(),
    workflows: new Map(),
    background: new Map(),
    teammates: new Map(),
    pendingToolUse: new Map(),
    externalRoot,
    externalFiles: new Set(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function tokenValue(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function resolveExternalRoot(sessions: SessionStatusLookup, sid: string): string | undefined {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) return undefined;
  const base = entry.meta.repo_root ?? entry.meta.cwd;
  if (!base || !path.isAbsolute(base)) return undefined;
  try {
    return fs.realpathSync(base);
  } catch {
    return undefined;
  }
}

/** DR-0026 workspace detection anchor. Deliberately the session's own cwd
 * (its working copy), not the possibly-widened repo_root — a
 * `.code-workspace` sits in a specific worktree's checkout, and its siblings
 * should not inherit its allowlist. Returns undefined the same way
 * resolveExternalRoot does when the session lacks a usable cwd. */
function resolveWorkspaceAnchor(sessions: SessionStatusLookup, sid: string): string | undefined {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) return undefined;
  const cwd = entry.meta.cwd;
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  try {
    return fs.realpathSync(cwd);
  } catch {
    return undefined;
  }
}

function isInsideRoot(root: string, candidate: string): boolean {
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate === root || candidate.startsWith(prefix);
}

/** DR-0024 external-file fold. File tools are recorded at tool_use appearance,
 * without waiting for tool_result: the DR defines the allowlist from call input,
 * failed reads merely become not_found later, and routing these calls through
 * pendingToolUse would let their volume evict the status tools protected by its
 * MAX_PENDING_TOOL_USES bound. Write's observed extra model-generated keys are
 * intentionally ignored; only a string path field matters. Broken
 * __unparsedToolInput shapes, empty/non-string/relative paths are skipped.
 * NotebookEdit/MultiEdit had no observed transcript examples when DR-0024 was
 * accepted, so their notebook_path/file_path handling defensively follows the
 * tool definitions. */
function foldExternalFile(
  state: SessionStatusState,
  name: string,
  input: Record<string, unknown>,
): boolean {
  if (!state.externalRoot) return false;
  const rawPath =
    name === "NotebookEdit"
      ? input.notebook_path
      : name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit"
        ? input.file_path
        : undefined;
  if (typeof rawPath !== "string" || rawPath === "" || !path.isAbsolute(rawPath)) return false;

  const normalized = path.normalize(rawPath);
  let canonical = normalized;
  try {
    canonical = fs.realpathSync(normalized);
  } catch {
    // A Write target may not exist yet and a previously touched file may have
    // been removed. Canonicalize through the nearest existing ancestor + the
    // missing lexical remainder (resolveContained's flavor): a lexical path
    // through a symlinked ancestor (macOS's /tmp, /var) would otherwise never
    // equal the realpath the file has once created, and fs_read_external's
    // read-time realpath check would reject the session's own Write target
    // forever. When no ancestor resolves either, the normalized lexical path
    // stays as the entry; fs_read_external returns not_found until it exists.
    let cursor = path.dirname(normalized);
    for (;;) {
      let real: string;
      try {
        real = fs.realpathSync(cursor);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        const parent = path.dirname(cursor);
        if (err.code !== "ENOENT" || parent === cursor) break;
        cursor = parent;
        continue;
      }
      canonical = path.join(real, path.relative(cursor, normalized));
      break;
    }
  }
  if (isInsideRoot(state.externalRoot, canonical)) return false;
  const sizeBefore = state.externalFiles.size;
  state.externalFiles.add(canonical);
  return state.externalFiles.size !== sizeBefore;
}

function addPendingToolUse(
  state: SessionStatusState,
  id: string,
  name: string,
  input: Record<string, unknown>,
  timestamp: string,
): void {
  state.pendingToolUse.set(id, { name, input, timestamp });
  while (state.pendingToolUse.size > MAX_PENDING_TOOL_USES) {
    const oldest = state.pendingToolUse.keys().next().value;
    if (typeof oldest !== "string") break;
    state.pendingToolUse.delete(oldest);
  }
}

function isTrackedToolUse(name: string, input: Record<string, unknown>): boolean {
  if (name === "Agent") {
    return input.run_in_background === true || typeof input.name === "string";
  }
  if (name === "Bash") return input.run_in_background === true;
  return (
    name === "TaskCreate" ||
    name === "TaskUpdate" ||
    name === "TaskStop" ||
    name === "Workflow" ||
    name === "Monitor" ||
    name === "SendMessage"
  );
}

/** The latest accepted assistant usage row replaces the prior observation even
 * when the total decreases after compaction. Tail batches produce at most one
 * push after all lines are folded, so changing context on normal assistant
 * turns does not create one write per line. */
function foldContextUsage(state: SessionStatusState, row: Record<string, unknown>): boolean {
  if (row.isSidechain === true) return false;
  const timestamp = stringValue(row.timestamp);
  const message = row.message;
  if (!timestamp || !isRecord(message)) return false;
  const model = stringValue(message.model);
  const usage = message.usage;
  if (!model || model === "<synthetic>" || !isRecord(usage)) return false;
  const tokens =
    tokenValue(usage.input_tokens) +
    tokenValue(usage.cache_read_input_tokens) +
    tokenValue(usage.cache_creation_input_tokens);
  if (tokens === 0) return false;
  // effort is a TOP-LEVEL row field (not under message). Older CC versions
  // (≤2.1.211 observed) do not write it, so absence keeps context.effort
  // undefined rather than failing the fold. "" normalizes to absent so the
  // change check and the stored shape agree (a raw "" would compare unequal
  // to the stored-as-absent value and re-trigger a push on every row).
  const effort = stringValue(row.effort) || undefined;
  const current = state.context;
  if (
    current &&
    current.tokens === tokens &&
    current.model === model &&
    current.effort === effort
  ) {
    return false;
  }
  state.context = { tokens, model, ...(effort ? { effort } : {}), timestamp };
  return true;
}

function foldAssistant(state: SessionStatusState, row: Record<string, unknown>): boolean {
  let changed = foldContextUsage(state, row);
  const timestamp = stringValue(row.timestamp);
  const message = row.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return changed;

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const id = stringValue(block.id);
    const name = stringValue(block.name);
    const input = block.input;
    if (!name || !isRecord(input)) continue;
    if (foldExternalFile(state, name, input)) changed = true;
    if (!timestamp || !id || !isTrackedToolUse(name, input)) continue;
    addPendingToolUse(state, id, name, input, timestamp);
  }
  return changed;
}

function applyTodoUpdate(
  state: SessionStatusState,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
): boolean {
  if (result.success !== true) return false;
  const taskId = stringValue(input.taskId) ?? stringValue(result.taskId);
  if (!taskId) return false;

  const status = stringValue(input.status);
  const owner = stringValue(input.owner);
  const subject = stringValue(input.subject);
  if (status === undefined && owner === undefined && subject === undefined) return false;

  // status:"deleted" removes the task from the TUI's todo list, so the folded
  // current state drops it too (DR-0020 § 2.1 "TUI 同等") instead of keeping a
  // "deleted"-status entry forever. Returns true only when something was removed.
  if (status === "deleted") return state.todos.delete(taskId);

  const current = state.todos.get(taskId);
  const next: SessionTodo = current
    ? { ...current }
    : { id: taskId, subject: subject ?? "(unknown)", status: status ?? "pending" };
  if (status !== undefined) next.status = status;
  if (owner !== undefined) next.owner = owner;
  if (subject !== undefined) next.subject = subject;
  if (
    current &&
    current.status === next.status &&
    current.subject === next.subject &&
    current.owner === next.owner
  ) {
    return false;
  }
  state.todos.set(taskId, next);
  return true;
}

function applyTaskStop(
  state: SessionStatusState,
  input: Record<string, unknown>,
  result: Record<string, unknown>,
  timestamp: string | undefined,
): boolean {
  const taskId = stringValue(input.task_id);
  if (!taskId) return false;
  // Agent-teams teammates are stoppable via TaskStop by name: the observed
  // result carries task_type:"in_process_teammate" with input.task_id being
  // the teammate name (result.task_id is the internal task id). Without this
  // branch a stopped teammate keeps its last idle/active estimate forever.
  // A teammate unknown to the fold (e.g. spawn predates the transcript) is
  // not resurrected as a stopped-only entry.
  if (result.task_type === "in_process_teammate") {
    const teammate = state.teammates.get(taskId);
    if (!teammate || teammate.state === "stopped") return false;
    state.teammates.set(taskId, { ...teammate, state: "stopped" });
    return true;
  }
  const workflow = state.workflows.get(taskId);
  if (workflow) {
    if (workflow.status === "stopped" && workflow.ended_at === timestamp) return false;
    state.workflows.set(taskId, {
      ...workflow,
      status: "stopped",
      ...(timestamp ? { ended_at: timestamp } : {}),
    });
    return true;
  }
  const background = state.background.get(taskId);
  if (!background) return false;
  if (background.status === "stopped" && background.ended_at === timestamp) return false;
  state.background.set(taskId, {
    ...background,
    status: "stopped",
    ...(timestamp ? { ended_at: timestamp } : {}),
  });
  return true;
}

function foldTeammateSpawn(
  state: SessionStatusState,
  pending: PendingToolUse,
  result: Record<string, unknown>,
  timestamp: string | undefined,
): boolean {
  if (result.status !== "teammate_spawned") return false;
  const name = stringValue(result.name) ?? stringValue(pending.input.name);
  if (!name) return false;
  const current = state.teammates.get(name);
  const next: TeammateState = {
    ...(current ?? { name, spawned: false, state: "spawned" }),
    name,
    spawned: true,
    state: "spawned",
    ...(stringValue(result.agent_type)
      ? { agent_type: stringValue(result.agent_type)! }
      : { agent_type: undefined }),
    ...(stringValue(result.color) ? { color: stringValue(result.color)! } : { color: undefined }),
    ...(timestamp ? { spawned_at: timestamp } : {}),
  };
  state.teammates.set(name, next);
  return true;
}

function foldSendMessage(
  state: SessionStatusState,
  pending: PendingToolUse,
  result: Record<string, unknown>,
  timestamp: string | undefined,
): boolean {
  if (result.success !== true || !timestamp) return false;
  const name = stringValue(pending.input.to);
  if (!name) return false;
  const current = state.teammates.get(name);
  if (current?.last_sent_at === timestamp) return false;
  // Sending does not prove the recipient is active. A first-seen recipient
  // still needs a representable initial state; later sends preserve idle/spawned.
  state.teammates.set(name, {
    ...(current ?? { name, spawned: false, state: "active" }),
    last_sent_at: timestamp,
  });
  return true;
}

function applyToolResult(
  state: SessionStatusState,
  pending: PendingToolUse,
  result: Record<string, unknown>,
  timestamp: string | undefined,
  isError: boolean,
): boolean {
  if (isError) return false;
  const { name, input } = pending;

  if (name === "Agent" && result.status === "teammate_spawned") {
    return foldTeammateSpawn(state, pending, result, timestamp);
  }
  if (name === "SendMessage") return foldSendMessage(state, pending, result, timestamp);

  if (name === "TaskCreate") {
    const task = result.task;
    if (!isRecord(task)) return false;
    const id = stringValue(task.id);
    if (!id) return false;
    const subject = stringValue(task.subject) ?? stringValue(input.subject) ?? "(unknown)";
    const next: SessionTodo = { id, subject, status: "pending" };
    const current = state.todos.get(id);
    if (
      current &&
      current.subject === next.subject &&
      current.status === next.status &&
      current.owner === undefined
    ) {
      return false;
    }
    state.todos.set(id, next);
    return true;
  }

  if (name === "TaskUpdate") return applyTodoUpdate(state, input, result);

  if (name === "Workflow") {
    const taskId = stringValue(result.taskId);
    const workflowName = stringValue(result.workflowName);
    if (!taskId || !workflowName) return false;
    const rawStatus = stringValue(result.status);
    const rawRunId = stringValue(result.runId);
    // DR-0025 Phase 1: `runId` is intentionally re-validated on the fold side
    // (transcript rows are AI-controlled input) — only `wf_XXXXXXXX-XXX` is
    // accepted, everything else is silently dropped and the workflow simply
    // has no `run_id` (drilldown disabled). See RUN_ID_RE for the exact
    // shape; the value is written back into `path.join` by
    // workflow-drilldown.ts, so no unvetted value ever reaches the fs.
    const runId = rawRunId && RUN_ID_RE.test(rawRunId) ? rawRunId : undefined;
    const workflow: SessionWorkflowStatus = {
      task_id: taskId,
      name: workflowName,
      ...(stringValue(result.summary) ? { summary: stringValue(result.summary)! } : {}),
      status: rawStatus === "async_launched" || rawStatus === undefined ? "running" : rawStatus,
      started_at: pending.timestamp,
      ...(runId ? { run_id: runId } : {}),
    };
    state.workflows.set(taskId, workflow);
    return true;
  }

  if (name === "Monitor") {
    const taskId = stringValue(result.taskId);
    if (!taskId) return false;
    state.background.set(taskId, {
      task_id: taskId,
      kind: "monitor",
      description: stringValue(input.description) ?? "",
      status: "running",
      started_at: pending.timestamp,
    });
    return true;
  }

  if (name === "Bash") {
    const taskId = stringValue(result.backgroundTaskId);
    if (!taskId) return false;
    state.background.set(taskId, {
      task_id: taskId,
      kind: "bash",
      description: stringValue(input.description) ?? "",
      status: "running",
      started_at: pending.timestamp,
    });
    return true;
  }

  if (name === "Agent") {
    const taskId = stringValue(result.agentId);
    if (!taskId) return false;
    state.background.set(taskId, {
      task_id: taskId,
      kind: "agent",
      description: stringValue(input.description) ?? "",
      status: "running",
      started_at: pending.timestamp,
    });
    return true;
  }

  if (name === "TaskStop") return applyTaskStop(state, input, result, timestamp);
  return false;
}

function relayState(body: string): "active" | "idle" {
  const trimmed = body.trim();
  if (!trimmed.startsWith('{"type":"idle_notification"')) return "active";
  try {
    const value: unknown = JSON.parse(trimmed);
    return isRecord(value) && value.type === "idle_notification" ? "idle" : "active";
  } catch {
    return "active";
  }
}

function foldTeammateRelay(state: SessionStatusState, row: Record<string, unknown>): boolean {
  const timestamp = stringValue(row.timestamp);
  const message = row.message;
  if (!timestamp || !isRecord(message) || typeof message.content !== "string") return false;
  if (!message.content.startsWith("Another Claude session sent a message:")) return false;

  const pattern =
    /<teammate-message\s+teammate_id="([^"]+)"([^>]*)>([\s\S]*?)<\/teammate-message>/g;
  let changed = false;
  for (const match of message.content.matchAll(pattern)) {
    const name = match[1];
    if (!name) continue;
    // teammate_id="system" carries lifecycle notices (teammate_terminated),
    // not a teammate's own message — never list "system" as a teammate.
    if (name === "system") continue;
    const attributes = match[2] ?? "";
    const body = match[3] ?? "";
    const color = /\bcolor="([^"]+)"/.exec(attributes)?.[1];
    const stateValue = relayState(body);
    const current = state.teammates.get(name);
    if (
      current?.last_received_at === timestamp &&
      current.state === stateValue &&
      (color === undefined || current.color === color)
    ) {
      continue;
    }
    state.teammates.set(name, {
      ...(current ?? { name, spawned: false, state: stateValue }),
      state: stateValue,
      last_received_at: timestamp,
      ...(color ? { color } : {}),
    });
    changed = true;
  }
  return changed;
}

function foldUser(state: SessionStatusState, row: Record<string, unknown>): boolean {
  const message = row.message;
  if (!isRecord(message)) return false;
  let changed = foldTeammateRelay(state, row);
  if (!Array.isArray(message.content)) return changed;
  const result = row.toolUseResult;

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_result") continue;
    const toolUseId = stringValue(block.tool_use_id);
    if (!toolUseId) continue;
    const pending = state.pendingToolUse.get(toolUseId);
    if (!pending) continue;
    state.pendingToolUse.delete(toolUseId);
    if (!isRecord(result)) continue;
    if (
      applyToolResult(state, pending, result, stringValue(row.timestamp), block.is_error === true)
    ) {
      changed = true;
    }
  }
  return changed;
}

// The harness writes fixed-order tags (<task-id>, <tool-use-id>, <output-file>,
// <status>) before any tag whose body embeds user/tool-controlled text
// (<summary> carries the Monitor/Agent description verbatim; <event>/<result>
// carry raw output). Trim at the earliest of those three so a literal
// "<status>failed</status>" inside a description or output can never be
// mistaken for the genuine status tag.
function notificationPrefix(content: string): string {
  let end = content.length;
  for (const tag of ["<summary>", "<event>", "<result>"]) {
    const index = content.indexOf(tag);
    if (index >= 0 && index < end) end = index;
  }
  return content.slice(0, end);
}

function tagValue(content: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`).exec(content);
  return match?.[1]?.trim();
}

function foldNotification(state: SessionStatusState, row: Record<string, unknown>): boolean {
  if (row.operation !== "enqueue") return false;
  const content = stringValue(row.content);
  if (!content || !content.includes("<task-notification>")) return false;
  const prefix = notificationPrefix(content);
  const taskId = tagValue(prefix, "task-id");
  const status = tagValue(prefix, "status");
  if (!taskId || !status || status === "running") return false;
  const timestamp = stringValue(row.timestamp);

  const workflow = state.workflows.get(taskId);
  if (workflow) {
    if (workflow.status === status && workflow.ended_at === timestamp) return false;
    state.workflows.set(taskId, {
      ...workflow,
      status,
      ...(timestamp ? { ended_at: timestamp } : {}),
    });
    return true;
  }

  const background = state.background.get(taskId);
  if (!background) return false;
  if (background.status === status && background.ended_at === timestamp) return false;
  state.background.set(taskId, {
    ...background,
    status,
    ...(timestamp ? { ended_at: timestamp } : {}),
  });
  return true;
}

/** Fold one candidate jsonl line. Malformed JSON and non-matching shapes are ignored. */
export function foldLine(state: SessionStatusState, line: string): boolean {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return false;
  }
  if (!isRecord(row)) return false;
  if (row.type === "assistant") return foldAssistant(state, row);
  if (row.type === "user") return foldUser(state, row);
  if (row.type === "queue-operation") return foldNotification(state, row);
  return false;
}

/**
 * `sidDir` is the transcript path minus `.jsonl` — the sibling directory
 * where per-agent transcripts and workflow run artifacts live. Passing it
 * enables DR-0025 workflow drilldown; omitting it (older callers, tests
 * without an on-disk root) keeps the fold behaviour unchanged. Per-workflow
 * FS reads happen at snapshot time (not per line) because a workflow's
 * agent list can change even without a new transcript line — the state
 * json is written by the workflow harness independently. The FS cost is
 * bounded (workflow count × O(small json + short journal)) and only pays
 * on push, which the DR calls out as "sufficient granularity".
 */
export function snapshot(
  state: SessionStatusState,
  sidDir?: string,
  /** DR-0026: absolute realpath of the session cwd used to detect
   * `*.code-workspace` files at snapshot time. Omitted (test helpers,
   * unresolvable cwd) suppresses the workspace_folders field entirely rather
   * than publishing a spurious empty allowlist. */
  cwd?: string,
): SessionStatusSnapshot {
  return {
    todos: [...state.todos.values()].map((todo) => ({ ...todo })),
    workflows: [...state.workflows.values()].map((workflow) => {
      const copy: SessionWorkflowStatus = { ...workflow };
      if (sidDir && copy.run_id && RUN_ID_RE.test(copy.run_id)) {
        const drilldown = readWorkflowDrilldown(sidDir, copy.run_id);
        if (drilldown) {
          if (drilldown.phases) copy.phases = drilldown.phases;
          if (drilldown.agents) copy.agents = drilldown.agents;
        }
      }
      return copy;
    }),
    background: [...state.background.values()].map((task) => ({ ...task })),
    ...(state.context ? { context: { ...state.context } } : {}),
    // Teammate model comes from meta.json at snapshot time (see
    // readTeammateModels). The scan only runs when there is at least one
    // teammate to annotate — an fs readdir per push would otherwise be paid
    // by every teamless session.
    teammates: (() => {
      const models = sidDir && state.teammates.size > 0 ? readTeammateModels(sidDir) : undefined;
      return [...state.teammates.values()].map((teammate) => {
        const model = models?.get(teammate.name);
        return { ...teammate, ...(model ? { model } : {}) };
      });
    })(),
    external_files: [...state.externalFiles].sort(),
    // DR-0026: discovered inline at snapshot time — the workspace file is
    // hand-edited out of band and there is no transcript event to fold on.
    // Read cost is bounded (cwd top level only). Omit entirely when nothing
    // is found so older clients (no workspace_folders field) render exactly
    // the same shape as before this DR.
    ...(cwd
      ? (() => {
          const folders = discoverWorkspaceFolders(cwd);
          return folders.length > 0 ? { workspace_folders: folders } : {};
        })()
      : {}),
  };
}

/** DR-0020 addendum 2026-07-18: teammate model lookup. Scans
 * `<sidDir>/subagents/agent-*.meta.json` for `taskKind:"in_process_teammate"`
 * entries and returns name → model (raw spawn-time value, `[1m]` suffix kept).
 * Read at snapshot time (not folded) for the same reason as workflow
 * drilldown / workspace_folders: meta.json is written by the harness
 * independently of transcript lines, so a fold would miss late-appearing
 * files. Same-name duplicates resolve to the meta.json with the newest
 * mtime (matching agent-transcripts.ts resolveTeammate). All fs/JSON errors
 * degrade to an absent entry. */
export function readTeammateModels(sidDir: string): Map<string, string> {
  const models = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const subagentsDir = path.join(sidDir, "subagents");
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return models;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".meta.json")) continue;
    const metaPath = path.join(subagentsDir, entry.name);
    let value: unknown;
    let mtimeMs: number;
    try {
      value = JSON.parse(fs.readFileSync(metaPath, "utf-8"));
      mtimeMs = fs.statSync(metaPath).mtimeMs;
    } catch {
      continue;
    }
    if (!isRecord(value) || value.taskKind !== "in_process_teammate") continue;
    const name = stringValue(value.name);
    const model = stringValue(value.model);
    if (!name || !model) continue;
    const prev = mtimes.get(name);
    if (prev !== undefined && prev >= mtimeMs) continue;
    mtimes.set(name, mtimeMs);
    models.set(name, model);
  }
  return models;
}

function deriveSidDir(file: string): string | undefined {
  return file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : undefined;
}

/** Scan complete lines from the start of a transcript without loading the file whole. */
export function scanTranscript(file: string, state: SessionStatusState, endOffset?: number): void {
  const limit = endOffset ?? fs.statSync(file).size;
  const fd = fs.openSync(file, "r");
  let offset = 0;
  let carry = Buffer.alloc(0);
  try {
    while (offset < limit) {
      const toRead = Math.min(SCAN_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const n = fs.readSync(fd, chunk, 0, toRead, offset);
      if (n === 0) break;
      offset += n;
      const data =
        carry.length === 0 ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        const line = data.toString("utf-8", start, newline);
        if (isSessionStatusCandidate(line)) foldLine(state, line);
        start = newline + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
  } finally {
    fs.closeSync(fd);
  }
}

interface LiveSessionStatus {
  /** Transcript path and containment root this fold was built from. A re-hello
   * that changes either invalidates the fold: the same transcript classified
   * against a different root would otherwise retain a stale DR-0024 allowlist. */
  file: string;
  root?: string;
  /** DR-0025 Phase 1: sibling directory (`file` minus `.jsonl`) used to load
   * per-workflow phase / agent drilldown at snapshot time. */
  sidDir?: string;
  /** DR-0026 workspace anchor: session cwd realpath used to discover
   * `*.code-workspace` folders at snapshot time. Unlike `file`/`root` it is
   * NOT part of the fold-invalidation key — the fold has no cwd-derived state
   * (workspace discovery re-reads disk each snapshot) — so a cwd-only
   * re-hello just refreshes this field in place (getSessionStatus /
   * subscribeSessionStatus) instead of forcing a refold. */
  cwd?: string;
  state: SessionStatusState;
  statusConns: Set<TailConn>;
  listener: TranscriptLineListener;
}

export interface SessionStatusStore {
  sessions: Map<string, LiveSessionStatus>;
}

export function createSessionStatusStore(): SessionStatusStore {
  return { sessions: new Map() };
}

function statusEventLine(sid: string, live: LiveSessionStatus): string {
  return `${JSON.stringify({ ev: "session_status", sid, ...snapshot(live.state, live.sidDir, live.cwd) })}\n`;
}

function pushSnapshot(sid: string, live: LiveSessionStatus): void {
  const line = statusEventLine(sid, live);
  for (const conn of live.statusConns) conn.write(line);
}

export function getSessionStatus(
  store: SessionStatusStore,
  sessions: SessionStatusLookup,
  sid: string,
): TranscriptResult<SessionStatusSnapshot> {
  const resolved = resolveTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  const root = resolveExternalRoot(sessions, sid);
  const cwd = resolveWorkspaceAnchor(sessions, sid);
  // Serve the live fold only while it still describes both the current
  // transcript and the root used to classify DR-0024 external files.
  const live = store.sessions.get(sid);
  if (live && live.file === resolved.file && live.root === root) {
    // The fold itself is cwd-independent (workspace discovery re-reads disk
    // at snapshot time), so a re-hello that moved the cwd while keeping the
    // same transcript+root doesn't need a refold — just refresh the anchor
    // so this snapshot and later stream pushes probe the new cwd. Keep the
    // old anchor when the fresh resolve fails (session momentarily connless).
    live.cwd = cwd ?? live.cwd;
    return { ok: true, data: snapshot(live.state, live.sidDir, live.cwd) };
  }
  const state = createSessionStatusState(root);
  try {
    scanTranscript(resolved.file, state);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }
  return { ok: true, data: snapshot(state, deriveSidDir(resolved.file), cwd) };
}

export function subscribeSessionStatus(
  store: SessionStatusStore,
  transcriptTail: TranscriptTailStore,
  sessions: SessionStatusLookup,
  sid: string,
  conn: TailConn,
  log: TailLog,
): TranscriptResult<SessionStatusSnapshot> {
  const resolved = resolveTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  const root = resolveExternalRoot(sessions, sid);
  const cwd = resolveWorkspaceAnchor(sessions, sid);
  const existing = store.sessions.get(sid);
  if (existing && existing.file === resolved.file && existing.root === root) {
    existing.statusConns.add(conn);
    // Same cwd-refresh rationale as getSessionStatus: the fold survives a
    // cwd-only re-hello, but the workspace anchor must track the new cwd.
    existing.cwd = cwd ?? existing.cwd;
    return { ok: true, data: snapshot(existing.state, existing.sidDir, existing.cwd) };
  }
  const carriedConns = new Set<TailConn>([conn]);
  if (existing) {
    // A re-hello re-validated a DIFFERENT transcript file for this sid
    // (DR-0009 addendum): the old fold describes the wrong file, and its line
    // listener either died with the old Watch or watches the wrong path.
    // Rebuild from scratch, carrying every subscriber over to the new fold.
    for (const c of existing.statusConns) carriedConns.add(c);
    unsubscribeTranscriptLines(transcriptTail, sid, existing.listener);
    store.sessions.delete(sid);
  }

  // live.file is assigned from the subscribe result below, before any
  // listener can fire — everything between here and the return is
  // synchronous, and the Watch only invokes listeners from fs.watch
  // callbacks / poll timers (later ticks).
  const live: LiveSessionStatus = {
    file: "",
    root,
    sidDir: undefined,
    cwd,
    state: createSessionStatusState(root),
    statusConns: carriedConns,
    listener(payload) {
      if (payload.lines.length === 0) {
        // Watch reset (truncate or unlink+recreate replacement, transcript.ts
        // checkNow): the folded state describes bytes that no longer exist.
        // Refold the replacement file from scratch — the Watch's own lastEnd
        // is already payload.size, so subsequent growth resumes incrementally.
        live.state = createSessionStatusState(live.root);
        try {
          scanTranscript(live.file, live.state, payload.size);
        } catch {
          // vanished between the reset broadcast and our rescan; empty state
          // is the honest answer until the next Watch event.
        }
        pushSnapshot(sid, live);
        return;
      }
      let changed = false;
      for (const line of payload.lines) {
        if (isSessionStatusCandidate(line) && foldLine(live.state, line)) changed = true;
      }
      if (changed) pushSnapshot(sid, live);
    },
  };
  const subscribed = subscribeTranscriptLines(transcriptTail, sessions, sid, live.listener, log);
  if (!subscribed.ok) return subscribed;
  live.file = subscribed.data.file;
  live.sidDir = deriveSidDir(subscribed.data.file);
  try {
    scanTranscript(live.file, live.state, subscribed.data.size);
  } catch {
    unsubscribeTranscriptLines(transcriptTail, sid, live.listener);
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }
  store.sessions.set(sid, live);
  if (existing) {
    // Carried-over subscribers were following the OLD file's fold; without a
    // push they would keep rendering it until the new file happens to change.
    // (Only the old conns — the newly-subscribing conn gets the snapshot in
    // its op response.)
    const line = statusEventLine(sid, live);
    for (const c of existing.statusConns) c.write(line);
  }
  return { ok: true, data: snapshot(live.state, live.sidDir, live.cwd) };
}

export function unsubscribeSessionStatus(
  store: SessionStatusStore,
  transcriptTail: TranscriptTailStore,
  sid: string,
  conn: TailConn,
): void {
  const live = store.sessions.get(sid);
  if (!live) return;
  live.statusConns.delete(conn);
  if (live.statusConns.size !== 0) return;
  unsubscribeTranscriptLines(transcriptTail, sid, live.listener);
  store.sessions.delete(sid);
}

export function sessionStatusUnsubscribeAll(
  store: SessionStatusStore,
  transcriptTail: TranscriptTailStore,
  conn: TailConn,
): void {
  for (const [sid, live] of store.sessions) {
    if (!live.statusConns.delete(conn) || live.statusConns.size !== 0) continue;
    unsubscribeTranscriptLines(transcriptTail, sid, live.listener);
    store.sessions.delete(sid);
  }
}

export function stopAllSessionStatus(
  store: SessionStatusStore,
  transcriptTail: TranscriptTailStore,
): void {
  for (const [sid, live] of store.sessions) {
    unsubscribeTranscriptLines(transcriptTail, sid, live.listener);
  }
  store.sessions.clear();
}
