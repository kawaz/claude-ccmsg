// The requests for the person's permission (DR-0040 §4, §5), and what the
// person did with them. A request is a `permit` call in a session's
// transcript that the tool answered PERMIT_REQUESTED_TEXT: the transcript
// keeps it, and the Timeline draws it from the call's row. The daemon finds
// the requests on the lines it reads for the says (say-unread.ts): a live
// session's fold (the catch-up's and every push's read), the one-shot read of
// a session that is not live (permitScan), and the whole read the 🔐 filter
// asks for (permitList). A call is held until its result's line comes, and is
// a request only when that result says the request went out: a subagent's
// call, which the module refuses, and one that found no daemon are not.
//
// What the daemon keeps on disk is the person's state alone, in
// `<stateDir>/permit-state.json`: the ids of the requests acted on (and of
// the ones whose permission the person copied, granted), the time
// `since` before which every request counts as acted on (a first start, and a
// file that does not read, would otherwise bring every request of every
// transcript up at once), and the project permissions applied.
//
// Design rationale: this is the second state the daemon keeps on disk for the
// webui alone, after say-read.json (DR-0036 §3 keeps v1 from growing such
// state), and for the same reason: the requests are drawn from the
// transcripts, which outlive the daemon, so with the state in memory only
// every restart would bring every request back as not acted on and take away
// which project permissions were applied. What was asked is not kept here:
// the transcript has it for as long as the session is there.
import * as fs from "node:fs";
import * as path from "node:path";
import * as v from "valibot";
import {
  AppliedPermitPermissionSchema,
  CCMSG_TOOLS,
  ccmsgPermitCall,
  isKnownContentBlock,
  isKnownTranscriptRow,
  jsonText,
  parseWith,
  permitRequestedBy,
  TranscriptRowLineSchema,
  type AppliedPermitPermission,
  type PermitCall,
  type PermitProjectPermission,
  type PermitStateStreamEvent,
  type SessionPermit,
  type UnreadPermit,
} from "@ccmsg/protocol";
import type { OneShotLineReader } from "./session-status.ts";
import type { SessionSweep } from "./session-sweep.ts";
import type { LineFold } from "./transcript-relay.ts";

/** permit-state.json. */
const PermitStateFileSchema = jsonText(
  v.object({
    since: v.pipe(v.string(), v.isoTimestamp()),
    read: v.array(v.string()),
    granted: v.array(v.string()),
    applied: v.array(AppliedPermitPermissionSchema),
  }),
);

/** A request as the daemon found it on its call's row. */
export interface SeenPermit {
  /** The row's time. */
  ts: string;
  /** The directory the session ran in when it asked (the row's `cwd`). */
  cwd: string;
  permit: PermitCall;
  /** The subagent or teammate whose transcript it is in; absent on the main
   * thread. */
  agentId?: string;
}

/** The requests of one session, by their call's tool_use id. */
type SessionPermits = Map<string, SeenPermit>;

/** Every request of one session, from the first notification_list on. */
interface SessionPermitList {
  permits: SessionPermits;
  /** The first read of the session's transcripts: `permits` is whole once it
   * lands. Rejects when the session's own transcript does not read. */
  reading: Promise<void>;
}

export interface PermitStore {
  /** The requests of each live session's main thread, from its fold. */
  permits: Map<string, SessionPermits>;
  /** The requests of sessions that are not live, as the last one-shot read of
   * their transcript found them (permitScan): kept until the session becomes
   * live, when its fold takes over, or the daemon stops. */
  scanned: Map<string, SessionPermits>;
  /** Every request of each session a notification_list asked for, its main
   * thread's and its agents', live or not. Kept until the daemon stops; the
   * fold's lines add to it. */
  listed: Map<string, SessionPermitList>;
  read: Set<string>;
  /** The requests whose permission the person copied with 許可する: read
   * too. */
  granted: Set<string>;
  since: string;
  /** Every project permission applied, in the order applied. */
  applied: readonly AppliedPermitPermission[];
  file: string;
  log: PermitStateLog;
  /** The last write of the file: the writes go one after another, so an
   * older state never lands over a newer one. */
  written: Promise<void>;
}

export interface PermitStateLog {
  warn(msg: string): void;
}

