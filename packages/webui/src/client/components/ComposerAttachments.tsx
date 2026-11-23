/** @jsxImportSource preact */
// DR-0015 §4.3: 添付一覧の表示コンポーネントを Composer と分離。
//
// 表示だけを担う: entry の name / progress% / error msg を小さめフォントで
// 並べ、× ボタンで onRemove を呼ぶ。upload 進行中は取り消しできる (取り消せば
// 本文からも placeholder が消える — 実処理は useAttachmentInput)。onRemove が
// 無ければ並べるだけ (直していない未送信のコメントのカード)。
// 添付のボタン (📎) も置く: FAB の入力とコメントのフォームが同じものを使う。
import { useRef } from "preact/hooks";
import { useComposeFocusAcrossChoice, useKeepsComposeFocus } from "./compose-focus.ts";
import type { ComposerAttachment } from "./composer-attachments.ts";
import { openImageLightbox } from "./ImageLightbox.tsx";

/** 画像 mime (image/*) の添付か。lightbox で開くか新タブに逃がすかの分岐。 */
function isImageAttachment(a: ComposerAttachment): boolean {
  return a.mime?.startsWith("image/") ?? false;
}

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
  disabled = false,
}: {
  attachments: readonly ComposerAttachment[];
  /** × で外す。無ければ × を出さない。 */
  onRemove?: (n: number) => void;
  /** 削除を止める (送信中、送る添付を変えさせない時)。 */
  disabled?: boolean;
}) {
  // The textarea keeps the focus across a × (compose-focus.ts).
  const keepFocus = useKeepsComposeFocus();
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
            {/* upload 済みはファイル名クリックでプレビュー (kawaz r17 mid=44)。
             * 画像は in-app lightbox (kawaz r26 mid=49: standalone PWA で
             * target=_blank は脱出不能)、他 mime のみ新タブの既定挙動。 */}
            {href !== null ? (
              <a
                class="composer-attachment-label"
                href={href}
                target={isImageAttachment(a) ? undefined : "_blank"}
                rel="noopener noreferrer"
                onClick={
                  isImageAttachment(a)
                    ? (e) => {
                        e.preventDefault();
                        openImageLightbox(href, a.name);
                      }
                    : undefined
                }
              >
                {label}
              </a>
            ) : (
              <span class="composer-attachment-label">{label}</span>
            )}
            {onRemove !== undefined ? (
              <button
                type="button"
                class="composer-attachment-remove"
                aria-label={`FILE${a.n} を削除`}
                disabled={disabled}
                onPointerDown={keepFocus}
                onClick={() => onRemove(a.n)}
              >
                ×
              </button>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

/** 添付のボタン (📎): 押すとファイルの選択を開き、選んだファイルを `onFiles` に
 * 渡す。画像とファイルの区別はしない (貼り付け・ドロップの経路は入力欄の側)。
 * `hidden` 属性の file input は Mac Chrome で picker が開かないので、
 * visually-hidden の CSS で rendering ツリーに残し、ボタンから開く。 */
export function AttachFileButton({
  onFiles,
  disabled,
}: {
  onFiles: (files: readonly File[]) => void;
  disabled: boolean;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  // The 📎 takes no focus from the textarea, and the textarea gets the focus
  // and caret it had back when the choice closes (compose-focus.ts): before
  // the files go in, so their `[FILE<N>]` goes at that caret.
  const keepFocus = useKeepsComposeFocus();
  const choice = useComposeFocusAcrossChoice();
  return (
    <div class="composer-attach-buttons">
      <input
        ref={inputRef}
        type="file"
        multiple
        onChange={(e) => {
          const input = e.currentTarget;
          choice.closed();
          if (!input.files) return;
          onFiles(Array.from(input.files));
          input.value = ""; // 同じファイルの再選択を可能に (change event が発火するように)
        }}
        onCancel={() => choice.closed()}
        class="composer-attach-file"
        aria-hidden="true"
        tabIndex={-1}
      />
      <button
        type="button"
        class="composer-attach-btn"
        aria-label="ファイルを添付"
        disabled={disabled}
        onPointerDown={keepFocus}
        onClick={() => {
          const el = inputRef.current;
          if (!el) return;
          choice.opening();
          try {
            el.showPicker();
          } catch {
            el.click();
          }
        }}
      >
        <span aria-hidden="true">📎</span>
      </button>
    </div>
  );
}
