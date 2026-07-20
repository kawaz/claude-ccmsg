import * as fs from "node:fs";
import * as path from "node:path";
import type {
  MemberEvent,
  MsgEvent,
  RoomKind,
  SessionWorkflowStatus,
  StorageEvent,
} from "@ccmsg/protocol";
import { AGENT_ID_RE } from "./agent-transcripts.ts";
import { createSessionStatusState, foldLine, snapshot } from "./session-status.ts";
import { resolveVirtualTranscript } from "./virtual-sessions.ts";

export type SessionDumpKind =
  | "ccmsg-received"
  | "ccmsg-sent"
  | "agent-spawn"
  | "agent-send"
  | "peer-message"
  | "user"
  | "assistant"
  | "thinking";

interface RawSessionDumpEntry {
  ts: string;
  session: string;
  kind: SessionDumpKind;
  from: string | null;
  to: string | string[] | null;
  text: string;
  meta: Record<string, unknown>;
}

export interface SessionDumpHeader {
  session: string;
  since: string;
  until: string | null;
  generated: string;
  format: "ccmsg-session-dump-v2";
}

export interface SessionContextAgent {
  agent_id: string;
  kind: "teammate" | "subagent";
  state: string;
  name?: string;
  description?: string;
  agent_type?: string;
  model?: string;
}

export interface SessionContextRoom {
  room: string;
  title?: string;
  kind: RoomKind;
  last_mid: number;
  members: MemberEvent[];
}

export interface SessionContextBackground {
  task_id: string;
  kind: "monitor" | "bash";
  description: string;
  state: "possibly-alive";
  started_at: string;
}

export interface SessionContextSchedule {
  task_id: string;
  cron: string;
  prompt: string;
  recurring: boolean;
  state: "possibly-alive";
}

export interface SessionDumpContext {
  kind: "session-context";
  note: string;
  agents: SessionContextAgent[];
  workflows: SessionWorkflowStatus[];
  background: SessionContextBackground[];
  schedules: SessionContextSchedule[];
  rooms: SessionContextRoom[];
}

export interface SessionDumpEntry {
  t: number;
  kind: SessionDumpKind;
  from: string | null;
  to: string | string[] | null;
  text: string;
  meta: Record<string, unknown>;
}

export interface SessionDump {
  header: SessionDumpHeader;
  context: SessionDumpContext;
  entries: SessionDumpEntry[];
}

export interface SessionDumpOptions {
  since?: string;
  until?: string;
  dataDir: string;
  configDirs?: readonly string[];
}

interface TranscriptRow {
  row: Record<string, unknown>;
  index: number;
  ts: string;
}

interface CanonicalMessage extends MsgEvent {
  room: string;
}

interface ToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
  ts: string;
  index: number;
}

const ZONED_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TEAMMATE_MESSAGE_RE = /<(teammate-message|agent-message)([^>]*)>([\s\S]*?)<\/\1>/g;
const EVENT_TAG_RE = /<event>([\s\S]*?)<\/event>/g;
const XML_ATTR_RE = /([\w-]+)="([^"]*)"/g;
const CCMSG_COMMAND_RE = /(?:^|[\s;&|])(?:[^\s;&|]*\/)?ccmsg\s+(post|reply)\b/;
const SESSION_CONTEXT_NOTE =
  "IDs and possibly-alive tasks are best-effort hints. They are usable only when rewind or context clearing preserved the original session process; after a process restart they may already be unreachable.";

