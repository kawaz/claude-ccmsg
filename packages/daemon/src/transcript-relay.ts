// The live Timeline of a session (DR-0045 §2 / §4): the webui tabs that follow
// a session (`transcript_subscribe`) get the jsonl's new lines as
// `ev:"transcript"`, read when the session's hooks module pushes the rows that
// went into its conversation (`transcript_push`). Nothing watches the file:
// a session that pushes nothing (no hooks module) has no live Timeline, and
// its transcript is read with `transcript_read` alone.
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
  readLinesForTail,
  resolveConnectedTranscript,
  type SessionLookup,
  type TailConn,
  type TailLog,
  type TranscriptResult,
} from "./transcript.ts";
import type { TraceWriter } from "./trace.ts";
import { wireLine } from "./wire-line.ts";

/** How long a push waits for its rows to be written to the jsonl. */
export const RELAY_WAIT_MS = 5000;
/** How often the file is read again while a push waits. */
export const RELAY_RETRY_MS = 50;

/** Where the reading of one session's jsonl stands, and who follows it. */
interface Relay {
  sid: string;
  file: string;
  /** Byte offset up to which complete lines have been sent. */
  end: number;
  /** The file's identity as of the last read: a path that names another
   * file (rewrite, replacement) starts the reading over at its end, as a
   * shrink does. See transcript.ts's Watch for why the three belts. */
  ino: number;
  birthtimeMs: number;
  sawMissing: boolean;
  subscribers: Set<TailConn>;
  /** Pushed rows whose lines have not been read yet. */
  waiting: Set<string>;
  /** The wait for `waiting`, while there is one. */
  retry: { timer: ReturnType<typeof setTimeout>; deadline: number } | null;
}

export interface TranscriptRelayStore {
  relays: Map<string, Relay>;
  log: TailLog;
  trace?: TraceWriter;
  /** The clock, for tests. */
  now: () => number;
}

export function createTranscriptRelayStore(
  log: TailLog,
  trace?: TraceWriter,
  now: () => number = Date.now,
): TranscriptRelayStore {
  return { relays: new Map(), log, ...(trace !== undefined ? { trace } : {}), now };
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

/** Read what was written since `relay.end` and send it; a file that shrank
 * or was replaced starts over at its end, said with an empty event that
 * carries the new size (as the tail did, DR-0009). */
function readOn(store: TranscriptRelayStore, relay: Relay, cause: "push" | "retry"): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(relay.file);
  } catch {
    relay.sawMissing = true;
    return;
  }
  const replaced =
    stat.ino !== relay.ino ||
    relay.sawMissing ||
    (stat.birthtimeMs > 0 && relay.birthtimeMs > 0 && stat.birthtimeMs !== relay.birthtimeMs);
  if (replaced || stat.size < relay.end) {
    relay.ino = stat.ino;
    relay.birthtimeMs = stat.birthtimeMs;
    relay.sawMissing = false;
    relay.end = stat.size;
    relay.waiting.clear();
    send(store, relay, { lines: [], start: stat.size, end: stat.size, size: stat.size });
    return;
  }
  if (stat.size === relay.end) return;
  let read: { lines: string[]; end: number };
  try {
    read = readLinesForTail(relay.file, relay.end, stat.size);
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
  for (const line of read.lines) for (const uuid of uuidsOf(line)) relay.waiting.delete(uuid);
  send(store, relay, { lines: read.lines, start, end: read.end, size: stat.size });
}

function stopWaiting(relay: Relay): void {
  if (relay.retry !== null) clearTimeout(relay.retry.timer);
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
    readOn(store, relay, "retry");
    if (relay.waiting.size === 0) {
      relay.retry = null;
      return;
    }
    if (store.now() >= deadline) {
      store.log.info(
        `transcript relay: gave up waiting sid=${relay.sid} rows=${String(relay.waiting.size)} after ${String(RELAY_WAIT_MS)}ms`,
      );
      relay.waiting.clear();
      relay.retry = null;
      return;
    }
    relay.retry = { timer: setTimeout(tick, RELAY_RETRY_MS), deadline };
  };
  relay.retry = { timer: setTimeout(tick, RELAY_RETRY_MS), deadline };
}

