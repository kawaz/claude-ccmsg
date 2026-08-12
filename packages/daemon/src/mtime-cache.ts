// Memoize a value derived from one path, revalidated by that path's stat.
//
// The session_status snapshot re-derives its filesystem-backed fields on every
// push (one per transcript line), and most of those files never change between
// pushes: an agent's `meta.json` is written once at spawn, a `.code-workspace`
// is hand-edited at human speed. Statting the path and reusing the parse when
// nothing moved turns "readdir + N opens + N parses per line" into "N stats per
// line" — memoization only, per DR-0029: nothing is batched, delayed, or made
// to wait on another job.
//
// Freshness is (mtimeMs, size, ino), not mtime alone: mtime granularity can
// hide a rewrite that lands in the same millisecond as the read that cached it,
// and an unlink+recreate can reuse neither the inode nor the size reliably.
// Comparing all three costs one stat either way.
import * as fs from "node:fs";

export interface MtimeCache<T> {
  /** Stat `file`; return the memoized value when it is unchanged, otherwise
   * `load(stat)`. Returns `undefined` when the path cannot be statted — the
   * caller decides what an absent path means (usually "no entry"). `stat` is
   * handed to `load` so callers that need the mtime (liveness, tie-breaking)
   * don't stat twice. */
  get(file: string, load: (stat: fs.Stats) => Promise<T>): Promise<T | undefined>;
}

interface Entry<T> {
  mtimeMs: number;
  size: number;
  ino: number;
  value: T;
}

/** `maxEntries` bounds retention; entries refresh on access, so eviction drops
 * the least recently used path and costs only a re-read next time. */
export function createMtimeCache<T>(maxEntries: number): MtimeCache<T> {
  const entries = new Map<string, Entry<T>>();
  return {
    async get(file, load) {
      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(file);
      } catch {
        entries.delete(file);
        return undefined;
      }
      const hit = entries.get(file);
      if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size && hit.ino === stat.ino) {
        entries.delete(file); // re-inserted below to refresh recency
        entries.set(file, hit);
        return hit.value;
      }
      const value = await load(stat);
      entries.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, ino: stat.ino, value });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next();
        if (oldest.done) break;
        entries.delete(oldest.value);
      }
      return value;
    },
  };
}
