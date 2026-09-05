import { useEffect, useMemo, useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import { selectedSid } from "../store.ts";
import { useApp } from "../context.ts";
import { nextPeerSortKey, peerSortButtonLabel, sortPeers, type PeerSortKey } from "../utils.ts";
import { writeStorage } from "../storage.ts";
import { RoomCreator } from "./RoomCreator.tsx";
import { RoomList } from "./RoomList.tsx";
import {
  CLOSED_SIDEBAR,
  SORT_KEY_STORAGE,
  toggleSidebarPanel,
  type SidebarPanelKind,
} from "../sidebar-url.ts";
import { pushSidebarState } from "../navigation.ts";
import { sidebarInlinePanel } from "../form-pane.ts";
import {
  clampDrawerWidth,
  clampSidebarListWidth,
  loadDrawerWidth,
  loadSidebarListWidth,
  saveDrawerWidth,
  saveSidebarListWidth,
} from "../drawer.ts";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { useNarrowLayout } from "../useNarrowLayout.ts";
import { SessionCreator } from "./SessionCreator.tsx";
import { SessionList } from "./SessionList.tsx";
import { SessionSearchPanel } from "./SessionSearchPanel.tsx";

function PeersRefreshButton() {
  const { store, ws } = useApp();
  return (
    <button
      id="peers-refresh"
      type="button"
      title="refresh"
      onClick={() =>
        void ws.peers().then((res) => {
          if (res.ok) store.dispatch({ type: "peers/loaded", peers: res.peers });
        })
      }
    >
      &#8635;
    </button>
  );
}

function PeersSortButton({ sortKey, onCycle }: { sortKey: PeerSortKey; onCycle: () => void }) {
  // Labels are prompt/name/created/recent (kawaz 2026-07-16: "わかりづらい。
  // name/created/recent にして"); "click for X" names the *next* key in
  // PEER_SORT_CYCLE's order (prompt -> name -> connected -> idle -> prompt).
  const titles: Record<PeerSortKey, string> = {
    prompt: "sorted by last user input (most recent first) — click for name",
    name: "sorted by name (repo · ws · branch) — click for created",
    connected: "sorted by connect time (most recently connected first) — click for recent",
    idle: "sorted by idle time (most recently active first) — click for prompt",
  };
  return (
    <button id="peers-sort" type="button" title={titles[sortKey]} onClick={onCycle}>
      {peerSortButtonLabel(sortKey)}
    </button>
  );
}

function SearchToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="session-search-toggle"
      type="button"
      title={open ? "検索を閉じる" : "過去セッションを検索 (DR-0021)"}
      aria-pressed={open}
      onClick={onToggle}
    >
      🔍
    </button>
  );
}

/** DR-0018 §2.1 "+ 新規" affordance — same chromeless toggle-button family as
 * SearchToggleButton (see its sibling doc comment on Sidebar for why this is
 * a panel toggle, not a `state.view`). Always rendered regardless of whether
 * session_launcher is configured (DR-0018 §2.1's "launcher 未設定時" branch
 * (b) — SessionCreator itself probes on open and shows setup guidance
 * instead of the form, rather than this button disappearing/needing its own
 * probe just to decide whether to render at all). */
function CreatorToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="session-creator-toggle"
      type="button"
      title={open ? "新規セッションを閉じる" : "新規セッションを起動 (DR-0018)"}
      aria-pressed={open}
      onClick={onToggle}
    >
      {"+⁠New"}
    </button>
  );
}

/** ROOMS section "+ 新規" affordance (issue 2026-07-17-rooms-sidebar-new-
 * button.md), the room-creation counterpart to CreatorToggleButton above —
 * same chromeless toggle-button family, symmetric with SESSIONS's "+ 新規"
 * per the issue's stated goal. Always rendered (no session-launcher-style
 * probe gate — create_room has no server-side "unconfigured" state). */
function RoomCreatorToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="room-creator-toggle"
      type="button"
      title={open ? "新規 Room を閉じる" : "新規 Room を作成"}
      aria-pressed={open}
      onClick={onToggle}
    >
      {"+⁠New"}
    </button>
  );
}

/** サイドバーの SESSIONS / ROOMS セクションと、そこから開く 3 つのフォーム
 * パネル (新規セッション / Session Search / 新規 Room) のトグル。
 *
 * **3 つは 1 本の排他トグル**: `state.sidebar.panel` が高々 1 つを持つ
 * (`null` = どれも開いていない)。セクションをまたいで排他なのは、ROOMS の
 * 「+ 新規」を押したら SESSIONS のフォームが閉じるのが自然だからで、単一の
 * 値がそれを構造として保証する (3 つの boolean だと互いを知る必要が出る)。
 *
 * **状態の正本は URL** (kawaz r259 m47-m53)。トグルは
 * `pushSidebarState(toggleSidebarPanel(...))` で `?sb.panel=new|search|room`
 * を書き換える遷移で、store の `sidebar` はそれを読み直した結果でしかない。
 * これで「今どのセッションを見ながら、どのフォームを何の値で開いているか」
 * が丸ごと 1 本の URL になり、リロード・戻る・リンク共有のどれでも同じ画面に
 * なる。文法は sidebar-url.ts、表は docs/design/webui-url-grammar.md。
 *
 * path 側に載せないのは、この 3 つがメインペインの中身を置き換えないから:
 * `/s/<sid>/timeline` を開いたまま横で使うものなので、「どこを見ているか」を
 * 名乗る path とは別の名前空間 (`sb.`) に属する。
 *
 * どこに描くかは幅で変わる (D-Q1 裁定 = b、2026-08-12):
 *
 * - **デスクトップ**: 3 つとも main ペイン側の `FormPane` が描き、サイドバー
 *   は SessionList / RoomList を出したまま (= 一覧を見ながら入力できる)。
 *   サイドバーの実効幅 264px がフォームの表示欠けの根だった
 *   (docs/findings/2026-08-12-form-ux-width-survey.md)。RoomCreator も同じ
 *   理由で FormPane 側に出す (kawaz r259 m53) — メンバのチェックボックスを
 *   一覧と見比べながら選ぶ価値は他の 2 つと変わらない。その並び順が依存する
 *   ソートキーは `state.peerSortKey` なので、描画先が変わっても同じ順で並ぶ。
 * - **スマホ** (サイドバーが overlay ドロワーになる幅): 3 つともここで描く。
 *   ドロワーの中を「一覧 | スプリッター | フォーム」に左右分割し、デスクトップ
 *   と同じ「一覧を見ながら入力できる」形にする (kawaz r273 m13)。一覧側の
 *   既定幅は数文字分で、読みたくなったらスプリッターで広げる。 */
