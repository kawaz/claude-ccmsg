import { useEffect, useMemo, useRef, useState } from "preact/hooks";
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
import {
  clampDrawerWidth,
  clampFormWidth,
  clampSidebarListHeight,
  clampSidebarWidth,
  loadDrawerWidth,
  loadFormWidth,
  loadSidebarListHeight,
  loadSidebarWidth,
  saveDrawerWidth,
  saveFormWidth,
  saveSidebarListHeight,
  saveSidebarWidth,
} from "../sidebar-panes.ts";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { paneAxisMetrics, readPaneAxis, usePaneAxis } from "../pane-axis.ts";
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
 * **3 つともサイドバーの中に描く** (kawaz r273 m35): フォームは一覧に対する
 * 操作 (セッションを起動する / 探す / ルームを作る) なので、一覧を管理する
 * このコンポーネントの責務に属する。幅が splitter で自由に動かせる今、これを
 * main ペイン側に出す理由は無い — フォームの表示欠け
 * (docs/findings/2026-08-12-form-ux-width-survey.md) は「サイドバーの外へ
 * 出す」ではなく「サイドバーを広げられるようにする」で解ける。
 *
 * 中は一覧とフォームの 2 段 (`#sidebar-panes`) で、並ぶ軸だけが画面で変わる:
 *
 * - **横並び**: 左が一覧、右がフォーム。一覧を見ながら入力できる。
 * - **縦積み** (サイドバーが overlay ドロワーになる幅): 上がフォーム、下が
 *   一覧 (kawaz r273 m26)。同じ形を縦長の画面に合わせて積み替えたもので、
 *   一覧側の既定の高さは行が 2〜3 本見える程度。もっと見たくなったら間の
 *   スプリッターを下げる。
 *
 * 軸を決めるのは app.css の `flex-direction` だけで、DOM も mount するものも
 * どちらでも同じ。RoomCreator が他の 2 つと同じ場所に出るのも同じ理由で
 * (kawaz r259 m53)、メンバのチェックボックスを一覧と見比べながら選ぶ価値は
 * 変わらない。その並び順が依存するソートキーは `state.peerSortKey`。 */
