// Session transcript access (DR-0009): byte-offset paginated reads of a
// connected session's single announced Claude Code transcript jsonl. Unlike
// fs-access.ts there is no client-supplied path — the daemon only ever serves
// the one file a session announced (and this module validated) at hello time,
// so no traversal surface exists at all.
import * as fs from "node:fs";
import * as path from "node:path";
import {
  ErrorCode,
  TRANSCRIPT_READ_MAX_BYTES,
  type TranscriptReadResponse,
  type TranscriptSubscribeResponse,
  type TranscriptUnsubscribeResponse,
} from "@ccmsg/protocol";

/** Minimal shape transcript-read needs from `Daemon.sessions` — kept structural
 *  (same rationale as fs-access.ts's SessionLookup) so this module has no
 *  dependency edge back to server.ts. */
export interface SessionLookup {
  get(sid: string): { meta: { transcript_path?: string }; conns: { size: number } } | undefined;
}

export type TranscriptResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ErrorCode; msg: string };

/**
 * Backward-scan budget (DR-0009 addendum) for locating the start of a "soft
 * cap" line — one whose own body exceeds a single window's cap
 * (TRANSCRIPT_READ_MAX_BYTES). Local to this module, not a protocol constant:
 * it's purely an internal knob for how far transcriptRead is willing to look
 * before giving up on retrieving a monster line's content (see
 * `readSoftCapLine`). Additional to (not counting) the original cap-sized
 * window already read.
 */
const TRANSCRIPT_LINE_SCAN_MAX = 4 * 1024 * 1024;

/**
 * Hello-time validation (DR-0009): a session's self-declared transcript_path is
 * adopted only if it is an absolute path, ends in ".jsonl", and its basename is
 * exactly "<sid>.jsonl". Any violation returns undefined (silent no-op) — the
 * hello itself still succeeds, the session just gets no Timeline view. This is
 * the entire trust boundary: a client can never name an arbitrary file, only
 * the one whose name is pinned to its own sid.
 */
export function validateTranscriptPath(sid: string, transcriptPath: unknown): string | undefined {
  if (typeof transcriptPath !== "string" || transcriptPath === "") return undefined;
  if (!path.isAbsolute(transcriptPath)) return undefined;
  if (path.extname(transcriptPath) !== ".jsonl") return undefined;
  if (path.basename(transcriptPath) !== `${sid}.jsonl`) return undefined;
  return transcriptPath;
}

function resolveTranscript(
  sessions: SessionLookup,
  sid: string,
): { ok: true; file: string } | { ok: false; code: ErrorCode; msg: string } {
  const entry = sessions.get(sid);
  if (!entry || entry.conns.size === 0) {
    return { ok: false, code: ErrorCode.session_not_found, msg: `session not connected: ${sid}` };
  }
  const file = entry.meta.transcript_path;
  if (!file) {
    return { ok: false, code: ErrorCode.not_found, msg: `session has no transcript: ${sid}` };
  }
  return { ok: true, file };
}

function readWindow(fd: number, rawStart: number, rawEnd: number): Buffer {
  const toRead = rawEnd - rawStart;
  if (toRead <= 0) return Buffer.alloc(0);
  const buf = Buffer.alloc(toRead);
  let readTotal = 0;
  while (readTotal < toRead) {
    const n = fs.readSync(fd, buf, readTotal, toRead - readTotal, rawStart + readTotal);
    if (n === 0) break; // file shrank concurrently; stop rather than loop forever
    readTotal += n;
  }
  return buf.subarray(0, readTotal);
}

