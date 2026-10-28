import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import { selectedSid } from "../store.ts";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import { nextPeerSortKey, peerSortButtonLabel, sortPeers, type PeerSortKey } from "../utils.ts";
import { writeStorage } from "../storage.ts";
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
import { SidebarFold } from "./SidebarFold.tsx";
import { SidebarGlobals } from "./SidebarGlobals.tsx";

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

/** DR-0018 §3.9 "+ 新規" affordance — same chromeless toggle-button family as
 * SearchToggleButton (see its sibling doc comment on Sidebar for why this is
 * a panel toggle, not a `state.view`). Rendered only while the daemon's hello
 * says `launch_available`: without a session_launcher the form could only
 * answer "未設定". */
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

function sidebarSlice(state: AppState) {
  return {
    peers: state.peers,
    peerSortKey: state.peerSortKey,
    sidebar: state.sidebar,
    sidebarOpen: state.sidebarOpen,
    launchAvailable: state.launchAvailable,
    currentSid: selectedSid(state),
  };
}

/** サイドバーの SESSIONS / ROOMS / GLOBALS の区画 (DR-0043) と、SESSIONS の
 * 見出しから開く 2 つのフォームパネル (新規セッション / Session Search) の
 * トグル。
 *
 * **2 つは 1 本の排他トグル**: `state.sidebar.panel` が高々 1 つを持つ
 * (`null` = どれも開いていない)。単一の値がそれを構造として保証する
 * (boolean を並べると互いを知る必要が出る)。
 *
 * **状態の正本は URL** (kawaz r259 m47-m53)。トグルは
 * `pushSidebarState(toggleSidebarPanel(...))` で `?sb.panel=new|search`
 * を書き換える遷移で、store の `sidebar` はそれを読み直した結果でしかない。
 * これで「今どのセッションを見ながら、どのフォームを何の値で開いているか」
 * が丸ごと 1 本の URL になり、リロード・戻る・リンク共有のどれでも同じ画面に
 * なる。文法は sidebar-url.ts、表は docs/design/webui-url-grammar.md。
 *
 * path 側に載せないのは、この 2 つがメインペインの中身を置き換えないから:
 * `/s/<sid>/timeline` を開いたまま横で使うものなので、「どこを見ているか」を
 * 名乗る path とは別の名前空間 (`sb.`) に属する。
 *
 * **2 つともサイドバーの中に描く** (kawaz r273 m35): フォームは一覧に対する
 * 操作 (セッションを起動する / 探す) なので、一覧を管理する
 * このコンポーネントの責務に属する。幅が splitter で自由に動かせる今、これを
 * main ペイン側に出す理由は無い — フォームの表示欠け
 * (docs/findings/2026-08-12-form-ux-width-survey.md) は「サイドバーの外へ
 * 出す」ではなく「サイドバーを広げられるようにする」で解ける。
 *
 * 中は一覧とフォームの 2 段 (`#sidebar-panes`) で、並ぶ軸だけが画面で変わる:
 *
 * - **横並び**: 左が一覧、右がフォーム。一覧を見ながら入力できる。
 * - **縦積み** (本文が viewport 幅を占める幅): 上がフォーム、下が
 *   一覧 (kawaz r273 m26)。同じ形を縦長の画面に合わせて積み替えたもので、
 *   一覧側の既定の高さは行が 2〜3 本見える程度。もっと見たくなったら間の
 *   スプリッターを下げる。
 *
 * 軸を決めるのは app.css の `flex-direction` だけで、DOM も mount するものも
 * どちらでも同じ。 */
export function Sidebar() {
  const { store } = useApp();
  const slice = useStoreState(store, sidebarSlice, shallowEqual);
  const sortKey = slice.peerSortKey;
  const panel = slice.sidebar.panel;
  const togglePanel = (kind: SidebarPanelKind) =>
    pushSidebarState(toggleSidebarPanel(slice.sidebar, kind));
  const closePanel = () => pushSidebarState(CLOSED_SIDEBAR);
  // Sorting only ever depends on the peers array reference and the chosen
  // key — never on wall-clock time — so a session list re-render triggered
  // purely by SessionList's idle-time tick doesn't reshuffle rows (see
  // sortPeers's doc comment in utils.ts and SessionList.tsx's tick).
  const sortedPeers = useMemo(() => sortPeers(slice.peers, sortKey), [slice.peers, sortKey]);
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
      // `off` が消す指示で、実際に消すかは app.css が決める — 横に並べきれない
      // 幅ではサイドバーは出しっぱなしで、ハンバーガーはどちら側を見るかの
      // 切り替えになる (kawaz r273 m63、App.tsx)。`hidden` 属性ではなく class
      // なのはそのため: 属性で「隠している」と名乗りながら見えている状態を
      // 作らない。
      //
      // 消すのは display だけで要素は残す。unmount すると書きかけのフォームと
      // 一覧のスクロール位置が消えるが、消す目的は画面共有で見せないことなので、
      // 戻したときに続きから使えないと用を成さない。
      class={[panel !== null ? "with-form" : null, slice.sidebarOpen ? null : "off"]
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
        {/* 一覧の段は開閉できる区画の列 (DR-0043 §1)。SESSIONS が日常の主動線
         * なので上で、開いて始まる (kawaz r76m52)。ROOMS は過去の読み取り専用の
         * ログで参照頻度が低いので閉じて始まり、開いた時に一覧を取る。GLOBALS は
         * セッションに属さないものの置き場で、下端に付く (app.css)。 */}
        <div id="sidebar-lists">
          <SidebarFold
            id="sidebar-sessions"
            title="Sessions"
            defaultOpen
            tools={
              <>
                {slice.launchAvailable ? (
                  <CreatorToggleButton
                    open={panel === "session-creator"}
                    onToggle={() => togglePanel("session-creator")}
                  />
                ) : null}
                <SearchToggleButton
                  open={panel === "session-search"}
                  onToggle={() => togglePanel("session-search")}
                />
                <PeersSortButton
                  sortKey={sortKey}
                  onCycle={() => {
                    const next = nextPeerSortKey(sortKey);
                    store.dispatch({ type: "peers/sort-key", key: next });
                    writeStorage(SORT_KEY_STORAGE, next);
                  }}
                />
                <PeersRefreshButton />
              </>
            }
          >
            <SessionList peers={sortedPeers} currentSid={slice.currentSid} />
          </SidebarFold>
          <RoomList />
          <SidebarFold id="sidebar-globals" title="Globals">
            <SidebarGlobals />
          </SidebarFold>
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
                <SessionCreator onClose={closePanel} seed={slice.sidebar.launch} />
              ) : (
                <SessionSearchPanel onClose={closePanel} query={slice.sidebar.search} />
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
