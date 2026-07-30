import type { Store } from "./useStore.ts";
import type { AppState, MissingTarget } from "./store.ts";
import type { createWsClient } from "./ws.ts";
import { parseUrl, timelineHref, type Locator } from "./locator.ts";
import { readStorage, sweepStaleBySid, writeStorage } from "./storage.ts";

const RECENT_PREFIX = "ccmsg.recent.";
const timelinePositions = new Map<string, string>();
const RECENT_STALE_MS = 10 * 24 * 60 * 60 * 1000;
export const BEFORE_NAVIGATION_EVENT = "ccmsg:before-navigation";

export interface RecentRecord {
  url: string;
  updatedAt: string;
}

export type WsClient = ReturnType<typeof createWsClient>;

export function rememberTimelinePosition(sid: string, position: string): void {
  if (position === "head") timelinePositions.delete(sid);
  else timelinePositions.set(sid, position);
}

export function urlWithRememberedTimelinePosition(url: string, sid: string): string {
  const position = timelinePositions.get(sid);
  return position ? timelineHref(sid, position) : url;
}

export function transcriptContainsUuid(lines: readonly string[], uuid: string): boolean {
  return lines.some((line) => {
    try {
      const value = JSON.parse(line) as { uuid?: unknown };
      return value.uuid === uuid;
    } catch {
      return false;
    }
  });
}

function recentKey(sid: string): string {
  return `${RECENT_PREFIX}${sid}`;
}

function readRecent(sid: string): RecentRecord | null {
  const raw = readStorage(recentKey(sid));
  if (!raw) return null;
  try {
    const record = JSON.parse(raw) as Partial<RecentRecord>;
    if (typeof record.url !== "string" || typeof record.updatedAt !== "string") return null;
    if (Date.now() - Date.parse(record.updatedAt) > RECENT_STALE_MS) return null;
    const url = new URL(record.url, location.origin);
    const locator = parseUrl(url.pathname, url.search);
    if ((locator.view !== "session" && locator.view !== "timeline") || locator.sid !== sid) {
      return null;
    }
    return { url: `${url.pathname}${url.search}`, updatedAt: record.updatedAt };
  } catch {
    return null;
  }
}

/** An agent TL is a drill-down into one subagent's transcript, not a place the
 * session itself was — so it is neither recorded as nor accepted as the
 * session's recent view. Restoring one for `/s/<sid>` (the sidebar's session
 * link) made every return to the session land back on that subagent, with no
 * way to reach the session's own timeline from the sidebar (kawaz r76 m59).
 * The agent may also be gone by the time the record is read, while the
 * session's own timeline always exists. */
export function isAgentTimelineUrl(url: string, origin: string = location.origin): boolean {
  const parsed = new URL(url, origin);
  const locator = parseUrl(parsed.pathname, parsed.search);
  return locator.view === "timeline" && !!locator.agent;
}

/** Records where the user was working in `sid`, for `/s/<sid>` to restore.
 * Skipping agent TLs here keeps the last non-agent view, so drilling into a
 * subagent and leaving doesn't throw away the file or timeline position the
 * session was actually parked on. recentIsValid re-checks on the read side
 * because a record written before this gate existed outlives it by up to
 * RECENT_STALE_MS. */
function saveRecent(sid: string, url: string): void {
  if (isAgentTimelineUrl(url)) return;
  writeStorage(recentKey(sid), JSON.stringify({ url, updatedAt: new Date().toISOString() }));
}

export async function recentIsValid(
  record: RecentRecord,
  sid: string,
  state: AppState,
  ws: WsClient,
  origin: string = location.origin,
): Promise<boolean> {
  if (!sessionExists(state, sid)) return false;
  const url = new URL(record.url, origin);
  const locator = parseUrl(url.pathname, url.search);
  if (isAgentTimelineUrl(record.url, origin)) return false;
  if (locator.view === "timeline" && locator.position && locator.position !== "head") {
    try {
      const result = await ws.transcriptRead(sid);
      return result.ok && transcriptContainsUuid(result.lines, locator.position);
    } catch {
      return false;
    }
  }
  if (locator.view !== "session" || locator.tab !== "files" || !locator.path) return true;
  const peer = state.peers.find((item) => item.sid === sid);
  const stored = state.pinnedSessions.get(sid) ?? state.sessionTrees.get(sid)?.searchHit;
  const cwd = peer?.cwd ?? stored?.cwd;
  if (!cwd) return false;
  const absolutePath = locator.path.startsWith("/") ? locator.path : `${cwd}/${locator.path}`;
  try {
    const result = await ws.fsStatBatch(sid, [absolutePath]);
    return result.ok && result.results[0] !== null;
  } catch {
    return false;
  }
}

function sweepRecent(state: AppState): void {
  sweepStaleBySid(RECENT_PREFIX, state, RECENT_STALE_MS, (sid) => readRecent(sid)?.updatedAt);
}

function locatorSid(locator: Locator): string | null {
  return locator.view === "session" ||
    locator.view === "timeline" ||
    locator.view === "session-root"
    ? locator.sid
    : null;
}

function locatorTab(locator: Locator): string | null {
  if (locator.view === "timeline") return "timeline";
  if (locator.view === "session") return locator.tab ?? "files";
  return null;
}

