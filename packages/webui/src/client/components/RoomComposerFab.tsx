/** @jsxImportSource preact */
// UNIF-Q1=b (kawaz r15 mid=1/mid=3、2026-07-14): RoomView の Composer を
// SessionView 1on1 と同じ「右下 + fab → floating popup」スタイルに統一する
// wrapper。inline Composer を廃止する狙いは kawaz mid=1 の「ルームだけ
// メッセージフォームが違うのもアレなので＋ボタン ui に合わせましょう」。
//
// 設計判断:
//   - 案 2 (責務分離): fab + popup shell を本ファイル、input/attachments/
//     送信ロジックは既存 Composer.tsx にそのまま任せる。Composer.tsx 側は
//     3 つの optional prop (onSent / onSendingChange / focusOnOpen) だけ
//     追加した。案 1 (Composer 内で open/close state を持つ) は Composer が
//     肥大化するので不採用。
//   - **panel は常時 mount** (display 切替) で Composer の text/attachments
//     state を close 中も維持する — kawaz 明示指定 (案 A): 「入力途中で外部
//     タップ → 誤タップで書きかけを失う事故防止」。localStorage 保存は
//     RoomView では過剰 (揮発でよい、1on1 は SessionView 越境保存のために
//     localStorage を使うが、通常 room は同 RoomView 内で mount 維持で足りる)。
//   - **sending 中は外部タップを無視** して popup 維持。post の中断リスクを
//     avoid。Composer から onSendingChange 経由で sending 遷移を受け取る。
//   - **送信成功で自動 close**: onSent を Composer が呼ぶ (post ok 経路のみ、
//     失敗時は開いたまま = text は残っている = 再送 UI 維持)。
//
// 外部タップ判定 (mousedown + touchstart、panelRef.contains) は
// OneOnOneComposer と同じ pattern。× ボタンは持たない (フォーム外タップで
// 閉じる UX に統一)。
import { useState } from "preact/hooks";
import type { RoomState } from "../store.ts";
import { Composer } from "./Composer.tsx";
import { useFabPopup } from "../useFabPopup.ts";
import { isPanelDragHandle, useDraggable, useFabPanelPositionLink } from "../useDraggable.ts";

export function RoomComposerFab({ room, mentionTo }: { room: RoomState; mentionTo: Set<string> }) {
  const [sending, setSending] = useState(false);
  // kawaz r26 mid=15: panel close 中に書きかけ (text/添付) が残っているとき
  // fab を「下書きあり」表示 (色 + 跳ねアニメーション) に切り替えて放置忘れを
  // 防ぐ。Composer は常時 mount なので onDraftChange がその状態を届けてくれる。
  const [hasDraft, setHasDraft] = useState(false);
  // openTicket = fab クリックのたびにインクリメントされるカウンタ。Composer
  // にそのまま焼き付けて focusOnOpen として渡す。値が変わった時だけ
  // textarea.focus() が走る (Composer 側 useEffect の deps 判定)。
  //
  // フォーム外の **click** で閉じる (OneOnOneComposer と同じ pattern、
  // kawaz r17 mid=8,10,11) — 配管は useFabPopup 共有。`blocked: sending` で
  // post 送信中は外部クリック無視 (中断リスク回避、sending が false に戻れば
  // 再び listener が張られる)。
  const { open, openTicket, openPanel, closePanel, panelRef } = useFabPopup(sending);
  // kawaz r46 m44: FAB とパネルを個別に D&D 移動可能に。位置は永続化しない
  // (component state のみ、リロードで初期位置に戻る)。panel は常時 mount
  // (display 切替) なので open/close 越しに位置は保たれる。
  // kawaz r46m51: FAB とパネル位置を連動 (bottom-right 角を揃える)。
  // useFabPanelPositionLink が open 遷移時に相手の位置を同期する。
  const fabDrag = useDraggable();
  const panelDrag = useDraggable({ handleFilter: isPanelDragHandle });
  const { onFabRef, onPanelRef } = useFabPanelPositionLink({ open, fabDrag, panelDrag });

  const fabTitle = room.kind === "broadcast" ? "broadcast メッセージを送信" : "メッセージを送信";

  return (
    <>
      {/* fab は open 中は非表示 (unmount ではなく render しない切替)。
       *  panel は常時 mount して text/attachments state を維持する ([案 A])。
       *  panel 側の hide は display:none クラス切替、Composer は re-mount
       *  されない = state 消失しない。 */}
      {!open ? (
        <button
          type="button"
          class={"room-composer-fab" + (hasDraft ? " composer-fab-draft" : "")}
          title={hasDraft ? "書きかけの下書きがあります" : fabTitle}
          aria-label={hasDraft ? "書きかけの下書きがあります" : fabTitle}
          onClick={openPanel}
          ref={onFabRef}
          onPointerDown={fabDrag.onPointerDown}
          style={fabDrag.style}
        >
          +
        </button>
      ) : null}
      <div
        ref={(el) => {
          // useFabPopup と useDraggable (経由: onPanelRef) の両方に同じ DOM
          // を届ける (callback ref 経由の relay。OneOnOneComposer 側と同型)。
          // onPanelRef 側で size 計測も行う (r46m51 位置連動用)。
          panelRef.current = el;
          onPanelRef(el);
        }}
        class={"room-composer-panel" + (open ? "" : " room-composer-panel-hidden")}
        role="dialog"
        aria-label="composer"
        aria-hidden={open ? undefined : "true"}
        onPointerDown={panelDrag.onPointerDown}
        style={panelDrag.style}
      >
        <Composer
          room={room}
          mentionTo={mentionTo}
          focusOnOpen={openTicket}
          onSendingChange={setSending}
          onSent={closePanel}
          onDraftChange={setHasDraft}
        />
      </div>
    </>
  );
}
