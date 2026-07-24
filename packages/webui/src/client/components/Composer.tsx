import { useEffect, useRef, useState } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";
import {
  extractTransferFiles,
  hasPendingUpload,
  insertPlaceholder,
  maxPlaceholderNumber,
  nextAttachmentNumber,
  removePlaceholder,
  substitutePlaceholders,
  type ComposerAttachment,
} from "./composer-attachments.ts";
import { shouldSendOnKeyDown } from "./composer-keydown.ts";
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
  onDraftChange,
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
  /** kawaz r26 mid=15: 書きかけ (text or 添付あり) の有無を親に通知する。
   *  RoomComposerFab が fab を「下書きあり」表示 (色 + 跳ね) に切り替え、
   *  panel close 中の書きかけ放置忘れを防ぐ。省略時は inline 挙動。 */
  onDraftChange?: (hasDraft: boolean) => void;
}) {
  const { store, ws } = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  /** 同一 tick 内の連続添付で共有する挿入位置 (直前 placeholder の直後)。
   * microtask で null に戻る — 単発添付は常に textarea caret を使う。 */
  const pendingCaretRef = useRef<number | null>(null);
  // placeholder 挿入直後に復元すべき caret 位置 (kawaz r46 mid=33): controlled
  // textarea は value がプログラム的に変わると caret が末尾に飛ぶ (React/Preact
  // 共通の挙動)。beginUpload が setText で挿入した直後、DOM への反映後に
  // setSelectionRange で挿入した placeholder の直後へ戻す必要がある。
  // pendingCaretRef は「同 tick 連続添付」用で microtask で null に戻る
  // (DOM 反映前に消える) ため、別 ref で effect まで値を持ち越す。
  const restoreCaretRef = useRef<number | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);

  // text 変化のたび textarea の高さを content に追随させる (上限で頭打ち)。
  // 空になった時 (送信後 reset) も呼ぶことで rows 属性由来の min-height 相当に
  // 戻る (scrollHeight が rows 分だけになる)。同じ effect で caret 復元も行う
  // (DOM に text が反映された後でないと setSelectionRange が効かないため)。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    autosizeTextarea(el, COMPOSER_MAX_HEIGHT_REM);
    if (restoreCaretRef.current !== null) {
      const pos = Math.min(restoreCaretRef.current, el.value.length);
      el.setSelectionRange(pos, pos);
      restoreCaretRef.current = null;
    }
  }, [text]);

  // UNIF-Q1=b: focusOnOpen が変わった (0 でない値 = fab がクリックされた) 時
  // だけ textarea にフォーカスを移す。inline mode (focusOnOpen 省略) では
  // 何もしない。値の同一比較で「一度だけ」を担保するので、popup が既に
  // 開いた状態のまま再 render しても余計な focus 移動は起きない。
  // kawaz r26 mid=20: 再オープン時は前回離脱時のカーソル位置を復元する。
  // 位置は selectionchange 級の頻度で追わず、blur (= panel 外クリックで
  // 閉じる直前に必ず発火する) の瞬間に ref へ保存すれば十分。初回 open
  // (保存なし) は末尾にカーソルを置く。
  const lastCursorRef = useRef<{ start: number; end: number } | null>(null);
  useEffect(() => {
    if (focusOnOpen === undefined || focusOnOpen === 0) return;
    const el = textareaRef.current;
    if (!el) return;
    el.focus();
    const pos = lastCursorRef.current;
    const start = pos ? Math.min(pos.start, el.value.length) : el.value.length;
    const end = pos ? Math.min(pos.end, el.value.length) : el.value.length;
    el.setSelectionRange(start, end);
  }, [focusOnOpen]);

  // UNIF-Q1=b: sending 遷移を親に通知。popup 側が sending 中の外部タップを
  // 無視するため。inline mode では onSendingChange 未指定なので no-op。
  useEffect(() => {
    onSendingChange?.(sending);
  }, [sending, onSendingChange]);

  // kawaz r26 mid=15: 書きかけの有無 (空白のみの text は下書き扱いしない) を
  // 親に通知。popup close 中も Composer は mount されたままなので、この通知が
  // fab の「下書きあり」表示の唯一の情報源になる。
  const hasDraft = text.trim().length > 0 || attachments.length > 0;
  useEffect(() => {
    onDraftChange?.(hasDraft);
  }, [hasDraft, onDraftChange]);

  /** 添付エントリを一件追加し、XHR upload を開始する。DR-0015 §2.5 の
   *  「選択時 即 upload、直ちに送信はしない」経路。placeholder 挿入は
   *  ここで済ませ、送信ボタン disable は hasPendingUpload に任せる。 */
  function beginUpload(file: File): void {
    // 1. 番号を決めて uploading entry を state に足す。attachments 配列の
    //    max だけでなく本文中の [FILE<N>] の max も跨ぐ (kawaz r17 mid=33):
    //    draft 復元などで「本文に placeholder が残っているのに attachments
    //    が空」の状態から添付すると番号が再利用され、送信時の substitute
    //    (global regex) が古い placeholder まで新 upload の path に置換して
    //    「複数ファイルが全部同じリンク」になる。
    const el = textareaRef.current;
    // 複数ファイル同時添付 (for ループで beginUpload 連打) では全呼び出しが
    // 同一 tick で走り、el.selectionStart は最初の挿入を反映しない。そのまま
    // 使うと後発の placeholder が同じ caret 位置へ挿入され、本文上の並びが
    // 逆順になる (kawaz r38 mid=37)。挿入位置は setText の関数形式内で
    // current text に対して都度クランプし、挿入後 caret を進めて共有する。
    const caret = pendingCaretRef.current ?? (el ? el.selectionStart : text.length);
    const textFloor = maxPlaceholderNumber(text);
    let assignedN = 0;
    setAttachments((prev) => {
      const n = Math.max(nextAttachmentNumber(prev), textFloor + 1);
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
      const at = Math.min(caret, current.length);
      const inserted = insertPlaceholder(current, at, n);
      const nextCaret = at + (inserted.length - current.length);
      // 次の同 tick 添付は今回の placeholder の直後に挿入する (順序保存)。
      pendingCaretRef.current = nextCaret;
      queueMicrotask(() => {
        pendingCaretRef.current = null;
      });
      // 表示上の caret も placeholder の直後に復元する (末尾へ飛ぶのを防ぐ)。
      // 実際の DOM 反映後でないと setSelectionRange が効かないので、上の
      // [text] effect に委ねる。
      restoreCaretRef.current = nextCaret;
      return inserted;
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

  /** clipboard paste のファイルを beginUpload に流す (DR-0015 §2.5 +
   *  kawaz r17 mid=51): 画像スクショに加え、Finder でコピーしたファイル
   *  (mime 不問) も添付になる。file が 1 つ以上あれば default paste (=
   *  画像 data URI やファイルパス文字列の paste) を止めて添付経路に一本化。 */
  function onPaste(e: ClipboardEvent): void {
    if (!e.clipboardData) return;
    const files = extractTransferFiles(e.clipboardData.items);
    if (files.length === 0) return; // 通常テキスト paste は default に任せる
    e.preventDefault();
    for (const f of files) beginUpload(f);
  }

  /** Finder 等からの textarea への drag & drop 添付 (kawaz r17 mid=51)。
   *  dragover の preventDefault が無いと drop は発火しない (HTML DnD 仕様)。
   *  ファイルを含まない drag (テキスト選択の drop 等) は default に任せる。 */
  function onDragOver(e: DragEvent): void {
    if (e.dataTransfer?.types.includes("Files")) e.preventDefault();
  }
  function onDrop(e: DragEvent): void {
    if (!e.dataTransfer) return;
    const files = extractTransferFiles(e.dataTransfer.items);
    if (files.length === 0) return;
    e.preventDefault();
    for (const f of files) beginUpload(f);
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
        // kawaz r26 mid=20: panel close (外側クリック) の直前に必ず blur が
        // 発火するので、ここでカーソル位置を保存 → 次回 open 時に復元。
        onBlur={(e) => {
          const el = e.target as HTMLTextAreaElement;
          lastCursorRef.current = { start: el.selectionStart, end: el.selectionEnd };
        }}
        onKeyDown={onKeyDown}
        onPaste={onPaste}
        onDragOver={onDragOver}
        onDrop={onDrop}
      />
      <ComposerAttachments attachments={attachments} onRemove={removeAttachment} />
      <div class="composer-actions">
        <div class="composer-attach-buttons">
          {/* DR-0015 §2.5 + kawaz r15 mid=8 (2026-07-14): 画像/ファイルボタン
              の区別は不要、クリップマーク 1 個に統一。iOS のファイル App /
              iCloud も accept 無指定なら写真ライブラリと同じ picker から
              呼び出せる。paste 経由の image mime 添付経路 (§2.5) は独立で
              残る。 */}
          {/* kawaz r55m46: label 内 hidden input への click 転送が Mac Chrome
              で発火しないことがある (スマホは OK) ため、button から ref 経由で
              showPicker()/click() を明示的に叩く方式に変更。
              kawaz r55m48: r55m46 の button 方式でも Mac Chrome で依然無反応
              だった (kawaz 実機報告)。root cause は `hidden` 属性: file input が
              `hidden` / `display:none` だと Mac Chrome では showPicker()/.click()
              いずれでもピッカーが開かない (kawaz 検証: DevTools で hidden 属性を
              外すとネイティブボタンからは開く = input 自体は生きている)。
              visually-hidden CSS (絶対配置 + 透過) に切り替え、rendering ツリー
              には残す ─ この pattern は Gmail / react-dropzone 等でも定番。 */}
          <input
            ref={fileInputRef}
            type="file"
            multiple
            onChange={() => onFilesPicked(fileInputRef.current)}
            class="composer-attach-file"
            aria-hidden="true"
            tabIndex={-1}
          />
          <button
            type="button"
            class="composer-attach-btn"
            aria-label="ファイルを添付"
            onClick={() => {
              const el = fileInputRef.current;
              if (!el) return;
              // showPicker はユーザジェスチャ必須だが onClick 内なので OK。
              // 非対応/拒否環境は click() にフォールバック。
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
        <button type="submit" disabled={sendDisabled}>
          {uploading ? "アップロード中..." : "送信"}
        </button>
      </div>
    </form>
  );
}
