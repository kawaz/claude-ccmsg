/** @jsxImportSource preact */
// DR-0015 §4.3: 添付一覧の表示コンポーネントを Composer と分離。
//
// 表示だけを担う: entry の name / progress% / error msg を小さめフォントで
// 並べ、× ボタンで onRemove を呼ぶ。upload 進行中は取り消しできる (取り消せば
// 本文からも placeholder が消える — 実処理は Composer.tsx 側)。
import type { ComposerAttachment } from "./composer-attachments.ts";

/** upload 済み添付のプレビュー URL (daemon の /attachment/<uuid>.<ext>
 * endpoint)。TMPDIR の生パスはブラウザから開けないので、markdown-view.tsx
 * の表示変換と同じ endpoint に写す。uuid が無い (未完了) entry は null。 */
function previewHref(a: ComposerAttachment): string | null {
  if (a.status !== "done" || !a.uuid) return null;
  // ext は AttachmentUploadResponse 由来で leading `.` 込み (`.png`)、拡張子
  // なしなら ""。
  return `/attachment/${a.uuid}${a.ext ?? ""}`;
}

export function ComposerAttachments({
  attachments,
  onRemove,
}: {
  attachments: ComposerAttachment[];
  onRemove: (n: number) => void;
}) {
  if (attachments.length === 0) return null;
  return (
    <ul class="composer-attachments" aria-label="添付ファイル一覧">
      {attachments.map((a) => {
        const label =
          a.status === "uploading"
            ? `FILE${a.n}: ${a.name} (${a.progress}%)`
            : a.status === "error"
              ? `FILE${a.n}: ${a.name} — エラー: ${a.errorMsg ?? "アップロード失敗"}`
              : `FILE${a.n}: ${a.name}`;
        const cls =
          a.status === "error"
            ? "composer-attachment composer-attachment-error"
            : "composer-attachment";
        const href = previewHref(a);
        return (
          <li key={a.n} class={cls}>
            {/* upload 済みはファイル名クリックでプレビューを新タブに開く
             * (kawaz r17 mid=44、2026-07-15)。送信前の内容確認用 — 画像は
             * ブラウザがインライン表示、他 mime はダウンロード等の既定挙動。 */}
            {href !== null ? (
              <a
                class="composer-attachment-label"
                href={href}
                target="_blank"
                rel="noopener noreferrer"
              >
                {label}
              </a>
            ) : (
              <span class="composer-attachment-label">{label}</span>
            )}
            <button
              type="button"
              class="composer-attachment-remove"
              aria-label={`FILE${a.n} を削除`}
              onClick={() => onRemove(a.n)}
            >
              ×
            </button>
          </li>
        );
      })}
    </ul>
  );
}
