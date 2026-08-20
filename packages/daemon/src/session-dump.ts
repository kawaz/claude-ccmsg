import * as fs from "node:fs";
import * as path from "node:path";
import type {
  MemberEvent,
  MsgEvent,
  RoomKind,
  SessionApiError,
  SessionTodo,
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
  /** How to read back an agent that this dump folded to one line. Present only
   * when something was folded, so it never adds noise to a dump that already
   * shows every agent in full. */
  agent_detail?: string;
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

/** One-line form of an agent that never appears in the dumped range: enough to
 * recognize it and to name it in `--agent`, nothing more. */
export interface SessionContextAgentBrief {
  agent_id: string;
  name?: string;
  description?: string;
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
  /** Folded TODO list (TUI-equivalent current state, DR-0020). Completed items
   * are kept: a rewound session that only sees the open items risks redoing
   * finished work, which is the costlier failure mode. `status` distinguishes
   * them, so a journal consumer can filter cheaply. */
  todos: SessionTodo[];
  /** Agents this dump's range actually involves, in full. Omitted entirely
   * under `--no-agent`. */
  agents?: SessionContextAgent[];
  /** Agents that only exist outside the dumped range, folded to one line each.
   * They are still addressable identities, so dropping them would hide work the
   * session did; but their spawn prompts and states belong to a past the
   * rewound session is not resuming. `header.agent_detail` names the command
   * that expands one. Absent when empty, and under `--no-agent`. */
  agents_past?: SessionContextAgentBrief[];
  /** Omitted entirely under `--no-agent`. */
  workflows?: SessionWorkflowStatus[];
  background: SessionContextBackground[];
  schedules: SessionContextSchedule[];
  rooms: SessionContextRoom[];
  /** Present iff the session's last main-context turn ended on a harness API
   * error ("Prompt is too long", a 500, a usage limit) instead of a completed
   * turn. That is why the transcript stops where it does — worth stating
   * outright, since a rewind consumer otherwise has to infer it from a
   * conversation that simply ends mid-air. */
  api_error?: SessionApiError;
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
  /** Inclusive lower bound, as either a timezone-qualified ISO 8601 timestamp
   * or a transcript record `uuid`. A uuid cuts at that record's position in
   * the transcript, so records sharing its timestamp stay on their own side of
   * the boundary — which a clock-based cut cannot promise. */
  since?: string;
  /** Inclusive upper bound, in the same two forms as `since`. */
  until?: string;
  dataDir: string;
  configDirs?: readonly string[];
  /** Drop assistant thinking blocks. Recovering a session needs the conclusions
   * that already reached the transcript; thinking is bulk. Journal generation
   * wants the opposite, so the default keeps them. */
  noThinking?: boolean;
  /** Drop the in-process agent machinery: the `agents`/`workflows` context and
   * the `agent-spawn` / `agent-send` / `peer-message` entries. Cross-session
   * ccmsg traffic and rooms stay — those are correspondence, not machinery. */
  noAgent?: boolean;
  /** Expand one agent instead of the whole session: keep only the entries that
   * involve it (its spawn prompt, the SendMessage bodies addressed to it, its
   * replies). Accepts an agent id, an agent name, or an unambiguous agent id
   * prefix. This is the read-back path for an agent folded into `agents_past`;
   * that fold is what `--since` caused, so the read-back is normally issued
   * without one. It narrows independently of `--since`/`--until` rather than
   * overriding them: an explicitly given range silently ignored would be the
   * bigger surprise. */
  agent?: string;
  /** The transcript to dump, when the caller already resolved `session`
   * through the daemon's own resolver (`resolveTranscript`, which answers for
   * connected sessions too). Given this, `dumpSession` skips its historical
   * lookup rather than repeating a resolution that already succeeded — and
   * would not necessarily succeed a second time, since the two resolvers see
   * different sets of sessions. */
  transcriptFile?: string;
}

/** `agent-spawn` / `agent-send` / `peer-message` are the three kinds produced by
 * the in-process Agent tool machinery (Agent spawn prompts, SendMessage bodies,
 * teammate-message deliveries). ccmsg-received / ccmsg-sent are deliberately
 * absent: they are session-to-session correspondence that a journal is about. */
const AGENT_ENTRY_KINDS: ReadonlySet<SessionDumpKind> = new Set<SessionDumpKind>([
  "agent-spawn",
  "agent-send",
  "peer-message",
]);

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

/** Transcript record `uuid` shape (8-4-4-4-12 hex). A `--since`/`--until` value
 * in this shape names a record; anything else is read as a timestamp. */
const RECORD_UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ZONED_ISO_RE =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/;
const TEAMMATE_MESSAGE_RE = /<(teammate-message|agent-message)([^>]*)>([\s\S]*?)<\/\1>/g;
const EVENT_TAG_RE = /<event>([\s\S]*?)<\/event>/g;
const XML_ATTR_RE = /([\w-]+)="([^"]*)"/g;
const CCMSG_COMMAND_RE = /(?:^|[\s;&|])(?:[^\s;&|]*\/)?ccmsg\s+(post|reply)\b/;
const SESSION_CONTEXT_NOTE =
  "IDs and possibly-alive tasks are best-effort hints. They are usable only when rewind or context clearing preserved the original session process; after a process restart they may already be unreachable.";

