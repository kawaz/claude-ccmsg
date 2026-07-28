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
