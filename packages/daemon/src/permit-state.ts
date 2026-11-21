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
  isBashCommandOf,
  isKnownContentBlock,
  isKnownTranscriptRow,
  jsonText,
  parseWith,
  permitRequestedBy,
  TranscriptRowLineSchema,
  type AppliedPermitPermission,
  type PermitAction,
  type Output,
  type PermitCall,
  type PermitProjectPermission,
  type PermitStateStreamEvent,
  type SessionPermit,
  SkippedPermitActionSchema,
  type SkippedPermitAction,
  type UnreadPermit,
  type UserRow,
} from "@ccmsg/protocol";
import { bashInputOfText } from "./bash-command-rows.ts";
import type { OneShotLineReader } from "./session-status.ts";
import type { SessionSweep } from "./session-sweep.ts";
import type { LineFold } from "./transcript-relay.ts";
import { SessionIds, SessionIdsFileSchema } from "./session-ids.ts";

/** A project permission applied, and the session whose request it was. */
const HeldApplicationSchema = v.object({
  sid: v.string(),
  ...AppliedPermitPermissionSchema.entries,
});
type HeldApplication = Output<typeof HeldApplicationSchema>;

/** An action the person said not to do, and the session whose request it
 * was. */
const HeldSkipSchema = v.object({
  sid: v.string(),
  ...SkippedPermitActionSchema.entries,
});
type HeldSkip = Output<typeof HeldSkipSchema>;

/** permit-state.json: the ids read and granted by the session that has
 * each, the applications, and the actions skipped (none in a file written
 * before there were any). */