/**
 * Handles the "soft cap" case: `targetEnd` is *verified* (by the caller,
 * before calling this) to be the genuine end of a line whose own body is
 * larger than a single cap-sized window — the leading-trim's only newline in
 * [rawStart, targetEnd) sits on the window's very last byte, so a plain
 * subarray-past-it would yield an empty page anchored at `targetEnd` itself,
 * making the next `before` identical to this one (STUCK, DR-0009 addendum).
 *
 * Recovers by scanning further back in `cap`-sized chunks — bounded by
 * TRANSCRIPT_LINE_SCAN_MAX total additional bytes — for the newline that
 * starts this line. Two outcomes:
 *  - found (incl. hitting byte 0, which trivially starts the file's first
 *    line): return the *entire* line as a single soft-cap line, uncapped by
 *    max_bytes — this one line is the sole exception to the byte cap.
 *  - not found within budget (a truly monstrous line): give up on this
 *    line's content (`lines: []`) rather than buffering it without bound,
 *    but still guarantee progress — `start` becomes wherever the scan
 *    stopped, which is always strictly less than `targetEnd` (the scan
 *    always consumes at least one `cap`-sized chunk before giving up).
 */
function readSoftCapLine(
  fd: number,
  rawStart: number,
  targetEnd: number,
  cap: number,
  sid: string,
  size: number,
): TranscriptResult<Omit<TranscriptReadResponse, "ok">> {
  let scanLimit = rawStart;
  let scanned = 0;
  let lineStart: number | undefined;

  while (lineStart === undefined) {
    if (scanLimit === 0) {
      lineStart = 0; // reached byte 0: this line is the file's first line
      break;
    }
    if (scanned >= TRANSCRIPT_LINE_SCAN_MAX) break; // give up: exceeded scan budget
    const chunkSize = Math.min(cap, scanLimit, TRANSCRIPT_LINE_SCAN_MAX - scanned);
    const chunkStart = scanLimit - chunkSize;
    const chunk = readWindow(fd, chunkStart, scanLimit);
    const idx = chunk.lastIndexOf(0x0a);
    if (idx !== -1) {
      lineStart = chunkStart + idx + 1;
      break;
    }
    scanned += chunkSize;
    scanLimit = chunkStart;
  }

  if (lineStart === undefined) {
    return { ok: true, data: { sid, lines: [], start: scanLimit, end: scanLimit, size } };
  }

  const lineBuf = readWindow(fd, lineStart, targetEnd);
  const text = lineBuf.toString("utf-8");
  const line = text.endsWith("\n") ? text.slice(0, -1) : text;
  return { ok: true, data: { sid, lines: [line], start: lineStart, end: targetEnd, size } };
}

/**
 * `before`/`max_bytes` paginated read of `sid`'s announced transcript.
 *
 * Byte-offset windowing with line-boundary alignment, so a multi-hundred-MB
 * transcript never needs a full scan or a line index:
 *  - target end = `before` (clamped to the current file size) or file size
 *    when `before` is absent (tail read).
 *  - raw window = [max(0, end - cap), end), cap = max_bytes clamped to
 *    TRANSCRIPT_READ_MAX_BYTES.
 *  - leading trim: unless the window starts at true byte 0, its first bytes
 *    may be the tail of a line that began earlier — drop up to and including
 *    the first newline.
 *  - trailing trim: the window's tail can be an unterminated partial line
 *    only at the live tail (end === size) while the writer is mid-append —
 *    drop back to the last newline.
 *  - both trims only ever cut at a literal 0x0A byte, which in valid UTF-8
 *    never occurs as part of a multi-byte sequence (continuation/lead bytes
 *    are all >= 0x80) — so this is always safe against multi-byte content
 *    straddling a chunk boundary.
 *
 * If a window (after trims) contains no complete line at all — the window is
 * smaller than a single line — this returns an empty page anchored so that
 * passing the returned `start` back as the next `before` keeps moving strictly
 * backward (guaranteed progress even in that degenerate case).
 *
 * Soft-cap addendum (DR-0009): the degenerate case above splits in two
 * depending on *why* the window held no complete line. If the window's tail
 * genuinely isn't a line boundary (no 0x0A anywhere), the plain anchor above
 * is correct and cheap. But if the window's *only* 0x0A is its own last byte
 * — i.e. `targetEnd` is verified to be a real line's end, and that line's
 * body alone is >= a full cap — anchoring at `targetEnd` itself would make
 * the next `before` identical to this one (STUCK: an infinite empty-page
 * loop, since `[targetEnd - cap, targetEnd)` re-reads byte-for-byte the same
 * window forever). That case instead scans further back (see
 * `readSoftCapLine`) and returns the whole oversized line as one soft-cap
 * line, uncapped by `max_bytes`.
 */
