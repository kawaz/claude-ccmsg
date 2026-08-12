import * as fs from "node:fs";
import * as path from "node:path";
import { yieldToEventLoop } from "./event-loop.ts";
import {
  ErrorCode,
  type AgentTreeGroups,
  type AgentTreeNode,
  type AgentTreeWorkflowGroup,
  type AgentTreeWorkflowPhase,
  type SessionApiError,
  type SessionBackgroundStatus,
  type SessionContextUsage,
  type SessionStatusSnapshot,
  type SessionTeammate,
  type SessionTodo,
  type SessionWorkflowStatus,
} from "@ccmsg/protocol";
import {
  resolveConnectedTranscript,
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
import { createMtimeCache } from "./mtime-cache.ts";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_TOOL_USES = 1000;

/** String prefilter before JSON.parse. Context usage and DR-0024 file path
 * inputs appear frequently, so they weaken the filter, but transcripts are only
 * a few thousand lines and parsing happens once plus incremental tail batches. */
const PREFILTER = [
  '"name":"TaskCreate"',
  '"name":"TaskUpdate"',
  // Shared task-store snapshots injected into the main transcript. These are
  // the only place a subagent's TaskCreate/TaskUpdate becomes visible to the
  // session we fold (the tool_use rows themselves land in subagents/*.jsonl).
  '"type":"task_reminder"',
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
  // Harness API-error rows (api_error fold). Observed rows also carry a
  // `usage` object and would pass via cache_read_input_tokens above, but the
  // classification must not silently depend on synthetic rows keeping a
  // token count they have no real use for.
  '"isApiErrorMessage":true',
  "<task-notification>",
  "<teammate-message",
  // Oversized `! <cmd>` results, whose sidecar path joins the DR-0024
  // allowlist. These rows carry no tool input, so no `file_path` key admits
  // them.
  "<persisted-output>",
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
   * fs_read_external. Every value is a `canonicalizeExternalPath` result, and
   * requests are compared against it after the same canonicalization. */
  externalFiles: Set<string>;
  /** Latest-turn API error, or undefined while the session looks healthy.
   * Set by an `isApiErrorMessage` assistant row, cleared by the next real
   * assistant row (see classifyApiErrorRow). */
  apiError?: SessionApiError;
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

async function resolveExternalRoot(
  sessions: SessionStatusLookup,
  sid: string,
): Promise<string | undefined> {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) return undefined;
  const base = entry.meta.repo_root ?? entry.meta.cwd;
  if (!base || !path.isAbsolute(base)) return undefined;
  try {
    return await fs.promises.realpath(base);
  } catch {
    return undefined;
  }
}

/** DR-0026 workspace detection anchor. Deliberately the session's own cwd
 * (its working copy), not the possibly-widened repo_root — a
 * `.code-workspace` sits in a specific worktree's checkout, and its siblings
 * should not inherit its allowlist. Returns undefined the same way
 * resolveExternalRoot does when the session lacks a usable cwd. */
async function resolveWorkspaceAnchor(
  sessions: SessionStatusLookup,
  sid: string,
): Promise<string | undefined> {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) return undefined;
  const cwd = entry.meta.cwd;
  if (!cwd || !path.isAbsolute(cwd)) return undefined;
  try {
    return await fs.promises.realpath(cwd);
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
  const rawPath =
    name === "NotebookEdit"
      ? input.notebook_path
      : name === "Read" || name === "Write" || name === "Edit" || name === "MultiEdit"
        ? input.file_path
        : undefined;
  if (typeof rawPath !== "string") return false;
  return addExternalFile(state, rawPath);
}

/** Spelling used for every DR-0024 external_files entry, and the spelling a
 * request must reduce to before it is compared against that set. The allowlist
 * is a set of exact files, so the two sides only ever agree if they apply the
 * *same* canonicalization — the transcript names a path as the tool call spelled
 * it (`/var/folders/...`, `/tmp/...`), while the file's realpath goes through
 * macOS's `/private` symlinks, and a one-sided realpath makes those two
 * spellings of one file miss each other.
 *
 * Resolution is realpath when the target exists, otherwise the nearest existing
 * ancestor's realpath plus the missing lexical remainder (resolveContained's
 * flavor): a Write target does not exist yet and a previously read file may have
 * been removed, and without the ancestor step such an entry could never equal the
 * realpath the file gets once created. When no ancestor resolves either (or the
 * walk hits a non-ENOENT error), the normalized lexical path is the answer and a
 * read of it fails as not_found.
 *
 * `absPath` must already be absolute; callers reject relative input themselves. */
export function canonicalizeExternalPath(absPath: string): string {
  const normalized = path.normalize(absPath);
  try {
    return fs.realpathSync(normalized);
  } catch {
    let cursor = path.dirname(normalized);
    for (;;) {
      let real: string;
      try {
        real = fs.realpathSync(cursor);
      } catch (e) {
        const err = e as NodeJS.ErrnoException;
        const parent = path.dirname(cursor);
        if (err.code !== "ENOENT" || parent === cursor) return normalized;
        cursor = parent;
        continue;
      }
      return path.join(real, path.relative(cursor, normalized));
    }
  }
}

/** Canonicalize one transcript-named absolute path and add it to the allowlist
 * when it falls outside the containment root. Shared by every fold that grants
 * external reads so they agree on normalization and on the fail-closed
 * behaviour when the session root is unresolvable. */
function addExternalFile(state: SessionStatusState, rawPath: string): boolean {
  if (!state.externalRoot) return false;
  if (rawPath === "" || !path.isAbsolute(rawPath)) return false;

  const canonical = canonicalizeExternalPath(rawPath);
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
    // r44 m6: 同期 Agent (subagent) も Status に載せるため、run_in_background /
    // name の有無に関わらず全 Agent tool_use を追跡する。teammate 判定は
    // applyToolResult 側 (foldTeammateSpawn) が result.status で行うため、
    // ここは分岐せず「Agent の tool_use は全部 pending に積む」で済ませる。
    void input;
    return true;
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

/** What one assistant row says about the session's API-error state:
 * - `"error"` — a harness-synthesized error row ended the turn. Claude Code
 *   writes these as assistant messages ("Prompt is too long", "API Error: 500
 *   ...", "You're out of extra usage · resets 7pm", "Please run /login"), but
 *   they are the CLI reporting a stopped turn, and the session then sits doing
 *   nothing until the user intervenes.
 * - `"clear"` — a real, model-generated assistant row: the agent is answering
 *   again, so whatever error preceded it is over. This is what keeps the state
 *   scoped to the *latest* turn instead of latching on the first error ever
 *   seen. A new user turn is not itself a clear signal — the user typing does
 *   not mean the error is resolved (`Prompt is too long` survives it), and the
 *   assistant row that follows within the same turn settles it either way.
 * - `undefined` — the row says nothing either way. Notably synthetic rows with
 *   `isApiErrorMessage: false` (the harness's own "No response requested.")
 *   are not the agent speaking, so they must not clear a preceding error.
 *
 * Sidechain rows never signal: subagent transcripts interleave into the same
 * file, and neither a subagent's failure nor its recovery describes what the
 * main context is doing.
 *
 * Exported for session-errors.ts, which folds this one pattern across every
 * connected peer without paying for a full status fold per session. */
export type ApiErrorSignal = { kind: "error"; error: SessionApiError } | { kind: "clear" };

export function classifyApiErrorRow(row: Record<string, unknown>): ApiErrorSignal | undefined {
  if (row.type !== "assistant" || row.isSidechain === true) return undefined;
  const message = row.message;
  if (!isRecord(message)) return undefined;
  if (row.isApiErrorMessage !== true) {
    // A real turn is one the model produced; `<synthetic>` marks every row the
    // harness wrote itself, error or not.
    const model = stringValue(message.model);
    return model && model !== "<synthetic>" ? { kind: "clear" } : undefined;
  }
  const text = errorText(message.content);
  if (!text) return undefined;
  return { kind: "error", error: { text, timestamp: stringValue(row.timestamp) ?? "" } };
}

/** Joins an error row's text blocks. Observed rows carry exactly one, but the
 * content is a normal block array, so a multi-block row concatenates rather
 * than reporting only its first line. */
function errorText(content: unknown): string | undefined {
  if (typeof content === "string") return content.trim() || undefined;
  if (!Array.isArray(content)) return undefined;
  const parts: string[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "text") continue;
    const text = stringValue(block.text);
    if (text) parts.push(text);
  }
  return parts.join("\n").trim() || undefined;
}

function foldApiError(state: SessionStatusState, row: Record<string, unknown>): boolean {
  const signal = classifyApiErrorRow(row);
  if (!signal) return false;
  if (signal.kind === "clear") {
    if (!state.apiError) return false;
    state.apiError = undefined;
    return true;
  }
  const current = state.apiError;
  // A retry burst writes several error rows for one stall; the newest wins so
  // the UI shows the error the user is actually stuck on.
  if (current?.text === signal.error.text && current.timestamp === signal.error.timestamp) {
    return false;
  }
  state.apiError = signal.error;
  return true;
}

function foldAssistant(state: SessionStatusState, row: Record<string, unknown>): boolean {
  let changed = foldContextUsage(state, row);
  if (foldApiError(state, row)) changed = true;
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

/** DR-0020 addendum (r38 mid=4): TaskUpdate の `addBlockedBy` / `addBlocks` は
 * 「入力に含まれた ID を既存集合に足す」形。fold 側は現在の list に merge して
 * dedup + 数値順で並べ替える。string ID の numeric-first sort は数字だけの ID
 * (実データの主形) を人間直感順に並べつつ、非数値の ID も lexicographic で安定
 * させる (Array.prototype.sort の同値要素の順序保証を利用する必要はない、id は
 * ユニークだから)。空配列は undefined に落として snapshot の subject/status と
 * 同じく「無い時は field 自体を出さない」不変条件を維持する。 */
function compareTaskIds(a: string, b: string): number {
  const na = Number(a);
  const nb = Number(b);
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return a < b ? -1 : a > b ? 1 : 0;
}

function mergeTaskIdList(
  current: string[] | undefined,
  add: unknown,
): { list: string[] | undefined; changed: boolean } {
  if (!Array.isArray(add)) return { list: current, changed: false };
  const additions = add.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (additions.length === 0) return { list: current, changed: false };
  const set = new Set(current ?? []);
  let changed = false;
  for (const id of additions) {
    if (!set.has(id)) {
      set.add(id);
      changed = true;
    }
  }
  if (!changed) return { list: current, changed: false };
  return { list: [...set].sort(compareTaskIds), changed: true };
}

function taskIdListEquals(a: string[] | undefined, b: string[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b) return (a?.length ?? 0) === 0 && (b?.length ?? 0) === 0;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
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
  const hasBlocking = "addBlockedBy" in input || "addBlocks" in input;
  if (status === undefined && owner === undefined && subject === undefined && !hasBlocking) {
    return false;
  }

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
  const mergedBlockedBy = mergeTaskIdList(next.blocked_by, input.addBlockedBy);
  if (mergedBlockedBy.list !== undefined) {
    if (mergedBlockedBy.list.length > 0) next.blocked_by = mergedBlockedBy.list;
    else delete next.blocked_by;
  }
  const mergedBlocks = mergeTaskIdList(next.blocks, input.addBlocks);
  if (mergedBlocks.list !== undefined) {
    if (mergedBlocks.list.length > 0) next.blocks = mergedBlocks.list;
    else delete next.blocks;
  }
  if (
    current &&
    current.status === next.status &&
    current.subject === next.subject &&
    current.owner === next.owner &&
    taskIdListEquals(current.blocked_by, next.blocked_by) &&
    taskIdListEquals(current.blocks, next.blocks)
  ) {
    return false;
  }
  state.todos.set(taskId, next);
  return true;
}

/** Full task-id list straight from a task_reminder item. Unlike the TaskUpdate
 * path this one is authoritative (the harness writes both directions, including
 * the `blocks` back-edges `addBlockedBy` never states), so it replaces rather
 * than merges. Anything but a non-empty string array collapses to undefined,
 * matching the "no field when empty" invariant snapshot relies on. */
function taskIdListFrom(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const ids = value.filter((v): v is string => typeof v === "string" && v.length > 0);
  return ids.length > 0 ? [...new Set(ids)].sort(compareTaskIds) : undefined;
}

/** DR-0020 addendum: a subagent's TaskCreate / TaskUpdate lands in
 * `subagents/*.jsonl`, which this fold never reads — so folding tool_use rows
 * alone loses every task a worker owns, while the TUI (reading the shared
 * store) shows them. The one place the shared store surfaces in the main
 * transcript is the `task_reminder` attachment the harness injects, carrying
 * `{id, subject, status, owner, blocks, blockedBy}` per task.
 *
 * Applied as an **upsert, never a removal**, because the attachment is not a
 * snapshot of the whole store: observed transcripts show its content narrowing
 * to the most recent batch and going empty once that batch is fully completed,
 * while earlier tasks stay addressable (ids keep climbing, `TaskGet` still
 * resolves them). Treating `content: []` as "no tasks" would therefore erase
 * tasks the tool_use fold recorded correctly. Removal stays the exclusive job
 * of `TaskUpdate status:"deleted"`, which the attachment can never contradict —
 * deleted tasks simply never appear in it.
 *
 * A reminder is built slightly before it is injected, so it can restate a
 * status a newer tool_use row already advanced. The staleness is bounded by the
 * next reminder or the next TaskUpdate for that id, both of which win by
 * arriving later in the file. */
function foldTaskReminder(state: SessionStatusState, attachment: Record<string, unknown>): boolean {
  const content = attachment.content;
  if (!Array.isArray(content)) return false;
  let changed = false;
  for (const item of content) {
    if (!isRecord(item)) continue;
    const id = stringValue(item.id);
    if (!id) continue;
    const current = state.todos.get(id);
    const next: SessionTodo = {
      id,
      subject: stringValue(item.subject) ?? current?.subject ?? "(unknown)",
      status: stringValue(item.status) ?? current?.status ?? "pending",
    };
    const owner = stringValue(item.owner) ?? current?.owner;
    if (owner !== undefined) next.owner = owner;
    const blockedBy = taskIdListFrom(item.blockedBy);
    if (blockedBy) next.blocked_by = blockedBy;
    const blocks = taskIdListFrom(item.blocks);
    if (blocks) next.blocks = blocks;
    if (
      current &&
      current.status === next.status &&
      current.subject === next.subject &&
      current.owner === next.owner &&
      taskIdListEquals(current.blocked_by, next.blocked_by) &&
      taskIdListEquals(current.blocks, next.blocks)
    ) {
      continue;
    }
    state.todos.set(id, next);
    changed = true;
  }
  return changed;
}

function foldAttachment(state: SessionStatusState, row: Record<string, unknown>): boolean {
  const attachment = row.attachment;
  if (!isRecord(attachment) || attachment.type !== "task_reminder") return false;
  return foldTaskReminder(state, attachment);
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
    // r44 m6: agent_type = subagent_type of the spawn call (`general-purpose`,
    // `Explore`, custom agent name...). Absent when Claude Code omits it from
    // the input row — keep the field optional rather than fabricate a value.
    const agentType = stringValue(input.subagent_type);
    // Sync Agent completes inline (result carries the final status, no async
    // task-notification will follow). Async spawn returns `status:
    // "async_launched"` (or `isAsync: true`) with completion coming later via
    // foldNotification. Distinguish so sync subagents show as finished the
    // moment their tool_result lands, matching the observation the fold has.
    const rawStatus = stringValue(result.status);
    const isAsync = result.isAsync === true || rawStatus === "async_launched";
    const status = isAsync ? "running" : (rawStatus ?? "completed");
    state.background.set(taskId, {
      task_id: taskId,
      kind: "agent",
      description: stringValue(input.description) ?? "",
      status,
      started_at: pending.timestamp,
      ...(agentType ? { agent_type: agentType } : {}),
      ...(!isAsync && timestamp ? { ended_at: timestamp } : {}),
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

/** DR-0024 addendum: the sidecar an oversized `! <cmd>` result was spilled to.
 * Claude Code replaces such a result with a `<persisted-output>` stub naming
 * the file it wrote next to the transcript, so the path is transcript-named in
 * exactly the sense the DR's allowlist already relies on — the same grant as a
 * `Read` tool input, and equally an exact-path one.
 *
 * The two patterns mirror `parsePersistedOutput` in the webui's
 * transcript-model.ts, which decides whether the bash card offers its "open the
 * full text" link. They are duplicated rather than shared because the daemon
 * does not otherwise reach into the webui's client code; should the two drift,
 * a path this side misses simply leaves that link dark (the card's existence
 * probe gates it), never the reverse.
 *
 * Anchoring `<persisted-output>` to the whole `<bash-stdout>` body is what
 * keeps a command's own output from naming arbitrary paths: to be folded, the
 * output must be nothing but the stub. A user who deliberately echoes one is
 * granting a read of their own choosing, which `! <cmd>` already permits far
 * more directly. */
const PERSISTED_STDOUT_RE = /<bash-stdout>([\s\S]*?)<\/bash-stdout>/;
const PERSISTED_OUTPUT_RE =
  /^\s*<persisted-output>\s*([\s\S]*?)\n\s*Preview \(first [^)]*\):\n[\s\S]*?<\/persisted-output>\s*$/;
const PERSISTED_PATH_RE = /saved to:\s*(\S+)/;

function foldPersistedOutput(state: SessionStatusState, content: string): boolean {
  const stdout = content.match(PERSISTED_STDOUT_RE)?.[1];
  if (stdout === undefined) return false;
  const note = stdout.match(PERSISTED_OUTPUT_RE)?.[1];
  if (note === undefined) return false;
  const sidecar = note.match(PERSISTED_PATH_RE)?.[1];
  if (sidecar === undefined) return false;
  return addExternalFile(state, sidecar);
}

function foldUser(state: SessionStatusState, row: Record<string, unknown>): boolean {
  const message = row.message;
  if (!isRecord(message)) return false;
  let changed = foldTeammateRelay(state, row);
  if (typeof message.content === "string" && foldPersistedOutput(state, message.content)) {
    changed = true;
  }
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
  if (row.type === "attachment") return foldAttachment(state, row);
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
export async function snapshot(
  state: SessionStatusState,
  sidDir?: string,
  /** DR-0026: absolute realpath of the session cwd used to detect
   * `*.code-workspace` files at snapshot time. Omitted (test helpers,
   * unresolvable cwd) suppresses the workspace_folders field entirely rather
   * than publishing a spurious empty allowlist. */
  cwd?: string,
): Promise<SessionStatusSnapshot> {
  // r44 m7: agent_tree lookup shares the same "read at snapshot time" fold
  // pattern as readTeammateModels — meta.json / subagent transcripts are
  // written by the harness outside the transcript stream we fold, so a
  // per-line fold would miss late-appearing files. Skip entirely when we
  // don't know sidDir (constructed snapshots in tests).
  const agentTree = sidDir ? await readAgentTree(sidDir, `${sidDir}.jsonl`, state) : undefined;
  const workflows: SessionWorkflowStatus[] = [];
  for (const workflow of state.workflows.values()) {
    const copy: SessionWorkflowStatus = { ...workflow };
    if (sidDir && copy.run_id && RUN_ID_RE.test(copy.run_id)) {
      const drilldown = await readWorkflowDrilldown(sidDir, copy.run_id);
      if (drilldown) {
        if (drilldown.phases) copy.phases = drilldown.phases;
        if (drilldown.agents) copy.agents = drilldown.agents;
      }
    }
    workflows.push(copy);
  }
  // Teammate model comes from meta.json at snapshot time (see
  // readTeammateModels). The scan only runs when there is at least one
  // teammate to annotate — an fs readdir per push would otherwise be paid
  // by every teamless session.
  const models = sidDir && state.teammates.size > 0 ? await readTeammateModels(sidDir) : undefined;
  // DR-0026: discovered inline at snapshot time — the workspace file is
  // hand-edited out of band and there is no transcript event to fold on.
  // Read cost is bounded (cwd top level only). Omit the field entirely when
  // nothing is found so older clients (no workspace_folders field) render
  // exactly the same shape as before this DR.
  const workspaceFolders = cwd ? await discoverWorkspaceFolders(cwd) : [];
  return {
    todos: [...state.todos.values()].map((todo) => ({ ...todo })),
    workflows,
    background: [...state.background.values()].map((task) => ({ ...task })),
    ...(state.context ? { context: { ...state.context } } : {}),
    teammates: [...state.teammates.values()].map((teammate) => {
      const model = models?.get(teammate.name);
      return { ...teammate, ...(model ? { model } : {}) };
    }),
    external_files: [...state.externalFiles].sort(),
    ...(state.apiError ? { api_error: { ...state.apiError } } : {}),
    ...(agentTree &&
    (agentTree.teammates.length > 0 ||
      agentTree.agents.length > 0 ||
      agentTree.workflows.length > 0)
      ? { agent_tree: agentTree }
      : {}),
    ...(workspaceFolders.length > 0 ? { workspace_folders: workspaceFolders } : {}),
  };
}

/** Directory listings behind `subagents/`, memoized on each directory's own
 * mtime — which moves whenever an agent's meta.json or transcript is created
 * or removed, the only changes that alter the listing. Entries come back
 * sorted by name: readdir's order is filesystem-dependent (ext4 hashes, APFS
 * looks insertion-ordered) and that order reaches the Status / dump display,
 * so it is pinned here rather than at each use. The returned array is shared
 * with the cache — callers must not mutate it. */
const dirEntriesByPath = createMtimeCache<fs.Dirent[] | undefined>(128);

async function readDirEntries(dir: string): Promise<fs.Dirent[] | undefined> {
  return dirEntriesByPath.get(dir, async () => {
    let entries: fs.Dirent[];
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return undefined;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return entries;
  });
}

/** Parsed `agent-*.meta.json` bodies, memoized on the file's mtime. A meta is
 * written when its agent spawns and is not rewritten afterwards, so this is a
 * hit on essentially every push after the first. `mtimeMs` rides along because
 * two callers need it (teammate same-name tie-break, transcript-less agent
 * liveness) and it cannot have changed on a hit. */
const metaJsonByPath = createMtimeCache<{ value: unknown; mtimeMs: number }>(1024);

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await fs.promises.readFile(file, "utf-8"));
  } catch {
    return undefined;
  }
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
export async function readTeammateModels(sidDir: string): Promise<Map<string, string>> {
  const models = new Map<string, string>();
  const mtimes = new Map<string, number>();
  const subagentsDir = path.join(sidDir, "subagents");
  const entries = await readDirEntries(subagentsDir);
  if (!entries) return models;
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!entry.name.startsWith("agent-") || !entry.name.endsWith(".meta.json")) continue;
    const metaPath = path.join(subagentsDir, entry.name);
    const cached = await metaJsonByPath.get(metaPath, async (stat) => ({
      value: await readJson(metaPath),
      mtimeMs: stat.mtimeMs,
    }));
    if (!cached) continue;
    const { value, mtimeMs } = cached;
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

/** r44 m7: max depth (inclusive) surfaced by readAgentTree. Root's direct
 * children are depth 0, so a value of 5 admits depth 0..5 — matching the
 * `spawnDepth` ceiling CC itself enforces (observed via test fixture
 * `Recursive depth-5 agent spawn`). Nodes with `spawn_depth > MAX_AGENT_TREE_DEPTH`
 * are dropped along with their descendants. */
const MAX_AGENT_TREE_DEPTH = 5;

/** r44 m7: liveness heuristic threshold. A transcript file whose mtime is
 * newer than `Date.now() - AGENT_LIVE_MTIME_WINDOW_MS` is considered still
 * writing (= "active"). This is a fallback for depth≥1 subagents whose
 * lifecycle the root fold cannot observe (they emit tool-use rows in their
 * own transcript, not the root's). 2 min is generous enough to survive
 * ordinary long-running tool calls (Bash / Read) without flapping to
 * "stopped" mid-turn. See Design rationale in readAgentTree. */
const AGENT_LIVE_MTIME_WINDOW_MS = 2 * 60 * 1000;

interface AgentMetaFile {
  /** agentId derived from filename: `agent-<agentId>.meta.json`. */
  agentId: string;
  /** absolute path to the .meta.json file. */
  metaPath: string;
  /** absolute path to the paired .jsonl transcript (may or may not exist). */
  transcriptPath: string;
  /** transcript file mtime (ms) when known, else meta.json mtime. */
  mtimeMs: number;
  /** parsed meta.json record (schema-loose; consumer picks fields). */
  meta: Record<string, unknown>;
}

/** Filename → agentId. The convention is `agent-<agentId>.meta.json`; the
 * agentId is whatever follows the `agent-` prefix and is used verbatim in
 * `agentTimelineHref` and as the parent lookup key. Returns `undefined` for
 * a filename that doesn't fit the shape (defensive against hand-edited /
 * unrelated files inside `subagents/`). */
function parseAgentIdFromFilename(filename: string): string | undefined {
  if (!filename.startsWith("agent-") || !filename.endsWith(".meta.json")) return undefined;
  const agentId = filename.slice("agent-".length, -".meta.json".length);
  return agentId.length > 0 ? agentId : undefined;
}

/** Collect every `id` from `tool_use` blocks whose `name` is `"Agent"` in one
 * transcript line. */
function collectAgentToolUseIds(line: string, out: Set<string>): void {
  // Cheap prefilter: only lines that mention both a tool_use id and the
  // literal `"name":"Agent"` need JSON parsing.
  if (!line.includes('"name":"Agent"')) return;
  if (!line.includes('"type":"tool_use"')) return;
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return;
  }
  if (!isRecord(row)) return;
  const message = row.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return;
  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    if (block.name !== "Agent") continue;
    const id = stringValue(block.id);
    if (id) out.add(id);
  }
}

/** Per-file incremental scan state for {@link readAgentToolUseIds}. Retains
 * only the extracted Agent tool_use ids and the offset up to the last
 * COMPLETE line consumed, so memory is proportional to the number of agents
 * a session spawned, not to transcript size. File identity is tracked the
 * same way transcript.ts's Watch does (ino + birthtime), because an
 * unlink+recreate can reuse the inode. */
interface AgentToolUseIdScan {
  ino: number;
  birthtimeMs: number;
  /** Bytes consumed; always sits on a newline boundary. */
  offset: number;
  ids: Set<string>;
}

/** Cap on cached transcripts. Entries are refreshed on access, so eviction
 * drops the least recently scanned file — a re-scan from offset 0 is correct,
 * just slower. */
const AGENT_TOOL_USE_ID_CACHE_MAX_FILES = 512;
const agentToolUseIdScans = new Map<string, AgentToolUseIdScan>();

/** Read the new tail of `file` into `scan`, advancing `scan.offset` only past
 * complete lines. A trailing partial line is parsed but not consumed, so a
 * transcript whose last line lacks a newline still contributes its ids (and
 * re-contributes them harmlessly on the next call — `ids` is a Set). */
async function scanAgentToolUseIdsFrom(
  file: string,
  scan: AgentToolUseIdScan,
  limit: number,
): Promise<void> {
  let fd: fs.promises.FileHandle;
  try {
    fd = await fs.promises.open(file, "r");
  } catch {
    return;
  }
  let offset = scan.offset;
  let carry = Buffer.alloc(0);
  try {
    while (offset < limit) {
      const toRead = Math.min(SCAN_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead: n } = await fd.read(chunk, 0, toRead, offset);
      if (n === 0) break;
      offset += n;
      const data =
        carry.length === 0 ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        collectAgentToolUseIds(data.toString("utf-8", start, newline), scan.ids);
        start = newline + 1;
      }
      scan.offset = offset - (data.length - start);
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
  } finally {
    await fd.close();
  }
  if (carry.length > 0) collectAgentToolUseIds(carry.toString("utf-8"), scan.ids);
}

/** Union into `out` every `id` of an `Agent` tool_use block recorded in a
 * .jsonl transcript. Used to reverse-map a child meta's `toolUseId` back to
 * its parent transcript (= the file where the Agent tool_use was emitted).
 *
 * Called once per transcript per status push, so it reads incrementally: the
 * ids found so far are cached per path and only bytes appended since the last
 * call are parsed. Truncation and file replacement reset the cache (ino /
 * birthtime / size-shrink checks, mirroring transcript.ts's Watch). */
async function readAgentToolUseIds(file: string, out: Set<string>): Promise<void> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(file);
  } catch {
    agentToolUseIdScans.delete(file);
    return;
  }
  let scan = agentToolUseIdScans.get(file);
  if (scan) {
    const replaced =
      scan.ino !== stat.ino ||
      (scan.birthtimeMs > 0 && stat.birthtimeMs > 0 && scan.birthtimeMs !== stat.birthtimeMs);
    if (replaced || stat.size < scan.offset) scan = undefined;
    else agentToolUseIdScans.delete(file); // re-inserted below to refresh recency
  }
  if (!scan) {
    scan = { ino: stat.ino, birthtimeMs: stat.birthtimeMs, offset: 0, ids: new Set() };
    if (agentToolUseIdScans.size >= AGENT_TOOL_USE_ID_CACHE_MAX_FILES) {
      const oldest = agentToolUseIdScans.keys().next();
      if (!oldest.done) agentToolUseIdScans.delete(oldest.value);
    }
  }
  agentToolUseIdScans.set(file, scan);
  if (stat.size > scan.offset) await scanAgentToolUseIdsFrom(file, scan, stat.size);
  for (const id of scan.ids) out.add(id);
}

