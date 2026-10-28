// The daemon's one reading of each session's jsonl (DR-0045 §2 / §3 / §5).
// Its lines go to the webui tabs that follow the session's Timeline
// (`transcript_subscribe`, as `ev:"transcript"`) and to the daemon's own
// folds of it (Status, the API error, the last user input).
//
// The file is read when the session's hooks module pushes the rows that went
// into its conversation (`transcript_push`), and nothing watches it. A session
// is live while its module has a run named (`sidecar_hello`): then its folds
// exist, and are caught up by one read of the file from its first byte. A
// session with no module has neither folds nor a live Timeline; its transcript
// is read with `transcript_read` and session_status's one-shot read.
//
// A row goes in before its line is written (measured: 20–200 ms later,
// docs/findings/2026-10-28-session-append-vs-jsonl.md), so a push whose rows
// are not in the file yet reads the file again at short intervals until they
// are, and past RELAY_WAIT_MS reads it once more and stops waiting. A row
// given up on is read with the next push, from where the reading stopped.
import * as fs from "node:fs";
import { ErrorCode } from "@ccmsg/protocol";
import {
  extractEntryTimestamp,
  readCompleteLines,
  resolveConnectedTranscript,
  scanTranscriptLines,
  type SessionLookup,
  type TranscriptConn,
  type TranscriptLog,
  type TranscriptResult,
} from "./transcript.ts";
import type { TraceWriter } from "./trace.ts";
import { wireLine } from "./wire-line.ts";

/** How long a push waits for its rows to be written to the jsonl. */
export const RELAY_WAIT_MS = 5000;
/** How often the file is read again while a push waits. */
export const RELAY_RETRY_MS = 50;

/** One of the daemon's folds of a live session's lines. The relay hands it
 * every complete line of the session's jsonl once, in file order: from the
 * first byte at each `restart`, then each read's lines as pushes bring them. */
export interface LineFold {
  /** The reading starts over from the first byte of `file` (the session
   * became live, its file was replaced, or what the fold is classified
   * against moved): what was folded no longer describes it. `file` is
   * undefined while the session names no transcript yet. */
  restart(file: string | undefined): void;
  /** The next complete line. */
  take(line: string): void;
  /** The lines taken so far are all there is for now: the catch-up read
   * reached its end, or a push's read did. */
  settle(): void;
  /** The session is no longer live: nothing more comes. */
  close(): void;
}

/** Makes a live session's fold of one kind. */
export type LineFoldFactory = (sid: string) => LineFold;

interface FileIdentity {
  ino: number;
  birthtimeMs: number;
}

/** Where the reading of one session's jsonl stands, and who follows it. */
interface Relay {
  sid: string;
  /** Undefined while the session names no transcript (none written yet). */
  file: string | undefined;
  /** Byte offset up to which complete lines have been read. */
  end: number;
  /** The file's identity as of the last read; undefined while the file has
   * not been seen. A path that names another file (rewrite, replacement)
   * starts the reading over at its end, as a shrink does. Three belts: the
   * inode, the birthtime (ext4 hands an unlink+recreate the freed inode),
   * and having seen the path missing. */
  identity: FileIdentity | undefined;
  sawMissing: boolean;
  subscribers: Set<TranscriptConn>;
  /** The session's folds while it is live; null while it is not. */
  folds: LineFold[] | null;
  /** The uuids of the rows read off the file: a push of a row already read
   * (the catch-up read got there first, or compaction pushes the rows it
   * keeps again under their uuids) waits for nothing. */
  read: Set<string>;
  /** Pushed rows whose lines have not been read yet. */
  waiting: Set<string>;
  /** The wait for `waiting`, while there is one. */
  retry: ReturnType<typeof setTimeout> | null;
  /** The catch-up read in flight; pushes meanwhile only add to `waiting`. */
  catchUp: Promise<void> | null;
  /** Bumped per catch-up: one superseded by a later one stops handing lines
   * on. */
  catchUpGen: number;
}

export interface TranscriptRelayStore {
  relays: Map<string, Relay>;
  foldFactories: readonly LineFoldFactory[];
  log: TranscriptLog;
  trace?: TraceWriter;
  /** The clock, for tests. */
  now: () => number;
}

export function createTranscriptRelayStore(
  log: TranscriptLog,
  options: {
    trace?: TraceWriter;
    folds?: readonly LineFoldFactory[];
    now?: () => number;
  } = {},
): TranscriptRelayStore {
  return {
    relays: new Map(),
    foldFactories: options.folds ?? [],
    log,
    ...(options.trace !== undefined ? { trace: options.trace } : {}),
    now: options.now ?? Date.now,
  };
}