/** What a `--since`/`--until` value was written as. A uuid names one transcript
 * record, which is the sharper boundary: several records can share a timestamp,
 * and a range that cuts on time cannot tell them apart. */
type DumpBound = { kind: "time"; ms: number } | { kind: "record"; uuid: string };

/** A bound placed on the transcript: `ms` is what the header reports and what
 * entry `t` offsets are measured from, `index` is the transcript row to cut at
 * and is present only for a uuid bound. */
interface ResolvedBound {
  ms: number;
  index?: number;
}

function parseBound(value: string | undefined, name: "since" | "until"): DumpBound | undefined {
  if (value === undefined) return undefined;
  if (RECORD_UUID_RE.test(value)) return { kind: "record", uuid: value };
  if (!ZONED_ISO_RE.test(value)) {
    throw new Error(
      `--${name} must be an ISO 8601 timestamp with timezone or a transcript record uuid: ${value}`,
    );
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new Error(`invalid --${name} timestamp: ${value}`);
  }
  return { kind: "time", ms: parsed };
}

/** Whether `since` really precedes `until`. Two record bounds compare by
 * position, which is what they were chosen for: records sharing a timestamp
 * are still ordered, and comparing their equal `ms` would call a valid range
 * inverted. Anything else compares by time, the only scale both kinds share. */
function isOrdered(since: ResolvedBound, until: ResolvedBound): boolean {
  if (since.index !== undefined && until.index !== undefined) return since.index <= until.index;
  return since.ms <= until.ms;
}

/** Place a bound on `rows`. A uuid that names no record in this transcript is
 * refused rather than silently widened to the whole session: the caller asked
 * to cut at one specific message, and dumping more than that would quietly
 * hand a successor session memories it was meant not to have. */
function resolveBound(
  bound: DumpBound | undefined,
  rows: readonly TranscriptRow[],
  name: "since" | "until",
): ResolvedBound | undefined {
  if (bound === undefined) return undefined;
  if (bound.kind === "time") return { ms: bound.ms };
  const row = rows.find((item) => item.row.uuid === bound.uuid);
  if (!row) {
    throw new Error(
      `--${name} record uuid not found in this session's transcript: ${bound.uuid} — use a uuid this session recorded (the webui shows each record's uuid), or pass an ISO 8601 timestamp instead`,
    );
  }
  return { ms: Date.parse(row.ts), index: row.index };
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

export interface ContextAgentRecord {
  agent: SessionContextAgent;
  /** Every token a dump entry can use to name this agent (see `agentTokens`). */
  tokens: string[];
}

function loadContextAgents(
  sidDir: string,
  status: Awaited<ReturnType<typeof snapshot>>,
  notificationStates: ReadonlyMap<string, string>,
): ContextAgentRecord[] {
  const subagentsDir = path.join(sidDir, "subagents");
  let files: fs.Dirent[];
  try {
    files = fs.readdirSync(subagentsDir, { withFileTypes: true });
  } catch {
    return [];
  }
  const teammateByName = new Map((status.teammates ?? []).map((item) => [item.name, item]));
  const backgroundById = new Map(status.background.map((item) => [item.task_id, item]));
  const agents: ContextAgentRecord[] = [];
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
      agent: {
        agent_id: agentId,
        kind: teammate ? "teammate" : "subagent",
        state: agentState ?? "unknown",
        ...(name ? { name } : {}),
        ...(stringField(meta, "description")
          ? { description: stringField(meta, "description")! }
          : {}),
        ...(stringField(meta, "agentType") ? { agent_type: stringField(meta, "agentType")! } : {}),
        ...(stringField(meta, "model") ? { model: stringField(meta, "model")! } : {}),
      },
      // A dump entry names an agent in one of three ways, and which one is
      // available depends on how it was spawned: teammates appear by `name`
      // (SendMessage `to`, peer-message `from`), nameless background subagents
      // only ever appear as the spawning `tool_use_id`, and the agent id itself
      // shows up wherever the session quotes it back. Collect all three.
      tokens: [
        agentId,
        ...(name ? [name] : []),
        ...(stringField(meta, "toolUseId") ? [stringField(meta, "toolUseId")!] : []),
      ],
    });
  }
  return agents.sort(compareContextAgents);
}

