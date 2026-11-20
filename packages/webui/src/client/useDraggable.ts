// Floating element の D&D 移動 (kawaz r46 m44、2026-07-23): SessionInputComposer /
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
//   - 要素の置き場 (position: fixed の基準の箱 = #app、ソフトウェアキーボードが
//     出ている間は見える範囲に縮む。visible-area.ts) の中に収まるよう
//     [0, 箱の幅 - w] / [0, 箱の高さ - h] に clamp。size 0 や箱より大きい要素
//     でも下限 0 に丸まって安全。
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
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { useEffectEvent } from "./useEffectEvent.ts";

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
  /** 収める範囲の左上 (位置と同じ座標)。default 0。 */
  vx?: number;
  vy?: number;
}

/** 範囲 (左上 vx/vy、大きさ vw/vh) の中に clamp。要素が範囲より大きい
 * (w > vw 等) ケースでも `Math.max(vx, ...)` で下限 vx に丸まる (範囲の外へ
 * 吸い込まれない)。 */
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

/** position: fixed の要素の今の位置 (inline style の left/top と同じ、置き場の
 * 箱の左上からの距離) と、置き場の箱 (fixed の基準: #app、無ければ viewport)
 * の大きさ。 */
interface Placement {
  x: number;
  y: number;
  boxWidth: number;
  boxHeight: number;
}

function px(value: string): number {
  const n = Number.parseFloat(value);
  return Number.isFinite(n) ? n : 0;
}

/** `el` の offsetParent (fixed の基準の祖先)。無い・持たない実装 (happy-dom は
 * undefined) では null。 */
function boxOf(el: HTMLElement): Element | null {
  const box = el.offsetParent;
  return box instanceof Element ? box : null;
}

/** `el` (position: fixed) の配置を、`el` と置き場の箱の client rect の差で
 * 読む。箱は `el.offsetParent`: fixed の要素では、fixed の基準になる祖先
 * (contain: layout の #app) があればそれ、無ければ null (viewport)。fixed の
 * 基準は箱の padding box なので、箱の border の分を除く。同じ座標系の rect
 * どうしの差なので、client rect の座標系 (iOS でキーボードが出ている時に
 * layout viewport か visual viewport か) に左右されない。viewport が基準の
 * 時は viewport の左上を client 座標の原点とみなす。 */
