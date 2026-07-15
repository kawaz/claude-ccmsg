// DR-0015 Composer attachment pure helpers.
//
// The heavy JSX + XHR piece lives in Composer.tsx; this module holds the
// text-manipulation / clipboard-pick / status-computation logic so it can be
// unit-tested without a preact DOM (matching this test suite's `.ts`-only
// import convention — see composer-keydown.ts for the same split).
//
// Contract with Composer.tsx:
//   - `n` is a 1-indexed attachment number that persists across the entry's
//     lifetime (upload → send). It maps to the `[FILE<N>]` placeholder in the
//     composer text and to the final `[FILE<N>:<name>](<path>)` substitution
//     at send time (DR-0015 §2.4).
//   - Placeholders are literal `[FILE<N>]` — no leading whitespace / bracket
//     escaping. Numbers ≥1, no zero-padding.

export type AttachmentStatus = "uploading" | "done" | "error";

export interface ComposerAttachment {
  n: number;
  name: string;
  status: AttachmentStatus;
  /** 0-100 upload progress; only meaningful while status is "uploading". */
  progress: number;
  uuid?: string;
  ext?: string;
  size?: number;
  mime?: string;
  path?: string;
  errorMsg?: string;
}

/** Assign the next available `[FILE<N>]` number for a new attachment. Uses
 * `max(existing n) + 1` rather than `length + 1` so numbers stay stable when
 * an earlier entry gets removed — a user who deletes FILE1 then adds a new
 * one should get FILE3 (or whatever's next), not a recycled FILE1, since the
 * original FILE1 placeholder in the text might still be referenced by the
 * user's own edits above the deletion point. */
export function nextAttachmentNumber(existing: ComposerAttachment[]): number {
  let max = 0;
  for (const a of existing) if (a.n > max) max = a.n;
  return max + 1;
}

/** The largest `[FILE<N>]` number already present in `text`, 0 if none.
 * 採番は attachments 配列だけでなく本文のプレースホルダとも衝突してはいけない
 * (kawaz r17 mid=33 の実事故、2026-07-15): 1on1 の draft 復元は text
 * ([FILE1] 入り) を戻すが attachments は空リセットするため、reopen 後の
 * 新規添付が再び n=1 を取り、送信時の substitute (global regex) が古い
 * [FILE1] と新しい [FILE1] を両方とも新 upload の path に置換してしまう —
 * 「2 ファイル添付したら両方同じリンク」になる。採番側が本文の最大 N も
 * 跨ぐことで、stale placeholder は設計通りリテラルのまま残る。 */
export function maxPlaceholderNumber(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/\[FILE(\d+)\]/g)) {
    const n = Number(m[1]);
    if (n > max) max = n;
  }
  return max;
}

/** Insert `[FILE<N>]` into `text` at the caret. If `caret` is out of range
 * (negative or past the end), the placeholder is appended to the end —
 * matches Composer.tsx's fallback when the textarea ref is unavailable. */
export function insertPlaceholder(text: string, caret: number, n: number): string {
  const placeholder = `[FILE${n}]`;
  if (caret < 0 || caret > text.length) return text + placeholder;
  return text.slice(0, caret) + placeholder + text.slice(caret);
}

/** Remove EVERY occurrence of `[FILE<N>]` from `text`. Global regex on
 * purpose: the user might have duplicated the placeholder by pasting the
 * whole message somewhere; if they cancel the upload, both copies should
 * disappear (a stale placeholder that no longer resolves to a URL would
 * survive the send-time substitution below and land in the message as
 * literal `[FILE3]`). */
export function removePlaceholder(text: string, n: number): string {
  // \[FILE<N>\] with the exact number, not a prefix match — regex escape
  // isn't needed because `n` is always a decimal integer here.
  const re = new RegExp(`\\[FILE${n}\\]`, "g");
  return text.replace(re, "");
}

/**
 * Send-time substitution: replace each `[FILE<N>]` with its finalized
 * `[FILE<N>:<name>](<path>)` markdown link. Skips attachments whose upload
 * hasn't completed (no `path`) — Composer.tsx also disables the send button
 * while any upload is still running, but this is defensive: an error entry
 * or a race between upload completion and send should not emit a link with
 * `undefined` in the URL.
 */
export function substitutePlaceholders(text: string, attachments: ComposerAttachment[]): string {
  let out = text;
  for (const a of attachments) {
    if (a.status !== "done" || !a.path) continue;
    const re = new RegExp(`\\[FILE${a.n}\\]`, "g");
    // The link label reuses `[FILE<N>:<name>]` verbatim (DR-0015 §2.4 example),
    // so the receiving side / agents can grep for `FILE<N>` and know which
    // attachment this token refers to across the message body.
    out = out.replace(re, `[FILE${a.n}:${a.name}](${a.path})`);
  }
  return out;
}

/** True when at least one attachment is still uploading. Composer.tsx uses
 * this to disable the send button (DR-0015 §2.5: 未完了 upload があれば送信
 * ボタン disable)、失敗した entry は送信を止めない (× で消せば済む)。 */
export function hasPendingUpload(attachments: ComposerAttachment[]): boolean {
  return attachments.some((a) => a.status === "uploading");
}

/**
 * Extract every File object from a paste / drop event's DataTransfer items.
 * DR-0015 §2.5 は image mime の clipboard paste が起点だが、kawaz r17 mid=51
 * (2026-07-15) で「Finder でコピーしたファイルの paste」「Finder からの
 * drag & drop」にも拡張 — どちらも kind:"file" の item として届くので、
 * mime を問わず全部拾う (添付機能自体が任意ファイル対応、DR-0015 §2.1)。
 * Returns [] when the transfer has no file (in which case the caller should
 * fall through to the browser's default text paste / drop behavior).
 */
export function extractTransferFiles(
  items:
    | Iterable<{ kind: string; type: string; getAsFile(): File | null }>
    | ArrayLike<{ kind: string; type: string; getAsFile(): File | null }>,
): File[] {
  const out: File[] = [];
  // items may be a DataTransferItemList (array-like) or an iterable; loop over
  // both via for-of on a materialized array.
  const arr: Array<{ kind: string; type: string; getAsFile(): File | null }> = Array.isArray(items)
    ? items
    : Array.from(items as Iterable<{ kind: string; type: string; getAsFile(): File | null }>);
  for (const item of arr) {
    if (item.kind !== "file") continue;
    const file = item.getAsFile();
    if (file) out.push(file);
  }
  return out;
}