/** Follow `sid`'s Timeline on `conn`: from the file's end now, so what is
 * already on disk is not sent again (the tab read it with transcript_read).
 * The session must be connected with a transcript it named in its hello. */
export function relaySubscribe(
  store: TranscriptRelayStore,
  sessions: SessionLookup,
  sid: string,
  conn: TailConn,
): TranscriptResult<{ sid: string; size: number }> {
  const resolved = resolveConnectedTranscript(sessions, sid);
  if (!resolved.ok) return resolved;
  const held = store.relays.get(sid);
  const relay =
    held !== undefined && held.file === resolved.file
      ? held
      : moveRelay(store, sid, resolved.file, held);
  if (relay === undefined) {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not readable: ${sid}` };
  }
  relay.subscribers.add(conn);
  return { ok: true, data: { sid, size: relay.end } };
}

/** Follow `file` for `sid` from its end, with the tabs that followed `held`
 * (the session named another transcript since, a re-hello). Undefined when
 * the file cannot be read; the tabs that followed `held` stay with it. */
function moveRelay(
  store: TranscriptRelayStore,
  sid: string,
  file: string,
  held: Relay | undefined,
): Relay | undefined {
  const fresh = openRelay(sid, file);
  if (fresh === undefined) return held;
  if (held !== undefined) {
    stopWaiting(held);
    for (const c of held.subscribers) fresh.subscribers.add(c);
  }
  store.relays.set(sid, fresh);
  return fresh;
}

/** A relay of `file` from its end now; undefined when the file cannot be
 * read. */
function openRelay(sid: string, file: string): Relay | undefined {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(file);
  } catch {
    return undefined;
  }
  return {
    sid,
    file,
    end: stat.size,
    ino: stat.ino,
    birthtimeMs: stat.birthtimeMs,
    sawMissing: false,
    subscribers: new Set(),
    waiting: new Set(),
    retry: null,
  };
}

function dropIfUnfollowed(store: TranscriptRelayStore, relay: Relay): void {
  if (relay.subscribers.size > 0) return;
  stopWaiting(relay);
  store.relays.delete(relay.sid);
}

export function relayUnsubscribe(store: TranscriptRelayStore, sid: string, conn: TailConn): void {
  const relay = store.relays.get(sid);
  if (relay === undefined) return;
  relay.subscribers.delete(conn);
  dropIfUnfollowed(store, relay);
}

/** Forget `conn` everywhere (its connection closed). */
export function relayUnsubscribeAll(store: TranscriptRelayStore, conn: TailConn): void {
  for (const relay of store.relays.values()) {
    if (relay.subscribers.delete(conn)) dropIfUnfollowed(store, relay);
  }
}

/** `sid`'s module pushed rows of its main thread's conversation (`uuids`):
 * read the jsonl on, and wait for the rows not written yet. Nothing to do
 * while no tab follows the session. */
export function relayPushed(
  store: TranscriptRelayStore,
  sid: string,
  uuids: readonly string[],
): void {
  const relay = store.relays.get(sid);
  if (relay === undefined) return;
  for (const uuid of uuids) relay.waiting.add(uuid);
  readOn(store, relay, "push");
  waitForRows(store, relay);
}

/** `sid` named another transcript in a hello (DR-0009 §5): the tabs that
 * follow it follow `file` from its end now. */
export function relayRetarget(store: TranscriptRelayStore, sid: string, file: string): void {
  const held = store.relays.get(sid);
  if (held === undefined || held.file === file) return;
  moveRelay(store, sid, file, held);
}

/** Stop every wait (daemon shutdown). */
export function stopAllRelays(store: TranscriptRelayStore): void {
  for (const relay of store.relays.values()) stopWaiting(relay);
  store.relays.clear();
}