/** The store as `file` holds it. A file that is missing or does not read
 * starts over from now (said in the log when it was there). */
export function loadPermitStore(file: string, log: PermitStateLog, now: () => Date): PermitStore {
  let text: string | undefined;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (e) {
    if (!(e instanceof Error && "code" in e && e.code === "ENOENT")) {
      log.warn(
        `permit-state: ${file}: ${e instanceof Error ? e.message : "unreadable"} — starting over`,
      );
    }
  }
  const read = text === undefined ? undefined : parseWith(PermitStateFileSchema, text);
  if (read !== undefined && !read.ok) {
    log.warn(`permit-state: ${file}: ${read.failure.summary} — starting over`);
  }
  const held = read?.ok === true ? read.value : undefined;
  return {
    permits: new Map(),
    scanned: new Map(),
    listed: new Map(),
    read: new Set(held?.read ?? []),
    granted: new Set(held?.granted ?? []),
    since: held?.since ?? now().toISOString(),
    applied: held?.applied ?? [],
    file,
    log,
    written: Promise.resolve(),
  };
}

/** Finds the requests among the lines of one thread, read in order: a
 * `permit` call is held until the line of its result, and is a request when
 * that result says the request went out. In a session's own transcript
 * (`thread: "main"`) a row of a sidechain is not the main thread's; an
 * agent's transcript is all its own rows, which are sidechain ones. */
function permitPairing(
  thread: "main" | "agent",
  agentId?: string,
): { take(line: string): [string, SeenPermit][]; reset(): void } {
  const calls = new Map<string, SeenPermit>();
  return {
    take(line) {
      const mayCall = line.includes(`"${CCMSG_TOOLS.permit}"`);
      const mayAnswer = calls.size > 0 && line.includes('"tool_result"');
      if (!mayCall && !mayAnswer) return [];
      const read = parseWith(TranscriptRowLineSchema, line);
      if (!read.ok) return [];
      const row = read.value;
      if (!isKnownTranscriptRow(row)) return [];
      if (row.type !== "assistant" && row.type !== "user") return [];
      if (thread === "main" && row.isSidechain) return [];
      const content = row.message.content;
      if (typeof content === "string") return [];
      const found: [string, SeenPermit][] = [];
      for (const block of content) {
        if (!isKnownContentBlock(block)) continue;
        if (row.type === "assistant" && block.type === "tool_use") {
          const permit = ccmsgPermitCall(block.name, block.input);
          if (permit === null) continue;
          calls.set(block.id, {
            ts: row.timestamp,
            cwd: row.cwd,
            permit,
            ...(agentId !== undefined ? { agentId } : {}),
          });
        } else if (row.type === "user" && block.type === "tool_result") {
          const call = calls.get(block.tool_use_id);
          if (call === undefined) continue;
          calls.delete(block.tool_use_id);
          if (permitRequestedBy(block)) found.push([block.tool_use_id, call]);
        }
      }
      return found;
    },
    reset() {
      calls.clear();
    },
  };
}

/** Every session the store knows requests of, with them: a live session's
 * from its fold, the others' from their last one-shot read, then the lists
 * of the sessions a notification_list asked for. A session may come more
 * than once; a request several sources hold is one request. */
function* sessionsPermits(store: PermitStore): Iterable<[string, SessionPermits]> {
  yield* store.permits;
  for (const entry of store.scanned) if (!store.permits.has(entry[0])) yield entry;
  for (const [sid, list] of store.listed) yield [sid, list.permits];
}

function isUnread(store: PermitStore, id: string, ts: string): boolean {
  return !store.read.has(id) && Date.parse(ts) >= Date.parse(store.since);
}

/** Every request the person has not acted on, oldest first. */
export function unreadPermits(store: PermitStore): UnreadPermit[] {
  const unread = new Map<string, UnreadPermit>();
  for (const [sid, permits] of sessionsPermits(store)) {
    for (const [id, seen] of permits) {
      if (unread.has(id) || !isUnread(store, id, seen.ts)) continue;
      unread.set(id, { session_id: sid, tool_use_id: id, ts: seen.ts });
    }
  }
  return [...unread.values()].sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}

/** The ev:"permit_state" of now. */
export function permitStateEvent(store: PermitStore): PermitStateStreamEvent {
  return {
    ev: "permit_state",
    unread: unreadPermits(store),
    granted: [...store.granted],
    applied: [...store.applied],
  };
}

