import type { Store } from "./useStore.ts";
import type { AppState, MissingTarget } from "./store.ts";
import type { createWsClient } from "./ws.ts";
import { parseUrl, timelineHref, type Locator } from "./locator.ts";
import {
  CLOSED_SIDEBAR,
  parseSidebarUrl,
  withSidebarState,
  type SidebarUrlState,
} from "./sidebar-url.ts";
import { readStorage, sweepStaleBySid, writeStorage } from "./storage.ts";
import { hasUnsentInput } from "./unsent-input.ts";
import { markReloadedForVersion, type VersionMismatch } from "./version-guard.ts";

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
  // Strip `sb.*`: what the session was parked on is a place, and a form panel
  // that happened to be open while the user was there is not part of it.
  // Restoring one would reopen a launcher nobody asked for, seeded from
  // whatever session was being looked at then.
  const place = withSidebarState(url, CLOSED_SIDEBAR);
  writeStorage(recentKey(sid), JSON.stringify({ url: place, updatedAt: new Date().toISOString() }));
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
  // Readiness here means "the registry that could prove this URL names
  // nothing has arrived". /usage and /catalog name no session and no room, so
  // there is nothing to wait for and nothing missingTarget could ever report.
  if (locator.view === "usage" || locator.view === "catalog") return true;
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

/** The URL to actually navigate to, given a caller that named a path. With no
 * `sidebar` argument the open panel travels along unchanged — a session link,
 * a room link, a search hit's Timeline all mean "show me this", not "and close
 * what I have open", and DR-0021 relies on the search panel surviving the
 * navigation it triggers. Callers that do mean to change the panel pass the
 * state they want, `CLOSED_SIDEBAR` included; nothing is inferred from whether
 * the url they built happens to carry `sb.*`, because "close it" and "leave it
 * alone" would then be the same argument. */
export function navigationTarget(
  url: string,
  currentSearch: string,
  sidebar?: SidebarUrlState,
): string {
  return withSidebarState(url, sidebar ?? parseSidebarUrl(currentSearch));
}

/** `navigate()` info marking a URL whose `sb.*` was composed on purpose — by
 * `navigationTarget`, which either carried the current panel over or applied
 * an explicit state (including "closed"). A navigation without it (a plain
 * `<a href>` such as a session tab, a typed URL) says nothing about the panel,
 * so the intercept keeps the one that is open (kawaz r259m65). */
const SIDEBAR_COMPOSED = { sidebar: "composed" } as const;

export function pushNavigation(url: string, sidebar?: SidebarUrlState): void {
  window.navigation.navigate(navigationTarget(url, location.search, sidebar), {
    history: "push",
    info: SIDEBAR_COMPOSED,
  });
}

export function replaceNavigation(url: string, sidebar?: SidebarUrlState): void {
  window.navigation.navigate(navigationTarget(url, location.search, sidebar), {
    history: "replace",
    info: SIDEBAR_COMPOSED,
  });
}

/** Open, close or swap a form panel without leaving the page. Pushed rather
 * than replaced so 戻る closes what the user just opened — the panel is a
 * place the user navigated to, and the back button is the cheapest way out of
 * it. */
export function pushSidebarState(sidebar: SidebarUrlState): void {
  pushNavigation(`${location.pathname}${location.search}`, sidebar);
}

/** 新しい daemon に追従するためのフルリロードを、この遷移に相乗りさせて
 * よいか (kawaz r273m9)。version-guard は不一致を見つけても即リロードせず
 * 予約だけ立てるので、実際にページを捨てる瞬間はここが決める。
 *
 * `push` に限るのは「ユーザが自分で次の画面を選んだ」遷移だけを拾うため。
 * 戻る/進む (`traverse`) は元の画面が返ってくることを期待した操作なので
 * 読み直しは不意打ちになるし、`replace` はタイムライン位置の追従やファイル
 * 復元のようにプログラム起点の書き換えが大半で、ユーザは何も操作していない。
 *
 * 書きかけがある間は見送る。遷移でフォームが unmount される経路なら下書きは
 * どのみち失われるが、パネルの開閉のようにその場に留まる遷移では生き残る。 */
