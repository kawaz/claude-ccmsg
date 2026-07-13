import { useEffect, useRef, useState } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { memberLabel } from "../utils.ts";

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

export function Composer({ room, mentionTo }: { room: RoomState; mentionTo: Set<string> }) {
  const { store, ws } = useApp();
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  // text 変化のたび textarea の高さを content に追随させる (上限で頭打ち)。
  // 空になった時 (送信後 reset) も呼ぶことで rows 属性由来の min-height 相当に
  // 戻る (scrollHeight が rows 分だけになる)。
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    autosizeTextarea(el, COMPOSER_MAX_HEIGHT_REM);
  }, [text]);

  async function send(): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const to = [...mentionTo];
      const res = await ws.post(room.id, trimmed, to);
      if (res.ok) {
        store.dispatch({
          type: "protocol-event",
          event: {
            type: "msg",
            mid: res.mid,
            from: ADMIN_ID,
            ...(to.length ? { to } : {}),
            ts: new Date().toISOString(),
            msg: trimmed,
            r: room.id,
          },
        });
        setText("");
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

  return (
    <form class="composer" onSubmit={(e) => void submit(e)}>
      <div class="composer-mention">
        {mentionTo.size
          ? `→ ${[...mentionTo].map((id) => memberLabel(id, room)).join(", ")}`
          : "room 全体へ (member chip をクリックで mention)"}
      </div>
      <textarea
        ref={textareaRef}
        placeholder="メッセージを入力 (⌘+Enter で送信)"
        rows={3}
        value={text}
        onInput={(e) => setText((e.target as HTMLTextAreaElement).value)}
        onKeyDown={onKeyDown}
      />
      <button type="submit" disabled={sending}>
        送信
      </button>
    </form>
  );
}