/** r44 m7: build a `SessionStatusSnapshot.agent_tree` from `<sidDir>/subagents/`.
 *
 * Approach:
 *
 * 1. Enumerate `agent-*.meta.json` under `subagents/`.
 * 2. For each meta with `toolUseId`, locate its parent transcript by
 *    scanning the root `<rootSid>.jsonl` and each subagent `.jsonl` for a
 *    matching `Agent` tool_use id. Meta files without a `toolUseId` (agent-
 *    teams teammates) attach directly under the root session.
 * 3. Assemble the tree, drop nodes exceeding `MAX_AGENT_TREE_DEPTH`, and
 *    orphan-fallback (attach to root) for nodes whose parent transcript
 *    couldn't be located — parent likely rotated or was never captured.
 *
 * Liveness (`state` field):
 *
 * - Depth 0 with a matching `state.background` / `state.teammates` entry
 *   reuses that fold-observed value (accurate — same source that powers the
 *   existing Status tab).
 * - Depth ≥ 1 falls back to `AGENT_LIVE_MTIME_WINDOW_MS` on the transcript
 *   file (see Design rationale below).
 *
 * Design rationale (deep-node liveness): the root fold only observes
 * tool_use / tool_result events written to the root transcript, so a
 * grandchild's active/idle transitions are invisible to it. The three
 * candidates considered were:
 *
 *   (a) read each subagent's transcript end and look for a completion
 *       marker — but subagents don't emit a well-defined "done" line
 *       (they exit when the parent's Agent tool_result folds in), so this
 *       yields false negatives.
 *   (b) parse `<task-notification>` fanned out through queue-operation
 *       rows — same information the root fold already uses, but only
 *       covers direct children of root.
 *   (c) transcript-file mtime relative to now — coarse but robust: a
 *       still-active agent is writing tool-use rows, so its mtime tracks
 *       roughly with the current wall clock; a finished agent's file
 *       stops moving.
 *
 * (c) is the pragmatic choice for depth ≥ 1. Limitation: a subagent stuck
 * on a long-running tool call with no intervening output will look
 * "stopped" once its mtime falls outside the window. The UI shows this as
 * an educated guess, not authoritative status.
 */