/** Order the dump's agent roster: by display name, then by agent id.
 *
 * The id tiebreak is what makes the order a total one. Re-delegating a job
 * spawns a fresh agent per round under a single name, so same-name agents are
 * routine rather than exceptional — and comparing only the name leaves them
 * equal, at which point a stable sort just republishes whatever `readdir`
 * handed over. That order is a filesystem property (insertion-ordered on APFS,
 * hash-ordered on ext4), so without this tiebreak one session dumps its retry
 * rounds in one order on macOS and the reverse on Linux. */
export function compareContextAgents(a: ContextAgentRecord, b: ContextAgentRecord): number {
  return (
    (a.agent.name ?? a.agent.agent_id).localeCompare(b.agent.name ?? b.agent.agent_id, "en") ||
    a.agent.agent_id.localeCompare(b.agent.agent_id, "en")
  );
}

function brief(agent: SessionContextAgent): SessionContextAgentBrief {
  return {
    agent_id: agent.agent_id,
    ...(agent.name ? { name: agent.name } : {}),
    ...(agent.description ? { description: agent.description } : {}),
  };
}

/** Resolve a `--agent` selector to the agents it names.
 *
 * An exact id picks exactly one. An exact name picks *every* agent carrying it:
 * a session that delegates the same job repeatedly spawns a fresh agent per
 * round under one name, and "show me what I did with local-issue-update" means
 * all of those rounds — forcing a choice between twenty opaque ids would answer
 * a question nobody asked. An id prefix is the last resort, since ids are long
 * hex a reader will paste in fragments; there it must be unambiguous, because a
 * prefix collision is an accident rather than a shared identity, and silently
 * dumping the wrong agent is worse than asking for more characters. */
function resolveAgentSelector(
  selector: string,
  agents: readonly ContextAgentRecord[],
): ContextAgentRecord[] {
  const byId = agents.filter(({ agent }) => agent.agent_id === selector);
  if (byId.length > 0) return byId;
  const byName = agents.filter(({ agent }) => agent.name === selector);
  if (byName.length > 0) return byName;
  const byPrefix = agents.filter(({ agent }) => agent.agent_id.startsWith(selector));
  if (byPrefix.length === 1) return byPrefix;
  if (byPrefix.length === 0) {
    throw new Error(`no agent matches --agent ${selector} in this session`);
  }
  const shown = byPrefix
    .slice(0, 5)
    .map(({ agent }) => (agent.name ? `${agent.agent_id} (${agent.name})` : agent.agent_id));
  const rest = byPrefix.length - shown.length;
  throw new Error(
    `--agent ${selector} matches ${byPrefix.length} agents, use more characters: ` +
      `${shown.join(", ")}${rest > 0 ? `, and ${rest} more` : ""}`,
  );
}

/** The tokens by which one dump entry names the agent it concerns. Only the
 * three agent machinery kinds are consulted: ccmsg endpoints are room member
 * ids belonging to other sessions, not agents of this one. */
