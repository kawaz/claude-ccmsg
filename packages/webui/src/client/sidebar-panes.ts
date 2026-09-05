// サイドバーの寸法 (一覧・フォーム・ドロワー) と、外側タップの判定。描画から
// 切り出してあるのは他の永続値と同じ理由 — 丸めと永続化をレンダラ無しで検証
// できるように (DR-0005 §1、session-creator.ts / files-view-store.ts と同じ
// 約束)。
//
// 寸法が 4 つあるのは、同じ 2 つのペイン (一覧とフォーム) が横に並ぶか縦に
// 積まれるかで測る軸が変わり、軸ごとに覚えておきたい値が違うため:
//
// | 値 | 何の寸法か | 動かす splitter |
// |---|---|---|
// | `sidebarWidth` | 横並びのときの一覧の幅 | `#sidebar-pane-splitter` |
// | `formWidth` | 横並びのときのフォームの幅 | `#sidebar-splitter` |
// | `listHeight` | 縦積みのときの一覧の高さ | `#sidebar-pane-splitter` |
// | `drawerWidth` | 縦積みのときのサイドバー全体の幅 | `#sidebar-splitter` |
//
// 1 本の splitter が軸によって別のキーを書くのは、測っているものが違うから:
// 横に広げた一覧の幅を、縦に積んだときの高さとして復元しても意味がない。
import { readStorage, writeStorage } from "./storage.ts";
import { clampPanePx } from "./utils.ts";

export const SIDEBAR_WIDTH_KEY = "ccmsg.sidebarWidth";
export const SIDEBAR_DEFAULT_PX = 280;

export const FORM_WIDTH_KEY = "ccmsg.formPaneWidth";
/** 確定した cwd の表示に 422px 要る (docs/findings/2026-08-12-form-ux-width-
 * survey.md) ので、既定はそれを満たす幅にする。 */
export const FORM_DEFAULT_PX = 460;

export const DRAWER_WIDTH_KEY = "ccmsg.drawerWidth";
/** ドロワーの既定幅。画面のほとんどを覆いつつ、タブレット幅の端末で端から端まで
 * 伸びないように上限を置く。 */
export const DRAWER_DEFAULT_RATIO = 0.85;
export const DRAWER_DEFAULT_MAX_PX = 400;

export const SIDEBAR_LIST_HEIGHT_KEY = "ccmsg.sidebarListHeight";
/** 縦積みのときの一覧側の既定の高さ。フォームが上・一覧が下なので
 * (kawaz r273 m26)、一覧は「今どのセッションを見ながら入力しているか」が
 * 分かる最小限だけ残す = 行が 2〜3 本見える高さ。
 *
 * 実測 (390x844): 一覧の上端から 1 行目までに 75px (padding + SESSIONS 見出し
 * + セクション見出し)、行のピッチが 59px。220px なら 2 行が収まり、3 行目が
 * 途中まで覗く (= まだ下に続くことも見える)。足りなければスプリッターを
 * 下げれば広がるし、邪魔なら潰しきれる。 */
export const SIDEBAR_LIST_DEFAULT_PX = 220;

/** 幅はどれも px 直値 (比率でないのは、フォームの必要幅がウィンドウ幅ではなく
 * 中身 — cwd の絶対パスや uuid — で決まるため)。下限・上限は共通で、隣が潰れる
 * 手前 (PANE_MIN_PX) まで動かせる。`availablePx` はドラッグ時のみ渡す。
 *
 * 復元時にコンテナ幅を渡さない (下限のみ効かせる) のは、ウィンドウを一時的に
 * 狭くしただけで記憶している値を書き換えてしまわないため。 */
export function clampSidebarWidth(width: number, availablePx?: number): number {
  return clampPanePx(width, SIDEBAR_DEFAULT_PX, availablePx);
}

export function loadSidebarWidth(): number {
  // 未保存 (null) と空文字はどちらも Number で 0 になる = 既定幅扱いにする。
  return clampSidebarWidth(Number(readStorage(SIDEBAR_WIDTH_KEY)) || Number.NaN);
}

export function saveSidebarWidth(width: number): void {
  writeStorage(SIDEBAR_WIDTH_KEY, String(width));
}

export function clampFormWidth(width: number, availablePx?: number): number {
  return clampPanePx(width, FORM_DEFAULT_PX, availablePx);
}

export function loadFormWidth(): number {
  return clampFormWidth(Number(readStorage(FORM_WIDTH_KEY)) || Number.NaN);
}

export function saveFormWidth(width: number): void {
  writeStorage(FORM_WIDTH_KEY, String(width));
}

/** 上限はサイドバーの高さそのもの — フォームが完全に隠れるところまで広げられる。
 * `drawerPx` はドラッグ時のみ渡す。 */
export function clampSidebarListHeight(height: number, drawerPx?: number): number {
  return clampPanePx(height, SIDEBAR_LIST_DEFAULT_PX, drawerPx);
}

export function loadSidebarListHeight(): number {
  return clampSidebarListHeight(Number(readStorage(SIDEBAR_LIST_HEIGHT_KEY)) || Number.NaN);
}

export function saveSidebarListHeight(height: number): void {
  writeStorage(SIDEBAR_LIST_HEIGHT_KEY, String(height));
}

export function defaultDrawerWidth(viewportPx: number): number {
  return Math.min(viewportPx * DRAWER_DEFAULT_RATIO, DRAWER_DEFAULT_MAX_PX);
}

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