export function transcriptRead(
  sessions: SessionLookup,
  sid: string,
  before: number | undefined,
  maxBytes: number | undefined,
): TranscriptResult<Omit<TranscriptReadResponse, "ok">> {
  const resolved = resolveTranscript(sessions, sid);
  if (!resolved.ok) return resolved;

  if (
    before !== undefined &&
    (typeof before !== "number" || !Number.isFinite(before) || before < 0)
  ) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read before must be a non-negative number",
    };
  }
  if (
    maxBytes !== undefined &&
    (typeof maxBytes !== "number" || !Number.isFinite(maxBytes) || maxBytes <= 0)
  ) {
    return {
      ok: false,
      code: ErrorCode.invalid_args,
      msg: "transcript_read max_bytes must be a positive number",
    };
  }

  let stat: fs.Stats;
  try {
    stat = fs.statSync(resolved.file);
  } catch {
    return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
  }

  const size = stat.size;
  const cap = Math.min(maxBytes ?? TRANSCRIPT_READ_MAX_BYTES, TRANSCRIPT_READ_MAX_BYTES);
  const targetEnd = before === undefined ? size : Math.min(before, size);
  const rawStart = Math.max(0, targetEnd - cap);

  if (targetEnd <= rawStart) {
    // before === 0 (or an otherwise empty window): nothing precedes it.
    return { ok: true, data: { sid, lines: [], start: targetEnd, end: targetEnd, size } };
  }

  const fd = fs.openSync(resolved.file, "r");
  try {
    const raw = readWindow(fd, rawStart, targetEnd);

    let data = raw;
    let start = rawStart;
    if (rawStart > 0) {
      const nl = data.indexOf(0x0a);
      if (nl === -1) {
        // no line boundary anywhere in this window: anchor the empty page at
        // rawStart so `before: start` on the next call scans strictly further back.
        return { ok: true, data: { sid, lines: [], start: rawStart, end: rawStart, size } };
      }
      if (nl === data.length - 1) {
        // The window's only newline is its own last byte: targetEnd is a
        // genuine line end, but that line's body alone fills (or exceeds) the
        // whole cap. See readSoftCapLine / module doc "soft-cap addendum".
        return readSoftCapLine(fd, rawStart, targetEnd, cap, sid, size);
      }
      data = data.subarray(nl + 1);
      start = rawStart + nl + 1;
    }

    let end = targetEnd;
    if (data.length > 0 && data[data.length - 1] !== 0x0a) {
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) {
        return { ok: true, data: { sid, lines: [], start, end: start, size } };
      }
      end = start + lastNl + 1;
      data = data.subarray(0, lastNl + 1);
    }

    // Invariant at this point: data.length === 0, or data's last byte is 0x0a —
    // so split-and-drop-trailing-empty always yields only complete lines.
    const lines = data.length === 0 ? [] : data.toString("utf-8").split("\n").slice(0, -1);

    return { ok: true, data: { sid, lines, start, end, size } };
  } finally {
    fs.closeSync(fd);
  }
}

// ---------------------------------------------------------------------------
// Live tail (DR-0009 live-tail addendum): follow a connected session's
// transcript, pushing complete-line-only ev:"transcript" events to every
// subscriber of that sid. Distinct storage from transcriptRead above — a
// Watch tracks one fs.watch/poll timer + one subscriber set per sid, keyed
// off the same hello-validated transcript_path (no separate trust boundary).
// ---------------------------------------------------------------------------

export interface TailLog {
  info(msg: string): void;
  error(msg: string): void;
}

/** Minimal shape this module needs from a wire connection — kept structural
 *  (same rationale as SessionLookup above) so this module has no dependency
 *  edge back to server.ts. Transport-level Conn.write() implementations
 *  (UDS/WS) already guard against a closing socket, so no try/catch here. */
export interface TailConn {
  write(line: string): void;
}

/** Stat-poll period used as the SOLE mechanism when fs.watch is unavailable
 *  for a given file (see startWatching). Not a protocol constant — purely an
 *  internal fallback knob. */
