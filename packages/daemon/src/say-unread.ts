// Which says the person has not read (DR-0045 §7). A say is a `say` tool
// call on the main thread of a session, known by its tool_use's id. For a live
// session the relay hands its lines to the fold here (the catch-up's and every
// push's read); for one that is not live, a tab opening it has its transcript
// read once for its status, and the same read counts its says (sayScan). A
// say is seen with its row's time. What is read is a set
// of those ids, kept in `<stateDir>/say-read.json` with `since`, the time
// before which every say counts as read: the first start, and a file that
// does not read, would otherwise make every say in every live transcript
// unread at once.
//
// The 🔔 filter shows every say of a session, read or not (say_list,
// DR-0050 §5): the first ask reads the session's transcript and its agents'
// whole (sayList), and from then on the fold's lines and the pushed rows add
// to what it found. Those says are counted with the others, each id once.
//
// Design rationale: this is the one state the daemon keeps on disk for the
// webui alone (DR-0036 §3 keeps v1 from growing such state). The says are
// drawn from the transcripts, which outlive the daemon; with the read ids in
// memory only, every restart would bring back every say as unread.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  ccmsgSayText,
  isKnownContentBlock,
  isKnownTranscriptRow,
  jsonText,
  parseWith,
  TranscriptRowLineSchema,
  type AgentSay,
  type SessionSay,
  type TranscriptPushRow,
  type UnreadSay,
} from "@ccmsg/protocol";
import { listAgentTranscripts } from "./agent-transcripts.ts";
import type { OneShotLineReader } from "./session-status.ts";
import { scanTranscriptLines } from "./transcript.ts";
import type { LineFold } from "./transcript-relay.ts";
import { toolUsesOf } from "./row-effects.ts";

/** say-read.json: the read ids, and the time before which every say is
 * read. */
const SayReadFileSchema = jsonText(
  v.object({
    since: v.pipe(v.string(), v.isoTimestamp()),
    read: v.array(v.string()),
  }),
);

/** The says of one session's main thread, by tool_use id, to their row's
 * time. */
type SessionSays = Map<string, string>;

/** The says of one live session's subagents and teammates, by tool_use id. */
type SessionAgentSays = Map<string, { agentId: string; ts: string; text: string }>;

/** A say of a session as say_list hands it, by tool_use id. */
interface ListedSay {
  ts: string;
  text: string;
  /** The subagent or teammate that called it; absent on the main thread. */
  agentId?: string;
}

/** Every say of one session, from the first say_list on (sayList). */
interface SessionSayList {
  says: Map<string, ListedSay>;
  /** The first read of the session's transcripts: `says` is whole once it
   * lands. Rejects when the session's own transcript does not read. */
  reading: Promise<void>;
}

export interface SayUnreadStore {
  /** The settled says of each live session. */
  says: Map<string, SessionSays>;
  /** The says of sessions that are not live, as the last one-shot read of
   * their transcript found them (sayScan): kept until the session becomes
   * live, when its fold takes over, or the daemon stops. A session in `says`
   * is not read from here. */
  scanned: Map<string, SessionSays>;
  /** The says of each live session's subagents and teammates (DR-0050 §10).
   * Their rows are in the agents' own transcripts, which the relay does not
   * read, so they come from the pushed rows only: a say made while the daemon
   * was down is not among them. */
  agentSays: Map<string, SessionAgentSays>;
  /** Every say, read or not, of each session a say_list asked for: its main
   * thread's and its agents', live or not. Kept until the daemon stops; the
   * fold's lines and the pushed rows add to it. */
  listed: Map<string, SessionSayList>;
  read: Set<string>;
  since: string;
  file: string;
  /** The last write of the file: the writes go one after another, so an
   * older set never lands over a newer one. */
  written: Promise<void>;
}

export interface SayReadLog {
  warn(msg: string): void;
}

/** The store as `file` holds it. A file that is missing or does not read
 * starts over from now (said in the log when it was there). */
