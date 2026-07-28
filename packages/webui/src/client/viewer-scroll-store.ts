// FileViewer のスクロール位置を **history entry 単位** で覚えるための store
// (kawaz r76 m39: 「少しスクロールした状態でリンクを開いて Back で戻ると
// 一番上に戻ってしまう」)。
//
// SessionView 側の scroll capture/restore は「SessionView が hidden ↔ active
// を往復する」ケース専用で、同一 SessionView 内でファイルだけが差し替わる
// リンク → Back の往復には効かない (要素は同じままコンテンツが変わるので、
// 位置は新コンテンツの高さでクランプされて失われる)。
//
// キーは Navigation API の `navigation.currentEntry.key` — 1 つの history
// entry を指す安定 ID で、back/forward で同じ entry に戻れば同じ key が返る。
// per-entry の `state` (navigation.updateCurrentEntry) ではなく in-memory Map
// を選んだ理由:
//  - `updateCurrentEntry` は navigate イベントのディスパッチ中に呼ぶ経路 (=
//    まさに位置を保存したい瞬間) が仕様上デリケートで、失敗すれば保存自体が
//    落ちる。key を Map のキーにすれば同じ per-entry 意味論を副作用ゼロで得る
//  - スクロール位置は reload をまたいで復元する必要がない (= entry state の
//    永続性という唯一の優位点が要らない)
// 記録は path 付きで持ち、復元時に path 一致を要求する。同一 entry を
// replaceNavigation で使い回す経路 (タブ切替) があるため、key だけを信じると
// 別コンテンツへ他人の位置を当ててしまう。

export interface ViewerScrollRecord {
  /** 記録時に viewer が表示していた path。復元時の照合に使う。 */
  path: string;
  /** スクロールコンテナ (VIEWER_SCROLLER_SELECTOR) の scrollTop。 */
  top: number;
}

/** 縦スクロールを実際に持つ要素。code モードは `.viewer-body` (pre 自身が
 * スクロールする — `.file-viewer` 側は overflow:auto だが子が伸びないので
 * 動かない)、preview モードは `.viewer-preview` (自前の overflow:auto)。
 * 実機で scrollHeight / clientHeight を突き合わせて確認済み。 */
export const VIEWER_SCROLLER_SELECTOR = ".viewer-preview, .viewer-body";

/** 保持する entry 数の上限。history entry は 1 セッションで単調に増えるので、
 * 上限なしだと長時間タブを開きっぱなしにした分だけ漏れ続ける。古い entry ほど
 * 戻る確率が低いので、挿入順 (= 最後に記録した順) で古い方から捨てる。 */
export const VIEWER_SCROLL_MAX_ENTRIES = 64;

const records = new Map<string, ViewerScrollRecord>();

export function rememberViewerScroll(key: string, record: ViewerScrollRecord): void {
  records.delete(key);
  records.set(key, record);
  while (records.size > VIEWER_SCROLL_MAX_ENTRIES) {
    const oldest = records.keys().next();
    if (oldest.done) break;
    records.delete(oldest.value);
  }
}

export function readViewerScroll(key: string): ViewerScrollRecord | null {
  return records.get(key) ?? null;
}

export function clearViewerScrolls(): void {
  records.clear();
}

/** 復元すべき scrollTop を決める純関数。null は「復元しない (= 通常どおり
 * 先頭 or 指定行)」。 */
export function resolveViewerScrollTop(
  saved: ViewerScrollRecord | null,
  path: string,
  /** 行範囲付きで開かれたか。指定行へのジャンプは「この行を見せろ」という
   * 明示要求なので記憶より優先する (files-view-store の viewMode と同じ扱い)。 */
  hasLineRange: boolean,
): number | null {
  if (hasLineRange) return null;
  if (!saved || saved.path !== path) return null;
  // 0 (先頭) は復元する意味がない。負値は壊れた記録なので無視する。
  if (saved.top <= 0) return null;
  return saved.top;
}
