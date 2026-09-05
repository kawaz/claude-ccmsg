// スマホ幅のサイドバー (overlay ドロワー) の寸法と、外側タップの判定。
// 描画から切り出してあるのは form-pane.ts と同じ理由 — 幅の丸めと永続化を
// レンダラ無しで検証できるように (DR-0005 §1)。
import { readStorage, writeStorage } from "./storage.ts";
import { clampPanePx } from "./utils.ts";

export const DRAWER_WIDTH_KEY = "ccmsg.drawerWidth";
/** ドロワーの既定幅。画面のほとんどを覆いつつ、タブレット幅の端末で端から端まで
 * 伸びないように上限を置く。 */
export const DRAWER_DEFAULT_RATIO = 0.85;
export const DRAWER_DEFAULT_MAX_PX = 400;

export const SIDEBAR_LIST_WIDTH_KEY = "ccmsg.sidebarListWidth";
/** フォームを開いている時の一覧側の既定幅 (kawaz r273 m13: 「セッションリスト
 * 側のデフォルト幅は 2,3 文字程度まで狭くて構わない」)。左右 padding
 * (var(--space-8) = 0.5rem ずつ) を引いて中身 24px ≒ 2〜3 文字分。読みたく
 * なったらスプリッターで広げられるし、邪魔なら潰しきれる。 */
export const SIDEBAR_LIST_DEFAULT_PX = 40;

/** 一覧幅は `#form-pane` の幅とは別のキーに持つ。px 直値である点も、潰す /
 * 広げるの操作も同じだが、測っているものが違う (あちらはフォームの幅、
 * こちらはその隣の一覧の幅) ので、片方をドラッグしたらもう片方も動く、
 * という結び付きは意図しない。 */
export function loadSidebarListWidth(): number {
  return clampSidebarListWidth(Number(readStorage(SIDEBAR_LIST_WIDTH_KEY)) || Number.NaN);
}

/** 上限はドロワー幅そのもの — フォームが完全に隠れるところまで広げられる
 * (kawaz r273 m13)。`drawerPx` はドラッグ時のみ渡す。 */
export function clampSidebarListWidth(width: number, drawerPx?: number): number {
  return clampPanePx(width, SIDEBAR_LIST_DEFAULT_PX, drawerPx);
}

export function saveSidebarListWidth(width: number): void {
  writeStorage(SIDEBAR_LIST_WIDTH_KEY, String(width));
}

export function defaultDrawerWidth(viewportPx: number): number {
  return Math.min(viewportPx * DRAWER_DEFAULT_RATIO, DRAWER_DEFAULT_MAX_PX);
}

/** 復元時にコンテナ幅を渡さないのは #sidebar / #form-pane と同じ — ウィンドウ
 * を一時的に狭くしただけで記憶している幅を書き換えないため。 */
export function loadDrawerWidth(viewportPx: number): number {
  return clampPanePx(
    Number(readStorage(DRAWER_WIDTH_KEY)) || Number.NaN,
    defaultDrawerWidth(viewportPx),
  );
}

export function saveDrawerWidth(width: number): void {
  writeStorage(DRAWER_WIDTH_KEY, String(width));
}

/** ドロワーの右端は画面の右端まで動かせるが、`main` が完全に隠れると
 * 「右で本文を見ながら操作する」ができなくなるので、他のペインと同じく
 * PANE_MIN_PX だけ残す。 */
export function clampDrawerWidth(width: number, viewportPx: number): number {
  return clampPanePx(width, defaultDrawerWidth(viewportPx), viewportPx);
}
