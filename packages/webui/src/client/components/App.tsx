import { useStoreState } from "../useStore.ts";
import { useApp } from "../context.ts";
import type { AppState } from "../store.ts";
import { Avatar } from "../avatar.tsx";
import { lastPathSegment } from "../utils.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { RoomView } from "./RoomView.tsx";
import { SessionView } from "./SessionView.tsx";
import { ImageLightboxHost } from "./ImageLightbox.tsx";

/** topbar のタイトル — アプリ名 "ccmsg" の固定表示をやめ、選択中の
 * SESSION (repo ▸ ws) / ROOM (title) を出す (kawaz r17 mid=1、2026-07-14):
 * スマホでは topbar が常に最前面に見えるため、固定 "ccmsg" だと他リポの
 * セッションを見ながら「ccmsg リポにいる」と勘違いして会話する事故の温床
 * になる。何も選択していない初期状態だけアプリ名を出す。 */
function TopbarTitle({ state }: { state: AppState }) {
  if (state.view === "session" || state.view === "timeline") {
    const sid = state.currentSid;
    if (sid !== null) {
      const peer = state.peers.find((p) => p.sid === sid);
      // repo ▸ ws の 2 段構成 (kawaz r17 mid=29): repo だけだと同一リポの
      // 複数 worktree セッションが区別できない。
      const repo = peer?.repo || "";
      const ws = peer?.ws || "";
      const label =
        repo && ws
          ? `${repo} ▸ ${ws}`
          : repo || ws || lastPathSegment(peer?.cwd ?? "") || sid.slice(0, 8);
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
        <TopbarTitle state={state} />
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
      <ImageLightboxHost />
    </div>
  );
}