export function loadSayUnreadStore(file: string, log: SayReadLog, now: () => Date): SayUnreadStore {
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      log.warn(
        `say-read: ${file}: ${e instanceof Error ? e.message : "unreadable"} — starting over`,
      );
    }
  }
  const read = text === undefined ? undefined : parseWith(SayReadFileSchema, text);
  if (read !== undefined && !read.ok) {
    log.warn(`say-read: ${file}: ${read.failure.summary} — starting over`);
  }
  if (read?.ok === true) {
    const { since } = read.value;
    return {
      says: new Map(),
      scanned: new Map(),
      agentSays: new Map(),
      listed: new Map(),
      read: new Set(read.value.read),
      since,
      file,
      written: Promise.resolve(),
    };
  }
  const since = now().toISOString();
  return {
    says: new Map(),
    scanned: new Map(),
    agentSays: new Map(),
    listed: new Map(),
    read: new Set(),
    since,
    file,
    written: Promise.resolve(),
  };
}

function isUnread(store: SayUnreadStore, id: string, ts: string): boolean {
  return !store.read.has(id) && Date.parse(ts) >= Date.parse(store.since);
}

/** The main thread's says of every session the store knows them of: a live
 * session's from its fold, and the others' from their last one-shot read. */
function* mainSays(store: SayUnreadStore): Iterable<[string, SessionSays]> {
  yield* store.says;
  for (const entry of store.scanned) if (!store.says.has(entry[0])) yield entry;
}

/** The subagents' and teammates' says of every session the store knows them
 * of: the pushed ones of the live sessions, then the ones a say_list found
 * that are not among those. */
function* agentSaysOf(
  store: SayUnreadStore,
): Iterable<{ sid: string; id: string; agentId: string; ts: string; text: string }> {
  for (const [sid, says] of store.agentSays) {
    for (const [id, say] of says) yield { sid, id, ...say };
  }
  for (const [sid, list] of store.listed) {
    const pushed = store.agentSays.get(sid);
    for (const [id, say] of list.says) {
      if (say.agentId === undefined || pushed?.has(id) === true) continue;
      yield { sid, id, agentId: say.agentId, ts: say.ts, text: say.text };
    }
  }
}

/** Every unread say, oldest first. A say several of the store's sources hold
 * (a live fold and a say_list, say) is one say. */
