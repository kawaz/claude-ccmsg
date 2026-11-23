// 入力欄に添付を付ける操作 (DR-0015 §2.4, §2.5): 📎 で選んだファイル・貼り付け・
// ドロップを upload し、caret の位置に `[FILE<N>]` を入れ、チップ (添付の一覧) の
// × で本文の `[FILE<N>]` ごと外す。FAB の入力 (SessionInputComposer) と
// コメントのフォーム・未送信のコメントの「直す」(timeline/comments.tsx) が同じものを
// 使う (DR-0062 §3)。
//
// 入力欄の中身 (本文と添付) は呼び出し側が持つ: `content` は render を待たない
// 最新の中身 (同じ tick に続く編集、複数ファイルの同時添付が前の編集の上に積める
// ように)、`edit` はそれを変える人の編集 (FAB は下書きの保存も兼ねる)。
import { useCallback, useLayoutEffect, useRef, useState } from "preact/hooks";
import {
  extractTransfer,
  insertPlaceholder,
  maxPlaceholderNumber,
  nextAttachmentNumber,
  removePlaceholder,
  type ComposerAttachment,
} from "./composer-attachments.ts";
import { uploadAttachment } from "./composer-upload.ts";

/** What an input box holds: its text and its attachments. */
export interface AttachmentBoxContent {
  text: string;
  attachments: ComposerAttachment[];
}

/** An input box's text and attachments kept in the component alone (the
 * comment form, the 直す of an unsent comment): what is rendered, the latest
 * ahead of a render (`content`), and the edit that changes both. The FAB's
 * box, whose edits are also saved as its draft, keeps its own. */
export function useAttachmentBox(initial: () => AttachmentBoxContent): {
  text: string;
  attachments: ComposerAttachment[];
  content: { readonly current: AttachmentBoxContent };
  edit: (next: AttachmentBoxContent) => void;
} {
  const [shown, setShown] = useState(initial);
  const content = useRef(shown);
  const edit = useCallback((next: AttachmentBoxContent) => {
    content.current = next;
    setShown(next);
  }, []);
  return { text: shown.text, attachments: shown.attachments, content, edit };
}

export interface AttachmentInput {
  /** Upload `files` and put a `[FILE<N>]` for each at the caret. */
  attachFiles: (files: readonly File[]) => void;
  /** Take attachment `n` off, and its `[FILE<N>]` from the text. */
  removeAttachment: (n: number) => void;
  onPaste: (e: ClipboardEvent) => void;
  onDragOver: (e: DragEvent) => void;
  onDrop: (e: DragEvent) => void;
}