/** The uuids of `line`'s rows: the jsonl line's `"uuid"` key. A string in
 * the row's content holds its quotes escaped, so it does not match. */
function uuidsOf(line: string): string[] {
  return [...line.matchAll(/"uuid":"([^"]+)"/gu)].flatMap((m) =>
    m[1] === undefined ? [] : [m[1]],
  );
}

function send(
  store: TranscriptRelayStore,
  relay: Relay,
  payload: { lines: string[]; start: number; end: number; size: number },
): void {
  if (relay.subscribers.size === 0) return;
  const line = wireLine({ ev: "transcript", sid: relay.sid, ...payload });
  const entryTs = extractEntryTimestamp(payload.lines);
  let subscriber = 0;
  for (const conn of relay.subscribers) {
    void store.trace?.write({
      comp: "daemon",
      edge: "out",
      kind: "wire_write",
      sid: relay.sid,
      start: payload.start,
      end: payload.end,
      size: payload.size,
      ...(entryTs ? { entry_ts: entryTs } : {}),
      subscriber: subscriber++,
    });
    conn.write(line);
  }
}

function statOf(file: string): fs.Stats | undefined {
  try {
    return fs.statSync(file);
  } catch {
    return undefined;
  }
}

function identityOf(stat: fs.Stats): FileIdentity {
  return { ino: stat.ino, birthtimeMs: stat.birthtimeMs };
}

/** Whether `stat` names another file than the one read so far. */
function isReplaced(relay: Relay, stat: fs.Stats): boolean {
  const seen = relay.identity;
  if (seen === undefined) return false;
  return (
    stat.ino !== seen.ino ||
    relay.sawMissing ||
    (stat.birthtimeMs > 0 && seen.birthtimeMs > 0 && stat.birthtimeMs !== seen.birthtimeMs)
  );
}

/** Read the file on from `relay.end` and hand the lines to the tabs and the
 * folds. A file that shrank or was replaced starts over at its end: the tabs
 * are told with an empty event that carries the new size (DR-0009), and the
 * folds catch up with the new file. */
function readOn(store: TranscriptRelayStore, relay: Relay, cause: "push" | "retry"): void {
  if (relay.catchUp !== null || relay.file === undefined) return;
  const file = relay.file;
  const stat = statOf(file);
  if (stat === undefined) {
    if (relay.identity !== undefined) relay.sawMissing = true;
    return;
  }
  if (isReplaced(relay, stat) || stat.size < relay.end) {
    relay.identity = identityOf(stat);
    relay.sawMissing = false;
    relay.end = stat.size;
    relay.waiting.clear();
    relay.read.clear();
    send(store, relay, { lines: [], start: stat.size, end: stat.size, size: stat.size });
    startCatchUp(store, relay);
    return;
  }
  relay.identity = identityOf(stat);
  if (stat.size === relay.end) return;
  let read: { lines: string[]; end: number };
  try {
    read = readCompleteLines(file, relay.end, stat.size);
  } catch (e) {
    store.log.error(`transcript relay: read failed sid=${relay.sid}: ${String(e)}`);
    return;
  }
  if (read.lines.length === 0) return;
  const start = relay.end;
  void store.trace?.write({
    comp: "daemon",
    edge: "out",
    kind: "transcript_read",
    sid: relay.sid,
    start,
    end: read.end,
    size: stat.size,
    bytes: read.end - start,
    lines: read.lines.length,
    source: cause,
  });
  relay.end = read.end;
  for (const line of read.lines) {
    for (const uuid of uuidsOf(line)) {
      relay.waiting.delete(uuid);
      relay.read.add(uuid);
    }
  }
  send(store, relay, { lines: read.lines, start, end: read.end, size: stat.size });
  for (const fold of relay.folds ?? []) {
    for (const line of read.lines) fold.take(line);
    fold.settle();
  }
}

function stopWaiting(relay: Relay): void {
  if (relay.retry !== null) clearTimeout(relay.retry);
  relay.retry = null;
}

/** Read again shortly while rows wait, up to the deadline, where the file is
 * read a last time and the wait ends. */
function waitForRows(store: TranscriptRelayStore, relay: Relay): void {
  if (relay.waiting.size === 0) {
    stopWaiting(relay);
    return;
  }
  if (relay.retry !== null) return;
  const deadline = store.now() + RELAY_WAIT_MS;
  const tick = (): void => {
    relay.retry = null;
    readOn(store, relay, "retry");
    // A catch-up the read started resumes the wait when it lands.
    if (relay.waiting.size === 0 || relay.catchUp !== null) return;
    if (store.now() >= deadline) {
      store.log.info(
        `transcript relay: gave up waiting sid=${relay.sid} rows=${String(relay.waiting.size)} after ${String(RELAY_WAIT_MS)}ms`,
      );
      relay.waiting.clear();
      return;
    }
    relay.retry = setTimeout(tick, RELAY_RETRY_MS);
  };
  relay.retry = setTimeout(tick, RELAY_RETRY_MS);
}