function entryAgentTokens(entry: RawSessionDumpEntry): string[] {
  if (!AGENT_ENTRY_KINDS.has(entry.kind)) return [];
  const values: unknown[] = [entry.from, ...(Array.isArray(entry.to) ? entry.to : [entry.to])];
  // `meta.name` falls back to the spawn description when the Agent call passed
  // no name; that fallback is prose, not an identity, so only take it when the
  // two differ.
  if (entry.meta.name !== entry.meta.description) values.push(entry.meta.name);
  values.push(entry.meta.tool_use_id);
  return values.filter((value): value is string => typeof value === "string" && value !== "");
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

interface SessionStatusBundle {
  status: Awaited<ReturnType<typeof snapshot>>;
  notificationStates: ReadonlyMap<string, string>;
  agents: ContextAgentRecord[];
}

async function loadStatusBundle(transcriptFile: string): Promise<SessionStatusBundle> {
  const state = createSessionStatusState();
  for (const { row } of parseTranscript(transcriptFile)) foldLine(state, JSON.stringify(row));
  const sidDir = transcriptFile.endsWith(".jsonl")
    ? transcriptFile.slice(0, -".jsonl".length)
    : undefined;
  const status = await snapshot(state, sidDir);
  const notificationStates = loadTaskNotificationStates(transcriptFile);
  return {
    status,
    notificationStates,
    agents: sidDir ? loadContextAgents(sidDir, status, notificationStates) : [],
  };
}

function loadSessionContext(
  session: string,
  transcriptFile: string,
  dataDir: string,
  noAgent: boolean,
  bundle: SessionStatusBundle,
  /** Tokens naming the agents the dumped entries actually involve. Agents
   * outside it are folded to one line. */
  rangeTokens: ReadonlySet<string>,
  /** `--agent` already answers "which agent", so the roster of the others is
   * pure noise in a targeted read. */
  listPast: boolean,
): SessionDumpContext {
  const { status, notificationStates } = bundle;
  const inRange = new Set(
    bundle.agents.filter((record) => record.tokens.some((token) => rangeTokens.has(token))),
  );
  const past = listPast ? bundle.agents.filter((record) => !inRange.has(record)) : [];
  return {
    kind: "session-context",
    note: SESSION_CONTEXT_NOTE,
    todos: status.todos,
    ...(noAgent
      ? {}
      : {
          agents: bundle.agents.filter((record) => inRange.has(record)).map(({ agent }) => agent),
          ...(past.length > 0 ? { agents_past: past.map((record) => brief(record.agent)) } : {}),
        }),
    ...(noAgent ? {} : { workflows: status.workflows }),
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
    ...(status.api_error ? { api_error: status.api_error } : {}),
  };
}

export async function dumpSession(
  session: string,
  options: SessionDumpOptions,
): Promise<SessionDump> {
  // Parsed before the transcript is read (a malformed value is the caller's
  // typo, worth refusing without touching the disk), placed on the records
  // afterwards — a uuid bound has no meaning until there are records to find
  // it among.
  const sinceBound = parseBound(options.since, "since");
  const untilBound = parseBound(options.until, "until");
  if (options.agent !== undefined && options.noAgent === true) {
    throw new Error("--agent and --no-agent contradict each other: pick one");
  }
  const file =
    options.transcriptFile ?? (await resolveVirtualTranscript(session, options.configDirs))?.file;
  if (file === undefined) throw new Error(`session transcript not found: ${session}`);
  const rows = parseTranscript(file);
  const sinceAt = resolveBound(sinceBound, rows, "since");
  const untilAt = resolveBound(untilBound, rows, "until");
  if (sinceAt !== undefined && untilAt !== undefined && !isOrdered(sinceAt, untilAt)) {
    throw new Error("--since must not be later than --until");
  }
  const since = sinceAt?.ms;
  const until = untilAt?.ms;
  const bundle = await loadStatusBundle(file);
  const selectedTokens =
    options.agent === undefined
      ? undefined
      : new Set(resolveAgentSelector(options.agent, bundle.agents).flatMap(({ tokens }) => tokens));
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
    .filter(
      (entry) =>
        !(options.noThinking === true && entry.kind === "thinking") &&
        !(options.noAgent === true && AGENT_ENTRY_KINDS.has(entry.kind)),
    )
    .filter((entry) => {
      const time = Date.parse(entry.ts);
      if (!Number.isFinite(time)) return false;
      // A record bound cuts on the transcript position it names (inclusive on
      // both ends), never on that record's clock: the whole reason to name a
      // uuid is that the records sharing its timestamp must not come along.
      const after =
        sinceAt === undefined ||
        (sinceAt.index === undefined ? time >= sinceAt.ms : entry._index >= sinceAt.index);
      const before =
        untilAt === undefined ||
        (untilAt.index === undefined ? time <= untilAt.ms : entry._index <= untilAt.index);
      return after && before;
    })
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts) || a._index - b._index)
    .filter((entry) => {
      if (selectedTokens === undefined) return true;
      return entryAgentTokens(entry).some((token) => selectedTokens.has(token));
    })
    .filter((entry) => {
      const key =
        (entry.kind === "ccmsg-received" || entry.kind === "ccmsg-sent") &&
        typeof entry.meta.room === "string" &&
        typeof entry.meta.mid === "number"
          ? `${entry.kind}|${entry.meta.room}|${entry.meta.mid}`
          : entry.kind === "peer-message"
            ? `${entry.kind}|${entry.from ?? ""}|${entry.text}`
            : // Two tool_use blocks are two distinct actions even when their
              // texts coincide (several spawns in one assistant turn, all with
              // an empty prompt), so the tool_use_id keys them apart.
              typeof entry.meta.tool_use_id === "string"
              ? `${entry.kind}|${entry.meta.tool_use_id}`
              : `${entry.kind}|${entry._index}|${entry.text}`;
      if (dedup.has(key)) return false;
      dedup.add(key);
      return true;
    });
  const base = since ?? (filtered[0] ? Date.parse(filtered[0].ts) : Date.now());
  // An agent is "in range" when the dumped entries involve it. The `--agent`
  // selection counts too, so the agent that was asked for stays expanded even
  // when the surrounding time range holds none of its entries.
  const rangeTokens = new Set<string>(selectedTokens ?? []);
  for (const entry of filtered) for (const token of entryAgentTokens(entry)) rangeTokens.add(token);
  const context = loadSessionContext(
    session,
    file,
    options.dataDir,
    options.noAgent === true,
    bundle,
    rangeTokens,
    selectedTokens === undefined,
  );
  return {
    header: {
      session,
      since: new Date(base).toISOString(),
      until: until === undefined ? null : new Date(until).toISOString(),
      generated: new Date().toISOString(),
      format: "ccmsg-session-dump-v2",
      ...(context.agents_past === undefined
        ? {}
        : {
            agent_detail: `ccmsg dump ${session} --agent <agent_id|name> — expand one of the agents_past entries (its spawn prompt, the messages sent to it, its replies)`,
          }),
    },
    context,
    entries: filtered.map(({ _index: _discard, ts, session: _session, ...entry }) => ({
      ...entry,
      t: Date.parse(ts) - base,
      from: normalizeSessionReference(entry.from, session) as string | null,
      to: normalizeSessionReference(entry.to, session) as string | string[] | null,
      meta: normalizeSessionReference(entry.meta, session) as Record<string, unknown>,
    })),
  };
}