function placementOf(el: HTMLElement): Placement {
  const rect = el.getBoundingClientRect();
  const box = boxOf(el);
  if (box === null) {
    return {
      x: rect.left,
      y: rect.top,
      boxWidth: window.innerWidth,
      boxHeight: window.innerHeight,
    };
  }
  const b = box.getBoundingClientRect();
  const cs = getComputedStyle(box);
  const left = b.left + px(cs.borderLeftWidth);
  const top = b.top + px(cs.borderTopWidth);
  return {
    x: rect.left - left,
    y: rect.top - top,
    boxWidth: b.width - px(cs.borderLeftWidth) - px(cs.borderRightWidth),
    boxHeight: b.height - px(cs.borderTopWidth) - px(cs.borderBottomWidth),
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
  // 写すのは commit 後 (render 中に ref を書かない)。読むのは pointer の
  // handler だけなので、常に commit 済みの最新が見える。
  const handleFilterRef = useRef(handleFilter);
  useLayoutEffect(() => {
    handleFilterRef.current = handleFilter;
  });

  const setElement = useCallback((el: HTMLElement | null) => {
    elRef.current = el;
  }, []);

  // 動かした後に置き場の箱が縮んだら (ソフトウェアキーボードが出て #app が
  // 見える範囲に縮む、窓が小さくなる)、位置を箱の中へ寄せ直す。寄せ直さないと
  // 動かしたパネルが箱の外 (キーボードの下) に残る。CSS の right/bottom で
  // 置かれている間 (未移動) は箱に付いて動くので要らない。箱は fixed の
  // 要素の offsetParent (#app のような基準の祖先。基準が viewport なら null で、
  // その時は窓の resize で見る)。
  const moved = position !== null;
  useEffect(() => {
    const el = elRef.current;
    if (!moved || el === null) return;
    const keepInside = () => {
      const now = elRef.current;
      if (now === null || now.getClientRects().length === 0) return;
      const placed = placementOf(now);
      const rect = now.getBoundingClientRect();
      const next = clampPosition({
        x: placed.x,
        y: placed.y,
        w: rect.width,
        h: rect.height,
        vw: placed.boxWidth,
        vh: placed.boxHeight,
      });
      if (Math.abs(next.x - placed.x) >= 0.5 || Math.abs(next.y - placed.y) >= 0.5) {
        setPosition(next);
      }
    };
    const box = boxOf(el);
    if (box === null) {
      window.addEventListener("resize", keepInside);
      return () => window.removeEventListener("resize", keepInside);
    }
    const observer = new ResizeObserver(keepInside);
    observer.observe(box);
    return () => observer.disconnect();
  }, [moved]);

  const onPointerDown = useCallback((e: PointerEvent) => {
    // 左ボタン (primary) のみ。右クリック / middle click のドラッグは開始しない。
    if (e.button !== 0) return;
    const filter = handleFilterRef.current;
    if (filter && !filter(e.target)) return;
    const el = elRef.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    // 位置 (inline style の left/top) は置き場の箱の左上から測るので、始点も
    // 箱からの距離で読む (要素の client rect をそのまま使うと、箱が画面の
    // 左上に無い時にドラッグ開始の瞬間その分ジャンプする)。ev.clientX/Y は
    // `dx = ev.clientX - startX` の差分しか使わないので座標系に依らない。
    const origin = placementOf(el);
    const startX = e.clientX;
    const startY = e.clientY;
    const origLeft = origin.x;
    const origTop = origin.y;
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
      // clamp は今の置き場の箱の中に収める。キーボード表示中は箱 (#app) が
      // 見える範囲に縮むので、要素はキーボードの上に留まる。ドラッグ中に
      // 箱が変わることも想定して move 毎に測る。
      const now = placementOf(el);
      const next = clampPosition({
        x: origLeft + dx,
        y: origTop + dy,
        w: width,
        h: height,
        vw: now.boxWidth,
        vh: now.boxHeight,
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
  /** 収める範囲 (位置と同じ座標)。`vx/vy` は省略時 0。 */
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

  const setFabElement = fabDrag.setElement;
  const setPanelElement = panelDrag.setElement;
  const onFabRef = useCallback(
    (el: HTMLElement | null) => {
      fabElRef.current = el;
      setFabElement(el);
      const s = measure(el);
      if (s) fabSizeRef.current = s;
    },
    [setFabElement],
  );

  const onPanelRef = useCallback(
    (el: HTMLElement | null) => {
      panelElRef.current = el;
      setPanelElement(el);
      const s = measure(el);
      if (s) panelSizeRef.current = s;
    },
    [setPanelElement],
  );

  // open 遷移時に位置同期。反応するのは open の変化だけで、その時点の
  // fabDrag / panelDrag の位置を読む部分は Effect Event に置く (両 object は
  // useDraggable が毎 render 作り直すので、反応させると毎 render 走る)。
  const alignOnToggle = useEffectEvent((opened: boolean) => {
    // 収める範囲は FAB とパネルが共に置かれている箱 (#app)。今見えている方
    // (開いた時はパネル、閉じた時は FAB) から測る。
    // 描画されていない (display: none) 時は箱を測れないので合わせない。
    const shown = opened ? panelElRef.current : fabElRef.current;
    if (shown === null || shown.getClientRects().length === 0) return;
    const placed = placementOf(shown);
    const vp = { vw: placed.boxWidth, vh: placed.boxHeight };
    if (opened) {
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
  });
  useLayoutEffect(() => {
    const prev = prevOpenRef.current;
    prevOpenRef.current = open;
    if (open === prev) return;
    alignOnToggle(open);
  }, [open]);

  return { onFabRef, onPanelRef };
}

/** `closest` を持つ target か (isPanelDragHandle の duck typing)。 */
function hasClosest(
  target: EventTarget,
): target is EventTarget & { closest(sel: string): unknown } {
  return "closest" in target && typeof target.closest === "function";
}

/** panel 側で使う handleFilter: textarea / input / button / select / a /
 * contenteditable と、自分のドラッグを持つ separator (入力欄の左上のつまみ)
 * のいずれかに含まれる target は drag を開始しない。パネルの余白・ヘッダ・
 * ラベル領域は許可される。 */
export function isPanelDragHandle(target: EventTarget | null): boolean {
  // DOM の Element type 参照を避けて duck typing (`closest` メソッドの有無)。
  // ブラウザ以外のテスト環境 (bun/node) で Element が未定義でも参照エラーに
  // ならないようにするための予防。closest を持たない target (Text / Window
  // / null) は handle 対象外 (false)。
  if (!target || !hasClosest(target)) return false;
  if (
    target.closest(
      'textarea, input, button, select, a, [contenteditable="true"], [role="separator"]',
    )
  ) {
    return false;
  }
  return true;
}
