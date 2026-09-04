// デスクトップ幅でフォームパネルを収める main ペイン側のパネル (D-Q1 裁定
// = b、2026-08-12)。新規セッション / セッション検索 / 新規 Room の 3 つとも
// ここに出る (kawaz r259 m53)。
//
// 置き場所を #layout 直下 (サイドバーの右隣) にしているのは:
//
// - **現在の view を置換しない**: 検索結果を選んで Timeline へ遷移しても
//   パネルは閉じない (DR-0021 の設計判断) ので、遷移先が同時に見えていないと
//   その仕様が意味を失う。フォームと本文が横に並ぶ形だけがこれを満たす。
// - **セッションのタブ (Files/Timeline/Status/Rooms) の中に入れない**: タブは
//   sid スコープで、セッション未選択・room・usage・404 では描けない。+New と
//   検索はどの画面からでも開ける。
// - SessionView 群は既に全部 mount 済みで表示のみ切り替わる (App.tsx) ため、
//   兄弟としてパネルが増えても Timeline は再マウントされない。
//
// どれが開いているかと、フォームの初期値は URL の `sb.*` が正本
// (sidebar-url.ts)。ここは state.sidebar を読んで描くだけで、閉じる操作も
// URL を書き換える遷移として出す。
//
// スマホ幅ではサイドバー内インライン置換のまま (裁定文が明示) — Sidebar.tsx
// が narrow のときだけ自分で描き、こちらは描かない。
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import {
  clampFormPaneWidth,
  formPanePanel,
  loadFormPaneWidth,
  saveFormPaneWidth,
} from "../form-pane.ts";
import { useNarrowLayout } from "../useNarrowLayout.ts";
import { CLOSED_SIDEBAR } from "../sidebar-url.ts";
import { pushSidebarState } from "../navigation.ts";
import { sortPeers } from "../utils.ts";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { RoomCreator } from "./RoomCreator.tsx";
import { SessionCreator } from "./SessionCreator.tsx";
import { SessionSearchPanel } from "./SessionSearchPanel.tsx";

export function FormPane({ state }: { state: AppState }) {
  const [width, setWidth] = useState<number>(loadFormPaneWidth);
  const paneRef = useRef<HTMLElement>(null);
  // Sidebar と同じ並び (state.peerSortKey)。identity を保つのは RoomCreator の
  // メンバ一覧が peers 配列の参照で再描画されるため。
  const sortedPeers = useMemo(
    () => sortPeers(state.peers, state.peerSortKey),
    [state.peers, state.peerSortKey],
  );
  // ドラッグが落ち着いてから永続化 (FilesPanes の ratio と同じく、ハンドラの
  // クロージャが捕まえた値ではなく実際に反映された値を保存する)。
  useEffect(() => {
    saveFormPaneWidth(width);
  }, [width]);

  const narrow = useNarrowLayout();
  const { template, params, search } = state.sidebar;
  const panel = formPanePanel(state.sidebar.panel, narrow);
  if (panel === null) return null;
  const close = () => pushSidebarState(CLOSED_SIDEBAR);

  return (
    <>
      <aside id="form-pane" ref={paneRef} style={{ width: `${width}px` }}>
        {panel === "session-creator" ? (
          <SessionCreator onClose={close} template={template} params={params} />
        ) : panel === "session-search" ? (
          <SessionSearchPanel onClose={close} query={search} />
        ) : (
          <RoomCreator peers={sortedPeers} onClose={close} />
        )}
      </aside>
      {/* #sidebar-splitter と同じ「clientX の px 直読み」解釈。ただしこのペイン
       * は layout 左端に接していないので、幅は自分の左辺からの距離で測る
       * (サイドバー幅 + splitter 幅を足し直すより、動いても壊れない)。 */}
      <PaneSplitter
        id="form-pane-splitter"
        ariaOrientation="vertical"
        onDrag={(e) => {
          const pane = paneRef.current;
          if (!pane) return;
          // 上限はこのペインの左辺から先の残り幅で決まる (右のセッション
          // ビューを潰しきる手前まで動かせる)。
          const left = pane.getBoundingClientRect().left;
          setWidth(clampFormPaneWidth(e.clientX - left, window.innerWidth - left));
        }}
      />
    </>
  );
}