/** Fold `relay`'s file from its first byte up to where the reading stands,
 * then read on for what was pushed meanwhile. The tabs get none of the
 * catch-up: they read what was on disk with transcript_read. */
function startCatchUp(store: TranscriptRelayStore, relay: Relay): void {
  const folds = relay.folds;
  if (folds === null) return;
  stopWaiting(relay);
  relay.catchUpGen += 1;
  const gen = relay.catchUpGen;
  const file = relay.file;
  const end = relay.end;
  for (const fold of folds) fold.restart(file);
  const current = (): boolean => gen === relay.catchUpGen && relay.folds === folds;
  const scan = async (): Promise<void> => {
    if (file !== undefined && end > 0) {
      try {
        await scanTranscriptLines(file, end, (line) => {
          if (!current()) return;
          for (const uuid of uuidsOf(line)) relay.read.add(uuid);
          for (const fold of folds) fold.take(line);
        });
      } catch (e) {
        store.log.error(`transcript relay: catch-up failed sid=${relay.sid}: ${String(e)}`);
      }
    }
    if (!current()) return;
    relay.catchUp = null;
    for (const fold of folds) fold.settle();
    for (const uuid of relay.read) relay.waiting.delete(uuid);
    readOn(store, relay, "push");
    waitForRows(store, relay);
  };
  // Held before the scan starts: a scan with nothing to read lands within
  // this call. Nothing awaits it on the push path, so it must not be able to
  // reject: an unhandled rejection would take the daemon down over one fold.
  const landed = Promise.withResolvers<void>();
  relay.catchUp = landed.promise;
  void scan()
    .catch((e: unknown) => {
      if (current()) relay.catchUp = null;
      store.log.error(`transcript relay: catch-up failed sid=${relay.sid}: ${String(e)}`);
    })
    .finally(landed.resolve);
}

/** A relay of `sid`'s file from its end now; from its first byte when the
 * session names no file yet or the file is not written yet. */
function openRelay(sessions: SessionLookup, sid: string): Relay {
  const resolved = resolveConnectedTranscript(sessions, sid);
  const file = resolved.ok ? resolved.file : undefined;
  const stat = file !== undefined ? statOf(file) : undefined;
  return {
    sid,
    file,
    end: stat?.size ?? 0,
    identity: stat !== undefined ? identityOf(stat) : undefined,
    sawMissing: false,
    subscribers: new Set(),
    folds: null,
    read: new Set(),
    waiting: new Set(),
    retry: null,
    catchUp: null,
    catchUpGen: 0,
  };
}

function relayOf(store: TranscriptRelayStore, sessions: SessionLookup, sid: string): Relay {
  const held = store.relays.get(sid);
  if (held !== undefined) return held;
  const relay = openRelay(sessions, sid);
  store.relays.set(sid, relay);
  return relay;
}

function dropIfUnused(store: TranscriptRelayStore, relay: Relay): void {
  if (relay.subscribers.size > 0 || relay.folds !== null) return;
  stopWaiting(relay);
  store.relays.delete(relay.sid);
}

/** Make the live sessions exactly `sids` (those whose module has a run
 * named, DR-0045 §3): a session that became live gets its folds and catches
 * up with its file, one that is no longer live closes them. */
export function syncLiveRelays(
  store: TranscriptRelayStore,
  sessions: SessionLookup,
  sids: Iterable<string>,
): void {
  const wanted = new Set(sids);
  for (const relay of store.relays.values()) {
    if (relay.folds === null || wanted.has(relay.sid)) continue;
    const folds = relay.folds;
    relay.folds = null;
    relay.catchUp = null;
    relay.read.clear();
    for (const fold of folds) fold.close();
    dropIfUnused(store, relay);
  }
  for (const sid of wanted) {
    const relay = relayOf(store, sessions, sid);
    if (relay.folds !== null) continue;
    relay.folds = store.foldFactories.map((make) => make(sid));
    startCatchUp(store, relay);
  }
}

/** Fold `sid`'s file again from its first byte: what its folds are
 * classified against moved (a re-hello with another cwd or repo root). */
export function relayRefold(store: TranscriptRelayStore, sid: string): void {
  const relay = store.relays.get(sid);
  if (relay !== undefined) startCatchUp(store, relay);
}