function sessionExists(state: AppState, sid: string): boolean {
  return (
    state.peers.some((peer) => peer.sid === sid) ||
    state.agents.some((agent) => agent.sessionId === sid) ||
    state.pinnedSessions.has(sid) ||
    state.sessionTrees.has(sid)
  );
}

export function missingTarget(state: AppState, locator: Locator): MissingTarget | null {
  if (locator.view === "room" && locator.room) {
    if (!state.roomsLoaded) return null;
    if (!state.rooms.has(locator.room)) return { kind: "room", id: locator.room };
  }
  const sid = locatorSid(locator);
  if (sid) {
    if (!state.peersLoaded || !state.agentsLoaded) return null;
    if (!sessionExists(state, sid)) return { kind: "session", id: sid };
  }
  return null;
}

function currentUrl(): string {
  const url = `${location.pathname}${location.search}`;
  const locator = parseUrl(location.pathname, location.search);
  return locator.view === "timeline" && !locator.agent
    ? urlWithRememberedTimelinePosition(url, locator.sid)
    : url;
}

export function sessionRootHistory(current: Locator, targetSid: string): "push" | "replace" {
  return locatorSid(current) === targetSid ? "replace" : "push";
}

export function isSameSessionTabChange(current: Locator, target: Locator): boolean {
  const currentSid = locatorSid(current);
  return (
    currentSid !== null &&
    currentSid === locatorSid(target) &&
    locatorTab(current) !== null &&
    locatorTab(current) !== locatorTab(target)
  );
}

export function initialLocatorReady(state: AppState, locator: Locator): boolean {
  return locator.view === "room" ? state.roomsLoaded : state.peersLoaded && state.agentsLoaded;
}

export async function resolveSessionRootTarget(
  recent: RecentRecord | null,
  sid: string,
  state: AppState,
  ws: WsClient,
  origin: string = location.origin,
): Promise<string> {
  return recent && (await recentIsValid(recent, sid, state, ws, origin))
    ? recent.url
    : timelineHref(sid);
}

export function pushNavigation(url: string): void {
  window.navigation.navigate(url, { history: "push" });
}

export function replaceNavigation(url: string): void {
  window.navigation.navigate(url, { history: "replace" });
}

export function setupNavigation(store: Store, ws: WsClient): void {
  const apply = (url: URL): void => {
    store.dispatch({ type: "locator/changed", locator: parseUrl(url.pathname, url.search) });
  };

  const redirectSessionRoot = async (sid: string, history: "push" | "replace"): Promise<void> => {
    const target = await resolveSessionRootTarget(readRecent(sid), sid, store.getState(), ws);
    if (history === "push") pushNavigation(target);
    else replaceNavigation(target);
  };

  window.navigation.addEventListener("navigate", (rawEvent) => {
    const event = rawEvent as NavigateEvent;
    if (!event.canIntercept || event.downloadRequest !== null || event.hashChange) return;
    // A reload (location.reload(), the header reload button, Cmd+R) also fires
    // `navigate` with canIntercept=true. Intercepting it would turn "restart
    // the whole bundle" into a soft SPA re-route — the header button exists
    // precisely to throw broken state away, so let the browser handle it.
    if (event.navigationType === "reload") return;
    const targetUrl = new URL(event.destination.url);
    if (targetUrl.origin !== location.origin) return;
    window.dispatchEvent(new Event(BEFORE_NAVIGATION_EVENT));
    const target = parseUrl(targetUrl.pathname, targetUrl.search);
    const current = parseUrl(location.pathname, location.search);

    const missing = missingTarget(store.getState(), target);
    if (missing) {
      event.preventDefault();
      store.dispatch({ type: "navigation/missing", target: missing });
      return;
    }

    if (target.view === "session-root") {
      event.preventDefault();
      const currentSid = locatorSid(current);
      if (currentSid && currentSid !== target.sid) saveRecent(currentSid, currentUrl());
      void redirectSessionRoot(target.sid, sessionRootHistory(current, target.sid));
      return;
    }

    const currentSid = locatorSid(current);
    const targetSid = locatorSid(target);
    if (currentSid && currentSid !== targetSid) saveRecent(currentSid, currentUrl());

    if (isSameSessionTabChange(current, target) && event.navigationType === "push") {
      event.preventDefault();
      replaceNavigation(`${targetUrl.pathname}${targetUrl.search}`);
      return;
    }

    event.intercept({ handler: () => apply(targetUrl) });
  });

  const unsubscribeRecentSweep = store.subscribe(() => {
    if (store.getState().peers.length === 0) return;
    sweepRecent(store.getState());
    unsubscribeRecentSweep();
  });

  const initial = parseUrl(location.pathname, location.search);
  if (initial.view === "session-root") {
    const unsubscribe = store.subscribe(() => {
      const state = store.getState();
      if (!initialLocatorReady(state, initial)) return;
      unsubscribe();
      const missing = missingTarget(state, initial);
      if (missing) store.dispatch({ type: "navigation/missing", target: missing });
      else void redirectSessionRoot(initial.sid, "replace");
    });
  } else {
    apply(new URL(location.href));
    const unsubscribe = store.subscribe(() => {
      const state = store.getState();
      if (!initialLocatorReady(state, initial)) return;
      unsubscribe();
      const missing = missingTarget(state, initial);
      if (missing) store.dispatch({ type: "navigation/missing", target: missing });
    });
  }
}