export function Sidebar({ state }: { state: AppState }) {
  const { store } = useApp();
  const sortKey = state.peerSortKey;
  const panel = state.sidebar.panel;
  const togglePanel = (kind: SidebarPanelKind) =>
    pushSidebarState(toggleSidebarPanel(state.sidebar, kind));
  const closePanel = () => pushSidebarState(CLOSED_SIDEBAR);
  // Sorting only ever depends on the peers array reference and the chosen
  // key — never on wall-clock time — so a session list re-render triggered
  // purely by SessionList's idle-time tick doesn't reshuffle rows (see
  // sortPeers's doc comment in utils.ts and SessionList.tsx's tick).
  const sortedPeers = useMemo(() => sortPeers(state.peers, sortKey), [state.peers, sortKey]);
  // 2 段の寸法。どれもサイドバーの中だけの値なので、他のペインと同じく
  // px 直値 + localStorage 永続でここが抱える (どの値がどの軸のものかは
  // sidebar-panes.ts の表)。CSS 変数として置き、どれを使うかは app.css が
  // 軸ごとに選ぶ。
  const [sidebarWidth, setSidebarWidth] = useState<number>(loadSidebarWidth);
  const [formWidth, setFormWidth] = useState<number>(loadFormWidth);
  const [drawerWidth, setDrawerWidth] = useState<number>(() => loadDrawerWidth(window.innerWidth));
  const [listHeight, setListHeight] = useState<number>(loadSidebarListHeight);
  const panesRef = useRef<HTMLDivElement>(null);
  const formRef = useRef<HTMLElement>(null);
  const axis = usePaneAxis(panesRef);
  useEffect(() => {
    saveSidebarWidth(sidebarWidth);
  }, [sidebarWidth]);
  useEffect(() => {
    saveFormWidth(formWidth);
  }, [formWidth]);
  useEffect(() => {
    saveDrawerWidth(drawerWidth);
  }, [drawerWidth]);
  useEffect(() => {
    saveSidebarListHeight(listHeight);
  }, [listHeight]);

  return (
    <nav
      id="sidebar"
      class={[state.sidebarOpen ? "open" : null, panel !== null ? "with-form" : null]
        .filter(Boolean)
        .join(" ")}
      style={{
        "--sidebar-width": `${sidebarWidth}px`,
        "--sidebar-form-width": `${formWidth}px`,
        "--sidebar-list-height": `${listHeight}px`,
        "--drawer-width": `${drawerWidth}px`,
      }}
    >
      {/* 一覧とフォームの 2 段。並ぶ軸は app.css が決める (横並び = 一覧 →
       * フォーム、縦積み = フォーム → 一覧)。サイドバー自体の右端に立つ
       * splitter はこの外なので、軸が変わるのはこの中だけ。 */}
      <div id="sidebar-panes" ref={panesRef}>
        <div id="sidebar-lists">
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
        {panel !== null ? (
          <>
            {/* 一覧とフォームの境界。持たせる値は軸で変わり、一覧がどちらの端に
             * あるかも app.css の `order` で変わる: 横並びなら手前 (左) が一覧
             * なので幅は `pointer - start`、縦積みならフォームが `order` で前に
             * 出るので一覧は奥 (下) にあり、高さは `end - pointer`。どちらも
             * 上限は隣が潰れる手前 = フォームを隠しきるところまで動かせる。 */}
            <PaneSplitter
              id="sidebar-pane-splitter"
              ariaOrientation={axis === "column" ? "horizontal" : "vertical"}
              onDrag={(e) => {
                const panes = panesRef.current;
                if (!panes) return;
                const dragAxis = readPaneAxis(panes);
                const m = paneAxisMetrics(dragAxis, panes.getBoundingClientRect(), e);
                if (dragAxis === "column") {
                  setListHeight(clampSidebarListHeight(m.end - m.pointer, m.size));
                } else {
                  setSidebarWidth(
                    clampSidebarWidth(m.pointer - m.start, window.innerWidth - m.start),
                  );
                }
              }}
            />
            <aside id="sidebar-form" ref={formRef}>
              {panel === "session-creator" ? (
                <SessionCreator
                  onClose={closePanel}
                  template={state.sidebar.template}
                  params={state.sidebar.params}
                />
              ) : panel === "session-search" ? (
                <SessionSearchPanel onClose={closePanel} query={state.sidebar.search} />
              ) : (
                <RoomCreator peers={sortedPeers} onClose={closePanel} />
              )}
            </aside>
          </>
        ) : null}
      </div>
      {/* サイドバーの右端。横並びでは右のペイン (= フォーム、閉じていれば一覧)
       * の幅を、縦積みではサイドバーそのものの幅を動かす — どちらも「右に残った
       * main を見ながら操作できる」ための同じ操作 (kawaz r273 m15)。幅は自分の
       * 左辺からの距離で測る (左のものの幅を足し直すより、動いても壊れない)。 */}
      <PaneSplitter
        id="sidebar-splitter"
        ariaOrientation="vertical"
        onDrag={(e) => {
          const panes = panesRef.current;
          if (!panes) return;
          if (readPaneAxis(panes) === "column") {
            setDrawerWidth(clampDrawerWidth(e.clientX, window.innerWidth));
            return;
          }
          const form = formRef.current;
          if (form === null) {
            setSidebarWidth(clampSidebarWidth(e.clientX, window.innerWidth));
            return;
          }
          const left = form.getBoundingClientRect().left;
          setFormWidth(clampFormWidth(e.clientX - left, window.innerWidth - left));
        }}
      />
    </nav>
  );
}