/** JSONL serialization of a dump: header line, context line, then one line per
 * entry. The CLI's stdout form and a `jsonl`-format file written by
 * `writeSessionDumpFile` are the same bytes, so a consumer never has to know
 * which produced its input. */
export function formatJsonlDump(dump: SessionDump): string {
  const lines = [JSON.stringify(dump.header), JSON.stringify(dump.context)];
  for (const entry of dump.entries) lines.push(JSON.stringify(entry));
  return `${lines.join("\n")}\n`;
}

function dumpEndpoint(value: SessionDumpEntry["to"] | SessionDumpEntry["from"]): string {
  if (value === null) return "-";
  return Array.isArray(value) ? value.join(",") : value;
}

/** One `SessionTodo` as a single line: `[status] #id subject (owner: X) blocked
 * by: 1,2`. `status` already carries the pending/in_progress/completed
 * distinction, so no separate marker is needed for "in progress". */
function formatTodoLine(todo: SessionTodo): string {
  const owner = todo.owner ? ` (owner: ${todo.owner})` : "";
  const blockedBy =
    todo.blocked_by && todo.blocked_by.length > 0
      ? ` blocked by: ${todo.blocked_by.join(",")}`
      : "";
  return `[${todo.status}] #${todo.id} ${todo.subject}${owner}${blockedBy}`;
}

