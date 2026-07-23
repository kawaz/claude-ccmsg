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
import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";

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
  /** viewport 左上の layout viewport 座標 (visual viewport が offset を持つ
   * ケースで使う、r46m52)。default 0。iOS でソフトウェアキーボードが出て
   * visualViewport.offsetTop > 0 の時、位置 (= layout 座標) を [vx, vx+vw-w]
   * の範囲に clamp することで、可視領域内 (キーボードの上) に収まる。 */
  vx?: number;
  vy?: number;
}

/** viewport 内に clamp。要素が viewport より大きい (w > vw 等) ケースでも
 * `Math.max(vx, ...)` で下限 vx に丸まる (viewport 外へ吸い込まれない)。 */
export function clampPosition(input: ClampInput): Position {
  const { x, y, w, h, vw, vh } = input;
  const vx = input.vx ?? 0;
  const vy = input.vy ?? 0;
  const maxX = Math.max(vx, vx + vw - w);
  const maxY = Math.max(vy, vy + vh - h);
  return {
    x: Math.max(vx, Math.min(maxX, x)),
    y: Math.max(vy, Math.min(maxY, y)),
  };
}

/** 現在の viewport 情報 (layout viewport 座標系での可視領域)。iOS で
 * ソフトウェアキーボードが出ている時、visualViewport は縮む/offset を
 * 持つが、`position: fixed` の座標系は layout viewport のままなので
 * 両者を区別して扱う必要がある (r46m52)。
 *
 * - `vw/vh`: 可視領域のサイズ (visualViewport.width/height、fallback:
 *   window.innerWidth/innerHeight)
 * - `vx/vy`: 可視領域左上の layout viewport 座標
 *   (visualViewport.offsetLeft/Top、fallback: 0)
 *
 * visualViewport 未対応環境 (古い browser / SSR / test) では層 viewport =
 * 可視領域として fallback するので、従来 (r46m51 以前) と同じ挙動になる。 */
