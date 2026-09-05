import { memo } from "preact/compat";
import { useStoreState } from "../useStore.ts";
import { useApp } from "../context.ts";
import { SIDEBAR_OPEN_KEY, type AppState, type MissingTarget } from "../store.ts";
import { Avatar } from "../avatar.tsx";
import { documentTitleFor, lastPathSegment, resolveSessionTopbar } from "../utils.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { RoomView } from "./RoomView.tsx";
import { SessionView } from "./SessionView.tsx";
import { ImageLightboxHost } from "./ImageLightbox.tsx";
import { ErrorView } from "./ErrorView.tsx";
import { UsageView } from "./UsageView.tsx";
import { ServiceStatusBadge } from "./ServiceStatus.tsx";
import { CatalogView } from "./CatalogView.tsx";
import { parseUrl, usageHref } from "../locator.ts";
import { pushNavigation } from "../navigation.ts";
import { markReloadedForVersion, reloadButtonTitle } from "../version-guard.ts";
import { useEffect, useRef } from "preact/hooks";
import { writeSessionStorage } from "../storage.ts";
import { layoutScrollsX, useLayoutScrollsX } from "../layout-mode.ts";
import { nextSidebarSnapLeft, opensOnMain } from "../sidebar-panes.ts";
import {
  evictedSessionViewSids,
  skipInactiveSessionViewRender,
  touchSessionViewCache,
  type CachedSessionView,
} from "../session-view-cache.ts";

/** topbar のタイトル — アプリ名 "ccmsg" の固定表示をやめ、選択中の
 * SESSION (repo ▸ ws) / ROOM (title) を出す (kawaz r17 mid=1、2026-07-14):
 * スマホでは topbar が常に最前面に見えるため、固定 "ccmsg" だと他リポの
 * セッションを見ながら「ccmsg リポにいる」と勘違いして会話する事故の温床
 * になる。何も選択していない初期状態だけアプリ名を出す。 */
function TopbarTitle({ state }: { state: AppState }) {
  // Names only the sections the daemon can actually fill: with one endpoint
  // configured, a title promising both would advertise a section that is not
  // on the screen.
  if (state.view === "usage") {
    const parts = [
      ...(state.llmUsageAvailable ? ["クオータ"] : []),
      ...(state.llmStatsAvailable ? ["使用量"] : []),
      ...(state.llmUsageAvailable || state.llmStatsAvailable ? [] : ["upstream"]),
    ];
    return <h1 class="topbar-title">{parts.length > 0 ? parts.join(" / ") : "クオータ"}</h1>;
  }
  if (state.view === "catalog") {
    return <h1 class="topbar-title">コンポーネントカタログ</h1>;
  }
  if (state.view === "session" || state.view === "timeline") {
    const sid = state.currentSid;
    if (sid !== null) {
      // repo ▸ ws の 2 段構成 (kawaz r17 mid=29): repo だけだと同一リポの
      // 複数 worktree セッションが区別できない。kawaz r38 mid=9: 生きた peer が
      // 無い pinned/agent-only 経路でも ws を復元できるよう resolveSessionTopbar
      // を経由 (それまでは peer.ws=="" になった瞬間 sid short まで落ちて
      // worktree 名が完全に消えていた)。
      const { repo, ws, cwd } = resolveSessionTopbar(state, sid);
      const label =
        repo && ws
          ? `${repo} ▸ ${ws}`
          : repo || ws || lastPathSegment(cwd ?? "") || sid.slice(0, 8);
      return (
        <h1 class="topbar-title">
          <Avatar seed={sid} size={18} />
          <span class="topbar-title-text">{label}</span>
        </h1>
      );
    }
  } else if (state.currentRoomId !== null) {
    const room = state.rooms.get(state.currentRoomId);
    return (
      <h1 class="topbar-title">
        <span class="topbar-title-text">{room?.title || state.currentRoomId}</span>
      </h1>
    );
  }
  return <h1 class="topbar-title">ccmsg</h1>;
}

/** Shown in the content area, with the sidebar left mounted beside it — the
 * point is that the user can see they are off-route *and* click their way
 * back, which is exactly what a served-from-the-daemon 404 page could not
 * offer. */
function UnknownPathView({ pathname }: { pathname: string }) {
  return (
    <ErrorView
      fill
      mark="404"
      title="このページはありません"
      detail={pathname}
      hint="左の一覧からセッションやルームを選んでください。"
      action={{ label: "トップに戻る", href: "/" }}
    />
  );
}

/** A URL naming a session or room that is gone. This is a 404 like any other —
 * the address resolved to nothing — so it says so in the same words and the
 * same shape as the rest, rather than reporting itself as a generic navigation
 * failure (kawaz r76 m76). The recovery differs only because the URL was never
 * committed to: there is a previous screen to return to. */