export async function readAgentTree(
  sidDir: string,
  rootTranscriptPath: string,
  state: SessionStatusState,
  nowMs: number = Date.now(),
): Promise<AgentTreeGroups | undefined> {
  const subagentsDir = path.join(sidDir, "subagents");
  const entries = await readDirEntries(subagentsDir);
  if (!entries) return undefined;

  // (a) subagents/ 直下: teammate / 単発 subagent / それらの子孫
  const metas: AgentMetaFile[] = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const meta = await loadAgentMeta(subagentsDir, entry.name);
    if (meta) metas.push(meta);
  }
  // (b) subagents/workflows/<runId>/: workflow メンバー。run 単位でまとめる。
  const workflowsDir = path.join(subagentsDir, "workflows");
  const workflowMembersByRun = new Map<string, AgentMetaFile[]>();
  // workflows/ 不在は空扱い (通常セッション)
  const runDirEntries = (await readDirEntries(workflowsDir)) ?? [];
  for (const runEntry of runDirEntries) {
    if (!runEntry.isDirectory()) continue;
    // RUN_ID_RE と同型の緩い基本判定 (path.join 前に traversal 文字を弾く)。
    if (!/^wf_[0-9a-f]{8}-[0-9a-f]{3}$/.test(runEntry.name)) continue;
    const runDir = path.join(workflowsDir, runEntry.name);
    const members = await readDirEntries(runDir);
    if (!members) continue;
    const runMetas: AgentMetaFile[] = [];
    for (const m of members) {
      if (!m.isFile()) continue;
      const meta = await loadAgentMeta(runDir, m.name);
      if (meta) runMetas.push(meta);
    }
    if (runMetas.length > 0) workflowMembersByRun.set(runEntry.name, runMetas);
  }
  if (metas.length === 0 && workflowMembersByRun.size === 0) {
    return { teammates: [], agents: [], workflows: [] };
  }

  // Reverse map: toolUseId → parent agentId (or null for root). Only
  // populated for meta entries that carry a toolUseId (the sync/async
  // subagent case). agent-teams teammates carry no toolUseId and attach
  // directly to root via the else-branch below.
  const rootAgentIds = new Set<string>();
  await readAgentToolUseIds(rootTranscriptPath, rootAgentIds);
  const subagentIdMaps = new Map<string, Set<string>>();
  for (const m of metas) {
    const ids = new Set<string>();
    await readAgentToolUseIds(m.transcriptPath, ids);
    subagentIdMaps.set(m.agentId, ids);
  }

  function findParent(toolUseId: string): string | null | undefined {
    if (rootAgentIds.has(toolUseId)) return null; // root is parent
    for (const [parentAgentId, ids] of subagentIdMaps) {
      if (ids.has(toolUseId)) return parentAgentId;
    }
    return undefined; // orphan
  }

  interface WorkingNode {
    node: AgentTreeNode;
    parent: string | null; // null = root; string = parent agentId
    isTeammate: boolean;
  }
  const working = new Map<string, WorkingNode>();
  for (const m of metas) {
    const toolUseId = stringValue(m.meta.toolUseId);
    const taskKind = stringValue(m.meta.taskKind);
    const isTeammate = taskKind === "in_process_teammate";
    const name = stringValue(m.meta.name);

    let parentAgentId: string | null;
    if (isTeammate || !toolUseId) {
      parentAgentId = null;
    } else {
      const found = findParent(toolUseId);
      parentAgentId = found === undefined ? null : found;
    }

    // depth-0 live comes from the fold; depth≥1 uses mtime.
    let liveState: string;
    if (isTeammate && name) {
      const teammate = state.teammates.get(name);
      liveState = teammate?.state ?? "unknown";
    } else if (parentAgentId === null) {
      const bg = state.background.get(m.agentId);
      liveState = bg
        ? bg.status === "running"
          ? "active"
          : bg.status
        : m.mtimeMs > 0 && nowMs - m.mtimeMs < AGENT_LIVE_MTIME_WINDOW_MS
          ? "active"
          : "unknown";
    } else {
      liveState =
        m.mtimeMs > 0 && nowMs - m.mtimeMs < AGENT_LIVE_MTIME_WINDOW_MS ? "active" : "stopped";
    }

    const node = buildAgentTreeNode(m, isTeammate ? "teammate" : "subagent", liveState);
    working.set(m.agentId, { node, parent: parentAgentId, isTeammate });
  }

  // Wire children under parents; unknown-parent nodes stay at root as
  // orphan fallback (already resolved to `null` above).
  const teammateRoots: AgentTreeNode[] = [];
  const agentRoots: AgentTreeNode[] = [];
  for (const w of working.values()) {
    if (w.parent === null) {
      (w.isTeammate ? teammateRoots : agentRoots).push(w.node);
    } else {
      const parent = working.get(w.parent);
      if (!parent) {
        // parent's meta.json disappeared while we were reading — treat as root.
        (w.isTeammate ? teammateRoots : agentRoots).push(w.node);
      } else {
        parent.node.children.push(w.node);
      }
    }
  }

  // r46 m12: workflow run 単位で subgroup を組む。フェーズ情報の一次ソースは
  // readWorkflowDrilldown (SessionStatusView / TUI と同経路)。member の agentId
  // をキーに drilldown.agents の state / phase_index を突き合わせ、node は
  // meta.json から生成 (last_activity_ms は agent-<id>.jsonl mtime)。
  const workflowGroups: AgentTreeWorkflowGroup[] = [];
  for (const [runId, runMetas] of workflowMembersByRun) {
    const drilldown = await readWorkflowDrilldown(sidDir, runId);
    const drillByAgent = new Map<
      string,
      { state: string; phase_index?: number; phase_title?: string }
    >();
    for (const a of drilldown?.agents ?? []) {
      drillByAgent.set(a.agent_id, {
        state: a.state,
        ...(a.phase_index !== undefined ? { phase_index: a.phase_index } : {}),
        ...(a.phase_title ? { phase_title: a.phase_title } : {}),
      });
    }

    // phase skeleton: drilldown.phases が正 (state.json 済 run)。無ければ
    // 空 → unassigned bucket に全 member を流す。
    interface WorkingPhase {
      index: number;
      title: string;
      done: number;
      total: number;
      members: AgentTreeNode[];
    }
    const phaseByIndex = new Map<number, WorkingPhase>();
    let phaseSeq = 0;
    for (const p of drilldown?.phases ?? []) {
      phaseSeq += 1;
      phaseByIndex.set(phaseSeq, {
        index: phaseSeq,
        title: p.title,
        done: p.done,
        total: p.total,
        members: [],
      });
    }

    const unassigned: AgentTreeNode[] = [];
    let latest = 0;
    let doneTotal = 0;
    let totalTotal = 0;
    for (const m of runMetas) {
      const drill = drillByAgent.get(m.agentId);
      // state 優先: drilldown ("done"/"running") → mtime 推定
      const liveState =
        drill?.state ??
        (m.mtimeMs > 0 && nowMs - m.mtimeMs < AGENT_LIVE_MTIME_WINDOW_MS ? "active" : "stopped");
      const node = buildAgentTreeNode(m, "workflow_member", liveState, { workflow_id: runId });
      const idx = drill?.phase_index;
      if (idx !== undefined && phaseByIndex.has(idx)) {
        phaseByIndex.get(idx)!.members.push(node);
      } else {
        unassigned.push(node);
      }
      if (m.mtimeMs > latest) latest = m.mtimeMs;
    }

    // phase 統計は drilldown 値を優先。drilldown が phases を持たない (run 中)
    // 場合は member 側の集計 (今回は 0 件) から差し戻し。
    const phases: AgentTreeWorkflowPhase[] = [];
    for (const wp of phaseByIndex.values()) {
      phases.push({
        index: wp.index,
        title: wp.title,
        done: wp.done,
        total: wp.total,
        members: wp.members,
      });
      doneTotal += wp.done;
      totalTotal += wp.total;
    }
    if (phases.length === 0) {
      // run 中 (state.json 未 landing): drilldown.agents の done 数から
      // 手動で done/total を出す。unassigned に全 member。
      totalTotal = unassigned.length;
      doneTotal = 0;
      for (const n of unassigned) {
        if (n.state === "done") doneTotal += 1;
      }
    }

    workflowGroups.push({
      workflow_id: runId,
      done: doneTotal,
      total: totalTotal,
      phases,
      unassigned,
      ...(latest > 0 ? { last_activity_ms: latest } : {}),
    });
  }
  workflowGroups.sort((a, b) => (b.last_activity_ms ?? 0) - (a.last_activity_ms ?? 0));

  // Depth cap via BFS (teammate / agents 側のみ。workflow member はフェーズ
  // 内で常に depth 0 相当のフラット列挙なので対象外)。root direct 子 =
  // depth 0、上限 MAX_AGENT_TREE_DEPTH。
  function capAndSort(nodes: AgentTreeNode[], depth: number): AgentTreeNode[] {
    if (depth > MAX_AGENT_TREE_DEPTH) return [];
    const capped = nodes.map((n) => ({
      ...n,
      children: capAndSort(n.children, depth + 1),
    }));
    capped.sort((a, b) => (b.last_activity_ms ?? 0) - (a.last_activity_ms ?? 0));
    return capped;
  }
  return {
    teammates: capAndSort(teammateRoots, 0),
    agents: capAndSort(agentRoots, 0),
    workflows: workflowGroups,
  };
}