export function shouldReloadForVersion(
  mismatch: VersionMismatch | null,
  navigationType: NavigationType,
  unsentInput: boolean,
): boolean {
  return (
    mismatch !== null && mismatch.reloadOnNavigation && navigationType === "push" && !unsentInput
  );
}

/** リロードを始めたら、遷移そのものはブラウザに任せる。`location.assign` は
 * それ自体が `navigate` を撃つので、印を付けないと同じ判定が再入する。 */
let reloadingForVersion = false;

export function setupNavigation(store: Store, ws: WsClient): void {
  // path と `sb.*` は同じ URL の別々の名前空間なので、1 回の遷移で両方を
  // 届ける。パネルの開閉も遷移 (pushSidebarState) なので、この経路以外から
  // activePanel が変わることはない = URL が正本。
  const apply = (url: URL): void => {
    store.dispatch({
      type: "locator/changed",
      locator: parseUrl(url.pathname, url.search),
      sidebar: parseSidebarUrl(url.search),
    });
  };

  const redirectSessionRoot = async (sid: string, history: "push" | "replace"): Promise<void> => {
    const target = await resolveSessionRootTarget(readRecent(sid), sid, store.getState(), ws);
    if (history === "push") pushNavigation(target);
    else replaceNavigation(target);
  };

  window.navigation.addEventListener("navigate", (rawEvent) => {
    const event = rawEvent as NavigateEvent;
    if (reloadingForVersion) return;
    if (!event.canIntercept || event.downloadRequest !== null || event.hashChange) return;
    // A reload (location.reload(), the header reload button, Cmd+R) also fires
    // `navigate` with canIntercept=true. Intercepting it would turn "restart
    // the whole bundle" into a soft SPA re-route — the header button exists
    // precisely to throw broken state away, so let the browser handle it.
    if (event.navigationType === "reload") return;
    const targetUrl = new URL(event.destination.url);
    if (targetUrl.origin !== location.origin) return;
    // A link that says nothing about the sidebar keeps the open panel: the
    // session tabs are plain anchors, and hopping Files → Timeline must not
    // close a Session Search the user is reading results from. Re-issued as
    // the same navigation with `sb.*` carried over (now marked composed, so
    // this branch runs once).
    const composed = (event.info as { sidebar?: string } | undefined)?.sidebar === "composed";
    if (!composed && event.navigationType !== "traverse") {
      const current = parseSidebarUrl(location.search);
      if (current.panel !== null && parseSidebarUrl(targetUrl.search).panel === null) {
        event.preventDefault();
        window.navigation.navigate(
          withSidebarState(`${targetUrl.pathname}${targetUrl.search}`, current),
          {
            history: event.navigationType === "replace" ? "replace" : "push",
            info: SIDEBAR_COMPOSED,
          },
        );
        return;
      }
    }
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

    // 予約済みのフルリロードは、遷移先へそのまま着地させる形で消化する
    // (ユーザから見れば「移動したら画面が新しくなっていた」だけ)。ここまで
    // 来ているので遷移先の存在確認と recent 保存は済んでいる。
    const mismatch = store.getState().versionMismatch;
    if (mismatch && shouldReloadForVersion(mismatch, event.navigationType, hasUnsentInput())) {
      event.preventDefault();
      reloadingForVersion = true;
      markReloadedForVersion(mismatch.daemonVersion);
      location.assign(targetUrl.href);
      return;
    }

    if (isSameSessionTabChange(current, target) && event.navigationType === "push") {
      event.preventDefault();
      // Re-issued verbatim, `sb.*` included: this is the same navigation the
      // caller already composed, only demoted to a replace so tab hopping
      // inside one session does not stack history entries.
      replaceNavigation(
        `${targetUrl.pathname}${targetUrl.search}`,
        parseSidebarUrl(targetUrl.search),
      );
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