const PermitStateFileSchema = jsonText(
  v.object({
    since: v.pipe(v.string(), v.isoTimestamp()),
    read: SessionIdsFileSchema,
    granted: SessionIdsFileSchema,
    applied: v.array(HeldApplicationSchema),
    skipped: v.optional(v.array(HeldSkipSchema), []),
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
  /** The places in `permit.commands` of the commands that have run since the
   * request went out: a `<bash-input>` row of the command (isBashCommandOf)
   * came after the request's result, in the same thread (DR-0040 §11).
   * Grows as the reader that found the request reads on. */
  ran: Set<number>;
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
  read: SessionIds;
  /** The requests whose permission the person copied with 許可する: read
   * too. */
  granted: SessionIds;
  since: string;
  /** Every project permission applied, in the order applied. */
  applied: readonly HeldApplication[];
  /** Every action the person said not to do (やらない), in the order said. */
  skipped: readonly HeldSkip[];
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
    read: new SessionIds(held?.read),
    granted: new SessionIds(held?.granted),
    since: held?.since ?? now().toISOString(),
    applied: held?.applied ?? [],
    skipped: held?.skipped ?? [],
    file,
    log,
    written: Promise.resolve(),
  };
}

/** What one line told a pairing: the requests it made (their result's
 * line), and whether a request found before had a command run by it. */
interface PairingTake {
  found: [string, SeenPermit][];
  ran: boolean;
}

const NOTHING_TAKEN: PairingTake = { found: [], ran: false };

/** The text of a person's row: its content as a string, or its text blocks
 * joined. Null when it holds any other block. */
function personTextOf(content: UserRow["message"]["content"]): string | null {
  if (typeof content === "string") return content;
  const texts: string[] = [];
  for (const block of content) {
    if (!isKnownContentBlock(block) || block.type !== "text") return null;
    texts.push(block.text);
  }
  return texts.join("");
}

/** Finds the requests among the lines of one thread, read in order: a
 * `permit` call is held until the line of its result, and is a request when
 * that result says the request went out. In a session's own transcript
 * (`thread: "main"`) a row of a sidechain is not the main thread's; an
 * agent's transcript is all its own rows, which are sidechain ones.
 *
 * It reads on the main thread's `<bash-input>` rows too (a bash mode command
 * that ended, the person's `!` or a 「! で実行」, DR-0040 §11): each marks the
 * commands of the same text of the requests it found before as run
 * (`SeenPermit.ran`). A subagent's or teammate's conversation has no bash
 * mode. */
function permitPairing(
  thread: "main" | "agent",
  agentId?: string,
): { take(line: string): PairingTake; reset(): void } {
  const calls = new Map<string, SeenPermit>();
  /** The requests found with a command not run yet. */
  const running = new Map<string, SeenPermit>();
  /** Mark the commands `ended` is of as run; true when any was not before. */
  const markRun = (ended: string): boolean => {
    let ran = false;
    for (const [id, seen] of running) {
      seen.permit.commands.forEach((command, i) => {
        if (seen.ran.has(i) || !isBashCommandOf(command.command, ended)) return;
        seen.ran.add(i);
        ran = true;
      });
      if (seen.ran.size === seen.permit.commands.length) running.delete(id);
    }
    return ran;
  };
  return {
    take(line) {
      const mayCall = line.includes(`"${CCMSG_TOOLS.permit}"`);
      const mayAnswer = calls.size > 0 && line.includes('"tool_result"');
      const mayRun = running.size > 0 && line.includes("<bash-input>");
      if (!mayCall && !mayAnswer && !mayRun) return NOTHING_TAKEN;
      const read = parseWith(TranscriptRowLineSchema, line);
      if (!read.ok) return NOTHING_TAKEN;
      const row = read.value;
      if (!isKnownTranscriptRow(row)) return NOTHING_TAKEN;
      if (row.type !== "assistant" && row.type !== "user") return NOTHING_TAKEN;
      if (thread === "main" && row.isSidechain) return NOTHING_TAKEN;
      const content = row.message.content;
      if (row.type === "user" && mayRun) {
        const text = personTextOf(content);
        const ended = text !== null ? bashInputOfText(text) : null;
        if (ended !== null) return { found: [], ran: markRun(ended) };
      }
      if (typeof content === "string") return NOTHING_TAKEN;
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
            ran: new Set(),
          });
        } else if (row.type === "user" && block.type === "tool_result") {
          const call = calls.get(block.tool_use_id);
          if (call === undefined) continue;
          calls.delete(block.tool_use_id);
          if (!permitRequestedBy(block)) continue;
          found.push([block.tool_use_id, call]);
          if (thread === "main" && call.permit.commands.length > 0) {
            running.set(block.tool_use_id, call);
          }
        }
      }
      return { found, ran: false };
    },
    reset() {
      calls.clear();
      running.clear();
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

/** Whether the person said not to do `action` of the request `id`. */
function isSkipped(store: PermitStore, id: string, action: PermitAction): boolean {
  return store.skipped.some((s) => s.tool_use_id === id && sameAction(s.action, action));
}

function sameAction(a: PermitAction, b: PermitAction): boolean {
  if ("command" in a) return "command" in b && a.command === b.command;
  return "permission" in b && sameChange(a.permission, b.permission);
}

/** Whether every action the request `id` (`seen`) asks for is done, so that
 * it counts as acted on (DR-0040 §4): each of its commands has run
 * (`seen.ran`) or was skipped, and each of its project permissions is
 * applied or was skipped. A request that asks for an intent (permission put
 * in words) is done only when the person marks it (既読, 許可する): the
 * daemon cannot tell it was carried out. */
function actionsDone(store: PermitStore, id: string, seen: SeenPermit): boolean {
  const { intents, commands, project_permissions: permissions } = seen.permit;
  if (intents.length > 0) return false;
  const commandsDone = commands.every(
    (_, i) => seen.ran.has(i) || isSkipped(store, id, { command: i }),
  );
  return (
    commandsDone &&
    permissions.every(
      (permission) =>
        store.applied.some((a) => a.tool_use_id === id && sameChange(a.permission, permission)) ||
        isSkipped(store, id, { permission }),
    )
  );
}

/** Every request the person has not acted on, oldest first. A request whose
 * actions are all done is acted on, whichever source holds it saw so (the
 * fold reads on past a one-shot read or a whole read). */
export function unreadPermits(store: PermitStore): UnreadPermit[] {
  const done = new Set<string>();
  for (const [, permits] of sessionsPermits(store)) {
    for (const [id, seen] of permits) if (actionsDone(store, id, seen)) done.add(id);
  }
  const unread = new Map<string, UnreadPermit>();
  for (const [sid, permits] of sessionsPermits(store)) {
    for (const [id, seen] of permits) {
      if (unread.has(id) || done.has(id) || !isUnread(store, id, seen.ts)) continue;
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
    granted: store.granted.ids(),
    applied: store.applied.map(
      ({ sid: _sid, ...application }): AppliedPermitPermission => application,
    ),
    skipped: store.skipped.map(({ sid: _sid, ...skip }): SkippedPermitAction => skip),
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
  const sessionOf = (id: string): string | undefined =>
    [...sessionsPermits(store)].find(([, permits]) => permits.has(id))?.[0];
  const unknown = ids.filter((id) => !store.read.has(id) && sessionOf(id) === undefined);
  if (unknown.length > 0) return { kind: "unknown", ids: unknown };
  const fresh = ids.filter((id) => unread.has(id) || (granted && !store.granted.has(id)));
  if (fresh.length === 0) return { kind: "unchanged" };
  for (const id of fresh) {
    // A request read before and not held now (its session not read since
    // the daemon started) keeps the session it was read under.
    const sid = sessionOf(id);
    if (sid === undefined) continue;
    store.read.add(id, sid);
    if (granted) store.granted.add(id, sid);
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

/** Mark the project permission `permission` of session `sid`'s request
 * `id` applied at `at`, and write the file before saying so. Applied again,
 * the time is the last one's. The request is acted on once all its actions
 * are done (actionsDone), not by one apply. */
export async function markPermitApplied(
  store: PermitStore,
  sid: string,
  id: string,
  permission: PermitProjectPermission,
  at: string,
): Promise<void> {
  store.applied = [
    ...store.applied.filter((a) => !(a.tool_use_id === id && sameChange(a.permission, permission))),
    { sid, tool_use_id: id, permission, applied_at: at },
  ];
  await writePermitState(store);
}

/** Whether the request `seen` asks for `action`: a command by a place it
 * has, a project permission it names. */
export function asksForAction(seen: SeenPermit, action: PermitAction): boolean {
  if ("command" in action) return action.command < seen.permit.commands.length;
  return askedFor(seen, action.permission);
}

/** Mark `action` of session `sid`'s request `id` as not to be done
 * (やらない), and write the file before saying so; false when it was
 * already. Kept for good: a run or an apply after it does the action all the
 * same, and either counts it done. */
export async function markPermitSkipped(
  store: PermitStore,
  sid: string,
  id: string,
  action: PermitAction,
): Promise<boolean> {
  if (isSkipped(store, id, action)) return false;
  store.skipped = [...store.skipped, { sid, tool_use_id: id, action }];
  await writePermitState(store);
  return true;
}

/** The sessions the person's state holds something of. */
export function permitStateSessions(store: PermitStore): Set<string> {
  return new Set([
    ...store.read.sessions(),
    ...store.granted.sessions(),
    ...store.applied.map((a) => a.sid),
    ...store.skipped.map((s) => s.sid),
  ]);
}

/** Drop the state of the sessions `gone` names (their transcripts are gone)
 * and write the file; true when any went. */
export async function dropPermitStateOf(
  store: PermitStore,
  gone: ReadonlySet<string>,
): Promise<boolean> {
  const readDropped = store.read.dropSessions(gone);
  const grantedDropped = store.granted.dropSessions(gone);
  const applied = store.applied.filter((a) => !gone.has(a.sid));
  const appliedDropped = applied.length !== store.applied.length;
  const skipped = store.skipped.filter((s) => !gone.has(s.sid));
  const skippedDropped = skipped.length !== store.skipped.length;
  if (!readDropped && !grantedDropped && !appliedDropped && !skippedDropped) return false;
  store.applied = applied;
  store.skipped = skipped;
  await writePermitState(store);
  return true;
}

/** Write the file whole: to a temporary file beside it, then renamed over
 * it, so a crash leaves the old file or the new one. A write that fails is
 * said in the log; the state stays held in memory. */
function writePermitState(store: PermitStore): Promise<void> {
  const text = `${JSON.stringify({
    since: store.since,
    read: store.read.bySession(),
    granted: store.granted.bySession(),
    applied: store.applied,
    skipped: store.skipped,
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
      const { found, ran } = pairing.take(line);
      // A command run may have done a held request's last action.
      if (ran && permits === settled) moved = true;
      for (const [id, seen] of found) {
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
      for (const [id, seen] of pairing.take(line).found) found.set(id, seen);
    },
    done() {
      if (store.permits.has(sid)) return;
      const held = store.scanned.get(sid);
      store.scanned.set(sid, found);
      if (held !== undefined && sameRequests(held, found)) return;
      if (held === undefined && found.size === 0) return;
      onChange();
    },
  };
}

/** Whether `a` and `b` hold the same requests with the same commands run. */
function sameRequests(a: SessionPermits, b: SessionPermits): boolean {
  if (a.size !== b.size) return false;
  for (const [id, seen] of a) if (b.get(id)?.ran.size !== seen.ran.size) return false;
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
      for (const [id, seen] of pairingOf(agentId).take(line).found) {
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
