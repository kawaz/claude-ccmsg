// デスクトップ幅で新規セッション / セッション検索フォームを収める main ペイン
// 側のパネル (D-Q1 裁定 = b、2026-08-12)。
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
// スマホ幅ではサイドバー内インライン置換のまま (裁定文が明示) — Sidebar.tsx
// が narrow のときだけ自分で描き、こちらは描かない。RoomCreator は幅の制約が
// 中身 (title + メンバのチェックボックス) に無く、並び順がサイドバーの peer
// ソートに従うため、どの幅でもサイドバー内に残る (Sidebar.tsx 参照)。
import { useEffect, useRef, useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import { useApp } from "../context.ts";
import { clampFormPaneWidth, loadFormPaneWidth, saveFormPaneWidth } from "../form-pane.ts";
import { sessionCreatorPrefill } from "../sidebar-panel.ts";
import { PaneSplitter } from "./PaneSplitter.tsx";
import { SessionCreator } from "./SessionCreator.tsx";
import { SessionSearchPanel } from "./SessionSearchPanel.tsx";

export function FormPane({ state }: { state: AppState }) {
  const { store } = useApp();
  const [width, setWidth] = useState<number>(loadFormPaneWidth);
  const paneRef = useRef<HTMLElement>(null);
  // ドラッグが落ち着いてから永続化 (FilesPanes の ratio と同じく、ハンドラの
  // クロージャが捕まえた値ではなく実際に反映された値を保存する)。
  useEffect(() => {
    saveFormPaneWidth(width);
  }, [width]);

  const panel = state.activePanel;
  if (panel === null || panel.kind === "room-creator") return null;
  const close = () => store.dispatch({ type: "panel/closed" });

  return (
    <>
      <aside id="form-pane" ref={paneRef} style={{ width: `${width}px` }}>
        {panel.kind === "session-creator" ? (
          <SessionCreator onClose={close} prefill={sessionCreatorPrefill(panel)} />
        ) : (
          <SessionSearchPanel onClose={close} />
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
          setWidth(clampFormPaneWidth(e.clientX - pane.getBoundingClientRect().left));
        }}
      />
    </>
  );
}
