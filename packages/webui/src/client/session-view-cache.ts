import type { AgentRef, SessionTab } from "./locator.ts";

export interface CachedSessionView {
  sid: string;
  tab: SessionTab;
  agent: AgentRef | null;
}

export const SESSION_VIEW_CACHE_LIMIT = 3;

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
