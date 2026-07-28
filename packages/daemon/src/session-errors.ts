// Which connected sessions are stopped on a harness API error, across *all*
// peers rather than just the one the webui has open.
//
// The sidebar has to colour every row, so the per-sid session_status
// subscription can't be the source: DR-0020 §2.1 (a) rejected subscribing a
// full fold per visible peer because its cost (agent-tree reads, workflow
// drilldown, snapshot pushes) scales with session count. This module keeps
// that budget by folding exactly one pattern — classifyApiErrorRow — over the
// same transcript tail machinery, so a session contributes one shared Watch
// and a string compare per appended line, and nothing at snapshot time.
//
// It tails rather than polls: the Watch already exists (fs.watch with a poll
// fallback inside transcript.ts) and reports appends as they land, so an error
// reaches the sidebar immediately instead of on a timer.
import type { SessionApiError, SessionErrorEntry } from "@ccmsg/protocol";
import { classifyApiErrorRow, scanTranscriptLines } from "./session-status.ts";
import {
  resolveTranscript,
  subscribeTranscriptLines,
  unsubscribeTranscriptLines,
  type SessionLookup,
  type TailLog,
  type TranscriptLineListener,
  type TranscriptTailStore,
} from "./transcript.ts";

/** Cheap string prefilter before JSON.parse, mirroring
 * isSessionStatusCandidate's role: only rows that could set the state
 * (`isApiErrorMessage`) or clear it (any assistant row) are worth parsing.
 * `"type":"assistant"` is the clearing side and matches every assistant row —
 * that is the intended breadth, since a real assistant row is exactly what
 * ends an error. */
export function isApiErrorCandidate(line: string): boolean {
  return line.includes('"isApiErrorMessage"') || line.includes('"type":"assistant"');
}

interface ErrorWatch {
  /** Transcript path this watch and its folded state describe. A re-hello
   * pointing the sid at a different file invalidates both. */
  file: string;
  listener: TranscriptLineListener;
  error?: SessionApiError;
}

export interface SessionErrorsStore {
  watches: Map<string, ErrorWatch>;
}

export function createSessionErrorsStore(): SessionErrorsStore {
  return { watches: new Map() };
}

/** Current error list, sorted by sid so callers can compare two snapshots by
 * value to decide whether a push is warranted. */
export function sessionErrorEntries(store: SessionErrorsStore): SessionErrorEntry[] {
  const entries: SessionErrorEntry[] = [];
  for (const [sid, watch] of store.watches) {
    if (watch.error) entries.push({ sid, ...watch.error });
  }
  return entries.sort((a, b) => a.sid.localeCompare(b.sid));
}

function foldLine(watch: ErrorWatch, line: string): boolean {
  let row: unknown;
  try {
    row = JSON.parse(line);
  } catch {
    return false;
  }
  if (typeof row !== "object" || row === null) return false;
  const signal = classifyApiErrorRow(row as Record<string, unknown>);
  if (!signal) return false;
  if (signal.kind === "clear") {
    if (!watch.error) return false;
    watch.error = undefined;
    return true;
  }
  const current = watch.error;
  if (current?.text === signal.error.text && current.timestamp === signal.error.timestamp) {
    return false;
  }
  watch.error = signal.error;
  return true;
}

/** Refold `file` from the start, up to `endOffset` when the caller knows how
 * far the tail has already delivered. Errors (file vanished mid-read) leave
 * the state cleared, which is the honest answer until the next tail event. */
function rescan(watch: ErrorWatch, endOffset?: number): void {
  watch.error = undefined;
  try {
    scanTranscriptLines(watch.file, endOffset, (line) => {
      if (isApiErrorCandidate(line)) foldLine(watch, line);
    });
  } catch {
    // leave cleared
  }
}

/**
 * Bring the watched set in line with `sids` (the currently connected peers):
 * start folding newly connected sessions, drop gone ones, and rebuild any
 * whose transcript path changed. `onChange` fires at most once per call, and
 * only when the resulting error list differs from the one before — including
 * the "a flagged session disconnected" case, where the list shrinks without
 * any transcript event.
 *
 * Sessions with no resolvable transcript are skipped, not recorded as errors:
 * not knowing is not the same as being stopped.
 */
export function syncSessionErrorWatches(
  store: SessionErrorsStore,
  transcriptTail: TranscriptTailStore,
  sessions: SessionLookup,
  sids: Iterable<string>,
  log: TailLog,
  onChange: () => void,
): void {
  const before = JSON.stringify(sessionErrorEntries(store));
  const wanted = new Set(sids);

  // Deleting the entry the iterator is currently on is well-defined for Map,
  // so this walks the live map rather than a copy.
  for (const [sid, watch] of store.watches) {
    const resolved = resolveTranscript(sessions, sid);
    const stillValid = wanted.has(sid) && resolved.ok && resolved.file === watch.file;
    if (stillValid) continue;
    unsubscribeTranscriptLines(transcriptTail, sid, watch.listener);
    store.watches.delete(sid);
  }

  for (const sid of wanted) {
    if (store.watches.has(sid)) continue;
    const resolved = resolveTranscript(sessions, sid);
    if (!resolved.ok) continue;
    const watch: ErrorWatch = {
      file: resolved.file,
      listener(payload) {
        if (payload.lines.length === 0) {
          // Watch reset (truncate / replacement file): the folded state
          // describes bytes that no longer exist.
          rescan(watch, payload.size);
          onChange();
          return;
        }
        let changed = false;
        for (const line of payload.lines) {
          if (isApiErrorCandidate(line) && foldLine(watch, line)) changed = true;
        }
        if (changed) onChange();
      },
    };
    const subscribed = subscribeTranscriptLines(transcriptTail, sessions, sid, watch.listener, log);
    if (!subscribed.ok) continue;
    watch.file = subscribed.data.file;
    rescan(watch, subscribed.data.size);
    store.watches.set(sid, watch);
  }

  if (JSON.stringify(sessionErrorEntries(store)) !== before) onChange();
}

/** Drop every watch (daemon shutdown). */
export function stopAllSessionErrors(
  store: SessionErrorsStore,
  transcriptTail: TranscriptTailStore,
): void {
  for (const [sid, watch] of store.watches) {
    unsubscribeTranscriptLines(transcriptTail, sid, watch.listener);
  }
  store.watches.clear();
}