export interface Viewport {
  vw: number;
  vh: number;
  vx: number;
  vy: number;
}
export function getViewport(): Viewport {
  if (typeof window === "undefined") return { vw: 0, vh: 0, vx: 0, vy: 0 };
  const vv = window.visualViewport;
  return {
    vw: vv?.width ?? window.innerWidth,
    vh: vv?.height ?? window.innerHeight,
    vx: vv?.offsetLeft ?? 0,
    vy: vv?.offsetTop ?? 0,
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
  /** 外部から位置を差し込む (FAB ↔ パネル間の位置連動同期用、r46m51)。
   * null を渡すと未移動状態に戻す (CSS 初期配置)。呼び出し側で clamp 済み
   * の値を渡す責務は呼び出し側にあるが、drag 中は onMove の clamp が優先。 */
  setPosition: (p: Position | null) => void;
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
    // r46m52 iOS visual viewport 対応: `getBoundingClientRect()` は visual
    // viewport 座標系 (キーボード表示時に offset を持つ) を返すが、position:
    // fixed の CSS 座標系 (= 我々が inline style で書き込む left/top) は
    // layout viewport 座標系。両者の差は `visualViewport.offsetLeft/Top`。
    // rect を layout 座標へ変換して origLeft/origTop に保存することで、
    // ドラッグ開始瞬間に offset 分ジャンプする現象を防ぐ。
    // ev.clientX/Y (pointer 座標) も visual 座標系だが、`dx = ev.clientX -
    // startX` の差分を取るため座標系変換は不要 (差分は座標系不変)。
    const vp = getViewport();
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = rect.left + vp.vx;
    const origTop = rect.top + vp.vy;
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
      // clamp は「今の可視領域内」に収める。キーボード表示中は visualViewport
      // が狭まって offset を持つので、その範囲内に収めれば要素はキーボードの
      // 上に留まる (r46m52)。ドラッグ中に viewport が変化することも想定して
      // move 毎に取得。
      const nowVp = getViewport();
      const next = clampPosition({
        x: origLeft + dx,
        y: origTop + dy,
        w: width,
        h: height,
        vw: nowVp.vw,
        vh: nowVp.vh,
        vx: nowVp.vx,
        vy: nowVp.vy,
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

  return { setElement, onPointerDown, position, setPosition, style };
}

/** anchor 要素の bottom-right 角に target の bottom-right 角を合わせるように
 * target の top-left 位置を計算する (viewport 内 clamp 付き)。FAB とパネルは
 * どちらも CSS 初期配置が右下寄せ (right/bottom) なので、bottom-right 角を
 * 揃えると「同じアンカー点にいる」感が最も自然に出る。r46m51:
 * FAB → パネル (パネルを FAB の近傍に開く) / パネル → FAB (パネルを閉じたら
 * 直前位置の近傍に FAB を戻す) の両方向で使う。 */
export interface AlignInput {
  anchor: { x: number; y: number; w: number; h: number };
  target: { w: number; h: number };
  /** viewport 情報。`vx/vy` (visual viewport offset) は省略時 0 で従来と同じ
   * 挙動。r46m52 対応の呼び出しは `getViewport()` の結果をそのまま渡す。 */
  viewport: { vw: number; vh: number; vx?: number; vy?: number };
}
export function alignBottomRight(input: AlignInput): Position {
  const { anchor, target, viewport } = input;
  const anchorRight = anchor.x + anchor.w;
  const anchorBottom = anchor.y + anchor.h;
  return clampPosition({
    x: anchorRight - target.w,
    y: anchorBottom - target.h,
    w: target.w,
    h: target.h,
    vw: viewport.vw,
    vh: viewport.vh,
    vx: viewport.vx ?? 0,
    vy: viewport.vy ?? 0,
  });
}

/** FAB とパネルの位置連動 (kawaz r46m51、2026-07-23): FAB を動かした後に
 * パネルを開くと FAB の近傍に、パネルを動かして閉じるとその近傍に FAB が
 * 戻る。両者の bottom-right 角を揃える (alignBottomRight) — CSS 初期配置が
 * 右下寄せなので視覚的アンカーとして自然。
 *
 * 「移動済み (position !== null)」時のみ相手を導出。未移動なら CSS 初期
 * 配置に任せる (同期しない)。従って初回開閉では何も起きない。
 *
 * サイズ計測は ref 経由 (`onFabRef` / `onPanelRef`)。RoomComposerFab では
 * パネルが常時 mount (display: none) で hidden 中は rect が 0 になるため、
 * 開閉遷移時に **再測定** する。 */
export interface UseFabPanelPositionLinkArgs {
  open: boolean;
  fabDrag: UseDraggableResult;
  panelDrag: UseDraggableResult;
}
export interface UseFabPanelPositionLinkResult {
  onFabRef: (el: HTMLElement | null) => void;
  onPanelRef: (el: HTMLElement | null) => void;
}
export function useFabPanelPositionLink(
  args: UseFabPanelPositionLinkArgs,
): UseFabPanelPositionLinkResult {
  const { open, fabDrag, panelDrag } = args;
  const fabElRef = useRef<HTMLElement | null>(null);
  const panelElRef = useRef<HTMLElement | null>(null);
  const fabSizeRef = useRef<{ w: number; h: number } | null>(null);
  const panelSizeRef = useRef<{ w: number; h: number } | null>(null);
  const prevOpenRef = useRef(open);

  const measure = (el: HTMLElement | null): { w: number; h: number } | null => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    // display: none や未 layout の要素は 0 になる — 使えない値として捨てる
    // (前回の有効値を残す)。
    if (r.width === 0 && r.height === 0) return null;
    return { w: r.width, h: r.height };
  };

  const onFabRef = useCallback(
    (el: HTMLElement | null) => {
      fabElRef.current = el;
      fabDrag.setElement(el);
      const s = measure(el);
      if (s) fabSizeRef.current = s;
    },
    [fabDrag.setElement],
  );

  const onPanelRef = useCallback(
    (el: HTMLElement | null) => {
      panelElRef.current = el;
      panelDrag.setElement(el);
      const s = measure(el);
      if (s) panelSizeRef.current = s;
    },
    [panelDrag.setElement],
  );

  // open 遷移時に位置同期。deps は [open] のみ — fabDrag/panelDrag object は
  // 毎 render で identity が変わる (useDraggable が新規 object を返す) が、
  // ここでは transition 時点の closure で捉えた値だけ使えれば十分。
  // stable な setPosition / 現在の position は closure 経由で最新を参照。
  useLayoutEffect(() => {
    const prev = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open === prev) return;
    const vp = getViewport();
    if (open) {
      // Opening: パネルが just mount / just show — 再測定してから同期。
      const s = measure(panelElRef.current);
      if (s) panelSizeRef.current = s;
      const fabPos = fabDrag.position;
      const fabSize = fabSizeRef.current;
      const panelSize = panelSizeRef.current;
      if (fabPos && fabSize && panelSize) {
        panelDrag.setPosition(
          alignBottomRight({
            anchor: { x: fabPos.x, y: fabPos.y, w: fabSize.w, h: fabSize.h },
            target: panelSize,
            viewport: vp,
          }),
        );
      }
    } else {
      // Closing: FAB が just re-mount / just show — 再測定してから同期。
      const s = measure(fabElRef.current);
      if (s) fabSizeRef.current = s;
      const panelPos = panelDrag.position;
      const fabSize = fabSizeRef.current;
      const panelSize = panelSizeRef.current;
      if (panelPos && fabSize && panelSize) {
        fabDrag.setPosition(
          alignBottomRight({
            anchor: { x: panelPos.x, y: panelPos.y, w: panelSize.w, h: panelSize.h },
            target: fabSize,
            viewport: vp,
          }),
        );
      }
    }
  }, [open]);

  return { onFabRef, onPanelRef };
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