/** The request `id` of session `sid`, when the store holds it. */
export function findPermit(store: PermitStore, sid: string, id: string): SeenPermit | undefined {
  return (
    store.permits.get(sid)?.get(id) ??
    store.scanned.get(sid)?.get(id) ??
    store.listed.get(sid)?.permits.get(id)
  );
}

/** What `markPermitsRead` did. `unknown` lists the ids that are no request
 * the store holds and were not read before; when any is, nothing is marked. */
export type MarkPermitsReadResult =
  | { kind: "read" }
  | { kind: "unchanged" }
  | { kind: "unknown"; ids: readonly string[] };

/** Mark `ids` read, and granted too when `granted` (許可する copied the
 * permission), all of them or none, and write the file before saying so. A
 * request read already (by 既読, or an apply) can be granted later; nothing
 * is ever taken back. */
export async function markPermitsRead(
  store: PermitStore,
  ids: readonly string[],
  granted = false,
): Promise<MarkPermitsReadResult> {
  const unread = new Set(unreadPermits(store).map((p) => p.tool_use_id));
  const known = (id: string): boolean =>
    store.read.has(id) || [...sessionsPermits(store)].some(([, permits]) => permits.has(id));
  const unknown = ids.filter((id) => !known(id));
  if (unknown.length > 0) return { kind: "unknown", ids: unknown };
  const fresh = ids.filter((id) => unread.has(id) || (granted && !store.granted.has(id)));
  if (fresh.length === 0) return { kind: "unchanged" };
  for (const id of fresh) {
    store.read.add(id);
    if (granted) store.granted.add(id);
  }
  await writePermitState(store);
  return { kind: "read" };
}

/** Whether `a` is the change `b`: the same rule, added or removed alike. */
function sameChange(
  a: { add: string } | { remove: string },
  b: { add: string } | { remove: string },
): boolean {
  if ("add" in a) return "add" in b && a.add === b.add;
  return "remove" in b && a.remove === b.remove;
}

/** Whether the request `seen` asked for the change `permission` (the person
 * applies only what the session asked). */
export function askedFor(seen: SeenPermit, permission: PermitProjectPermission): boolean {
  return seen.permit.project_permissions.some((asked) => sameChange(asked, permission));
}

/** Mark the project permission `permission` of the request `id` applied at
 * `at`, and the request read (the person has acted on it, as with 許可する),
 * and write the file before saying so. Applied again, the time is the last
 * one's. */
export async function markPermitApplied(
  store: PermitStore,
  id: string,
  permission: PermitProjectPermission,
  at: string,
): Promise<void> {
  store.applied = [
    ...store.applied.filter((a) => !(a.tool_use_id === id && sameChange(a.permission, permission))),
    { tool_use_id: id, permission, applied_at: at },
  ];
  store.read.add(id);
  await writePermitState(store);
}

/** Write the file whole: to a temporary file beside it, then renamed over
 * it, so a crash leaves the old file or the new one. A write that fails is
 * said in the log; the state stays held in memory. */
function writePermitState(store: PermitStore): Promise<void> {
  const text = `${JSON.stringify({
    since: store.since,
    read: [...store.read],
    granted: [...store.granted],
    applied: store.applied,
  })}\n`;
  const tmp = path.join(path.dirname(store.file), `.permit-state.${String(process.pid)}.tmp`);
  const write = async (): Promise<void> => {
    try {
      await fs.promises.mkdir(path.dirname(store.file), { recursive: true });
      await fs.promises.writeFile(tmp, text, { mode: 0o600 });
      await fs.promises.rename(tmp, store.file);
    } catch (e) {
      store.log.warn(
        `permit-state: ${store.file}: ${e instanceof Error ? e.message : "not written"}`,
      );
    }
  };
  const written = store.written.then(write);
  store.written = written;
  return written;
}

/** Add a request to `sid`'s list, when a notification_list asked for one:
 * the one already there stays. */
function listPermit(store: PermitStore, sid: string, id: string, seen: SeenPermit): void {
  const permits = store.listed.get(sid)?.permits;
  if (permits !== undefined && !permits.has(id)) permits.set(id, seen);
}

