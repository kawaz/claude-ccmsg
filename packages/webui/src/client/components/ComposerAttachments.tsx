/** @jsxImportSource preact */
// DR-0015 §4.3: 添付一覧の表示コンポーネントを Composer と分離。
//
// 表示だけを担う: entry の name / progress% / error msg を小さめフォントで
// 並べ、× ボタンで onRemove を呼ぶ。upload 進行中は取り消しできる (取り消せば
// 本文からも placeholder が消える — 実処理は Composer.tsx 側)。
import type { ComposerAttachment } from "./composer-attachments.ts";

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
        return (
          <li key={a.n} class={cls}>
            <span class="composer-attachment-label">{label}</span>
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
