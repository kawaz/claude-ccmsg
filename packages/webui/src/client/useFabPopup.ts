// FAB + floating popup panel の共通配管 (webui simplify componentization、
// issue 2026-07-17)。RoomComposerFab.tsx と OneOnOneComposer.tsx が同一の
// open state / openTicket カウンタ / 「open 中 (かつ blocked でない) だけ
// document click で外側クリック close」パターンを重複させていた
// (OneOnOneComposer 側コメントで「RoomComposerFab と同じ pattern」と明記
// 済み)。見た目 (fab button / panel markup) は各所で構造が違う (RoomComposerFab
// は Composer 委譲、OneOnOneComposer は独自 form) ので統合しない — ここは
// state + イベント配管だけを担う。
//
// `useDismissOnOutsidePointer` (RoomTitle のインライン編集等) とは別物:
// あちらは pointerdown/up + 移動量閾値で判定するタッチ耐性 dismiss、
// こちらは click 単発判定 — 各所のコメントに残る意図的な選択で、
// イベントモデル自体が異なるため統合しない。
import { useCallback, useEffect, useRef, useState } from "preact/hooks";

export interface FabPopup {
  open: boolean;
  /** fab クリックのたびにインクリメントされるカウンタ。0 は「まだ開かれて
   * いない」sentinel。Composer への focusOnOpen 伝搬に使う (RoomComposerFab)。
   * 使わない呼び出し側は無視してよい。 */
  openTicket: number;
  openPanel: () => void;
  closePanel: () => void;
  /** パネル DOM に付ける ref。外側クリック判定の contains() チェック対象。 */
  panelRef: { current: HTMLDivElement | null };
}

/** `blocked` が true の間は外側クリック listener を張らない (post 送信中の
 * 誤操作による中断を避ける用途、RoomComposerFab の sending ガード)。常時
 * listener で構わない呼び出し側は `false` を渡す (OneOnOneComposer は元々
 * sending ガードを持たなかった — 挙動不変のためここも false 固定)。
 *
 * `onClose` は close (外側クリック / 明示 close 呼び出しの両方) のたびに
 * 呼ばれる — OneOnOneComposer の handleClose が close と同時に
 * `setError(null)` していた副作用を、close 経路を一本化した後も保つため。 */
export function useFabPopup(blocked: boolean, onClose?: () => void): FabPopup {
  const [open, setOpen] = useState(false);
  const [openTicket, setOpenTicket] = useState(0);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // onClose はインライン関数で渡されうる (OneOnOneComposer の
  // `() => setError(null)`) — deps に直接入れると closePanel の identity が
  // 毎 render 変わり、外側クリック listener の effect / 呼び出し側の
  // useCallback deps 連鎖を毎 render 無効化してしまう。ref 経由で最新を
  // 参照し、closePanel は安定 identity を保つ (抽出前の handleClose /
  // closePanel が useCallback([]) 安定だった性質の維持)。
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  const openPanel = useCallback(() => {
    setOpen(true);
    setOpenTicket((n) => n + 1);
  }, []);

  const closePanel = useCallback(() => {
    setOpen(false);
    onCloseRef.current?.();
  }, []);

  // フォーム外の **click** で閉じる (kawaz r17 mid=8,10,11、2026-07-14)。
  // mousedown/touchstart 判定はスクロール目的のタッチ (指を置いた瞬間) でも
  // 閉じてしまい不便なので不可 — click は tap 完了 (押して離す) でだけ発火し、
  // スクロール gesture では発火しない。kawaz 明言「フォーム関連要素以外の
  // click イベントで閉じて」。open 中だけ listener を張る (閉じてる間は
  // 無駄 listener を避ける)。`open === false` の間 (fab 表示中) に張らない
  // ことは fab クリック自体を閉じ扱いする事故の防止でもある (open にした
  // click は listener 登録 (re-render 後) より前のイベントなので二重発火も
  // しない)。
  //
  // kawaz r46 mid=39 (2026-07-23): capture-phase pointerdown で「押した瞬間」
  // に panel 内かを ref に記録し、click 時にその記録を優先する。
  // Why: 添付ピルの × を押すと React が該当 `<li>` を DOM から即除去する
  // ため、click イベントが document に来た時点で `e.target` (= × ボタン)
  // は既に panel 外にある。素の `panel.contains(e.target)` はそれを「外側
  // クリック」と誤判定して composer を閉じてしまう (r46m39 バグ)。
  // pointerdown は capture phase なら React の render/removal より前に走る
  // ため、その瞬間の内外判定が信頼できる。close は依然 click でだけ判定
  // するので、スクロール gesture (pointerdown → 移動 → pointerup → click
  // 発火せず) では close されない ─ 元の click 単発判定の安全性は維持。
  useEffect(() => {
    if (!open) return;
    if (blocked) return;
    // pointerdown 時点で panel 内だったかどうか。click 時に target が DOM
    // から外れていても、押した瞬間が内側なら内側クリックとして扱う。
    let pressedInside = false;
    const onPointerDown = (e: PointerEvent) => {
      const panel = panelRef.current;
      pressedInside = !!(panel && e.target instanceof Node && panel.contains(e.target));
    };
    const onClick = (e: MouseEvent) => {
      if (pressedInside) {
        pressedInside = false;
        return;
      }
      const panel = panelRef.current;
      if (!panel || !(e.target instanceof Node)) return;
      if (!panel.contains(e.target)) closePanel();
    };
    // kawaz r46m53 (2026-07-23): listener 装着は次 macrotask に defer する。
    // 理由: FAB クリックで open=true になった直後、Preact が commit 途中で
    // useEffect を同期実行するケースがある (r46m51 の useFabPanelPositionLink
    // で useLayoutEffect が panelDrag.setPosition を呼び、その付随で
    // useEffect flush が誘発される)。すると **同じ click イベントの bubbling
    // 継続中に** document click listener が装着され、target=FAB
    // (panel 外) を「外側クリック」と誤判定して開いたばかりの panel を
    // 即閉じてしまう (v0.72.9 リグレッション: FAB がドラッグ位置で残り、
    // panel 側は position 適用済みだが display:none のまま = 開かない症状)。
    // setTimeout(0) で macrotask 境界まで待てば、開閉トリガー click は完全に
    // 過ぎ去ったあとに listener が張られる (通常の click 判定は不変、
    // r17 のスクロール誤 close 回避も維持)。
    let attached = false;
    const timer = setTimeout(() => {
      document.addEventListener("pointerdown", onPointerDown, true);
      document.addEventListener("click", onClick);
      attached = true;
    }, 0);
    return () => {
      clearTimeout(timer);
      if (attached) {
        document.removeEventListener("pointerdown", onPointerDown, true);
        document.removeEventListener("click", onClick);
      }
    };
  }, [open, blocked, closePanel]);

  return { open, openTicket, openPanel, closePanel, panelRef };
}