/** `sid`'s requests, for the transcript relay. A catch-up folds into a
 * detached set that replaces the settled one only when it lands. `onChange`
 * is told when the unread requests may have moved. */
export function permitFold(store: PermitStore, sid: string, onChange: () => void): LineFold {
  let settled: SessionPermits | undefined;
  let next: SessionPermits | undefined;
  let moved = false;
  const pairing = permitPairing("main");
  return {
    restart() {
      next = new Map();
      pairing.reset();
    },
    take(line) {
      const permits = next ?? settled;
      if (permits === undefined) return;
      for (const [id, seen] of pairing.take(line)) {
        listPermit(store, sid, id, seen);
        if (permits.has(id)) continue;
        permits.set(id, seen);
        if (permits === settled) moved = true;
      }
    },
    settle() {
      if (next !== undefined) {
        moved ||= next.size > 0 || (settled?.size ?? 0) > 0;
        settled = next;
        next = undefined;
        store.permits.set(sid, settled);
        // The fold takes over from the one-shot read: the same requests are
        // not held twice.
        if (store.scanned.delete(sid)) moved = true;
      }
      if (!moved) return;
      moved = false;
      onChange();
    },
    close() {
      if (store.permits.get(sid) === settled) store.permits.delete(sid);
      if ((settled?.size ?? 0) > 0) onChange();
      settled = undefined;
      next = undefined;
      pairing.reset();
    },
  };
}

/** Find `sid`'s requests on a one-shot read of its transcript, for a session
 * that is not live (session-status.ts getSessionStatus): its requests are
 * then the ones this read found. A session live by the time the read is done
 * keeps its fold's. `onChange` is told when what the read found differs from
 * what was held. */
export function permitScan(
  store: PermitStore,
  sid: string,
  onChange: () => void,
): OneShotLineReader {
  const found: SessionPermits = new Map();
  const pairing = permitPairing("main");
  return {
    take(line) {
      for (const [id, seen] of pairing.take(line)) found.set(id, seen);
    },
    done() {
      if (store.permits.has(sid)) return;
      const held = store.scanned.get(sid);
      store.scanned.set(sid, found);
      if (held !== undefined && sameIds(held, found)) return;
      if (held === undefined && found.size === 0) return;
      onChange();
    },
  };
}

function sameIds(a: SessionPermits, b: SessionPermits): boolean {
  if (a.size !== b.size) return false;
  for (const id of a.keys()) if (!b.has(id)) return false;
  return true;
}

/** Every request of `sid`, acted on or not, oldest first: its main thread's
 * and its agents' (notification_list, DR-0050 §5). `sweep` reads the
 * session's transcript and every agent transcript beside it whole; the first
 * ask runs it, what it finds is kept, and the fold's lines add to it, so a
 * later ask reads nothing. An ask while that read is under way waits for it.
 * `onChange` is told when the read lands: the unread may have grown. Null
 * when the session's transcript does not read (asked again, it is read
 * again). */
export async function permitList(
  store: PermitStore,
  sid: string,
  sweep: SessionSweep,
  onChange: () => void,
): Promise<SessionPermit[] | null> {
  let list = store.listed.get(sid);
  if (list === undefined) {
    const permits: SessionPermits = new Map();
    const pairings = new Map<string, ReturnType<typeof permitPairing>>();
    const pairingOf = (agentId: string | undefined): ReturnType<typeof permitPairing> => {
      const key = agentId ?? "";
      let pairing = pairings.get(key);
      if (pairing === undefined) {
        pairing = agentId === undefined ? permitPairing("main") : permitPairing("agent", agentId);
        pairings.set(key, pairing);
      }
      return pairing;
    };
    const reading = sweep((line, agentId) => {
      for (const [id, seen] of pairingOf(agentId).take(line)) {
        if (!permits.has(id)) permits.set(id, seen);
      }
    });
    const created: SessionPermitList = { permits, reading };
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
  return [...list.permits]
    .map(
      ([id, seen]): SessionPermit => ({
        tool_use_id: id,
        ts: seen.ts,
        cwd: seen.cwd,
        permit: seen.permit,
        ...(seen.agentId !== undefined ? { agent_id: seen.agentId } : {}),
      }),
    )
    .sort((a, b) => Date.parse(a.ts) - Date.parse(b.ts));
}
