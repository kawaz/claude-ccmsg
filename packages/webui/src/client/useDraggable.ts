// Floating element の D&D 移動 (kawaz r46 m44、2026-07-23): OneOnOneComposer /
// RoomComposerFab の FAB とパネルを自由配置できるようにする。位置は
// **永続化しない** (kawaz 明言「リロードしたら初期位置に戻ってくれて良い」)。
//
// クリック vs ドラッグ判別:
//   - pointerdown から総移動量が DRAG_THRESHOLD_PX 未満で pointerup したら
//     クリック扱い (element の onClick はそのまま発火)
//   - 閾値を超えて動いたら drag モードに入り、pointerup 後の click イベントを
//     capture-phase で 1 度だけ抑止 (FAB の場合 open/close トグル暴発防止)
//
// clamp:
//   - viewport 内に収まるよう [0, innerWidth - w] / [0, innerHeight - h] に
//     clamp。size 0 や viewport より大きい要素でも下限 0 に丸まって安全。
//
// ハンドル領域:
//   - `handleFilter` を渡すと、pointerdown target が該当条件を満たさない時
//     dragging を開始しない。パネル側は textarea / button / input などの
//     form control 上からのドラッグを禁止するのに使う (input 選択・text選択
//     ジェスチャと衝突しないため)。
//
// iframe 対策 (kawaz r46m45、2026-07-23):
//   - Terminal タブの iframe 上を pointer が横切ると、pointer events が iframe
//     内 document に持っていかれて親 window の pointermove/up が途切れる。
//     setPointerCapture(pointerId) で pointerdown した element に pointer を
//     固定すると、iframe 越しでも pointermove / pointerup が届き続ける。
//     touch drag でも同じ問題 (Safari の implicit capture は要素境界で外れる
//     ことがある) なので明示 capture が確実。listener は element に直接張る
//     (window listener は capture 中の event 経路にも入るが、element 経由の
//     方が capture の意味が明確)。
import { useCallback, useRef, useState } from "preact/hooks";

export const DRAG_THRESHOLD_PX = 5;

export interface Position {
  x: number;
  y: number;
}

export interface ClampInput {
  x: number;
  y: number;
  w: number;
  h: number;
  vw: number;
  vh: number;
}

/** viewport 内に clamp。要素が viewport より大きい (w > vw 等) ケースでも
 * `Math.max(0, ...)` で下限 0 に丸まる (負の座標へ吸い込まれない)。 */
export function clampPosition(input: ClampInput): Position {
  const { x, y, w, h, vw, vh } = input;
  const maxX = Math.max(0, vw - w);
  const maxY = Math.max(0, vh - h);
  return {
    x: Math.max(0, Math.min(maxX, x)),
    y: Math.max(0, Math.min(maxY, y)),
  };
}

export interface UseDraggableOptions {
  /** pointerdown target がドラッグハンドルとして許可されるか判定。false を
   * 返すと onPointerDown は何もしない (element の通常イベントに委ねる)。
   * 省略時は要素全体がハンドル。 */
  handleFilter?: (target: EventTarget | null) => boolean;
}

export interface UseDraggableResult {
  /** 対象要素に付ける ref。DOM 参照は clamp 時の element size 取得に使う。 */
  setElement: (el: HTMLElement | null) => void;
  /** 要素の onPointerDown に配線。 */
  onPointerDown: (e: PointerEvent) => void;
  /** 現在位置。null = 未移動 (元の CSS 位置を使う)。 */
  position: Position | null;
  /** position を inline style に変換したもの。null の間は undefined で、
   * CSS の right/bottom による初期配置がそのまま生きる。移動後は
   * left/top で置き、right/bottom は auto で打ち消す。 */
  style: Record<string, string> | undefined;
}