/** r46 m8: `subagents/` 直下や `subagents/workflows/<runId>/` 直下から
 * `agent-<agentId>.meta.json` を 1 件読んで `AgentMetaFile` に整形する共通
 * ヘルパ。JSON parse エラー / 型不一致は undefined を返し呼び出し側で skip。
 * mtime は transcript (`agent-<agentId>.jsonl`) を優先、無ければ meta.json
 * 自身。 */
async function loadAgentMeta(dir: string, fileName: string): Promise<AgentMetaFile | undefined> {
  const agentId = parseAgentIdFromFilename(fileName);
  if (!agentId) return undefined;
  const metaPath = path.join(dir, fileName);
  const transcriptPath = path.join(dir, `agent-${agentId}.jsonl`);
  const cached = await metaJsonByPath.get(metaPath, async (stat) => ({
    value: await readJson(metaPath),
    mtimeMs: stat.mtimeMs,
  }));
  if (!cached || !isRecord(cached.value)) return undefined;
  // The transcript's mtime is the agent's liveness clock, so it is statted
  // every time — it moves on every line the agent writes, which is exactly
  // what a cache would have to invalidate on anyway.
  let mtimeMs: number;
  try {
    mtimeMs = (await fs.promises.stat(transcriptPath)).mtimeMs;
  } catch {
    mtimeMs = cached.mtimeMs;
  }
  return { agentId, metaPath, transcriptPath, mtimeMs, meta: cached.value };
}

