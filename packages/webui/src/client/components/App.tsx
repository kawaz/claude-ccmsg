import { memo } from "preact/compat";
import { useStoreState } from "../useStore.ts";
import { useApp } from "../context.ts";
import type { AppState, MissingTarget } from "../store.ts";
import { Avatar } from "../avatar.tsx";
import { clampPanePx, documentTitleFor, lastPathSegment, resolveSessionTopbar } from "../utils.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { RoomView } from "./RoomView.tsx";
import { SessionView } from "./SessionView.tsx";
import { ImageLightboxHost } from "./ImageLightbox.tsx";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { FormPane } from "./FormPane.tsx";
import { ErrorView } from "./ErrorView.tsx";
import { UsageView } from "./UsageView.tsx";
import { ServiceStatusBadge } from "./ServiceStatus.tsx";
import { CatalogView } from "./CatalogView.tsx";
import { usageHref } from "../locator.ts";
import { pushNavigation } from "../navigation.ts";
import { markReloadedForVersion, reloadButtonTitle } from "../version-guard.ts";
import { useEffect, useRef, useState } from "preact/hooks";
import { readStorage, writeStorage } from "../storage.ts";
import { outsideClickClosesDrawer } from "../drawer.ts";
import {
  evictedSessionViewSids,
  skipInactiveSessionViewRender,
  touchSessionViewCache,
  type CachedSessionView,
} from "../session-view-cache.ts";

const SIDEBAR_WIDTH_KEY = "ccmsg.sidebarWidth";
const SIDEBAR_DEFAULT_PX = 280;

/** 復元時はコンテナ幅を渡さない (下限のみ) — ウィンドウを一時的に狭くした
 * だけで、記憶している幅を書き換えてしまわないため。ドラッグ側は
 * `window.innerWidth` を渡して、右のペインが潰れる手前で止める。 */
function loadSidebarWidth(): number {
  // 未保存 (null) と空文字はどちらも Number で 0 になる = 既定幅扱いにする。
  return clampPanePx(Number(readStorage(SIDEBAR_WIDTH_KEY)) || Number.NaN, SIDEBAR_DEFAULT_PX);
}

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
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  const versionMismatch = state.versionMismatch;
  const sessionViewsRef = useRef<CachedSessionView[]>([]);
  // Sids the LRU dropped since the last commit, queued for the effect below.
  // The eviction is discovered here (render) but dispatched there, because a
  // dispatch during render would re-enter the store while Preact is building
  // this tree.
  const evictedSidsRef = useRef<string[]>([]);
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
  useEffect(() => {
    writeStorage(SIDEBAR_WIDTH_KEY, String(sidebarWidth));
  }, [sidebarWidth]);
  // ドロワーの外をタップしたら閉じる (kawaz r273 m16/m17)。
  //
  // 見るのは `click` そのもの: スクロール・スワイプ・長押しでは click が出ない
  // ようブラウザが既に区別しているので、移動量や時間を自前で測る必要がない。
  //
  // 判定を document に置くのは、透明な当たり判定層をドロワーの外に敷くと
  // main のタップ・スクロールがその層に吸われるため — ドロワーの右に見えて
  // いる Timeline を触れることが暗転をやめた目的そのものなので、層は置かずに
  // イベントを覗くだけにする。押された要素の動作 (リンク・ボタン) は横取り
  // しない = preventDefault も stopPropagation もせず、閉じるだけ。
  //
  // ハンバーガーだけは対象外: ここで閉じてから同じ click が toggle を走らせ
  // ると開き直してしまい、ボタンが効かなくなる。
  useEffect(() => {
    if (!state.sidebarOpen) return;
    const onClick = (e: MouseEvent) => {
      // 判定は composedPath (= 押した瞬間の経路)。今の DOM を辿る closest では、
      // その click の中で自分ごと消える要素 (フォームの ✕) が「ドロワーの外」に
      // 化けて、閉じたくない時に閉じてしまう (drawer.ts の doc 参照)。
      const pathIds = e
        .composedPath()
        .flatMap((node) => (node instanceof Element && node.id ? [node.id] : []));
      if (!outsideClickClosesDrawer(pathIds)) return;
      store.dispatch({ type: "sidebar/set", open: false });
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, [state.sidebarOpen, store]);
  // Tab title tracks the selected session/room (kawaz r99 mid=39): opening
  // several sessions in separate tabs otherwise leaves every tab reading the
  // fixed "ccmsg" title, indistinguishable until clicked.
  useEffect(() => {
    document.title = documentTitleFor(state);
  }, [state]);

  return (
    <div id="app">
      <header id="topbar">
        <button
          id="menu-toggle"
          type="button"
          aria-label="menu"
          onClick={() => store.dispatch({ type: "sidebar/set", open: !state.sidebarOpen })}
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
          // (kawaz r273 m27)。色とアニメーションはレイアウトを動かさない。
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
      <div id="layout" style={{ "--sidebar-width": `${sidebarWidth}px` }}>
        <Sidebar state={state} />
        {/* kawaz r26 mid=75: ワイドスクリーン時のサイドバー右セパレータも
         * ドラッグで幅調整。#sidebar は layout 左端に接しているので clientX
         * がそのまま幅 (px)。localStorage 永続。モバイル (720px 以下の
         * overlay) では CSS が splitter を隠す。 */}
        <PaneSplitter
          id="sidebar-splitter"
          ariaOrientation="vertical"
          onDrag={(e) =>
            setSidebarWidth(clampPanePx(e.clientX, SIDEBAR_DEFAULT_PX, window.innerWidth))
          }
        />
        {/* デスクトップのフォームパネル (D-Q1 裁定 = b)。スマホ幅では
         * Sidebar が自分の中に描くので、FormPane 自身が何も出さない
         * (幅ごとの担当は form-pane.ts の sidebarInlinePanel / formPanePanel
         * が対で決める)。 */}
        <FormPane state={state} />
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
          <span title={state.daemonInfo.exe ?? undefined}>
            daemon v{state.daemonInfo.version}
            {state.daemonInfo.script ? ` · ${state.daemonInfo.script}` : ""}
          </span>
        ) : null}
      </footer>
      <ImageLightboxHost />
    </div>
  );
}
