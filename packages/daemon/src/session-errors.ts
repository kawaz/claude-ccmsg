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
  resolveConnectedTranscript,
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

/** The folded state itself, separable from the watch so a rescan can build a
 * detached one and swap it in only when it completes. */
interface ErrorFold {
  error?: SessionApiError;
}

interface ErrorWatch extends ErrorFold {
  /** Transcript path this watch and its folded state describe. A re-hello
   * pointing the sid at a different file invalidates both. */
  file: string;
  listener: TranscriptLineListener;
  /** Bumped per rescan; a scan that finds its generation stale on completion
   * was superseded by a later reset and drops its result. */
  rescanGen: number;
  /** True while a rescan is walking the file. Tail lines are buffered rather
   * than folded, since the scan is about to replace the state wholesale. */
  scanning: boolean;
  /** Lines the tail delivered during a rescan, folded in order once it lands. */
  pending: string[];
}

export interface SessionErrorsStore {
  watches: Map<string, ErrorWatch>;
  /** Rescans still walking their transcript. `session_errors` awaits these so
   * the op keeps answering with a settled list rather than one that fills in
   * moments later (pushes carry the same list to subscribers either way). */
  inflight: Set<Promise<void>>;
}

export function createSessionErrorsStore(): SessionErrorsStore {
  return { watches: new Map(), inflight: new Set() };
}

/** Resolve once every rescan started so far has folded. */
export async function sessionErrorsReady(store: SessionErrorsStore): Promise<void> {
  await Promise.all(store.inflight);
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

function foldLine(watch: ErrorFold, line: string): boolean {
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
 * the state cleared, which is the honest answer until the next tail event.
 *
 * The scan yields to the event loop per chunk (DR-0029), so it outlives the
 * call: it folds into a detached state, swaps that in on completion, and then
 * fires `onChange`. Until then the watch keeps serving its previous value —
 * callers observe the update through `onChange`, which is how they already
 * learn about tail-driven changes. */
function rescan(
  store: SessionErrorsStore,
  watch: ErrorWatch,
  endOffset: number | undefined,
  onChange: () => void,
  log: TailLog,
): void {
  watch.rescanGen += 1;
  const gen = watch.rescanGen;
  watch.scanning = true;
  watch.pending = [];
  const fold: ErrorFold = {};
  const scan = (async () => {
    try {
      await scanTranscriptLines(watch.file, endOffset, (line) => {
        if (isApiErrorCandidate(line)) foldLine(fold, line);
      });
    } catch {
      // leave cleared
    }
    if (gen !== watch.rescanGen) return;
    watch.error = fold.error;
    watch.scanning = false;
    const pending = watch.pending;
    watch.pending = [];
    for (const line of pending) {
      if (isApiErrorCandidate(line)) foldLine(watch, line);
    }
    onChange();
  })();
  // Nothing awaits `scan` on the Watch-callback path, and `sessionErrorsReady`
  // must not turn one bad transcript into a failed session_errors op, so the
  // tracked promise absorbs its own failure.
  const tracked = scan.catch((e: unknown) => {
    watch.scanning = false;
    log.error(`session_errors rescan failed file=${watch.file}: ${String(e)}`);
  });
  store.inflight.add(tracked);
  void tracked.finally(() => store.inflight.delete(tracked));
}

/**
 * Bring the watched set in line with `sids` (the currently connected peers):
 * start folding newly connected sessions, drop gone ones, and rebuild any
 * whose transcript path changed. The synchronous part fires `onChange` at most
 * once, and only when the resulting error list differs from the one before —
 * including the "a flagged session disconnected" case, where the list shrinks
 * without any transcript event. A newly started watch folds its transcript
 * asynchronously (see rescan) and fires `onChange` again when that lands, so
 * this call returning does not mean every watch has caught up.
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
    const resolved = resolveConnectedTranscript(sessions, sid);
    const stillValid = wanted.has(sid) && resolved.ok && resolved.file === watch.file;
    if (stillValid) continue;
    unsubscribeTranscriptLines(transcriptTail, sid, watch.listener);
    store.watches.delete(sid);
  }

  for (const sid of wanted) {
    if (store.watches.has(sid)) continue;
    const resolved = resolveConnectedTranscript(sessions, sid);
    if (!resolved.ok) continue;
    const watch: ErrorWatch = {
      file: resolved.file,
      rescanGen: 0,
      scanning: false,
      pending: [],
      listener(payload) {
        if (payload.lines.length === 0) {
          // Watch reset (truncate / replacement file): the folded state
          // describes bytes that no longer exist. rescan fires onChange when
          // the refold lands.
          rescan(store, watch, payload.size, onChange, log);
          return;
        }
        if (watch.scanning) {
          // These bytes start where the in-flight scan ends; fold them after it.
          watch.pending.push(...payload.lines);
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
    rescan(store, watch, subscribed.data.size, onChange, log);
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