/** r46 m8: meta.json + kind + state から `AgentTreeNode` を組む共通ヘルパ。
 * teammate は meta.name / description の chain、subagent は description /
 * agentType / agentId の chain。オプションで workflow_id を追加。 */
function buildAgentTreeNode(
  m: AgentMetaFile,
  kind: AgentTreeNode["kind"],
  state: string,
  extra?: { workflow_id?: string },
): AgentTreeNode {
  const name = stringValue(m.meta.name);
  const spawnDepth = typeof m.meta.spawnDepth === "number" ? m.meta.spawnDepth : 0;
  return {
    agent_id: m.agentId,
    spawn_depth: spawnDepth,
    kind,
    state,
    children: [],
    ...(kind === "teammate" && name ? { teammate_name: name } : {}),
    ...(stringValue(m.meta.agentType) ? { agent_type: stringValue(m.meta.agentType)! } : {}),
    ...(stringValue(m.meta.description) ? { description: stringValue(m.meta.description)! } : {}),
    ...(stringValue(m.meta.color) ? { color: stringValue(m.meta.color)! } : {}),
    ...(stringValue(m.meta.model) ? { model: stringValue(m.meta.model)! } : {}),
    ...(stringValue(m.meta.teamName) ? { team_name: stringValue(m.meta.teamName)! } : {}),
    ...(m.mtimeMs > 0 ? { last_activity_ms: m.mtimeMs } : {}),
    ...(extra?.workflow_id ? { workflow_id: extra.workflow_id } : {}),
  };
}

