import type { AgentRef, SessionTab } from "./locator.ts";

export interface CachedSessionView {
  sid: string;
  tab: SessionTab;
  agent: AgentRef | null;
}

export const SESSION_VIEW_CACHE_LIMIT = 3;

/** Preact memo comparator for sid-keyed SessionView instances. Hidden views keep
 * their DOM and local scroll state, but global store churn must not make them
 * rebuild a Timeline the user cannot see. Either edge involving an active view
 * renders normally; inactive-to-inactive updates can wait until activation. */
export function skipInactiveSessionViewRender(wasActive: boolean, isActive: boolean): boolean {
  return !wasActive && !isActive;
}

/** Sids that `touchSessionViewCache` dropped from the cache — the sessions
 * whose SessionView (and therefore whose Timeline subscription) is about to be
 * unmounted for good.
 *
 * Their `SessionTreeState.timeline` is the largest thing the store holds per
 * session (the whole cached transcript, megabytes for a long session) and it
 * has no other release path, so without this the store grows by one full
 * transcript for every distinct session the user ever opens. Keeping it bought
 * nothing anyway: Timeline's revisit effect re-reads the tail with
 * `mode:"replace"` on every arrival, so the cached lines are discarded on the
 * next visit regardless. The rest of the tree (loaded dir listings, expanded
 * set, selected path) IS reused on revisit and stays. */
export function evictedSessionViewSids(
  previous: readonly CachedSessionView[],
  next: readonly CachedSessionView[],
): string[] {
  if (previous.length === 0) return [];
  const kept = new Set(next.map((entry) => entry.sid));
  return previous.filter((entry) => !kept.has(entry.sid)).map((entry) => entry.sid);
}

export function touchSessionViewCache(
  cache: readonly CachedSessionView[],
  current: CachedSessionView,
  limit: number = SESSION_VIEW_CACHE_LIMIT,
): CachedSessionView[] {
  if (limit < 1) return [];
  const next = cache.filter((entry) => entry.sid !== current.sid);
  next.push(current);
  return next.slice(-limit);
}