const TAIL_POLL_FALLBACK_MS = 1000;

/**
 * Stat-poll period used as a low-frequency BACKUP alongside a working
 * fs.watch (as opposed to TAIL_POLL_FALLBACK_MS's sole-mechanism role).
 * Verified empirically (macOS/Bun, 2026-07): fs.watch/FSEvents delivery is
 * usually near-instant, but under heavy concurrent system load (observed:
 * many daemon subprocesses spawned across a parallel `bun test` run) it can
 * lag by tens of seconds before firing — never silently drops the event
 * outright in this scenario (unlike the close/reopen bug documented on
 * startWatching), just delivers it very late. This backup poll bounds
 * staleness to ~this interval regardless of how late FSEvents gets, without
 * giving up fs.watch's normal near-instant path.
 */
const TAIL_BACKUP_POLL_MS = 2000;

interface Watch {
  sid: string;
  file: string;
  /** byte offset up to which complete lines have already been emitted to subscribers. */
  lastEnd: number;
  /** inode of `file` as of the last successful checkNow (or Watch creation).
   *  Lets checkNow tell "the same file grew/shrank" apart from "this path
   *  now names a DIFFERENT file" (rewrite via unlink+recreate, or a rename
   *  swap) — a same-or-larger-size replacement is invisible to the
   *  size<lastEnd truncate check alone (see checkNow's doc comment). */
  ino: number;
  subscribers: Set<TailConn>;
  fsWatcher: fs.FSWatcher | null;
  pollTimer: ReturnType<typeof setInterval> | null;
}

export interface TranscriptTailStore {
  watches: Map<string, Watch>;
}

export function createTranscriptTailStore(): TranscriptTailStore {
  return { watches: new Map() };
}

function sendTail(
  conn: TailConn,
  payload: { sid: string; lines: string[]; start: number; end: number; size: number },
): void {
  conn.write(`${JSON.stringify({ ev: "transcript", ...payload })}\n`);
}

function broadcast(
  watch: Watch,
  payload: { lines: string[]; start: number; end: number; size: number },
): void {
  for (const sub of watch.subscribers) sendTail(sub, { sid: watch.sid, ...payload });
}

/**
 * Read `[from, to)` of `file` and trim to the last complete line boundary —
 * mirrors transcriptRead's trailing-trim rule but for a forward-growing
 * incremental read instead of a backward-paginated one: any trailing partial
 * line (the writer mid-append) is dropped and left for the next check
 * (`end` stays at `from` in that case, signaling "nothing complete yet").
 */