function parseBound(value: string | undefined, name: "since" | "until"): number | undefined {
  if (value === undefined) return undefined;
  if (!ZONED_ISO_RE.test(value)) {
    throw new Error(`--${name} must be an ISO 8601 timestamp with timezone: ${value}`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid --${name} timestamp: ${value}`);
  }
  return parsed;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function contentBlocks(row: Record<string, unknown>): unknown[] {
  const message = record(row.message);
  const content = message?.content;
  return Array.isArray(content) ? content : [];
}

function textContent(row: Record<string, unknown>): string {
  const message = record(row.message);
  const content = message?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) => {
      const value = record(block);
      return value?.type === "text" && typeof value.text === "string" ? [value.text] : [];
    })
    .join("\n");
}

function toolResultText(block: Record<string, unknown>): string {
  const content = block.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const value = record(item);
      return value?.type === "text" && typeof value.text === "string"
        ? value.text
        : JSON.stringify(item);
    })
    .join("\n");
}

function parseTranscript(file: string): TranscriptRow[] {
  const rows: TranscriptRow[] = [];
  for (const [index, line] of fs.readFileSync(file, "utf8").split("\n").entries()) {
    if (line.trim() === "") continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const row = record(value);
    if (!row || typeof row.timestamp !== "string") continue;
    rows.push({ row, index, ts: row.timestamp });
  }
  return rows;
}

function loadCanonicalMessages(dataDir: string): Map<string, CanonicalMessage> {
  const messages = new Map<string, CanonicalMessage>();
  const roomsDir = path.join(dataDir, "rooms");
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(roomsDir, { withFileTypes: true });
  } catch {
    return messages;
  }
  for (const file of files) {
    if (!file.isFile() || !/^r\d+\.jsonl$/.test(file.name)) continue;
    const room = file.name.slice(0, -".jsonl".length);
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(roomsDir, file.name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let event: StorageEvent;
      try {
        event = JSON.parse(line) as StorageEvent;
      } catch {
        continue;
      }
      if (event.type === "msg") messages.set(`${room}|${event.mid}`, { ...event, room });
    }
  }
  return messages;
}

function parseResponse(text: string): { room: string; mid: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(text.trim());
  } catch {
    return null;
  }
  const obj = record(value);
  return obj?.ok === true && typeof obj.room === "string" && typeof obj.mid === "number"
    ? { room: obj.room, mid: obj.mid }
    : null;
}

function canonicalEntry(
  session: string,
  kind: "ccmsg-received" | "ccmsg-sent",
  fallbackTs: string,
  message: CanonicalMessage,
  meta: Record<string, unknown>,
): RawSessionDumpEntry {
  return {
    ts: message.ts || fallbackTs,
    session,
    kind,
    from: message.from,
    to: message.to ?? null,
    text: message.msg,
    meta: {
      room: message.room,
      mid: message.mid,
      ...(message.reply_to ? { reply_to: message.reply_to } : {}),
      ...meta,
    },
  };
}

function parseXmlAttrs(raw: string): Record<string, string> {
  return Object.fromEntries([...raw.matchAll(XML_ATTR_RE)].map((match) => [match[1]!, match[2]!]));
}

function parseCcmsgFragment(fragment: string): { room: string; mid: number } | null {
  let value: unknown;
  try {
    value = JSON.parse(fragment.trim());
  } catch {
    return null;
  }
  const obj = record(value);
  return obj?.type === "msg" && typeof obj.r === "string" && typeof obj.mid === "number"
    ? { room: obj.r, mid: obj.mid }
    : null;
}

function peerEntries(
  session: string,
  ts: string,
  text: string,
  canonical: Map<string, CanonicalMessage>,
  sentRefs: ReadonlySet<string>,
  sourceIndex: number,
): RawSessionDumpEntry[] {
  const out: RawSessionDumpEntry[] = [];
  const consumed = new Set<string>();
  for (const match of text.matchAll(TEAMMATE_MESSAGE_RE)) {
    const fragment = match[3]!.trim();
    const ref = parseCcmsgFragment(fragment);
    if (ref) {
      const key = `${ref.room}|${ref.mid}`;
      consumed.add(key);
      if (!sentRefs.has(key)) {
        const message = canonical.get(key);
        if (message) {
          out.push(
            canonicalEntry(session, "ccmsg-received", ts, message, {
              source: "peer-message",
              transcript_line: sourceIndex + 1,
            }),
          );
        }
      }
      continue;
    }
    const attrs = parseXmlAttrs(match[2]!);
    out.push({
      ts,
      session,
      kind: "peer-message",
      from: attrs.from ?? attrs.teammate_id ?? "agent",
      to: session,
      text: fragment,
      meta: {
        wrapper: match[1],
        ...(attrs.summary ? { summary: attrs.summary } : {}),
        transcript_line: sourceIndex + 1,
      },
    });
  }
  for (const match of text.matchAll(EVENT_TAG_RE)) {
    for (const line of match[1]!.split("\n")) {
      const ref = parseCcmsgFragment(line);
      if (!ref) continue;
      const key = `${ref.room}|${ref.mid}`;
      if (consumed.has(key) || sentRefs.has(key)) continue;
      consumed.add(key);
      const message = canonical.get(key);
      if (message) {
        out.push(
          canonicalEntry(session, "ccmsg-received", ts, message, {
            source: "subscribe",
            transcript_line: sourceIndex + 1,
          }),
        );
      }
    }
  }
  return out;
}

function isHumanPrompt(row: Record<string, unknown>, text: string): boolean {
  if (row.promptSource === "system") return false;
  if (row.isMeta === true) return false;
  if (text.startsWith("<") || text.startsWith("[SYSTEM NOTIFICATION - NOT USER INPUT]"))
    return false;
  if (text.startsWith("Another Claude session sent a message:")) return false;
  return text !== "";
}

function normalizeSessionReference(value: unknown, session: string): unknown {
  if (value === session) return "self";
  if (Array.isArray(value)) return value.map((item) => normalizeSessionReference(item, session));
  const obj = record(value);
  if (!obj) return value;
  return Object.fromEntries(
    Object.entries(obj).map(([key, item]) => [key, normalizeSessionReference(item, session)]),
  );
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field !== "" ? field : undefined;
}

function loadTaskNotificationStates(transcriptFile: string): Map<string, string> {
  const states = new Map<string, string>();
  for (const { row } of parseTranscript(transcriptFile)) {
    if (row.type !== "queue-operation" || row.operation !== "enqueue") continue;
    const content = typeof row.content === "string" ? row.content : "";
    const summaryIndex = content.indexOf("<summary>");
    const eventIndex = content.indexOf("<event>");
    const resultIndex = content.indexOf("<result>");
    const boundaries = [summaryIndex, eventIndex, resultIndex].filter((index) => index >= 0);
    const prefix = content.slice(0, boundaries.length > 0 ? Math.min(...boundaries) : undefined);
    const agentId = /<task-id>([^<]+)<\/task-id>/.exec(prefix)?.[1]?.trim();
    const state = /<status>([^<]+)<\/status>/.exec(prefix)?.[1]?.trim();
    if (agentId && state) states.set(agentId, state);
  }
  return states;
}

function loadContextSchedules(
  transcriptFile: string,
  notificationStates: ReadonlyMap<string, string>,
): SessionContextSchedule[] {
  const pending = new Map<string, { name: string; input: Record<string, unknown> }>();
  const schedules = new Map<string, SessionContextSchedule>();
  for (const { row } of parseTranscript(transcriptFile)) {
    if (row.type === "assistant") {
      for (const block of contentBlocks(row)) {
        const value = record(block);
        const input = record(value?.input);
        if (
          value?.type === "tool_use" &&
          typeof value.id === "string" &&
          (value.name === "CronCreate" || value.name === "CronDelete") &&
          input
        ) {
          pending.set(value.id, { name: value.name, input });
        }
      }
      continue;
    }
    if (row.type !== "user") continue;
    for (const block of contentBlocks(row)) {
      const value = record(block);
      if (value?.type !== "tool_result" || typeof value.tool_use_id !== "string") continue;
      const use = pending.get(value.tool_use_id);
      if (!use) continue;
      pending.delete(value.tool_use_id);
      if (value.is_error === true) continue;
      if (use.name === "CronDelete") {
        const taskId = stringField(use.input, "id");
        if (taskId) schedules.delete(taskId);
        continue;
      }
      const result = toolResultText(value);
      const taskId = /Scheduled (?:one-shot|recurring) task ([A-Za-z0-9_-]+)/.exec(result)?.[1];
      const cron = stringField(use.input, "cron");
      const prompt = stringField(use.input, "prompt");
      if (!taskId || !cron || !prompt) continue;
      schedules.set(taskId, {
        task_id: taskId,
        cron,
        prompt,
        recurring: use.input.recurring !== false,
        state: "possibly-alive",
      });
    }
  }
  for (const [taskId, state] of notificationStates) {
    if (state !== "running") schedules.delete(taskId);
  }
  return [...schedules.values()].sort((a, b) => a.task_id.localeCompare(b.task_id, "en"));
}

function loadContextAgents(
  sidDir: string,
  status: ReturnType<typeof snapshot>,
  notificationStates: ReadonlyMap<string, string>,
): SessionContextAgent[] {
  const subagentsDir = path.join(sidDir, "subagents");
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const teammateByName = new Map((status.teammates ?? []).map((item) => [item.name, item]));
  const backgroundById = new Map(status.background.map((item) => [item.task_id, item]));
  const agents: SessionContextAgent[] = [];
  for (const file of files) {
    if (!file.isFile() || !file.name.startsWith("agent-") || !file.name.endsWith(".meta.json")) {
      continue;
    }
    const agentId = file.name.slice("agent-".length, -".meta.json".length);
    if (!AGENT_ID_RE.test(agentId)) continue;
    let meta: Record<string, unknown> | null = null;
    try {
      meta = record(JSON.parse(fs.readFileSync(path.join(subagentsDir, file.name), "utf8")));
    } catch {
      continue;
    }
    if (!meta) continue;
    const name = stringField(meta, "name");
    const teammate = meta.taskKind === "in_process_teammate";
    const agentState = teammate
      ? name
        ? teammateByName.get(name)?.state
        : undefined
      : (notificationStates.get(agentId) ?? backgroundById.get(agentId)?.status);
    agents.push({
      agent_id: agentId,
      kind: teammate ? "teammate" : "subagent",
      state: agentState ?? "unknown",
      ...(name ? { name } : {}),
      ...(stringField(meta, "description")
        ? { description: stringField(meta, "description")! }
        : {}),
      ...(stringField(meta, "agentType") ? { agent_type: stringField(meta, "agentType")! } : {}),
      ...(stringField(meta, "model") ? { model: stringField(meta, "model")! } : {}),
    });
  }
  return agents.sort((a, b) => (a.name ?? a.agent_id).localeCompare(b.name ?? b.agent_id, "en"));
}

function loadContextRooms(dataDir: string, session: string): SessionContextRoom[] {
  const roomsDir = path.join(dataDir, "rooms");
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(roomsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const rooms: SessionContextRoom[] = [];
  for (const file of files) {
    if (!file.isFile() || !/^r\d+\.jsonl$/.test(file.name)) continue;
    const present = new Map<string, MemberEvent>();
    let title: string | undefined;
    let kind: RoomKind = "normal";
    let lastMid = 0;
    let raw: string;
    try {
      raw = fs.readFileSync(path.join(roomsDir, file.name), "utf8");
    } catch {
      continue;
    }
    for (const line of raw.split("\n")) {
      if (line.trim() === "") continue;
      let event: StorageEvent;
      try {
        event = JSON.parse(line) as StorageEvent;
      } catch {
        continue;
      }
      if (event.type === "member") present.set(event.id, event);
      else if (event.type === "leave") present.delete(event.id);
      else if (event.type === "title") title = event.title;
      else if (event.type === "kind") kind = event.kind;
      else if (event.type === "msg" && event.mid > lastMid) lastMid = event.mid;
    }
    const members = [...present.values()];
    if (!members.some((member) => member.sid === session)) continue;
    rooms.push({
      room: file.name.slice(0, -".jsonl".length),
      ...(title ? { title } : {}),
      kind,
      last_mid: lastMid,
      members,
    });
  }
  return rooms.sort((a, b) => Number(a.room.slice(1)) - Number(b.room.slice(1)));
}

function loadSessionContext(
  session: string,
  transcriptFile: string,
  dataDir: string,
): SessionDumpContext {
  const state = createSessionStatusState();
  for (const { row } of parseTranscript(transcriptFile)) foldLine(state, JSON.stringify(row));
  const sidDir = transcriptFile.endsWith(".jsonl")
    ? transcriptFile.slice(0, -".jsonl".length)
    : undefined;
  const status = snapshot(state, sidDir);
  const notificationStates = loadTaskNotificationStates(transcriptFile);
  return {
    kind: "session-context",
    note: SESSION_CONTEXT_NOTE,
    agents: sidDir ? loadContextAgents(sidDir, status, notificationStates) : [],
    workflows: status.workflows,
    background: status.background
      .filter(
        (task): task is typeof task & { kind: "monitor" | "bash" } =>
          task.status === "running" && (task.kind === "monitor" || task.kind === "bash"),
      )
      .map((task) => ({
        task_id: task.task_id,
        kind: task.kind,
        description: task.description,
        state: "possibly-alive",
        started_at: task.started_at,
      })),
    schedules: loadContextSchedules(transcriptFile, notificationStates),
    rooms: loadContextRooms(dataDir, session),
  };
}

export function dumpSession(session: string, options: SessionDumpOptions): SessionDump {
  const since = parseBound(options.since, "since");
  const until = parseBound(options.until, "until");
  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("--since must not be later than --until");
  }
  const resolved = resolveVirtualTranscript(session, options.configDirs);
  if (!resolved) throw new Error(`session transcript not found: ${session}`);
  const rows = parseTranscript(resolved.file);
  const canonical = loadCanonicalMessages(options.dataDir);
  const toolUses = new Map<string, ToolUse>();
  const sentEntries: RawSessionDumpEntry[] = [];
  const sentRefs = new Set<string>();

  for (const item of rows) {
    if (item.row.type === "assistant") {
      for (const block of contentBlocks(item.row)) {
        const value = record(block);
        if (
          value?.type === "tool_use" &&
          typeof value.id === "string" &&
          typeof value.name === "string" &&
          record(value.input)
        ) {
          toolUses.set(value.id, {
            id: value.id,
            name: value.name,
            input: record(value.input)!,
            ts: item.ts,
            index: item.index,
          });
        }
      }
    }
    if (item.row.type !== "user") continue;
    for (const block of contentBlocks(item.row)) {
      const value = record(block);
      if (value?.type !== "tool_result" || typeof value.tool_use_id !== "string") continue;
      const use = toolUses.get(value.tool_use_id);
      if (use?.name !== "Bash") continue;
      const command = typeof use.input.command === "string" ? use.input.command : "";
      const commandMatch = command.match(CCMSG_COMMAND_RE);
      if (!commandMatch) continue;
      const response = parseResponse(toolResultText(value));
      if (!response) continue;
      const key = `${response.room}|${response.mid}`;
      const message = canonical.get(key);
      if (!message) continue;
      sentRefs.add(key);
      sentEntries.push(
        canonicalEntry(session, "ccmsg-sent", use.ts, message, {
          source: "bash",
          op: commandMatch[1],
          tool_use_id: use.id,
          command,
          transcript_line: use.index + 1,
        }),
      );
    }
  }

  const entries: Array<RawSessionDumpEntry & { _index: number }> = sentEntries.map((entry) => ({
    ...entry,
    _index:
      typeof entry.meta.transcript_line === "number"
        ? entry.meta.transcript_line - 1
        : Number.MAX_SAFE_INTEGER,
  }));

  for (const item of rows) {
    if (item.row.type === "assistant") {
      const texts: string[] = [];
      for (const block of contentBlocks(item.row)) {
        const value = record(block);
        if (!value) continue;
        if (value.type === "text" && typeof value.text === "string" && value.text !== "") {
          texts.push(value.text);
          continue;
        }
        if (
          value.type === "thinking" &&
          typeof value.thinking === "string" &&
          value.thinking !== ""
        ) {
          entries.push({
            ts: item.ts,
            session,
            kind: "thinking",
            from: session,
            to: null,
            text: value.thinking,
            meta: { transcript_line: item.index + 1 },
            _index: item.index,
          });
          continue;
        }
        if (value.type !== "tool_use" || typeof value.name !== "string") continue;
        const input = record(value.input);
        if (!input) continue;
        if (value.name === "Agent") {
          const description = typeof input.description === "string" ? input.description : "";
          entries.push({
            ts: item.ts,
            session,
            kind: "agent-spawn",
            from: session,
            to: typeof input.name === "string" ? input.name : null,
            text: typeof input.prompt === "string" ? input.prompt : "",
            meta: {
              tool_use_id: typeof value.id === "string" ? value.id : null,
              name: typeof input.name === "string" ? input.name : description || null,
              description,
              subagent_type: typeof input.subagent_type === "string" ? input.subagent_type : null,
              model: typeof input.model === "string" ? input.model : null,
              run_in_background: input.run_in_background === true,
              transcript_line: item.index + 1,
            },
            _index: item.index,
          });
        } else if (value.name === "SendMessage") {
          entries.push({
            ts: item.ts,
            session,
            kind: "agent-send",
            from: session,
            to: typeof input.to === "string" ? input.to : null,
            text: typeof input.message === "string" ? input.message : "",
            meta: {
              tool_use_id: typeof value.id === "string" ? value.id : null,
              summary: typeof input.summary === "string" ? input.summary : null,
              message_type: typeof input.type === "string" ? input.type : "message",
              transcript_line: item.index + 1,
            },
            _index: item.index,
          });
        }
      }
      if (texts.length > 0) {
        entries.push({
          ts: item.ts,
          session,
          kind: "assistant",
          from: session,
          to: "user",
          text: texts.join("\n"),
          meta: { transcript_line: item.index + 1 },
          _index: item.index,
        });
      }
      continue;
    }
    if (item.row.type !== "user" && item.row.type !== "queue-operation") continue;
    const text =
      item.row.type === "queue-operation" && typeof item.row.content === "string"
        ? item.row.content
        : textContent(item.row);
    for (const entry of peerEntries(session, item.ts, text, canonical, sentRefs, item.index)) {
      entries.push({ ...entry, _index: item.index });
    }
    if (item.row.type === "user" && isHumanPrompt(item.row, text)) {
      entries.push({
        ts: item.ts,
        session,
        kind: "user",
        from: "user",
        to: session,
        text,
        meta: { transcript_line: item.index + 1 },
        _index: item.index,
      });
    }
  }

  const dedup = new Set<string>();
  const filtered = entries
    .filter((entry) => {
      const time = Date.parse(entry.ts);
      return (
        Number.isFinite(time) &&
        (since === undefined || time >= since) &&
        (until === undefined || time <= until)
      );
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a._index - b._index)
    .filter((entry) => {
      const key =
        (entry.kind === "ccmsg-received" || entry.kind === "ccmsg-sent") &&
        typeof entry.meta.room === "string" &&
        typeof entry.meta.mid === "number"
          ? `${entry.kind}|${entry.meta.room}|${entry.meta.mid}`
          : entry.kind === "peer-message"
            ? `${entry.kind}|${entry.from ?? ""}|${entry.text}`
            : `${entry.kind}|${entry._index}|${entry.text}`;
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    });
  const base = since ?? (filtered[0] ? Date.parse(filtered[0].ts) : Date.now());
  return {
    header: {
      session,
      since: new Date(base).toISOString(),
      until: until === undefined ? null : new Date(until).toISOString(),
      generated: new Date().toISOString(),
      format: "ccmsg-session-dump-v2",
    },
    context: loadSessionContext(session, resolved.file, options.dataDir),
    entries: filtered.map(({ _index: _discard, ts, session: _session, ...entry }) => ({
      ...entry,
      t: Date.parse(ts) - base,
      from: normalizeSessionReference(entry.from, session) as string | null,
      to: normalizeSessionReference(entry.to, session) as string | string[] | null,
      meta: normalizeSessionReference(entry.meta, session) as Record<string, unknown>,
    })),
  };
}