export function useDraggable(options: UseDraggableOptions = {}): UseDraggableResult {
  const { handleFilter } = options;
  const [position, setPosition] = useState<Position | null>(null);
  const elRef = useRef<HTMLElement | null>(null);
  // handleFilter は inline 関数で渡されうる。ref 経由で最新参照して
  // onPointerDown の identity は安定させる (useFabPopup の onCloseRef と同型)。
  const handleFilterRef = useRef(handleFilter);
  handleFilterRef.current = handleFilter;

  const setElement = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  const onPointerDown = useCallback((e: PointerEvent) => {
    // 左ボタン (primary) のみ。右クリック / middle click のドラッグは開始しない。
    if (e.button !== 0) return;
    const filter = handleFilterRef.current;
    if (filter && !filter(e.target)) return;
    const el = elRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = rect.left;
    const origTop = rect.top;
    const width = rect.width;
    const height = rect.height;
    const pointerId = e.pointerId;
    let dragging = false;

    // Terminal タブの iframe 上を pointer が通っても move/up が途切れないよう
    // 明示 capture (kawaz r46m45)。pointerdown 時点で即掴む — 閾値未満で終わる
    // 通常 click でも capture は click 発火を妨げない (releasePointerCapture
    // は pointerup 時に自動発火するが、safety のため onUp でも明示解放)。
    try {
      el.setPointerCapture(pointerId);
    } catch {
      // pointerId が既に無効化されている等の稀ケースは無視 (capture 無しで
      // fallback 動作、iframe を跨がない normal 領域では従来通り動く)。
    }

    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;
      if (!dragging) {
        if (Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
        dragging = true;
      }
      const next = clampPosition({
        x: origLeft + dx,
        y: origTop + dy,
        w: width,
        h: height,
        vw: window.innerWidth,
        vh: window.innerHeight,
      });
      setPosition(next);
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      el.removeEventListener("pointermove", onMove);
      el.removeEventListener("pointerup", onUp);
      el.removeEventListener("pointercancel", onUp);
      try {
        el.releasePointerCapture(pointerId);
      } catch {
        // 既に自動解放済みの場合など。
      }
      if (dragging) {
        // ドラッグ完了時、直後に発火する click イベント (FAB の onClick に
        // つながる) を 1 度だけ抑止する。open トグルの暴発防止 + useFabPopup
        // の外側 click 判定が誤発火するのも防ぐ。
        const suppress = (ce: MouseEvent) => {
          ce.stopPropagation();
          ce.preventDefault();
          window.removeEventListener("click", suppress, true);
        };
        window.addEventListener("click", suppress, true);
        // フェイルセーフ: click が発火しなかった場合 (pointerup が要素外で
        // 起きて click が合成されないケース) に listener を残さない。
        // setTimeout で pointerup と click の task 順序を跨いでから撤収する
        // (microtask だと click task の前に走って本命を撤収してしまう)。
        setTimeout(() => {
          window.removeEventListener("click", suppress, true);
        }, 0);
      }
    };
    el.addEventListener("pointermove", onMove);
    el.addEventListener("pointerup", onUp);
    el.addEventListener("pointercancel", onUp);
  }, []);

  const style: Record<string, string> | undefined = position
    ? {
        left: `${position.x}px`,
        top: `${position.y}px`,
        right: "auto",
        bottom: "auto",
      }
    : undefined;

  return { setElement, onPointerDown, position, style };
}

/** panel 側で使う handleFilter: textarea / input / button / select / a /
 * contenteditable のいずれかに含まれる target は drag を開始しない。パネル
 * の余白・ヘッダ・ラベル領域は許可される。 */
export function isPanelDragHandle(target: EventTarget | null): boolean {
  // DOM の Element type 参照を避けて duck typing (`closest` メソッドの有無)。
  // ブラウザ以外のテスト環境 (bun/node) で Element が未定義でも参照エラーに
  // ならないようにするための予防。closest を持たない target (Text / Window
  // / null) は handle 対象外 (false)。
  if (!target || typeof (target as { closest?: unknown }).closest !== "function") {
    return false;
  }
  const el = target as unknown as { closest: (sel: string) => Element | null };
  if (el.closest('textarea, input, button, select, a, [contenteditable="true"]')) {
    return false;
  }
  return true;
}
