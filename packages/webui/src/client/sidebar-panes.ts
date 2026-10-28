// サイドバーの寸法 (一覧・フォーム・全体の幅)。描画から
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
// (`drawerWidth` のキー名は永続値なのでそのまま)
//
// 1 本の splitter が軸によって別のキーを書くのは、測っているものが違うから:
// 横に広げた一覧の幅を、縦に積んだときの高さとして復元しても意味がない。
//
// 4 つとも「レイアウト寸法」なので置き場は sessionStorage + localStorage の
// 2 段 (storage.ts の表)。窓ごとに独立して動かせて、次に開く窓は最後に使った
// 値で始まる。
import { parseWith } from "@ccmsg/protocol";
import * as v from "valibot";
import { numberText, readLayoutStorage, writeLayoutStorage } from "./storage.ts";
import { clampPanePx } from "./utils.ts";
import type { Locator } from "./locator.ts";

export const SIDEBAR_WIDTH_KEY = "ccmsg.sidebarWidth";
export const SIDEBAR_DEFAULT_PX = 280;

export const FORM_WIDTH_KEY = "ccmsg.formPaneWidth";
/** 確定した cwd の表示に 422px 要る (docs/findings/2026-08-12-form-ux-width-
 * survey.md) ので、既定はそれを満たす幅にする。 */
export const FORM_DEFAULT_PX = 460;

export const DRAWER_WIDTH_KEY = "ccmsg.drawerWidth";
/** 縦積みのときのサイドバーの既定幅。画面のほとんどを占めつつ、タブレット幅の
 * 端末で端から端まで伸びないように上限を置く。 */
export const DRAWER_DEFAULT_RATIO = 0.85;
export const DRAWER_DEFAULT_MAX_PX = 400;

export const SIDEBAR_LIST_HEIGHT_KEY = "ccmsg.sidebarListHeight";
/** 縦積みのときの一覧側の既定の高さ。フォームが上・一覧が下なので
 * (kawaz r273 m26)、一覧は「今どのセッションを見ながら入力しているか」が
 * 分かる最小限だけ残す = 行が 2〜3 本見える高さ。
 *
 * 実測 (390x844、DR-0043 の区画の列): 一覧の上端から 1 行目までに 71px
 * (padding + SESSIONS 見出し + セクション見出し)、行のピッチが 59px、
 * SESSIONS の本体の下に ROOMS と GLOBALS の見出しと段の余白で 80px。292px
 * なら 2 行が収まり、3 行目が途中まで覗く (= まだ下に続くことも見える)。
 * 足りなければスプリッターを下げれば広がるし、邪魔なら潰しきれる。 */
export const SIDEBAR_LIST_DEFAULT_PX = 292;

/** 幅はどれも px 直値 (比率でないのは、フォームの必要幅がウィンドウ幅ではなく
 * 中身 — cwd の絶対パスや uuid — で決まるため)。下限・上限は共通で、隣が潰れる
 * 手前 (PANE_MIN_PX) まで動かせる。`availablePx` はドラッグ時のみ渡す。
 *
 * 復元時にコンテナ幅を渡さない (下限のみ効かせる) のは、ウィンドウを一時的に
 * 狭くしただけで記憶している値を書き換えてしまわないため。 */
export function clampSidebarWidth(width: number, availablePx?: number): number {
  return clampPanePx(width, SIDEBAR_DEFAULT_PX, availablePx);
}

/** A px size as `writeLayoutStorage` stores it, `defaultPx` when nothing is
 * stored. */
function storedPx(defaultPx: number) {
  const schema = v.optional(v.number(), defaultPx);
  return { schema, text: numberText(schema) };
}

/** The px size stored at `key`: the default when nothing is stored or what
 * is stored is not a number. Held to its range by the caller. */
function loadPx(key: string, stored: ReturnType<typeof storedPx>): number {
  const raw = readLayoutStorage(key);
  const read = raw === null ? null : parseWith(stored.text, raw);
  return read?.ok ? read.value : v.getDefault(stored.schema);
}

const SIDEBAR_WIDTH = storedPx(SIDEBAR_DEFAULT_PX);
const FORM_WIDTH = storedPx(FORM_DEFAULT_PX);
const SIDEBAR_LIST_HEIGHT = storedPx(SIDEBAR_LIST_DEFAULT_PX);

export function loadSidebarWidth(): number {
  return clampSidebarWidth(loadPx(SIDEBAR_WIDTH_KEY, SIDEBAR_WIDTH));
}

