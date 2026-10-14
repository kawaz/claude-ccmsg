import type { AgentRef, SessionTab } from "./locator.ts";

export interface CachedSessionView {
  sid: string;
  tab: SessionTab;
  agent: AgentRef | null;
}

export const SESSION_VIEW_CACHE_LIMIT = 3;

/** The cache after `current` is shown: moved (or added) to the most recently
 * used end, the least recently used dropped past `limit`. Hands back `cache`
 * itself when `current` already is its most recent entry, so a caller holding
 * the cache in state can tell "nothing changed" by identity. */
export function touchSessionViewCache(
  cache: readonly CachedSessionView[],
  current: CachedSessionView,
  limit: number = SESSION_VIEW_CACHE_LIMIT,
): readonly CachedSessionView[] {
  if (limit < 1) return cache.length === 0 ? cache : [];
  const last = cache.at(-1);
  if (
    cache.length <= limit &&
    last !== undefined &&
    last.sid === current.sid &&
    last.tab === current.tab &&
    last.agent === current.agent
  ) {
    return cache;
  }
  const next = cache.filter((entry) => entry.sid !== current.sid);
  next.push(current);
  return next.slice(-limit);
}