export function useAttachmentInput({
  textareaRef,
  content,
  edit,
  locked,
  text,
}: {
  textareaRef: { readonly current: HTMLTextAreaElement | null };
  /** The box's latest content, ahead of a render. */
  content: { readonly current: AttachmentBoxContent };
  edit: (next: AttachmentBoxContent) => void;
  /** Whether the attachments may not change now (a send waits for its answer). */
  locked: () => boolean;
  /** The text as rendered: the caret put after a placeholder is set once it is
   * in the DOM. */
  text: string;
}): AttachmentInput {
  // 同じ tick の連続の挿入 (複数ファイルの同時添付) が共有する caret: 直前の挿入の
  // 直後。microtask の寿命。
  const pendingCaretRef = useRef<number | null>(null);
  // placeholder の挿入・外しの後に戻す caret の位置: controlled textarea は value が
  // プログラムで変わると caret が末尾に飛ぶので、DOM への反映の後、描く前に戻す
  // (描いた後だと、末尾に飛んだ caret が一度見える)。
  const restoreCaretRef = useRef<number | null>(null);
  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el || restoreCaretRef.current === null) return;
    const pos = Math.min(restoreCaretRef.current, el.value.length);
    el.setSelectionRange(pos, pos);
    restoreCaretRef.current = null;
  }, [text, textareaRef]);

  /** The caret a new insertion goes at, held for the rest of the tick as
   * `next` (where the insertion ends). */
  const holdCaret = useCallback((next: number) => {
    pendingCaretRef.current = next;
    queueMicrotask(() => {
      pendingCaretRef.current = null;
    });
    restoreCaretRef.current = next;
  }, []);

  // paste / drop されたディレクトリの名前を caret 位置にテキストとして入れる
  // (ディレクトリは添付にしない、DR-0015 §2.5)。同じイベントの添付の
  // placeholder が名前の後ろに続くように、beginUpload と同じ caret の予約を使う。
  const insertDirectoryNames = useCallback(
    (names: readonly string[]) => {
      const el = textareaRef.current;
      const current = content.current;
      const start = Math.min(
        pendingCaretRef.current ?? (el ? el.selectionStart : current.text.length),
        current.text.length,
      );
      const end = pendingCaretRef.current ?? (el ? el.selectionEnd : start);
      const inserted = names.join("\n");
      holdCaret(start + inserted.length);
      edit({
        text: current.text.slice(0, start) + inserted + current.text.slice(Math.max(start, end)),
        attachments: current.attachments,
      });
    },
    [textareaRef, content, edit, holdCaret],
  );

  // caret 位置にプレースホルダを入れて upload を始める。進み具合と結果はこの添付に
  // 映す。送信のボタンを止めるのは呼び出し側 (hasPendingUpload)。
  const beginUpload = useCallback(
    (file: File) => {
      const el = textareaRef.current;
      const current = content.current;
      const caret = pendingCaretRef.current ?? (el ? el.selectionStart : current.text.length);
      // 本文中の [FILE<N>] の max も跨いで採番: 本文だけ戻り添付が欠けた下書きで、
      // attachments 配列だけ見た採番は番号を再利用して、送信時の置き換えが新旧の
      // placeholder を同じ path に潰してしまう。
      const n = Math.max(
        nextAttachmentNumber(current.attachments),
        maxPlaceholderNumber(current.text) + 1,
      );
      const at = Math.min(caret, current.text.length);
      const inserted = insertPlaceholder(current.text, at, n);
      holdCaret(at + (inserted.length - current.text.length));
      edit({
        text: inserted,
        attachments: [
          ...current.attachments,
          { n, name: file.name || "upload", status: "uploading", progress: 0 },
        ],
      });
      const update = (change: (a: ComposerAttachment) => ComposerAttachment) => {
        const latest = content.current;
        edit({
          text: latest.text,
          attachments: latest.attachments.map((a) => (a.n === n ? change(a) : a)),
        });
      };
      void (async () => {
        try {
          const meta = await uploadAttachment(file, (percent) => {
            update((a) => ({ ...a, progress: percent }));
          });
          update((a) => ({
            ...a,
            status: "done",
            progress: 100,
            uuid: meta.uuid,
            ext: meta.ext,
            size: meta.size,
            mime: meta.mime,
            path: meta.path,
            name: meta.name,
          }));
        } catch (err) {
          update((a) => ({
            ...a,
            status: "error",
            errorMsg: err instanceof Error ? err.message : "アップロードに失敗した",
          }));
        }
      })();
    },
    [textareaRef, content, edit, holdCaret],
  );

  const attachFiles = useCallback(
    (files: readonly File[]) => {
      for (const file of files) beginUpload(file);
    },
    [beginUpload],
  );

  const removeAttachment = useCallback(
    (n: number) => {
      if (locked()) return;
      const current = content.current;
      // A × keeps the textarea's focus (compose-focus.ts), so its caret stays
      // where it was in the text: before it, the `[FILE<N>]` taken out.
      const el = textareaRef.current;
      if (el !== null && el.ownerDocument.activeElement === el) {
        const before = current.text.slice(0, el.selectionStart);
        restoreCaretRef.current = removePlaceholder(before, n).length;
      }
      edit({
        text: removePlaceholder(current.text, n),
        attachments: current.attachments.filter((a) => a.n !== n),
      });
    },
    [content, edit, locked, textareaRef],
  );

  // paste は画像に加え Finder コピーのファイル (mime 不問) も添付に、drop は
  // Finder からの drag & drop 添付。ディレクトリは名前をテキストで入れる。
  const takeTransfer = useCallback(
    (e: Event, items: DataTransferItemList) => {
      const { files, directoryNames } = extractTransfer(items);
      if (files.length === 0 && directoryNames.length === 0) return; // 通常テキストは default に任せる
      e.preventDefault();
      if (directoryNames.length > 0) insertDirectoryNames(directoryNames);
      attachFiles(files);
    },
    [attachFiles, insertDirectoryNames],
  );
  const onPaste = useCallback(
    (e: ClipboardEvent) => {
      if (!e.clipboardData || locked()) return;
      takeTransfer(e, e.clipboardData.items);
    },
    [takeTransfer, locked],
  );
  const onDragOver = useCallback((e: DragEvent) => {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }, []);
  const onDrop = useCallback(
    (e: DragEvent) => {
      if (!e.dataTransfer || locked()) return;
      takeTransfer(e, e.dataTransfer.items);
    },
    [takeTransfer, locked],
  );

  return { attachFiles, removeAttachment, onPaste, onDragOver, onDrop };
}