export function unreadSays(store: SayUnreadStore): UnreadSay[] {
  const unread = new Map<string, UnreadSay>();
  const take = (say: UnreadSay): void => {
    if (!unread.has(say.tool_use_id) && isUnread(store, say.tool_use_id, say.ts)) {
      unread.set(say.tool_use_id, say);
    }
  };
  for (const [sid, says] of mainSays(store)) {
    for (const [id, ts] of says) take({ session_id: sid, tool_use_id: id, ts });
  }
  for (const say of agentSaysOf(store)) {
    take({ session_id: say.sid, tool_use_id: say.id, ts: say.ts, agent_id: say.agentId });
  }
  for (const [sid, list] of store.listed) {
    for (const [id, say] of list.says) {
      if (say.agentId === undefined) take({ session_id: sid, tool_use_id: id, ts: say.ts });
    }
  }
  return [...unread.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** What `markSaysRead` did. `unknown` lists the ids that are neither unread
 * nor read; when any is, nothing is marked. */
export type MarkSaysReadResult =
  | { kind: "read" }
  | { kind: "unchanged" }
  | { kind: "unknown"; ids: readonly string[] };

/** Mark `ids` read, all of them or none, and write the file before saying
 * so. An id is known when a session's say the store holds has it, or it was
 * read before. */
export async function markSaysRead(
  store: SayUnreadStore,
  ids: readonly string[],
): Promise<MarkSaysReadResult> {
  const unread = new Set(unreadSays(store).map((s) => s.tool_use_id));
  const known = (id: string): boolean =>
    store.read.has(id) ||
    [...mainSays(store)].some(([, says]) => says.has(id)) ||
    [...store.agentSays.values()].some((says) => says.has(id)) ||
    [...store.listed.values()].some((list) => list.says.has(id));
  const unknown = ids.filter((id) => !known(id));
  if (unknown.length > 0) return { kind: "unknown", ids: unknown };
  const fresh = ids.filter((id) => unread.has(id));
  if (fresh.length === 0) return { kind: "unchanged" };
  for (const id of fresh) store.read.add(id);
  await writeSayRead(store);
  return { kind: "read" };
}

/** Every say of the sessions' subagents and teammates the store knows,
 * oldest first (ev:"agent_says"): the live sessions' pushed ones, and the
 * ones a say_list found. */
export function agentSays(store: SayUnreadStore): AgentSay[] {
  const out: AgentSay[] = [];
  for (const say of agentSaysOf(store)) {
    out.push({
      session_id: say.sid,
      agent_id: say.agentId,
      tool_use_id: say.id,
      ts: say.ts,
      text: say.text,
    });
  }
  return out.sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** Take a say `agentId` of `sid` called, from a pushed row: counted with the
 * session's says from then on (DR-0050 §10), at the time it was pushed. True
 * when it is new; the same tool_use pushed again is the one already held. */
export function takeAgentSay(
  store: SayUnreadStore,
  sid: string,
  say: { agentId: string; id: string; text: string; ts: string },
): boolean {
  let says = store.agentSays.get(sid);
  if (says === undefined) {
    says = new Map();
    store.agentSays.set(sid, says);
  }
  if (says.has(say.id)) return false;
  says.set(say.id, { agentId: say.agentId, ts: say.ts, text: say.text });
  listSay(store, sid, say.id, { ts: say.ts, text: say.text, agentId: say.agentId });
  return true;
}

/** Add a say to `sid`'s say_list, when one was asked for: the one already
 * there stays. */
function listSay(store: SayUnreadStore, sid: string, id: string, say: ListedSay): void {
  const says = store.listed.get(sid)?.says;
  if (says !== undefined && !says.has(id)) says.set(id, say);
}

/** Take the says of the subagents' and teammates' rows among `rows` (the
 * main thread's are the relay's, read off the jsonl), all at `ts`. True when
 * any is new. */
export function takeAgentSaysOf(
  store: SayUnreadStore,
  sid: string,
  rows: readonly TranscriptPushRow[],
  ts: string,
): boolean {
  let taken = false;
  for (const row of rows) {
    const agentId = row.agent_id;
    if (agentId === undefined) continue;
    for (const use of toolUsesOf(row)) {
      const text = ccmsgSayText(use.name, use.input);
      if (text === null) continue;
      if (takeAgentSay(store, sid, { agentId, id: use.id, text, ts })) taken = true;
    }
  }
  return taken;
}

/** Write the file whole: to a temporary file beside it, then renamed over
 * it, so a crash leaves the old file or the new one. */
function writeSayRead(store: SayUnreadStore): Promise<void> {
  const text = `${JSON.stringify({ since: store.since, read: [...store.read] })}\n`;
  const tmp = path.join(path.dirname(store.file), `.say-read.${String(process.pid)}.tmp`);
  const write = async (): Promise<void> => {
    await fs.promises.mkdir(path.dirname(store.file), { recursive: true });
    await fs.promises.writeFile(tmp, text, { mode: 0o600 });
    await fs.promises.rename(tmp, store.file);
  };
  const written = store.written.then(write, write);
  store.written = written.catch(() => {});
  return written;
}

/** The says a line makes: an assistant row's `say` tool calls whose input
 * is the tool's. In the session's own transcript (`thread: "main"`) a row of
 * a sidechain is not the main thread's; an agent's transcript is all its
 * own rows, which are sidechain ones. */
function saysOfLine(
  line: string,
  thread: "main" | "agent" = "main",
): { id: string; ts: string; text: string }[] {
  if (!line.includes('"mcp__ccmsg-v1__say"')) return [];
  const read = parseWith(TranscriptRowLineSchema, line);
  if (!read.ok) return [];
  const row = read.value;
  if (!isKnownTranscriptRow(row) || row.type !== "assistant") return [];
  if (thread === "main" && row.isSidechain) return [];
  return row.message.content.flatMap((block) => {
    if (!isKnownContentBlock(block) || block.type !== "tool_use") return [];
    const text = ccmsgSayText(block.name, block.input);
    return text === null ? [] : [{ id: block.id, ts: row.timestamp, text }];
  });
}

/** Every say of `sid`, read or not, oldest first: its main thread's and its
 * agents' (say_list, DR-0050 §5). `file` is the session's resolved
 * transcript. The first ask reads it and every agent transcript beside it
 * whole; what it finds is kept, and the fold's lines and the pushed rows add
 * to it, so a later ask reads nothing. An ask while that read is under way
 * waits for it. `onChange` is told when the read lands: the unread and the
 * agents' says may have grown. Null when the session's transcript does not
 * read (asked again, it is read again); an agent's transcript that does not
 * read is left out. */
export async function sayList(
  store: SayUnreadStore,
  sid: string,
  file: string,
  onChange: () => void,
): Promise<SessionSay[] | null> {
  let list = store.listed.get(sid);
  if (list === undefined) {
    const says = new Map<string, ListedSay>();
    // The pushed ones first, so a say has the same time here as on
    // ev:"agent_says".
    for (const [id, say] of store.agentSays.get(sid) ?? []) says.set(id, say);
    const created: SessionSayList = { says, reading: readEverySay(file, says) };
    list = created;
    store.listed.set(sid, created);
    created.reading.then(onChange, () => {
      if (store.listed.get(sid) === created) store.listed.delete(sid);
    });
  }
  try {
    await list.reading;
  } catch {
    return null;
  }
  return [...list.says]
    .map(
      ([id, say]): SessionSay => ({
        tool_use_id: id,
        ts: say.ts,
        text: say.text,
        ...(say.agentId !== undefined ? { agent_id: say.agentId } : {}),
      }),
    )
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** Read the says of the session transcript `file` and of its agents' into
 * `says`, keeping any already there. Rejects when `file` does not read. */
async function readEverySay(file: string, says: Map<string, ListedSay>): Promise<void> {
  const add = (id: string, say: ListedSay): void => {
    if (!says.has(id)) says.set(id, say);
  };
  await scanTranscriptLines(file, undefined, (line) => {
    for (const say of saysOfLine(line)) add(say.id, { ts: say.ts, text: say.text });
  });
  for (const agent of await listAgentTranscripts(file)) {
    try {
      await scanTranscriptLines(agent.file, undefined, (line) => {
        for (const say of saysOfLine(line, "agent")) {
          add(say.id, { ts: say.ts, text: say.text, agentId: agent.agentId });
        }
      });
    } catch {
      // Gone between the listing and the read: it has nothing to add.
    }
  }
}

/** `sid`'s says, for the transcript relay. A catch-up folds into a detached
 * set that replaces the settled one only when it lands. `onChange` is told
 * when the unread says may have moved. */
export function sayUnreadFold(store: SayUnreadStore, sid: string, onChange: () => void): LineFold {
  let settled: SessionSays | undefined;
  let next: SessionSays | undefined;
  let moved = false;
  return {
    restart() {
      next = new Map();
    },
    take(line) {
      const says = next ?? settled;
      if (says === undefined) return;
      for (const say of saysOfLine(line)) {
        listSay(store, sid, say.id, { ts: say.ts, text: say.text });
        if (says.has(say.id)) continue;
        says.set(say.id, say.ts);
        if (says === settled) moved = true;
      }
    },
    settle() {
      if (next !== undefined) {
        moved ||= next.size > 0 || (settled?.size ?? 0) > 0;
        settled = next;
        next = undefined;
        store.says.set(sid, settled);
        // The fold takes over from the one-shot read: the same says are not
        // held twice.
        if (store.scanned.delete(sid)) moved = true;
      }
      if (!moved) return;
      moved = false;
      onChange();
    },
    close() {
      if (store.says.get(sid) === settled) store.says.delete(sid);
      // The agents' says go with the session: it is no longer live.
      const hadAgentSays = (store.agentSays.get(sid)?.size ?? 0) > 0;
      store.agentSays.delete(sid);
      if ((settled?.size ?? 0) > 0 || hadAgentSays) onChange();
      settled = undefined;
      next = undefined;
    },
  };
}

/** Count `sid`'s says on a one-shot read of its transcript, for a session
 * that is not live (session-status.ts getSessionStatus): its says are then
 * the ones this read found. A session live by the time the read is done
 * keeps its fold's, which the relay reads off the same file. `onChange` is
 * told when what the read found differs from what was held. */
export function sayScan(
  store: SayUnreadStore,
  sid: string,
  onChange: () => void,
): OneShotLineReader {
  const found: SessionSays = new Map();
  return {
    take(line) {
      for (const say of saysOfLine(line)) found.set(say.id, say.ts);
    },
    done() {
      if (store.says.has(sid)) return;
      const held = store.scanned.get(sid);
      store.scanned.set(sid, found);
      if (held !== undefined && sameSays(held, found)) return;
      if (held === undefined && found.size === 0) return;
      onChange();
    },
  };
}

function sameSays(a: SessionSays, b: SessionSays): boolean {
  if (a.size !== b.size) return false;
  for (const [id, ts] of a) if (b.get(id) !== ts) return false;
  return true;
}
