// Client-side cache + batch coordinator for the message-body path linkifier
// (kawaz r46 m55-m58). Given a stream of "does this absolute path exist as a
// file the daemon will serve?" questions arriving from TimelineItem renders,
// this module:
//
//   1. dedupes and holds an authoritative Map<sid, Map<absPath, Status>> so a
//      re-render never re-asks something already answered (or in flight);
//   2. debounces enqueues into per-sid batches flushed on the next microtask,
//      turning N inline-code paths in one message (or across the visible
//      timeline) into 1 fs_stat_batch WS request;
//   3. notifies subscribers when new answers land so MarkdownView re-renders
//      and swaps <code> for <a> in place.
//
// The cache is intentionally session-lifetime: `clearSid` wipes a sid's
// entries on disconnect / reconnect (session_status stream); otherwise a
// resolved path stays cached until the page reload. Filesystem mutations
// happening during that window will not invalidate a stale positive — that
// tradeoff (accept "linked file was deleted mid-session, click 404s in
// FileViewer") is the same tradeoff FileTree makes for its own listing.

import type { FsStatEntry } from "@ccmsg/protocol";

/** Per-path lookup state. `undefined` = never asked (caller may enqueue),
 * `"pending"` = a batch request is in flight or scheduled, `FsStatEntry` =
 * daemon confirmed a servable file, `null` = daemon declined (missing,
 * forbidden, directory, ...). */
export type FilePathStatus = "pending" | FsStatEntry | null;

type SendBatch = (sid: string, paths: string[]) => Promise<(FsStatEntry | null)[]>;

const cache = new Map<string, Map<string, FilePathStatus>>();
const pendingQueue = new Map<string, Set<string>>();
const subscribers = new Set<() => void>();
let flushScheduled = false;
let sender: SendBatch | null = null;

/** Wire the module to a WS-backed batch sender. Called once at app boot
 * (main.tsx) with a closure over `ws.fsStatBatch`. Kept as an inject rather
 * than a hard import so unit tests can plug a synchronous fake sender in and
 * observe the flush sequencing without spinning up a real WS. */
export function configureFilePathExistenceCache(send: SendBatch): void {
  sender = send;
}

/** Read the cached status. `undefined` distinguishes "never asked" from
 * "asked and got null back" — the caller uses that to decide whether an
 * enqueue is needed. */
export function getFilePathStatus(sid: string, absPath: string): FilePathStatus | undefined {
  return cache.get(sid)?.get(absPath);
}

/** Enqueue an absolute path for the next batch flush. No-op when the path is
 * already known (any non-undefined status). Safe to call from render — the
 * actual WS send happens on the next microtask, and `sender === null` (no
 * one wired the cache yet) silently drops the enqueue so tests / storybook
 * renders don't crash. */
export function enqueueFilePathProbe(sid: string, absPath: string): void {
  if (!sender) return;
  let byPath = cache.get(sid);
  if (!byPath) {
    byPath = new Map();
    cache.set(sid, byPath);
  }
  if (byPath.has(absPath)) return;
  byPath.set(absPath, "pending");
  let queued = pendingQueue.get(sid);
  if (!queued) {
    queued = new Set();
    pendingQueue.set(sid, queued);
  }
  queued.add(absPath);
  scheduleFlush();
}

function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  queueMicrotask(() => {
    flushScheduled = false;
    const snapshot = new Map(pendingQueue);
    pendingQueue.clear();
    for (const [sid, paths] of snapshot.entries()) {
      const list = [...paths];
      void flushOne(sid, list);
    }
  });
}

async function flushOne(sid: string, paths: string[]): Promise<void> {
  if (!sender) return;
  let results: (FsStatEntry | null)[];
  try {
    results = await sender(sid, paths);
  } catch {
    // WS dropped / daemon error — treat every requested path as "no answer"
    // so a later retry from a new session (which clears the cache) can
    // re-probe. `null` here means "linkification declined"; the caller
    // re-enqueues by observing session-cleared state.
    results = paths.map(() => null);
  }
  const byPath = cache.get(sid);
  if (!byPath) return;
  paths.forEach((p, i) => byPath.set(p, results[i] ?? null));
  notifySubscribers();
}

function notifySubscribers(): void {
  for (const cb of subscribers) cb();
}

/** Subscribe for cache-update notifications. Returns the unsubscribe
 * function. TimelineItem uses this to re-render when a batch response
 * arrives — the callback fires once per batch, not per resolved path, so a
 * message with 20 code spans only re-renders once when they all come back. */
export function subscribeFilePathCache(cb: () => void): () => void {
  subscribers.add(cb);
  return () => {
    subscribers.delete(cb);
  };
}

/** Drop every cached entry for a sid — call on session disconnect /
 * reconnect so a re-registered session probes fresh (the underlying files
 * may have moved / the external_files allowlist may have changed). */
export function clearFilePathCacheForSid(sid: string): void {
  cache.delete(sid);
  pendingQueue.delete(sid);
  notifySubscribers();
}

/** Test-only reset — clears everything and drops the wired sender. */
export function _resetFilePathCacheForTests(): void {
  cache.clear();
  pendingQueue.clear();
  subscribers.clear();
  flushScheduled = false;
  sender = null;
}
