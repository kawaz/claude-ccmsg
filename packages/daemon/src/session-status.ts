import * as fs from "node:fs";
import {
  ErrorCode,
  type SessionBackgroundStatus,
  type SessionStatusSnapshot,
  type SessionTodo,
  type SessionWorkflowStatus,
} from "@ccmsg/protocol";
import {
  resolveTranscript,
  subscribeTranscriptLines,
  unsubscribeTranscriptLines,
  type SessionLookup,
  type TailConn,
  type TailLog,
  type TranscriptLineListener,
  type TranscriptResult,
  type TranscriptTailStore,
} from "./transcript.ts";

const SCAN_CHUNK_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_TOOL_USES = 1000;

const PREFILTER = [
  '"name":"TaskCreate"',
  '"name":"TaskUpdate"',
  '"name":"TaskStop"',
  '"name":"Workflow"',
  '"name":"Monitor"',
  '"name":"Agent"',
  '"run_in_background":true',
  '"task":{"id"',
  '"workflowName"',
  '"backgroundTaskId"',
  '"agentId"',
  '"updatedFields"',
  '"timeoutMs"',
  '"task_type"',
  "<task-notification>",
] as const;

export function isSessionStatusCandidate(line: string): boolean {
  return PREFILTER.some((part) => line.includes(part));
}

interface PendingToolUse {
  name: string;
  input: Record<string, unknown>;
  timestamp: string;
}

export interface SessionStatusState {
  todos: Map<string, SessionTodo>;
  workflows: Map<string, SessionWorkflowStatus>;
  background: Map<string, SessionBackgroundStatus>;
  pendingToolUse: Map<string, PendingToolUse>;
}

export function createSessionStatusState(): SessionStatusState {
  return {
    todos: new Map(),
    workflows: new Map(),
    background: new Map(),
    pendingToolUse: new Map(),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
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
  if (name === "Agent" || name === "Bash") return input.run_in_background === true;
  return (
    name === "TaskCreate" ||
    name === "TaskUpdate" ||
    name === "TaskStop" ||
    name === "Workflow" ||
    name === "Monitor"
  );
}

function foldAssistant(state: SessionStatusState, row: Record<string, unknown>): false {
  const timestamp = stringValue(row.timestamp);
  const message = row.message;
  if (!timestamp || !isRecord(message) || !Array.isArray(message.content)) return false;

  for (const block of message.content) {
    if (!isRecord(block) || block.type !== "tool_use") continue;
    const id = stringValue(block.id);
    const name = stringValue(block.name);
    const input = block.input;
    if (!id || !name || !isRecord(input) || !isTrackedToolUse(name, input)) continue;
    addPendingToolUse(state, id, name, input, timestamp);
  }
  return false;
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
  timestamp: string | undefined,
): boolean {
  const taskId = stringValue(input.task_id);
  if (!taskId) return false;
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

function applyToolResult(
  state: SessionStatusState,
  pending: PendingToolUse,
  result: Record<string, unknown>,
  timestamp: string | undefined,
  isError: boolean,
): boolean {
  if (isError) return false;
  const { name, input } = pending;

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
    const workflow: SessionWorkflowStatus = {
      task_id: taskId,
      name: workflowName,
      ...(stringValue(result.summary) ? { summary: stringValue(result.summary)! } : {}),
      status: rawStatus === "async_launched" || rawStatus === undefined ? "running" : rawStatus,
      started_at: pending.timestamp,
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

  if (name === "TaskStop") return applyTaskStop(state, input, timestamp);
  return false;
}

function foldUser(state: SessionStatusState, row: Record<string, unknown>): boolean {
  const message = row.message;
  if (!isRecord(message) || !Array.isArray(message.content)) return false;
  const result = row.toolUseResult;
  let changed = false;

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

export function snapshot(state: SessionStatusState): SessionStatusSnapshot {
  return {
    todos: [...state.todos.values()].map((todo) => ({ ...todo })),
    workflows: [...state.workflows.values()].map((workflow) => ({ ...workflow })),
    background: [...state.background.values()].map((task) => ({ ...task })),
  };
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
  /** transcript path this fold was built from — compared against the sid's
   *  currently-resolved path so a re-hello that re-validated a different file
   *  (DR-0009 addendum) invalidates the fold instead of serving stale state. */
  file: string;
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
  return `${JSON.stringify({ ev: "session_status", sid, ...snapshot(live.state) })}\n`;
}

function pushSnapshot(sid: string, live: LiveSessionStatus): void {
  const line = statusEventLine(sid, live);
  for (const conn of live.statusConns) conn.write(line);
}

export function getSessionStatus(
  store: SessionStatusStore,
  sessions: SessionLookup,
  sid: string,
): TranscriptResult<SessionStatusSnapshot> {
  const resolved = resolveTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  // Serve the live fold only while it still describes the sid's current
  // transcript file; after a re-hello swapped the path the cache is stale.
  const live = store.sessions.get(sid);
  if (live && live.file === resolved.file) return { ok: true, data: snapshot(live.state) };
  const state = createSessionStatusState();
  try {
    scanTranscript(resolved.file, state);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }
  return { ok: true, data: snapshot(state) };
}

export function subscribeSessionStatus(
  store: SessionStatusStore,
  transcriptTail: TranscriptTailStore,
  sessions: SessionLookup,
  sid: string,
  conn: TailConn,
  log: TailLog,
): TranscriptResult<SessionStatusSnapshot> {
  const resolved = resolveTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  const existing = store.sessions.get(sid);
  if (existing && existing.file === resolved.file) {
    existing.statusConns.add(conn);
    return { ok: true, data: snapshot(existing.state) };
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
    state: createSessionStatusState(),
    statusConns: carriedConns,
    listener(payload) {
      if (payload.lines.length === 0) {
        // Watch reset (truncate or unlink+recreate replacement, transcript.ts
        // checkNow): the folded state describes bytes that no longer exist.
        // Refold the replacement file from scratch — the Watch's own lastEnd
        // is already payload.size, so subsequent growth resumes incrementally.
        live.state = createSessionStatusState();
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
  return { ok: true, data: snapshot(live.state) };
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