function readLinesForTail(
  file: string,
  from: number,
  to: number,
): { lines: string[]; end: number } {
  const fd = fs.openSync(file, "r");
  try {
    const raw = readWindow(fd, from, to);
    if (raw.length === 0) return { lines: [], end: from };
    let data = raw;
    let end = to;
    if (data[data.length - 1] !== 0x0a) {
      const lastNl = data.lastIndexOf(0x0a);
      if (lastNl === -1) return { lines: [], end: from }; // no complete line yet; defer entirely
      end = from + lastNl + 1;
      data = data.subarray(0, lastNl + 1);
    }
    const lines = data.length === 0 ? [] : data.toString("utf-8").split("\n").slice(0, -1);
    return { lines, end };
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Re-check `watch.file` against `watch.lastEnd` and broadcast whatever
 * changed. All I/O here is synchronous (statSync/openSync/readSync/
 * closeSync) so this never yields mid-check — no reentrancy guard needed
 * even though it's invoked from both an fs.watch callback and a poll timer.
 *
 * Four cases:
 *  - inode changed (rewrite: unlink+recreate, or a rename swap): the offset
 *    bookkeeping was for a file that no longer exists at this path, even if
 *    the new file happens to be the same size or larger — reset exactly like
 *    a truncate (below), since a same-or-larger size would otherwise slip
 *    past the size<lastEnd check and read garbage from the wrong content at
 *    a stale offset.
 *  - size < lastEnd (truncate, same inode): reset the offset to the new size
 *    and tell subscribers with an empty-lines event carrying the new size,
 *    so a client watching for stale content knows to drop what it had
 *    (DR-0009 live-tail addendum: safe-side reset, no attempt to diff
 *    against content that no longer exists).
 *  - size === lastEnd: no growth, nothing to do.
 *  - size > lastEnd: read the new window, keep only complete lines (a
 *    trailing partial line is deferred to the next check), broadcast if at
 *    least one full line was found.
 */
function checkNow(watch: Watch, log: TailLog): void {
  let stat: fs.Stats;
  try {
    stat = fs.statSync(watch.file);
  } catch {
    return; // vanished; leave lastEnd as-is, a later check may find it again
  }
  if (stat.ino !== watch.ino) {
    watch.ino = stat.ino;
    watch.lastEnd = stat.size;
    broadcast(watch, { lines: [], start: stat.size, end: stat.size, size: stat.size });
    return;
  }
  if (stat.size < watch.lastEnd) {
    watch.lastEnd = stat.size;
    broadcast(watch, { lines: [], start: stat.size, end: stat.size, size: stat.size });
    return;
  }
  if (stat.size === watch.lastEnd) return;

  let result: { lines: string[]; end: number };
  try {
    result = readLinesForTail(watch.file, watch.lastEnd, stat.size);
  } catch (e) {
    log.error(`transcript tail: read failed for ${watch.sid}: ${String(e)}`);
    return;
  }
  if (result.lines.length === 0) return; // trailing partial line only; wait for more
  const start = watch.lastEnd;
  watch.lastEnd = result.end;
  broadcast(watch, { lines: result.lines, start, end: result.end, size: stat.size });
}

function startPolling(watch: Watch, log: TailLog, intervalMs: number): void {
  if (watch.pollTimer !== null) return;
  watch.pollTimer = setInterval(() => checkNow(watch, log), intervalMs);
  watch.pollTimer.unref?.();
}

function stopPolling(watch: Watch): void {
  if (watch.pollTimer !== null) {
    clearInterval(watch.pollTimer);
    watch.pollTimer = null;
  }
}

function stopFsWatcher(watch: Watch): void {
  if (watch.fsWatcher !== null) {
    try {
      watch.fsWatcher.close();
    } catch {
      // already closing
    }
    watch.fsWatcher = null;
  }
}

/**
 * fs.watch on the transcript's PARENT DIRECTORY, filtered to its basename —
 * NOT `fs.watch(watch.file)` directly. Confirmed empirically (macOS/Bun,
 * 2026-07): watching the file itself works for the *first* Watch on a given
 * sid, but once that fs.FSWatcher is `.close()`d (last subscriber leaves,
 * see teardownWatch) and a *later* subscribe re-opens `fs.watch()` on the
 * very same file path, the new watcher silently never fires again — no
 * thrown error, no "error" event, just permanent silence (reproduced with a
 * minimal standalone script, not specific to this module's code path).
 * Watching the parent directory instead survives repeated close/reopen
 * cycles without issue (also verified standalone), at the cost of checkNow
 * running on every change to any sibling file in that directory too — cheap
 * (a stat + maybe a bounded read), so not worth avoiding via inotify-style
 * directory-level filtering complexity.
 *
 * Falls back ENTIRELY to a 1s stat-poll (TAIL_POLL_FALLBACK_MS, the sole
 * mechanism) if fs.watch throws synchronously (e.g. an exotic filesystem, or
 * the directory itself is gone) or emits an "error" event later.
 *
 * When fs.watch DOES start successfully, a low-frequency backup poll
 * (TAIL_BACKUP_POLL_MS) runs alongside it unconditionally — not just on
 * failure. See TAIL_BACKUP_POLL_MS's doc comment for why: fs.watch alone
 * isn't a strong enough latency guarantee under heavy system load. checkNow
 * is naturally idempotent (a no-op once caught up), so having both the
 * fs.watch callback and the backup timer able to trigger it is never
 * redundant work beyond an extra stat() call every couple seconds.
 */
function startWatching(watch: Watch, log: TailLog): void {
  const dir = path.dirname(watch.file);
  const base = path.basename(watch.file);
  try {
    const w = fs.watch(dir, { persistent: false }, (_eventType, filename) => {
      if (filename !== null && filename !== base) return; // unrelated sibling file
      checkNow(watch, log);
    });
    w.on("error", (e) => {
      log.info(
        `transcript tail: fs.watch error for ${watch.sid} (${String(e)}), falling back to ${TAIL_POLL_FALLBACK_MS}ms poll`,
      );
      stopFsWatcher(watch);
      stopPolling(watch); // drop the backup-frequency timer before restarting at fallback frequency
      startPolling(watch, log, TAIL_POLL_FALLBACK_MS);
    });
    watch.fsWatcher = w;
    startPolling(watch, log, TAIL_BACKUP_POLL_MS);
  } catch (e) {
    log.info(
      `transcript tail: fs.watch unavailable for ${watch.sid} (${String(e)}), falling back to ${TAIL_POLL_FALLBACK_MS}ms poll`,
    );
    startPolling(watch, log, TAIL_POLL_FALLBACK_MS);
  }
}

function teardownWatch(watch: Watch): void {
  stopFsWatcher(watch);
  stopPolling(watch);
}

/**
 * Subscribe `conn` to `sid`'s transcript tail. First subscriber for a sid
 * creates the Watch (anchored at the file's current size — only bytes
 * appended *after* this call are ever tailed, matching transcript_read's own
 * "viewer starts from the tail" model); later subscribers for the same sid
 * join the existing Watch and its already-current `lastEnd`. If the sid's
 * accepted transcript_path changed since an existing Watch was created (a
 * later hello re-validated a different file, DR-0009 addendum), the stale
 * Watch is torn down and replaced.
 */
export function transcriptSubscribe(
  store: TranscriptTailStore,
  sessions: SessionLookup,
  sid: string,
  conn: TailConn,
  log: TailLog,
): TranscriptResult<Omit<TranscriptSubscribeResponse, "ok">> {
  const resolved = resolveTranscript(sessions, sid);
  if (!resolved.ok) return resolved;

  let watch = store.watches.get(sid);
  if (watch && watch.file !== resolved.file) {
    teardownWatch(watch);
    store.watches.delete(sid);
    watch = undefined;
  }
  if (!watch) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(resolved.file);
    } catch {
      return { ok: false, code: ErrorCode.not_found, msg: `transcript not found: ${sid}` };
    }
    watch = {
      sid,
      file: resolved.file,
      lastEnd: stat.size,
      ino: stat.ino,
      subscribers: new Set(),
      fsWatcher: null,
      pollTimer: null,
    };
    store.watches.set(sid, watch);
    startWatching(watch, log);
  }
  watch.subscribers.add(conn);
  return { ok: true, data: { sid, size: watch.lastEnd } };
}

