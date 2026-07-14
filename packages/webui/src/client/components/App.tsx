import { useStoreState } from "../useStore.ts";
import { useApp } from "../context.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { RoomView } from "./RoomView.tsx";
import { SessionView } from "./SessionView.tsx";

export function App() {
  const { store } = useApp();
  const state = useStoreState(store);

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
        <h1>ccmsg</h1>
        <ConnectionStatus status={state.connStatus} />
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
          title="ページを再読み込み"
          onClick={() => window.location.reload()}
        >
          &#8635;
        </button>
      </header>
      <div id="layout">
        <Sidebar state={state} />
        <div
          id="sidebar-backdrop"
          class={state.sidebarOpen ? "visible" : undefined}
          onClick={() => store.dispatch({ type: "sidebar/set", open: false })}
        />
        {state.view === "session" || state.view === "timeline" ? (
          <SessionView state={state} />
        ) : (
          <RoomView state={state} />
        )}
      </div>
      <footer id="app-footer">
        {state.daemonInfo ? (
          <span title={state.daemonInfo.exe ?? undefined}>
            daemon v{state.daemonInfo.version}
            {state.daemonInfo.script ? ` · ${state.daemonInfo.script}` : ""}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
