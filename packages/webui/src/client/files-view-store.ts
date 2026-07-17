// Files タブの表示状態 (選択ファイル + FileViewer の markdown モード) の per-sid
// 永続化 (kawaz r17 mid=5、2026-07-14 初版; r26 mid=112、2026-07-17 で意味論拡張)。
//
// 初版は「そのファイルを preview で見ていた瞬間だけ preview を復元する」= record
// の `viewMode` を per-path 情報として扱っていた。実運用では A(preview) → B → A
// のように別ファイルを一度でも挟むと B 選択時に record が {B, code} で上書きされ、
// A に戻ったとき saved.path !== A で復元経路を外れる (kawaz の「タブ切り替えの
// たびにコードビューへ戻る」感覚の真因)。
//
// r26 mid=112 以降は `viewMode` を **per-sid の markdown モードの last choice**
// として扱う (path は依然 selectedPath 復元用 = SessionView が使う)。restore は
// saved.path === path の一致ではなく isMarkdownPath(path) 判定で行い、markdown を
// 開くたびに「そのセッションで最後に確定した markdown モード」を再現する。非
// markdown ファイル選択では `viewMode` を上書きせず継承する (= 途中で .ts を
// 見ても markdown モードの記憶を失わない、resolveFilesViewSave の役割)。
//
// 1on1 draft (OneOnOneComposer) と同じ保存・削除ルールで localStorage に持つ:
//  - key は `ccmsg.filesView.<sid>`、値は { path, viewMode, updatedAt }
//  - mount-time sweep で (a) peers に居ない sid、(b) 10 日超非アクティブ
//    (peers.last_activity_at、無ければ record 自身の updatedAt) を削除
import type { AppState } from "./store.ts";
import { readStorage, sweepStaleBySid, writeStorage } from "./storage.ts";
import { isMarkdownPath } from "./utils.ts";

export const FILES_VIEW_PREFIX = "ccmsg.filesView.";
// 1on1 draft (OneOnOneComposer.CLEANUP_STALE_MS) と同じ 10 日。値を import
// せず独立定義なのは意図的 — 「同じルール」は現時点の仕様の一致であって、
// 片方の将来変更が黙ってもう片方に波及してよい結合ではない。
export const FILES_VIEW_STALE_DAYS = 10;
export const FILES_VIEW_STALE_MS = FILES_VIEW_STALE_DAYS * 24 * 60 * 60 * 1000;

export interface FilesViewState {
  /** repo-relative path selected in the FileTree (fileHref の path 部)。 */
  path: string;
  /** そのセッションで **最後に確定した markdown モード**。非 markdown ファイル
   * では画面上のトグルが出ないので現行の値がそのまま持ち越される (= 途中で
   * .ts を挟んでも記憶が失われない)。isMarkdownPath === false の path を復元
   * する時は viewer 側は常に "code" 扱いだが、record はここに保持している
   * markdown モードを維持する。 */
  viewMode: "code" | "preview";
  /** ISO-8601 stamp of the last update; sweep の fallback 基準。 */
  updatedAt: string;
}

/** Restore する viewMode を決める純関数 — FileViewer の path 遷移 effect と
 * 同一ロジックを test で固定するために切り出す。「該当 path が markdown なら
 * saved.viewMode を採用、そうでなければ常に code」というだけの規則だが、初版
 * の「path 一致時のみ復元」との差分が本 issue の要 (r26 mid=112) なので純関数
 * として明示する。 */
export function resolveMarkdownViewMode(
  saved: FilesViewState | null,
  path: string,
): "code" | "preview" {
  if (!isMarkdownPath(path)) return "code";
  return saved?.viewMode ?? "code";
}

/** Restore 直後に保存し直す viewMode を決める純関数。markdown を開いた時は
 * 復元値 (= その場の viewer 表示値) をそのまま record.viewMode に、非
 * markdown を開いた時は **saved.viewMode をそのまま継承** する — 非
 * markdown で "code" を書き戻すと「一度でも .ts を開くと markdown モード
 * 記憶が失われる」r26 mid=112 の再発になる。saved が無い初回は "code"
 * (= 何も選ばれていない中立状態)。 */
export function resolveMarkdownViewModePersist(
  saved: FilesViewState | null,
  path: string,
  restored: "code" | "preview",
): "code" | "preview" {
  if (isMarkdownPath(path)) return restored;
  return saved?.viewMode ?? "code";
}

export function filesViewKey(sid: string): string {
  return `${FILES_VIEW_PREFIX}${sid}`;
}

export function loadFilesView(sid: string): FilesViewState | null {
  const raw = readStorage(filesViewKey(sid));
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (
    parsed &&
    typeof parsed === "object" &&
    typeof (parsed as FilesViewState).path === "string" &&
    ((parsed as FilesViewState).viewMode === "code" ||
      (parsed as FilesViewState).viewMode === "preview") &&
    typeof (parsed as FilesViewState).updatedAt === "string"
  ) {
    return parsed as FilesViewState;
  }
  return null;
}

export function saveFilesView(sid: string, state: Omit<FilesViewState, "updatedAt">): void {
  // storage unavailable (private mode / quota) — 選択自体は locator が
  // 持っているので、復元だけが効かなくなる (無害に degrade)。
  const payload: FilesViewState = { ...state, updatedAt: new Date().toISOString() };
  writeStorage(filesViewKey(sid), JSON.stringify(payload));
}

/** OneOnOneComposer.cleanupStaleDrafts と同じ 2 規則の mount-time sweep:
 *  (a) sid が peers に居ない — 対象セッションが消えており復元先がない
 *  (b) 対象セッションが 10 日超非アクティブ (peers.last_activity_at、
 *      無ければ record 自身の updatedAt を fallback)
 * peers が未 hydrate (空) の間は呼び出し側が gate する (比較対象が無い
 * 状態で全消しする事故の防止)。 */
export function cleanupStaleFilesViews(state: AppState, now: number = Date.now()): void {
  sweepStaleBySid(
    FILES_VIEW_PREFIX,
    state,
    FILES_VIEW_STALE_MS,
    (sid) => loadFilesView(sid)?.updatedAt,
    now,
  );
}