function deriveSidDir(file: string): string | undefined {
  return file.endsWith(".jsonl") ? file.slice(0, -".jsonl".length) : undefined;
}

/** Scan complete lines from the start of a transcript without loading the file
 * whole. Shared by the full status fold (scanTranscript) and session-errors.ts,
 * which folds a single pattern and needs the same bounded-memory read.
 *
 * A cold scan walks the whole transcript, so it hands the event loop a turn
 * per chunk (DR-0029): one client's first `session_status` must not stall
 * every other client's WS delivery. */
export async function scanTranscriptLines(
  file: string,
  endOffset: number | undefined,
  onLine: (line: string) => void,
): Promise<void> {
  const limit = endOffset ?? (await fs.promises.stat(file)).size;
  const handle = await fs.promises.open(file, "r");
  let offset = 0;
  let carry = Buffer.alloc(0);
  try {
    while (offset < limit) {
      // Splitting and folding a chunk is pure CPU, so the loop has to re-enter
      // the loop itself rather than relying on the read's IO wait.
      await yieldToEventLoop();
      const toRead = Math.min(SCAN_CHUNK_BYTES, limit - offset);
      const chunk = Buffer.allocUnsafe(toRead);
      const { bytesRead: n } = await handle.read(chunk, 0, toRead, offset);
      if (n === 0) break;
      offset += n;
      const data =
        carry.length === 0 ? chunk.subarray(0, n) : Buffer.concat([carry, chunk.subarray(0, n)]);
      let start = 0;
      for (;;) {
        const newline = data.indexOf(0x0a, start);
        if (newline < 0) break;
        onLine(data.toString("utf-8", start, newline));
        start = newline + 1;
      }
      carry = start < data.length ? Buffer.from(data.subarray(start)) : Buffer.alloc(0);
    }
  } finally {
    await handle.close();
  }
}

