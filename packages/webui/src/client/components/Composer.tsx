import { useEffect, useRef, useState } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";
import {
  extractPastedImages,
  hasPendingUpload,
  insertPlaceholder,
  nextAttachmentNumber,
  removePlaceholder,
  substitutePlaceholders,
  type ComposerAttachment,
} from "./composer-attachments.ts";
import { ComposerAttachments } from "./ComposerAttachments.tsx";
import { uploadAttachment } from "./composer-upload.ts";

/** Composer 入力欄の上限行数 (これを超えたら textarea 内スクロールに切替)。
 * 1 行あたり CSS 側 `.composer textarea` の line-height 相応 (グローバル body
 * inherit の system-ui, 1rem = 1 行) + textarea 上下 padding 0.4rem × 2 を
 * autosizeTextarea 内で rem→px 換算して max height にする。 */
const COMPOSER_LINE_REM = 1;
const COMPOSER_PADDING_REM = 0.8;
const COMPOSER_MAX_LINES = 10;
const COMPOSER_MAX_HEIGHT_REM = COMPOSER_LINE_REM * COMPOSER_MAX_LINES + COMPOSER_PADDING_REM;

/** keydown event を「送信すべきか / textarea default (= 改行) に任せるか」に
 * 分類する pure function。kawaz 方針 (2026-07-13): Cmd+Enter (macOS) or
 * Ctrl+Enter (Linux/Windows) で送信、素の Enter と Shift+Enter はどちらも
 * textarea 既定の改行動作をそのまま (= false 返却で preventDefault しない)。
 * IME 変換確定の Enter (`isComposing === true`) は送信も改行も奪わず default
 * に任せる — IME 側の変換確定 UI を潰さないため。
 *
 * pure function にしておくことで Composer の DOM を組まずとも keyboard event
 * の分岐だけを unit test できる (webui/test/composer.test.ts)。 */
export function shouldSendOnKeyDown(e: {
  key: string;
  isComposing?: boolean;
  metaKey?: boolean;
  ctrlKey?: boolean;
  // shiftKey / altKey は分岐に使わないが、KeyboardEvent 由来の event object を
  // そのまま渡せるよう optional で受ける (test 側で `{ ..., shiftKey: true }`
  // 形式の spec 網羅を書きたいので必要)。
  shiftKey?: boolean;
  altKey?: boolean;
}): boolean {
  if (e.key !== "Enter") return false;
  if (e.isComposing) return false;
  return !!(e.metaKey || e.ctrlKey);
}

/** textarea の scrollHeight ベースで content 相応の高さ (px) を計算し反映する。
 * DOM を触るので必ず effect の中で呼ぶ。値は px 単位、CSS 側の max-height
 * (rem) を JS 側の rem→px 換算で頭打ちにする — root font-size は 16px 前提
 * だが getComputedStyle でユーザ設定を尊重する。
 *
 * measure ステップ: 一度 height を "auto" にリセットしてから scrollHeight を
 * 読み直すのは、既に伸びている textarea の scrollHeight が「今の height と
 * 同値」に頭打ちされ、縮小したい時に scrollHeight が最新 content 高より
 * 大きいまま止まるのを避けるため。 */
function autosizeTextarea(el: HTMLTextAreaElement, maxHeightRem: number): void {
  const rootFontSize = parseFloat(getComputedStyle(document.documentElement).fontSize || "16");
  const maxPx = maxHeightRem * rootFontSize;
  el.style.height = "auto";
  const next = Math.min(el.scrollHeight, maxPx);
  el.style.height = `${next}px`;
}