export function Sidebar({ state }: { state: AppState }) {
  const { store } = useApp();
  const sortKey = state.peerSortKey;
  const narrow = useNarrowLayout();
  const panel = state.sidebar.panel;
  const togglePanel = (kind: SidebarPanelKind) =>
    pushSidebarState(toggleSidebarPanel(state.sidebar, kind));
  const closePanel = () => pushSidebarState(CLOSED_SIDEBAR);
  // デスクトップではフォームは FormPane が描くので、ここは一覧のまま
  // (対になる formPanePanel と合わせて form-pane.ts が正本)。
  const inlinePanel = sidebarInlinePanel(panel, narrow);
  // Sorting only ever depends on the peers array reference and the chosen
  // key — never on wall-clock time — so a session list re-render triggered
  // purely by SessionList's idle-time tick doesn't reshuffle rows (see
  // sortPeers's doc comment in utils.ts and SessionList.tsx's tick).
  const sortedPeers = useMemo(() => sortPeers(state.peers, sortKey), [state.peers, sortKey]);
  // ドロワー幅と、その中の一覧幅。どちらもこの中だけの寸法なので、幅を持つ
  // 他のペインと同じく px 直値 + localStorage 永続で Sidebar が抱える。
  const [drawerWidth, setDrawerWidth] = useState<number>(() => loadDrawerWidth(window.innerWidth));
  const [listWidth, setListWidth] = useState<number>(loadSidebarListWidth);
  useEffect(() => {
    saveDrawerWidth(drawerWidth);
  }, [drawerWidth]);
  useEffect(() => {
    saveSidebarListWidth(listWidth);
  }, [listWidth]);

  return (
    <nav
      id="sidebar"
      class={state.sidebarOpen ? "open" : undefined}
      // デスクトップの幅は #layout の --sidebar-width (App.tsx) が持つので、
      // ここで幅を指定するのは overlay ドロワーの時だけ。
      style={narrow ? { width: `${drawerWidth}px` } : undefined}
    >
      <div
        id="sidebar-lists"
        style={inlinePanel ? { width: `${listWidth}px`, flex: "0 0 auto" } : undefined}
      >
        <section id="sessions-panel">
          <h2>
            Sessions{" "}
            <CreatorToggleButton
              open={panel === "session-creator"}
              onToggle={() => togglePanel("session-creator")}
            />{" "}
            <SearchToggleButton
              open={panel === "session-search"}
              onToggle={() => togglePanel("session-search")}
            />{" "}
            <PeersSortButton
              sortKey={sortKey}
              onCycle={() => {
                const next = nextPeerSortKey(sortKey);
                store.dispatch({ type: "peers/sort-key", key: next });
                writeStorage(SORT_KEY_STORAGE, next);
              }}
            />{" "}
            <PeersRefreshButton />
          </h2>
          <SessionList peers={sortedPeers} currentSid={selectedSid(state)} />
        </section>
        {/* Sessions が日常の主動線なので上 (kawaz r76m52)。Rooms は参照頻度が低い */}
        <section id="rooms-panel">
          <h2>
            Rooms{" "}
            <RoomCreatorToggleButton
              open={panel === "room-creator"}
              onToggle={() => togglePanel("room-creator")}
            />
          </h2>
          <RoomList state={state} />
        </section>
      </div>
      {inlinePanel !== null ? (
        <>
          {/* 一覧とフォームの境界。ドロワーは画面左端に接しているので clientX が
           * そのまま一覧の幅 (px)。上限はドロワー幅なので、フォームが隠れる
           * ところまで広げられる。 */}
          <PaneSplitter
            id="sidebar-list-splitter"
            ariaOrientation="vertical"
            onDrag={(e) => setListWidth(clampSidebarListWidth(e.clientX, drawerWidth))}
          />
          <aside id="sidebar-form">
            {inlinePanel === "session-creator" ? (
              <SessionCreator
                onClose={closePanel}
                template={state.sidebar.template}
                params={state.sidebar.params}
              />
            ) : inlinePanel === "session-search" ? (
              <SessionSearchPanel onClose={closePanel} query={state.sidebar.search} />
            ) : (
              <RoomCreator peers={sortedPeers} onClose={closePanel} />
            )}
          </aside>
        </>
      ) : null}
      {narrow ? (
        // ドロワーの右端。ここを動かすとドロワー自体の幅が変わり、右に残った
        // main (Timeline 等) を見ながら操作できる (kawaz r273 m15)。
        <PaneSplitter
          id="sidebar-drawer-splitter"
          ariaOrientation="vertical"
          onDrag={(e) => setDrawerWidth(clampDrawerWidth(e.clientX, window.innerWidth))}
        />
      ) : null}
    </nav>
  );
}