export async function scanTranscript(
  file: string,
  state: SessionStatusState,
  endOffset?: number,
): Promise<void> {
  await scanTranscriptLines(file, endOffset, (line) => {
    if (isSessionStatusCandidate(line)) foldLine(state, line);
  });
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
  /** Resolves when the in-flight cold scan / refold finishes; `undefined` when
   * the fold is current. Readers (getSessionStatus, subscribeSessionStatus)
   * await it so a snapshot is never taken from a half-scanned prefix. */
  ready?: Promise<void>;
  /** Bumped per scan. A scan whose generation is stale by the time it finishes
   * was superseded by a later reset and drops its result instead of publishing
   * a fold of bytes that have since been replaced. */
  scanGen: number;
  /** Tail of the serialized push queue for this session (see pushSnapshot).
   * Building a snapshot reads the filesystem, so a push cannot complete inside
   * the fs.watch callback that triggered it; chaining keeps concurrent pushes
   * from writing to a subscriber out of order. */
  pushChain: Promise<void>;
  /** Lines delivered by the tail while a scan was in flight. The Watch resets
   * its own offset to the scanned size first, so these are strictly the bytes
   * after the scanned window and fold in order once the scan lands. */
  pendingLines: string[];
}

/** Fold everything the tail delivered during a scan, then forget it. */
function drainPendingLines(live: LiveSessionStatus): void {
  const pending = live.pendingLines;
  live.pendingLines = [];
  for (const line of pending) {
    if (isSessionStatusCandidate(line)) foldLine(live.state, line);
  }
}

/** Refold the transcript from scratch up to `size` after a Watch reset
 * (truncate or replacement file). The scan runs off the fs.watch callback
 * rather than inside it: it builds a detached state and swaps it in on
 * completion, so the previous fold — a coherent view of an earlier moment —
 * stays readable meanwhile instead of a half-filled one. */
function startRefold(sid: string, live: LiveSessionStatus, size: number, log: TailLog): void {
  live.scanGen += 1;
  const gen = live.scanGen;
  live.pendingLines = [];
  const state = createSessionStatusState(live.root);
  // Nothing necessarily awaits this promise (the Watch callback that starts it
  // returns immediately), so it must not be able to reject: an unhandled
  // rejection here would take the daemon down over one unreadable transcript.
  live.ready = (async () => {
    try {
      await scanTranscript(live.file, state, size);
    } catch {
      // vanished between the reset broadcast and our rescan; empty state
      // is the honest answer until the next Watch event.
    }
    if (gen !== live.scanGen) return;
    live.state = state;
    live.ready = undefined;
    drainPendingLines(live);
    pushSnapshot(sid, live, log);
  })().catch((e: unknown) => {
    // Only the publish half can land here (the scan has its own catch); leave
    // `ready` cleared so readers aren't stuck waiting on a fold that failed.
    if (gen === live.scanGen) live.ready = undefined;
    log.error(`session_status refold failed sid=${sid}: ${String(e)}`);
  });
}