/** Unsubscribe `conn` from `sid`'s tail; tears the Watch down once its last
 *  subscriber leaves. Always ok:true — unsubscribing a sid this conn was
 *  never watching (or that no longer exists) is a no-op, not an error. */
export function transcriptUnsubscribe(
  store: TranscriptTailStore,
  sid: string,
  conn: TailConn,
): { ok: true; data: Omit<TranscriptUnsubscribeResponse, "ok"> } {
  const watch = store.watches.get(sid);
  if (watch) {
    watch.subscribers.delete(conn);
    if (watch.subscribers.size === 0) {
      teardownWatch(watch);
      store.watches.delete(sid);
    }
  }
  return { ok: true, data: { sid } };
}

/** Remove `conn` from every sid it's tailing — call on connection close so a
 *  disconnected client's dead handle doesn't linger in a Watch's subscriber
 *  set forever. */
export function transcriptUnsubscribeAll(store: TranscriptTailStore, conn: TailConn): void {
  for (const [sid, watch] of store.watches) {
    if (watch.subscribers.delete(conn) && watch.subscribers.size === 0) {
      teardownWatch(watch);
      store.watches.delete(sid);
    }
  }
}

/** Unconditional stop of every Watch, for daemon shutdown. */
export function stopAllTailWatches(store: TranscriptTailStore): void {
  for (const watch of store.watches.values()) teardownWatch(watch);
  store.watches.clear();
}