function MissingTargetView({
  target,
  onDismiss,
}: {
  target: MissingTarget;
  onDismiss: () => void;
}) {
  return (
    <ErrorView
      fill
      mark="404"
      title={target.kind === "room" ? "このルームはありません" : "このセッションはありません"}
      detail={target.id}
      hint="終了・削除された可能性があります。左の一覧から選び直してください。"
      action={{ label: "元の画面に戻る", onClick: onDismiss }}
    />
  );
}

const CachedSessionViewComponent = memo(SessionView, (previous, next) =>
  skipInactiveSessionViewRender(previous.active, next.active),
);

export function App() {
  const { store } = useApp();
  const state = useStoreState(store);
  const versionMismatch = state.versionMismatch;
  const sessionViewsRef = useRef<CachedSessionView[]>([]);
  // Sids the LRU dropped since the last commit, queued for the effect below.
  // The eviction is discovered here (render) but dispatched there, because a
  // dispatch during render would re-enter the store while Preact is building
  // this tree.
  const evictedSidsRef = useRef<string[]>([]);
  const layoutRef = useRef<HTMLDivElement>(null);
  const initialSnapRef = useRef(false);
  // ラベルにだけ使う (押した瞬間の判定は下で読み直す)。
  const layoutScrolls = useLayoutScrollsX(layoutRef);
  const visibleSessionSid =
    state.missingTarget === null &&
    state.unknownPath === null &&
    (state.view === "session" || state.view === "timeline")
      ? state.currentSid
      : null;
  if (visibleSessionSid !== null) {
    const previous = sessionViewsRef.current;
    sessionViewsRef.current = touchSessionViewCache(previous, {
      sid: visibleSessionSid,
      tab: state.currentTab ?? "files",
      agent: state.currentAgent,
    });
    const evicted = evictedSessionViewSids(previous, sessionViewsRef.current);
    if (evicted.length > 0) evictedSidsRef.current.push(...evicted);
  }
  useEffect(() => {
    const queued = evictedSidsRef.current;
    if (queued.length === 0) return;
    evictedSidsRef.current = [];
    // A sid can be evicted and then re-visited before this effect runs (fast
    // A→B→C→D→A navigation); dropping its transcript at that point would
    // throw away a Timeline that is mounted and current.
    const mounted = new Set(sessionViewsRef.current.map((view) => view.sid));
    const sids = queued.filter((sid) => !mounted.has(sid));
    if (sids.length > 0) store.dispatch({ type: "timeline/evicted", sids });
  });
  // サイドバーの在り / 無しはその窓の中だけの状態 (storage.ts の表)。
  useEffect(() => {
    writeSessionStorage(SIDEBAR_OPEN_KEY, String(state.sidebarOpen));
  }, [state.sidebarOpen]);
  // 横スクロールで行き来する幅では、開いた直後にどちら側を見せるかを決める
  // (sidebar-panes.ts の opensOnMain)。1 度きり — 以後の位置は指と
  // ハンバーガーのもので、遷移のたびに引き戻すと操作を奪う。
  useEffect(() => {
    const layout = layoutRef.current;
    if (layout === null || initialSnapRef.current) return;
    if (!layoutScrollsX(layout)) return;
    const max = layout.scrollWidth - layout.clientWidth;
    // 本文がまだ幅を持たないうちは測れない。次の描画で測り直す。
    if (max <= 0) return;
    initialSnapRef.current = true;
    layout.scrollLeft = opensOnMain(parseUrl(location.pathname, location.search)) ? max : 0;
  });
  // Tab title tracks the selected session/room (kawaz r99 mid=39): opening
  // several sessions in separate tabs otherwise leaves every tab reading the
  // fixed "ccmsg" title, indistinguishable until clicked.
  useEffect(() => {
    document.title = documentTitleFor(state);
  }, [state]);

  return (
    <div id="app">
      <header id="topbar">
        {/* 幅を問わず常に出すが、意味は Layout が横に並べきれるかで変わる
         * (layout-mode.ts):
         *
         * - **並べきれる幅**: サイドバーを消す / 出す (kawaz r273 m42: 画面
         *   共有で特定のセッションだけ見せたいときに消せることが目的)。
         * - **並べきれない幅**: サイドバーは出しっぱなしで、どちら側を見るかを
         *   切り替える (kawaz r273 m63)。消す方式だと、本文側へスワイプした
         *   状態で押したときサイドバーが画面外で消えるだけになり、何も起きて
         *   いないように見える。 */}
        <button
          id="menu-toggle"
          type="button"
          aria-label="menu"
          // 「押された状態」を持つのは消す / 出すの時だけ。切り替えの時は
          // 押しっぱなしの状態が無い。
          aria-pressed={layoutScrolls ? undefined : state.sidebarOpen}
          title={
            layoutScrolls
              ? "サイドバーと本文を行き来する"
              : state.sidebarOpen
                ? "サイドバーを隠す"
                : "サイドバーを出す"
          }
          onClick={() => {
            const layout = layoutRef.current;
            if (layout !== null && layoutScrollsX(layout)) {
              layout.scrollTo({
                left: nextSidebarSnapLeft(
                  layout.scrollLeft,
                  layout.scrollWidth - layout.clientWidth,
                ),
                behavior: "smooth",
              });
              return;
            }
            store.dispatch({ type: "sidebar/set", open: !state.sidebarOpen });
          }}
        >
          &#9776;
        </button>
        {state.unknownPath !== null ? (
          <h1 class="topbar-title">ccmsg</h1>
        ) : (
          <TopbarTitle state={state} />
        )}
        <ConnectionStatus status={state.connStatus} />
        {/* Host-wide, so it lives in the global header rather than in any
         * session's tabs. Shown only when the daemon has a usage gateway
         * configured — without one the screen could only ever show an error,
         * so the feature does not exist for that operator (same posture as the
         * Terminal tab). */}
        {/* Beside the usage entry rather than inside it: the badge says
         * something is wrong upstream, which is worth seeing on every screen,
         * and the entry beside it is where the detail lives. */}
        <ServiceStatusBadge state={state} />
        {state.llmUsageAvailable || state.llmStatsAvailable || state.llmStatusAvailable ? (
          <button
            id="app-usage"
            type="button"
            aria-label="usage"
            title="クオータ / 使用量"
            aria-current={state.view === "usage" ? "page" : undefined}
            onClick={() => pushNavigation(usageHref())}
          >
            &#9203;
          </button>
        ) : null}
        <div class="app-history-controls" aria-label="navigation history">
          <button
            id="app-back"
            type="button"
            aria-label="back"
            title="戻る"
            disabled={!window.navigation.canGoBack}
            onClick={() => void window.navigation.back()}
          >
            &#8592;
          </button>
          <button
            id="app-forward"
            type="button"
            aria-label="forward"
            title="進む"
            disabled={!window.navigation.canGoForward}
            onClick={() => void window.navigation.forward()}
          >
            &#8594;
          </button>
        </div>
        {/* SPA 内リロードボタン (kawaz 2026-07-14、RLD-Q1=a): iOS ホーム画面
         * 追加 (standalone display mode = PWA 起動) 時にブラウザのリロードが
         * 画面上に現れないため、topbar に置いてどの起動形態でも常時アクセス可
         * にする。desktop でも同じ位置に置くことで統一 (Sidebar は折り畳み可)。
         * window.location.reload() で bundle + subscribe を完全に再起動する
         * — soft な reconnect でなく hard reload なのは「壊れた state を全捨て
         * したい」用途 (fresh reload 経路の過去ログ復元と組合わさる)。 */}
        <button
          id="app-reload"
          type="button"
          aria-label="reload"
          // 不一致は専用のボックスを増やさず、このボタンの見た目だけで伝える
          // (kawaz r273 m27)。色だけを変えるのでレイアウトは動かない。
          class={versionMismatch !== null ? "app-reload-update" : undefined}
          title={reloadButtonTitle(versionMismatch)}
          onClick={() => {
            // 押した = このタブはこの version のために読み直した。記録しないと
            // 入れ替わらなかった時に同じ判定が何度でも成立する。
            if (versionMismatch !== null) markReloadedForVersion(versionMismatch.daemonVersion);
            window.location.reload();
          }}
        >
          &#8635;
        </button>
      </header>
      <div id="layout" ref={layoutRef}>
        {/* サイドバーは一覧もフォームも自分の中に持ち、幅を変える splitter も
         * 自分の右端に立てる (Sidebar.tsx)。本文と横に並びきるか、本文が
         * 幅いっぱいを占めて横スクロールで行き来するかは app.css が決める。 */}
        <Sidebar state={state} />
        {sessionViewsRef.current.map((view) => (
          <CachedSessionViewComponent
            key={view.sid}
            state={state}
            sid={view.sid}
            tab={view.tab}
            agent={view.agent}
            active={visibleSessionSid === view.sid}
          />
        ))}
        {state.missingTarget !== null ? (
          <MissingTargetView
            target={state.missingTarget}
            onDismiss={() => store.dispatch({ type: "navigation/missing", target: null })}
          />
        ) : state.unknownPath !== null ? (
          <UnknownPathView pathname={state.unknownPath} />
        ) : state.view === "usage" ? (
          <UsageView state={state} />
        ) : state.view === "catalog" ? (
          <CatalogView />
        ) : state.view === "room" ? (
          <RoomView state={state} />
        ) : null}
      </div>
      <footer id="app-footer">
        {state.daemonInfo ? (
          <span title={state.daemonInfo.exe ?? undefined}>daemon v{state.daemonInfo.version}</span>
        ) : null}
      </footer>
      <ImageLightboxHost />
    </div>
  );
}