/** Resolves once `sid`'s catch-up read, and any that superseded it, landed. */
export async function relayCaughtUp(store: TranscriptRelayStore, sid: string): Promise<void> {
  for (;;) {
    const pending = store.relays.get(sid)?.catchUp ?? null;
    if (pending === null) return;
    await pending;
  }
}

/** Resolves once every catch-up read started so far landed. */
export async function relaysCaughtUp(store: TranscriptRelayStore): Promise<void> {
  await Promise.all([...store.relays.keys()].map((sid) => relayCaughtUp(store, sid)));
}

/** Follow `sid`'s Timeline on `conn`, from where the reading stands, so what
 * is already on disk is not sent again (the tab read it with
 * transcript_read). The session must be connected with a transcript it
 * named in its hello. */
export function relaySubscribe(
  store: TranscriptRelayStore,
  sessions: SessionLookup,
  sid: string,
  conn: TranscriptConn,
): TranscriptResult<{ sid: string; size: number }> {
  const resolved = resolveConnectedTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  if (statOf(resolved.file) === undefined) {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not readable: ${sid}` };
  }
  const relay = relayOf(store, sessions, sid);
  if (relay.file !== resolved.file) retarget(store, relay, resolved.file);
  relay.subscribers.add(conn);
  return { ok: true, data: { sid, size: relay.end } };
}

export function relayUnsubscribe(
  store: TranscriptRelayStore,
  sid: string,
  conn: TranscriptConn,
): void {
  const relay = store.relays.get(sid);
  if (relay === undefined) return;
  relay.subscribers.delete(conn);
  dropIfUnused(store, relay);
}

/** Forget `conn` everywhere (its connection closed). */
export function relayUnsubscribeAll(store: TranscriptRelayStore, conn: TranscriptConn): void {
  for (const relay of store.relays.values()) {
    if (relay.subscribers.delete(conn)) dropIfUnused(store, relay);
  }
}

/** `sid`'s module pushed rows of its main thread's conversation (`uuids`):
 * read the jsonl on, and wait for the rows not read yet. Nothing to do for a
 * session that is not live and that no tab follows. */
export function relayPushed(
  store: TranscriptRelayStore,
  sessions: SessionLookup,
  sid: string,
  uuids: readonly string[],
): void {
  const relay = store.relays.get(sid);
  if (relay === undefined) return;
  let named = false;
  if (relay.file === undefined) {
    // The first prompt writes the transcript the session could not name yet.
    const resolved = resolveConnectedTranscript(sessions, sid);
    if (resolved.ok) {
      relay.file = resolved.file;
      named = true;
    }
  }
  for (const uuid of uuids) if (!relay.read.has(uuid)) relay.waiting.add(uuid);
  if (named && relay.folds !== null) {
    // The folds restarted with no file to fold: start them over on this one.
    // Nothing is read yet, so the catch-up lands at once and reads on.
    startCatchUp(store, relay);
    return;
  }
  if (relay.catchUp !== null) return;
  readOn(store, relay, "push");
  waitForRows(store, relay);
}

/** Whether `sid`'s row `uuid` has been read off its file: the catch-up or a
 * push's read got to it, so the row is not new. */
export function relayHasRead(store: TranscriptRelayStore, sid: string, uuid: string): boolean {
  return store.relays.get(sid)?.read.has(uuid) === true;
}

/** Follow `file` for `relay` from its end now: the tabs are told with an
 * empty event that carries its size, and the folds catch up with it. */
function retarget(store: TranscriptRelayStore, relay: Relay, file: string): void {
  stopWaiting(relay);
  const stat = statOf(file);
  relay.file = file;
  relay.end = stat?.size ?? 0;
  relay.identity = stat !== undefined ? identityOf(stat) : undefined;
  relay.sawMissing = false;
  relay.waiting.clear();
  relay.read.clear();
  send(store, relay, { lines: [], start: relay.end, end: relay.end, size: relay.end });
  startCatchUp(store, relay);
}

/** `sid` named another transcript in a hello (DR-0009 §5). */
export function relayRetarget(store: TranscriptRelayStore, sid: string, file: string): void {
  const relay = store.relays.get(sid);
  if (relay === undefined || relay.file === file) return;
  retarget(store, relay, file);
}

/** Stop every wait and close every fold (daemon shutdown). */
export function stopAllRelays(store: TranscriptRelayStore): void {
  for (const relay of store.relays.values()) {
    stopWaiting(relay);
    relay.catchUp = null;
    const folds = relay.folds;
    relay.folds = null;
    for (const fold of folds ?? []) fold.close();
  }
  store.relays.clear();
}