export interface SessionStatusStore {
  sessions: Map<string, LiveSessionStatus>;
}

export function createSessionStatusStore(): SessionStatusStore {
  return { sessions: new Map() };
}

async function statusEventLine(sid: string, live: LiveSessionStatus): Promise<string> {
  const data = await snapshot(live.state, live.sidDir, live.cwd);
  return `${JSON.stringify({ ev: "session_status", sid, ...data })}\n`;
}

/** Publish the current fold to every subscriber of `sid`.
 *
 * Callers are fs.watch callbacks and the refold completion, neither of which
 * can await: they must return before the snapshot's filesystem reads finish.
 * Each push is therefore queued behind the previous one for the same session,
 * so two lines arriving back to back can never have their writes interleave or
 * land reversed. This is ordering only — every push still builds and delivers
 * its own snapshot, nothing is coalesced into a window or made to wait on
 * another session (DR-0029). A push that lands after a later fold simply
 * publishes the newer state, which is what a subscriber wants anyway. */
function pushSnapshot(sid: string, live: LiveSessionStatus, log?: TailLog): void {
  live.pushChain = live.pushChain.then(async () => {
    // The session may have been dropped (unsubscribe, re-hello onto another
    // file) while this push waited its turn; publishing then would describe a
    // fold nobody is following.
    if (live.statusConns.size === 0) return;
    try {
      const line = await statusEventLine(sid, live);
      for (const conn of live.statusConns) conn.write(line);
    } catch (e: unknown) {
      // One unreadable snapshot must not break the chain for later pushes, and
      // an unhandled rejection here would take the daemon down.
      log?.error(`session_status push failed sid=${sid}: ${String(e)}`);
    }
  });
}

export async function getSessionStatus(
  store: SessionStatusStore,
  sessions: SessionStatusLookup,
  sid: string,
): Promise<TranscriptResult<SessionStatusSnapshot>> {
  const resolved = resolveConnectedTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  const root = await resolveExternalRoot(sessions, sid);
  const cwd = await resolveWorkspaceAnchor(sessions, sid);
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
    // A cold scan / refold may still be in flight (the fold is only published
    // when it lands); waiting for it keeps this response from describing a
    // prefix of the transcript. Looped rather than awaited once: a truncate
    // landing during the wait supersedes that scan with another one, and the
    // state between them is the half-published fold this guard exists to hide.
    while (live.ready) await live.ready;
    // That scan may have failed while we waited (transcript vanished): its
    // owner unsubscribes and drops the entry, so this fold describes nothing.
    // Answering `ok` here would contradict the not_found the owner returns.
    if (store.sessions.get(sid) !== live) {
      return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
    }
    return { ok: true, data: await snapshot(live.state, live.sidDir, live.cwd) };
  }
  const state = createSessionStatusState(root);
  try {
    await scanTranscript(resolved.file, state);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }
  return { ok: true, data: await snapshot(state, deriveSidDir(resolved.file), cwd) };
}

export async function subscribeSessionStatus(
  store: SessionStatusStore,
  transcriptTail: TranscriptTailStore,
  sessions: SessionStatusLookup,
  sid: string,
  conn: TailConn,
  log: TailLog,
): Promise<TranscriptResult<SessionStatusSnapshot>> {
  const resolved = resolveConnectedTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  const root = await resolveExternalRoot(sessions, sid);
  const cwd = await resolveWorkspaceAnchor(sessions, sid);
  const existing = store.sessions.get(sid);
  if (existing && existing.file === resolved.file && existing.root === root) {
    existing.statusConns.add(conn);
    // Same cwd-refresh rationale as getSessionStatus: the fold survives a
    // cwd-only re-hello, but the workspace anchor must track the new cwd.
    existing.cwd = cwd ?? existing.cwd;
    // Same wait as getSessionStatus, including the refold-chain loop: a
    // subscriber that joins mid-scan gets the complete fold in its op
    // response, not a prefix of it.
    while (existing.ready) await existing.ready;
    // Same failed-scan check as getSessionStatus.
    if (store.sessions.get(sid) !== existing) {
      return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
    }
    return { ok: true, data: await snapshot(existing.state, existing.sidDir, existing.cwd) };
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
  // listener can fire — the Watch only invokes listeners from fs.watch
  // callbacks / poll timers (later ticks), and nothing between here and that
  // assignment awaits.
  const live: LiveSessionStatus = {
    file: "",
    root,
    sidDir: undefined,
    cwd,
    state: createSessionStatusState(root),
    statusConns: carriedConns,
    scanGen: 0,
    pushChain: Promise.resolve(),
    pendingLines: [],
    listener(payload) {
      if (payload.lines.length === 0) {
        // Watch reset (truncate or unlink+recreate replacement, transcript.ts
        // checkNow): the folded state describes bytes that no longer exist.
        // Refold the replacement file from scratch — the Watch's own lastEnd
        // is already payload.size, so subsequent growth resumes incrementally.
        startRefold(sid, live, payload.size, log);
        return;
      }
      if (live.ready) {
        // A scan is walking bytes that end where these lines begin. Folding
        // them now would either be discarded with the superseded state or
        // land out of order, so hold them until the scan publishes.
        live.pendingLines.push(...payload.lines);
        return;
      }
      let changed = false;
      for (const line of payload.lines) {
        if (isSessionStatusCandidate(line) && foldLine(live.state, line)) changed = true;
      }
      if (changed) pushSnapshot(sid, live, log);
    },
  };
  const subscribed = subscribeTranscriptLines(transcriptTail, sessions, sid, live.listener, log);
  if (!subscribed.ok) return subscribed;
  live.file = subscribed.data.file;
  live.sidDir = deriveSidDir(subscribed.data.file);
  // Registered before the cold scan so a second subscriber arriving mid-scan
  // joins this fold and awaits it, instead of starting a rival one.
  store.sessions.set(sid, live);
  live.scanGen += 1;
  const gen = live.scanGen;
  let scanned = true;
  const ready = (async () => {
    try {
      await scanTranscript(live.file, live.state, subscribed.data.size);
    } catch {
      scanned = false;
    }
    // A Watch reset during the cold scan already started its own refold; that
    // scan owns the state from here.
    if (gen !== live.scanGen) return;
    live.ready = undefined;
    drainPendingLines(live);
  })();
  live.ready = ready;
  await ready;
  if (!scanned) {
    unsubscribeTranscriptLines(transcriptTail, sid, live.listener);
    store.sessions.delete(sid);
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }
  if (existing) {
    // Carried-over subscribers were following the OLD file's fold; without a
    // push they would keep rendering it until the new file happens to change.
    // (Only the old conns — the newly-subscribing conn gets the snapshot in
    // its op response.)
    const line = await statusEventLine(sid, live);
    for (const c of existing.statusConns) c.write(line);
  }
  return { ok: true, data: await snapshot(live.state, live.sidDir, live.cwd) };
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