/** Human-reading serialization of a dump: the form both `ccmsg dump --format
 * text` and the webui's file dump write, so a successor session reading it
 * back never has to parse JSONL to recover its own handoff context (jsonl
 * invites over-clever parsing attempts and half-read continuations instead —
 * this is the one true reading form). */
export function formatTextDump(dump: SessionDump): string {
  const { header, context, entries } = dump;
  // `agents_past` and `todos` are one line per item by design; pretty-printing
  // either as JSON would spend several lines each and defeat the fold. Both
  // are lifted out of the context JSON and rendered as the flat lists they
  // represent.
  const { kind: _contextKind, agents_past: past, todos, ...contextFields } = context;
  const lines = [
    `Session: ${header.session}`,
    `Since: ${header.since}`,
    `Until: ${header.until ?? "(end)"}`,
    `Generated: ${header.generated}`,
    `Format: ${header.format} text`,
    ...(header.agent_detail ? [`Agent detail: ${header.agent_detail}`] : []),
    "Session context:",
    JSON.stringify(contextFields, null, 2),
    ...(todos.length > 0
      ? [`Todos (${todos.length}):`, ...todos.map((todo) => `  ${formatTodoLine(todo)}`)]
      : []),
    ...(past && past.length > 0
      ? [
          `Agents outside this range (${past.length}):`,
          ...past.map(
            (agent) =>
              `  ${agent.agent_id}${agent.name ? ` ${agent.name}` : ""}${
                agent.description ? ` — ${agent.description}` : ""
              }`,
          ),
        ]
      : []),
    "",
  ];
  for (const entry of entries) {
    lines.push(
      `[+${entry.t}ms ${entry.kind} ${dumpEndpoint(entry.from)}→${dumpEndpoint(entry.to)}]`,
      entry.text,
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

/** File name of an auto-named dump: sid first so a directory listing groups by
 * session, local wall-clock second so repeated dumps of one session sort in
 * the order they were taken. The extension follows `format`, since a `.jsonl`
 * name on a text file (or vice versa) would mislead whatever opens it next. */
export function sessionDumpFileName(
  session: string,
  at: Date = new Date(),
  format: SessionDumpFileFormat = "jsonl",
): string {
  const p = (n: number, width = 2): string => String(n).padStart(width, "0");
  const stamp = `${at.getFullYear()}${p(at.getMonth() + 1)}${p(at.getDate())}-${p(at.getHours())}${p(at.getMinutes())}${p(at.getSeconds())}`;
  return `${session}-${stamp}.${format === "text" ? "txt" : "jsonl"}`;
}

/** The two forms `writeSessionDumpFile` can serialize to. `jsonl` is the
 * read-back-by-tooling form (`ccmsg dump --out`); `text` is
 * `formatTextDump`'s human-reading form, and what the webui's file dump uses
 * so a successor session picks the file up and reads it directly. */
export type SessionDumpFileFormat = "jsonl" | "text";

/** Write `dump` to a file and answer where it landed. `target` is either the
 * directory to auto-name inside (the daemon's `dumps/`) or an explicit file
 * path from `--out`; both are resolved to an absolute path, since the whole
 * point of the returned value is to be pasted into another session. */
export function writeSessionDumpFile(
  dump: SessionDump,
  target: { dir: string; at?: Date } | { file: string },
  format: SessionDumpFileFormat = "jsonl",
): string {
  const file =
    "file" in target
      ? path.resolve(target.file)
      : path.join(
          path.resolve(target.dir),
          sessionDumpFileName(dump.header.session, target.at, format),
        );
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, format === "text" ? formatTextDump(dump) : formatJsonlDump(dump));
  return file;
}