export function Composer({
  room,
  mentionTo,
  onSent,
  onSendingChange,
  focusOnOpen,
}: {
  room: RoomState;
  mentionTo: Set<string>;
  /** UNIF-Q1=b: 送信 (post ok) 完了で親に close を促す (popup 用)。省略時は
   *  従来の inline 挙動 (親は何も反応しない)。 */
  onSent?: () => void;
  /** UNIF-Q1=b: send 中の遷移を親に通知 (popup が外部タップ close を無効化
   *  するため)。省略時は inline 挙動 (親は sending を関知しない)。 */
  onSendingChange?: (sending: boolean) => void;
  /** UNIF-Q1=b: popup が「開いた」タイミングで textarea にフォーカスするための
   *  カウンタ。値が変わった (前回と異なる) たびに 1 度 focus() する。0 は
   *  「未 open」sentinel でスキップする — RoomComposerFab 側で fab クリックの
   *  たびにインクリメントして渡す。 */
  focusOnOpen?: number;
}) {
  const { store, ws } = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // text 変化のたび textarea の高さを content に追随させる (上限で頭打ち)。
  // 空になった時 (送信後 reset) も呼ぶことで rows 属性由来の min-height 相当に
  // 戻る (scrollHeight が rows 分だけになる)。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    autosizeTextarea(el, COMPOSER_MAX_HEIGHT_REM);
  }, [text]);

  // UNIF-Q1=b: focusOnOpen が変わった (0 でない値 = fab がクリックされた) 時
  // だけ textarea にフォーカスを移す。inline mode (focusOnOpen 省略) では
  // 何もしない。値の同一比較で「一度だけ」を担保するので、popup が既に
  // 開いた状態のまま再 render しても余計な focus 移動は起きない。
  useEffect(() => {
    if (focusOnOpen === undefined || focusOnOpen === 0) return;
    textareaRef.current?.focus();
  }, [focusOnOpen]);

  // UNIF-Q1=b: sending 遷移を親に通知。popup 側が sending 中の外部タップを
  // 無視するため。inline mode では onSendingChange 未指定なので no-op。
  useEffect(() => {
    onSendingChange?.(sending);
  }, [sending, onSendingChange]);

  /** 添付エントリを一件追加し、XHR upload を開始する。DR-0015 §2.5 の
   *  「選択時 即 upload、直ちに送信はしない」経路。placeholder 挿入は
   *  ここで済ませ、送信ボタン disable は hasPendingUpload に任せる。 */
  function beginUpload(file: File): void {
    // 1. 番号を決めて uploading entry を state に足す
    const el = textareaRef.current;
    const caret = el ? el.selectionStart : text.length;
    let assignedN = 0;
    setAttachments((prev) => {
      const n = nextAttachmentNumber(prev);
      assignedN = n;
      return [...prev, { n, name: file.name || "upload", status: "uploading", progress: 0 }];
    });
    // 2. text にプレースホルダ挿入 (caret 位置 or 末尾)。setAttachments と別
    //    setter なので、この時点で assignedN は上の setter 実行を待たない —
    //    Preact の同期 update batch 内で走る (state 更新の関数形式なので
    //    前回値との整合は取れる)、が念のため直前に localのMax計算する。
    setText((current) => {
      // assignedN が確定していない (setAttachments が非同期) 場合の safety。
      // 実際は Preact の setState は同一 tick 内で解決するので普通は number。
      const n = assignedN || nextAttachmentNumber(attachments) || 1;
      return insertPlaceholder(current, caret, n);
    });
    // 3. upload 開始 (async)、progress は state に反映
    const n = assignedN;
    void (async () => {
      try {
        const meta = await uploadAttachment(file, (percent) => {
          setAttachments((prev) => prev.map((a) => (a.n === n ? { ...a, progress: percent } : a)));
        });
        setAttachments((prev) =>
          prev.map((a) =>
            a.n === n
              ? {
                  ...a,
                  status: "done",
                  progress: 100,
                  uuid: meta.uuid,
                  ext: meta.ext,
                  size: meta.size,
                  mime: meta.mime,
                  path: meta.path,
                  name: meta.name,
                }
              : a,
          ),
        );
      } catch (err) {
        setAttachments((prev) =>
          prev.map((a) =>
            a.n === n
              ? {
                  ...a,
                  status: "error",
                  errorMsg: err instanceof Error ? err.message : String(err),
                }
              : a,
          ),
        );
      }
    })();
  }

  /** × ボタン押下: entry を state から消し、本文からも placeholder を除去。
   *  upload 中に消した場合、XHR 自体は走り続けるが state に entry がないので
   *  結果は捨てられる (=OS の TMPDIR に短命なゴミが残る、DR-0015 §2.1 で
   *  「OS 任せで削除」なので許容範囲)。 */
  function removeAttachment(n: number): void {
    setAttachments((prev) => prev.filter((a) => a.n !== n));
    setText((current) => removePlaceholder(current, n));
  }

  /** clipboard paste で image mime のファイルを検出し、beginUpload に流す。
   *  DR-0015 §2.5: `ClipboardEvent.clipboardData.items` に image があれば
   *  file 扱い。image が 1 つ以上あれば default paste (= 画像 data URI の
   *  文字列 paste 等) を止めて添付経路に一本化する。 */
  function onPaste(e: ClipboardEvent): void {
    if (!e.clipboardData) return;
    const images = extractPastedImages(e.clipboardData.items);
    if (images.length === 0) return; // 通常テキスト paste は default に任せる
    e.preventDefault();
    for (const f of images) beginUpload(f);
  }

  function onFilesPicked(input: HTMLInputElement | null): void {
    if (!input?.files) return;
    for (const f of Array.from(input.files)) beginUpload(f);
    input.value = ""; // 同じファイルの再選択を可能に (change event が発火するように)
  }

  async function send(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (hasPendingUpload(attachments)) return; // safety net (ボタン disable 済)
    setSending(true);
    try {
      const finalText = substitutePlaceholders(trimmed, attachments);
      const to = [...mentionTo];
      const res = await ws.post(room.id, finalText, to);
      if (res.ok) {
        store.dispatch({
          type: "protocol-event",
          event: {
            type: "msg",
            mid: res.mid,
            from: ADMIN_ID,
            ...(to.length ? { to } : {}),
            ts: new Date().toISOString(),
            msg: finalText,
            r: room.id,
          },
        });
        setText("");
        setAttachments([]);
        // UNIF-Q1=b: 送信成功で popup を閉じる (inline mode では省略で no-op)。
        // 失敗時 (res.ok=false) は開いたまま — text/attachments はまだ残って
        // いるので再送 UI を維持する。
        onSent?.();
      }
    } finally {
      setSending(false);
    }
  }

  async function submit(e: SubmitEvent): Promise<void> {
    e.preventDefault();
    await send();
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (!shouldSendOnKeyDown(e)) return;
    e.preventDefault();
    void send();
  }

  // DR-0013 §2.5 / §4.4: broadcast room では Composer の説明を「配信対象の選択」
  // 文脈に切り替える。webui は role:"user" (u1) hello で post するため §2.4 の
  // agent-must-target-u1 制約は適用されず、既存の member chip → mentionTo → to
  // 配列という配信フィルタ経路 (DR-0011) をそのまま再利用できる。未選択は
  // 通常 room では「room 全体へ」だが broadcast では「全 active session に個別
  // 配信」の意図を明示する。
  const isBroadcast = room.kind === "broadcast";
  const hint = mentionTo.size
    ? `→ ${[...mentionTo].map((id) => memberLabel(id, room)).join(", ")}`
    : isBroadcast
      ? "broadcast: 全 active session へ (member chip をクリックで個別 session に絞る)"
      : "room 全体へ (member chip をクリックで mention)";
  const placeholder = isBroadcast
    ? "メッセージを入力 (broadcast, ⌘+Enter で送信)"
    : "メッセージを入力 (⌘+Enter で送信)";
  const uploading = hasPendingUpload(attachments);
  const sendDisabled = sending || uploading;
  return (
    <form
      class={isBroadcast ? "composer composer-broadcast" : "composer"}
      onSubmit={(e) => void submit(e)}
    >
      <div class="composer-mention">{hint}</div>
      <textarea
        ref={textareaRef}
        placeholder={placeholder}
        rows={3}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
      />
      <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
      <div class="composer-actions">
        <div class="composer-attach-buttons">
          {/* DR-0015 §2.5 + kawaz r15 mid=8 (2026-07-14): 画像/ファイルボタン
              の区別は不要、クリップマーク 1 個に統一。iOS のファイル App /
              iCloud も accept 無指定なら写真ライブラリと同じ picker から
              呼び出せる。paste 経由の image mime 添付経路 (§2.5) は独立で
              残る。 */}
          <label class="composer-attach-btn" aria-label="ファイルを添付">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              onChange={() => onFilesPicked(fileInputRef.current)}
              hidden
            />
            <span aria-hidden="true">📎</span>
          </label>
        </div>
        <button type="submit" disabled={sendDisabled}>
          {uploading ? "アップロード中..." : "送信"}
        </button>
      </div>
    </form>
  );
}
