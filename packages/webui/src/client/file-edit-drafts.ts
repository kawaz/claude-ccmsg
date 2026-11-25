// Files の未保存の編集 (DR-0051 §9)、セッションとファイルのパスごと。編集を
// 始めた時に作り、保存とキャンセルの時だけ消す。別のファイルへ移って編集の画面が
// 無くなっても残り、そのファイルに戻ると同じ中身で編集の状態のまま開く。
// 覚えるのはページを開いている間だけ (再読み込みで消える)。コメントのフォームの
// 書きかけ (comment-form-drafts.ts) と同じ決まり。
import type { LineEnding } from "./editor-text.ts";
import type { HighlightLang } from "./highlight.ts";

/** 編集領域の選択 (本文の中の文字の位置、anchor と focus) とスクロール。 */
export interface FileEditPlace {
  selection: { anchor: number; focus: number } | null;
  scrollTop: number;
}

export interface FileEditDraft {
  /** 編集中の中身 (改行は LF、editor-text.ts) */
  text: string;
  /** 保存の時に戻すファイルの改行コード (編集を始めた時の本文で決めたもの) */
  lineEnding: LineEnding;
  /** 着色する言語 (編集を始めた時の本文で決めたもの) */
  lang: HighlightLang | null;
  /** 編集を始めた時に読んだファイルの mtime と size。保存の楽観ロック
   * (fs_edit の expected_mtime / expected_size) に渡す */
  expectedMtime: string;
  expectedSize: number;
  /** 見ていたのがコードかプレビューか */
  view: "code" | "preview";
  /** 編集の画面が無くなった時の編集領域の位置。null は先頭 */
  place: FileEditPlace | null;
}

const drafts = new Map<string, Map<string, FileEditDraft>>();

/** セッション `sid` の `path` の未保存の編集。無ければ null。 */
export function loadFileEditDraft(sid: string, path: string): FileEditDraft | null {
  return drafts.get(sid)?.get(path) ?? null;
}

/** セッション `sid` の `path` の編集を `draft` で覚える (編集を始めた時)。 */
export function saveFileEditDraft(sid: string, path: string, draft: FileEditDraft): void {
  const session = drafts.get(sid) ?? new Map<string, FileEditDraft>();
  session.set(path, draft);
  drafts.set(sid, session);
}

/** 覚えている編集の一部を書き換える。覚えていなければ何もしない (保存・
 * キャンセルで消えた後に、閉じていく編集の画面が書き戻さないように)。 */
export function updateFileEditDraft(
  sid: string,
  path: string,
  change: Partial<FileEditDraft>,
): void {
  const draft = loadFileEditDraft(sid, path);
  if (draft === null) return;
  saveFileEditDraft(sid, path, { ...draft, ...change });
}

/** セッション `sid` の `path` の編集を忘れる (保存した・キャンセルした)。 */
export function clearFileEditDraft(sid: string, path: string): void {
  const session = drafts.get(sid);
  if (session === undefined) return;
  session.delete(path);
  if (session.size === 0) drafts.delete(sid);
}

/** テスト用: 新しいページ。 */
export function resetFileEditDrafts(): void {
  drafts.clear();
}