export function saveSidebarWidth(width: number): void {
  writeLayoutStorage(SIDEBAR_WIDTH_KEY, String(width));
}

export function clampFormWidth(width: number, availablePx?: number): number {
  return clampPanePx(width, FORM_DEFAULT_PX, availablePx);
}

export function loadFormWidth(): number {
  return clampFormWidth(loadPx(FORM_WIDTH_KEY, FORM_WIDTH));
}

export function saveFormWidth(width: number): void {
  writeLayoutStorage(FORM_WIDTH_KEY, String(width));
}

/** 上限はサイドバーの高さそのもの — フォームが完全に隠れるところまで広げられる。
 * `sidebarPx` はドラッグ時のみ渡す。 */
export function clampSidebarListHeight(height: number, sidebarPx?: number): number {
  return clampPanePx(height, SIDEBAR_LIST_DEFAULT_PX, sidebarPx);
}

export function loadSidebarListHeight(): number {
  return clampSidebarListHeight(loadPx(SIDEBAR_LIST_HEIGHT_KEY, SIDEBAR_LIST_HEIGHT));
}

export function saveSidebarListHeight(height: number): void {
  writeLayoutStorage(SIDEBAR_LIST_HEIGHT_KEY, String(height));
}

export function defaultDrawerWidth(viewportPx: number): number {
  return Math.min(viewportPx * DRAWER_DEFAULT_RATIO, DRAWER_DEFAULT_MAX_PX);
}

/** The drawer's stored width. Its default depends on the viewport, so it is
 * not the schema's: nothing stored, or what is stored not a number, is the
 * default for this viewport. */
const DrawerWidthTextSchema = numberText(v.number());

export function loadDrawerWidth(viewportPx: number): number {
  const raw = readLayoutStorage(DRAWER_WIDTH_KEY);
  const read = raw === null ? null : parseWith(DrawerWidthTextSchema, raw);
  const fallback = defaultDrawerWidth(viewportPx);
  return read?.ok ? clampPanePx(read.value, fallback) : fallback;
}

export function saveDrawerWidth(width: number): void {
  writeLayoutStorage(DRAWER_WIDTH_KEY, String(width));
}

/** サイドバーの右端は画面の右端まで動かせるが、本文が完全に画面外へ出ると
 * 横スクロールで戻すしかなくなるので、他のペインと同じく PANE_MIN_PX だけ
 * 画面に残す。 */
export function clampDrawerWidth(width: number, viewportPx: number): number {
  return clampPanePx(width, defaultDrawerWidth(viewportPx), viewportPx);
}

/** 横に並びきらない幅では、サイドバーと本文は Layout の横スクロールで
 * 行き来する (app.css の scroll-snap)。ハンバーガーはその 2 つのスナップ点を
 * 往復する切り替えになる — 「今どちら側に居るか」で行き先が決まる。
 *
 * `maxScrollPx` (= `scrollWidth - clientWidth`) をサイドバー幅の代わりに使う。
 * 本文は Layout の幅ちょうどを占めるので、この 2 つは同じ値になる — そして
 * スプリッターでサイドバー幅が変わっても測り直しが要らない。
 *
 * 半分を境にするので、指を離した位置がどちらつかずでも必ずどちらかへ動く
 * (押しても何も起きないように見える状態を作らない)。 */
export function nextSidebarSnapLeft(scrollLeft: number, maxScrollPx: number): number {
  if (!(maxScrollPx > 0)) return 0;
  return scrollLeft < maxScrollPx / 2 ? maxScrollPx : 0;
}

/** 窓を開いた直後にどちらを見せるか。見る対象 (セッション / ルーム) を URL が
 * 名指しているなら、その本文を見に来たということなので本文側から始める。
 * 名指していない (一覧だけの URL) なら、次に何を開くかを選ぶところから
 * 始まるので一覧側。
 *
 * 判断を store の state ではなく locator から取るのは、`/s/<sid>` (一覧の
 * リンク先) が store 上ではまだ何も選んでいない状態を経由するため — 開いた
 * 瞬間に見れば URL だけが「何を見に来たか」を知っている。 */
export function opensOnMain(locator: Locator): boolean {
  switch (locator.view) {
    case "session":
    case "timeline":
    case "session-root":
      return true;
    case "room":
      return locator.room !== null;
    default:
      return false;
  }
}
