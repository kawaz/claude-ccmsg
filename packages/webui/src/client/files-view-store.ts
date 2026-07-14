// Files タブの表示状態 (選択ファイル + FileViewer の表示モード) の per-sid
// 永続化 (kawaz r17 mid=5、2026-07-14): Files タブのリンクは `#s<sid>`
// (path なし) なので、タブ切替やリロードのたびに locator 経由で selectedPath
// が null に戻り、ファイル選択とプレビューモードが失われるのが不便。
// 1on1 draft (OneOnOneComposer) と同じ保存・削除ルールで localStorage に持つ:
//  - key は `ccmsg.filesView.<sid>`、値は { path, viewMode, updatedAt }
//  - mount-time sweep で (a) peers に居ない sid、(b) 10 日超非アクティブ
//    (peers.last_activity_at、無ければ record 自身の updatedAt) を削除
import type { AppState } from "./store.ts";

export const FILES_VIEW_PREFIX = "ccmsg.filesView.";
// 1on1 draft (OneOnOneComposer.CLEANUP_STALE_MS) と同じ 10 日。値を import
// せず独立定義なのは意図的 — 「同じルール」は現時点の仕様の一致であって、
// 片方の将来変更が黙ってもう片方に波及してよい結合ではない。
export const FILES_VIEW_STALE_DAYS = 10;
export const FILES_VIEW_STALE_MS = FILES_VIEW_STALE_DAYS * 24 * 60 * 60 * 1000;

export interface FilesViewState {
  /** repo-relative path selected in the FileTree (fileHref の path 部)。 */
  path: string;
  /** FileViewer の表示モード。markdown 以外の path では常に "code" 扱い。 */
  viewMode: "code" | "preview";
  /** ISO-8601 stamp of the last update; sweep の fallback 基準。 */
  updatedAt: string;
}

export function filesViewKey(sid: string): string {
  return `${FILES_VIEW_PREFIX}${sid}`;
}

export function loadFilesView(sid: string): FilesViewState | null {
  try {
    const raw = localStorage.getItem(filesViewKey(sid));
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
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
  } catch {
    return null;
  }
}

export function saveFilesView(sid: string, state: Omit<FilesViewState, "updatedAt">): void {
  try {
    const payload: FilesViewState = { ...state, updatedAt: new Date().toISOString() };
    localStorage.setItem(filesViewKey(sid), JSON.stringify(payload));
  } catch {
    // storage unavailable (private mode / quota) — 選択自体は locator が
    // 持っているので、復元だけが効かなくなる (無害に degrade)。
  }
}

/** OneOnOneComposer.cleanupStaleDrafts と同じ 2 規則の mount-time sweep:
 *  (a) sid が peers に居ない — 対象セッションが消えており復元先がない
 *  (b) 対象セッションが 10 日超非アクティブ (peers.last_activity_at、
 *      無ければ record 自身の updatedAt を fallback)
 * peers が未 hydrate (空) の間は呼び出し側が gate する (比較対象が無い
 * 状態で全消しする事故の防止)。 */
export function cleanupStaleFilesViews(state: AppState, now: number = Date.now()): void {
  const keys: string[] = [];
  try {
    const n = localStorage.length;
    for (let i = 0; i < n; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(FILES_VIEW_PREFIX)) keys.push(k);
    }
  } catch {
    return;
  }
  for (const key of keys) {
    const sid = key.slice(FILES_VIEW_PREFIX.length);
    const peer = state.peers.find((p) => p.sid === sid);
    if (!peer) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
      continue;
    }
    const record = loadFilesView(sid);
    const peerActivityMs = peer.last_activity_at ? Date.parse(peer.last_activity_at) : NaN;
    const recordMs = record ? Date.parse(record.updatedAt) : NaN;
    // peer の activity stamp を優先 (セッションが最近使われたかの直接 signal)、
    // 無ければ record の updatedAt。両方 NaN なら比較不成立で残す (安全側 —
    // 次回 mount でより良いデータと共に再判定される)。
    const referenceMs = Number.isFinite(peerActivityMs)
      ? peerActivityMs
      : Number.isFinite(recordMs)
        ? recordMs
        : NaN;
    if (Number.isFinite(referenceMs) && now - referenceMs > FILES_VIEW_STALE_MS) {
      try {
        localStorage.removeItem(key);
      } catch {
        // ignore
      }
    }
  }
}
