// スマホ幅のサイドバー (overlay ドロワー) の寸法。描画から切り出してあるのは
// form-pane.ts と同じ理由 — 寸法の丸めと永続化をレンダラ無しで検証できるように
// (DR-0005 §1)。
import { readStorage, writeStorage } from "./storage.ts";
import { clampPanePx } from "./utils.ts";

export const DRAWER_WIDTH_KEY = "ccmsg.drawerWidth";
/** ドロワーの既定幅。画面のほとんどを覆いつつ、タブレット幅の端末で端から端まで
 * 伸びないように上限を置く。 */
export const DRAWER_DEFAULT_RATIO = 0.85;
export const DRAWER_DEFAULT_MAX_PX = 400;

export const SIDEBAR_LIST_HEIGHT_KEY = "ccmsg.sidebarListHeight";
/** フォームを開いている時の一覧側の既定の高さ。ドロワーの中はフォームが上・
 * 一覧が下の縦分割なので (kawaz r273 m26)、一覧は「今どのセッションを見ながら
 * 入力しているか」が分かる最小限だけ残す = 行が 2〜3 本見える高さ。
 *
 * 実測 (390x844): 一覧の上端から 1 行目までに 75px (padding + SESSIONS 見出し
 * + セクション見出し)、行のピッチが 59px。220px なら 2 行が収まり、3 行目が
 * 途中まで覗く (= まだ下に続くことも見える)。足りなければスプリッターを
 * 下げれば広がるし、邪魔なら潰しきれる。 */
export const SIDEBAR_LIST_DEFAULT_PX = 220;

/** 一覧の高さは `#form-pane` の幅とは別のキーに持つ。px 直値である点も、
 * 潰す / 広げるの操作も同じだが、測っているものが違う (あちらはフォームの
 * 幅、こちらはその下の一覧の高さ) ので、片方をドラッグしたらもう片方も
 * 動く、という結び付きは意図しない。 */
export function loadSidebarListHeight(): number {
  return clampSidebarListHeight(Number(readStorage(SIDEBAR_LIST_HEIGHT_KEY)) || Number.NaN);
}

/** 上限はドロワーの高さそのもの — フォームが完全に隠れるところまで広げられる
 * (横分割だった頃と同じ扱い)。`drawerPx` はドラッグ時のみ渡す。 */
export function clampSidebarListHeight(height: number, drawerPx?: number): number {
  return clampPanePx(height, SIDEBAR_LIST_DEFAULT_PX, drawerPx);
}

export function saveSidebarListHeight(height: number): void {
  writeStorage(SIDEBAR_LIST_HEIGHT_KEY, String(height));
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

/** ドロワーを開いたままにする経路上の id。ドロワー自身の中と、開閉を担う
 *  ハンバーガー (ここで閉じると同じ click が toggle を走らせて開き直す)。 */
const DRAWER_KEEP_OPEN_IDS: readonly string[] = ["sidebar", "menu-toggle"];

/** その click でドロワーを閉じるか。渡すのは `composedPath()` 上の id
 *  (App.tsx)。
 *
 *  「今どこにあるか」ではなく**押した瞬間の経路**で判定するのが要点:
 *  フォームの ✕ のように、その click の中で自分自身が unmount される要素だと、
 *  document に届く頃には DOM から外れていて `closest("#sidebar")` が届かない
 *  (実測: `isConnected: false` / `closest → null` なのに `composedPath` には
 *  `#sidebar` が残る)。経路で見れば、押した場所が消えた後でも分かる。 */
export function outsideClickClosesDrawer(pathIds: readonly string[]): boolean {
  return !pathIds.some((id) => DRAWER_KEEP_OPEN_IDS.includes(id));
}
