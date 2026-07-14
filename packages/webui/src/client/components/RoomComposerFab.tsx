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
import { useCallback, useEffect, useRef, useState } from "preact/hooks";
import type { RoomState } from "../store.ts";
import { Composer } from "./Composer.tsx";

export function RoomComposerFab({ room, mentionTo }: { room: RoomState; mentionTo: Set<string> }) {
  const [open, setOpen] = useState(false);
  const [sending, setSending] = useState(false);
  // openTicket = fab クリックのたびにインクリメントされるカウンタ。
  // Composer にそのまま焼き付けて focusOnOpen として渡す。値が変わった時だけ
  // textarea.focus() が走る (Composer 側 useEffect の deps 判定)。
  // useState の初期値 0 は「まだ開かれていない」sentinel — Composer 側で
  // 0 は skip する。
  const [openTicket, setOpenTicket] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);

  const openPanel = useCallback(() => {
    setOpen(true);
    setOpenTicket((n) => n + 1);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
  }, []);

  // フォーム外タップで閉じる (OneOnOneComposer と同じ pattern)。
  // - `mousedown` を選ぶ理由: click だと panel 内から panel 外へ text 選択
  //   drag した際に click.target が panel 外扱いになって意図しない close を
  //   起こす事故を避ける。mousedown なら drag 開始点で判定できる。
  // - `touchstart` を並列に張るのは iOS Safari で click 委譲より touch event
  //   の方が早く発火するため。
  // - **sending 中は listener を張らない** = 外部タップ無視。post の中断リスク
  //   を avoid。sending が false に戻れば再び listener が張られる。
  // - `open === false` の間 (fab 表示中) も張らない — fab クリック自体を
  //   閉じ扱いする事故を防ぐ。fab は Composer panel の外なので isOutside=true
  //   になり、open にできない事態を避ける。
  useEffect(() => {
    if (!open) return;
    if (sending) return;
    const isOutside = (target: EventTarget | null): boolean => {
      if (!(target instanceof Node)) return false;
      const panel = panelRef.current;
      if (!panel) return false;
      return !panel.contains(target);
    };
    const onPointer = (e: MouseEvent | TouchEvent) => {
      if (isOutside(e.target)) closePanel();
    };
    document.addEventListener("mousedown", onPointer);
    document.addEventListener("touchstart", onPointer);
    return () => {
      document.removeEventListener("mousedown", onPointer);
      document.removeEventListener("touchstart", onPointer);
    };
  }, [open, sending, closePanel]);

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
          class="room-composer-fab"
          title={fabTitle}
          aria-label={fabTitle}
          onClick={openPanel}
        >
          +
        </button>
      ) : null}
      <div
        ref={panelRef}
        class={"room-composer-panel" + (open ? "" : " room-composer-panel-hidden")}
        role="dialog"
        aria-label="composer"
        aria-hidden={open ? undefined : "true"}
      >
        <Composer
          room={room}
          mentionTo={mentionTo}
          focusOnOpen={openTicket}
          onSendingChange={setSending}
          onSent={closePanel}
        />
      </div>
    </>
  );
}
