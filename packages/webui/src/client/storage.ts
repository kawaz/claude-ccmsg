// localStorage の try/catch を1箇所に集約する pure I/O ヘルパ (webui simplify
// componentization、issue 2026-07-17)。private mode / quota 超過で
// localStorage アクセスが例外を投げる環境への耐性がこれまで App.tsx /
// FilesPanes.tsx / Sidebar.tsx / ws.ts / main.tsx / FileTree.tsx /
// files-view-store.ts / OneOnOneComposer.tsx の 8 箇所で同一の
// try/catch ラップとして重複していた。
//
// garbage 耐性の解釈 (clamp / 型 validate / filter / reject) は呼び出し側
// ごとに意図的に異なる (各 utils.ts ヘルパのコメント参照) ので、そちらは
// 統合しない — ここは read/write/remove の I/O 例外吸収と key 列挙だけを
// 担う配管。
import type { AppState } from "./store.ts";

/** `localStorage.getItem` を try/catch でラップ。private mode / quota 超過等
 * で例外が飛ぶ環境では `null` (= 未保存と同じ扱い) に degrade する。 */
export function readStorage(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** `localStorage.setItem` を try/catch でラップ。書き込み失敗は無視 —
 * 呼び出し側の機能自体はセッション中そのまま動く、永続化だけが効かなくなる
 * (既存各所の "storage unavailable" コメントと同じ posture)。 */
export function writeStorage(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode / quota) — degrade to non-persistent
  }
}

/** `localStorage.removeItem` を try/catch でラップ。 */
export function removeStorage(key: string): void {
  try {
    localStorage.removeItem(key);
  } catch {
    // ignore
  }
}

/** `prefix` で始まる localStorage の全 key を列挙する。files-view-store.ts の
 * sweep と OneOnOneComposer の sweep が同一の `localStorage.length` /
 * `localStorage.key(i)` ループを持っていたのを統一。列挙中の例外
 * (private mode 等) は空配列に degrade — 呼び出し側の sweep は「対象なし」
 * として扱われ、次回 mount で再試行される。 */
export function listStorageKeys(prefix: string): string[] {
  const keys: string[] = [];
  try {
    const n = localStorage.length;
    for (let i = 0; i < n; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(prefix)) keys.push(k);
    }
  } catch {
    return [];
  }
  return keys;
}

/** `ccmsg.filesView.<sid>` / `ccmsg.1on1.<sid>` の mount-time sweep が共有する
 * per-sid stale 判定 (files-view-store.ts の cleanupStaleFilesViews と
 * OneOnOneComposer.tsx の cleanupStaleDrafts で行単位同一だったロジックを
 * 統一)。2 規則: (a) sid が `state.peers` に居ない record は無条件削除、
 * (b) peer は居るが `peer.last_activity_at` (無ければ `loadUpdatedAt(sid)`
 * が返す record 自身の updatedAt) から `staleMs` 超経過していれば削除。
 * 両方 NaN (peer に activity stamp が無く record も見つからない) なら
 * 比較不成立で残す — 安全側デフォルト、次回 mount で再判定される。
 * `staleMs` を引数にすることで「値は各呼び出し側が独立定義する」という
 * 既存の意図 (files-view-store.ts の FILES_VIEW_STALE_MS コメント参照) を
 * 尊重しつつ配管だけ共有する。 */
export function sweepStaleBySid(
  prefix: string,
  state: AppState,
  staleMs: number,
  loadUpdatedAt: (sid: string) => string | undefined,
  now: number = Date.now(),
): void {
  const keys = listStorageKeys(prefix);
  for (const key of keys) {
    const sid = key.slice(prefix.length);
    const peer = state.peers.find((p) => p.sid === sid);
    if (!peer) {
      removeStorage(key);
      continue;
    }
    const recordUpdatedAt = loadUpdatedAt(sid);
    const peerActivityMs = peer.last_activity_at ? Date.parse(peer.last_activity_at) : NaN;
    const recordMs = recordUpdatedAt ? Date.parse(recordUpdatedAt) : NaN;
    // peer の activity stamp を優先 (セッションが最近使われたかの直接
    // signal)、無ければ record の updatedAt。両方 NaN なら比較不成立で残す。
    const referenceMs = Number.isFinite(peerActivityMs)
      ? peerActivityMs
      : Number.isFinite(recordMs)
        ? recordMs
        : NaN;
    if (Number.isFinite(referenceMs) && now - referenceMs > staleMs) {
      removeStorage(key);
    }
  }
}
