import { useRef, useState } from "preact/hooks";
import type { RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { useDismissOnOutsidePointer } from "../useDismissOnOutsidePointer.ts";

/** Room title with inline rename (set_title). Confirm は Shift+Enter か
 * [保存] ボタン、Escape か [キャンセル] ボタンか編集フォーム外クリックは
 * キャンセル (誤爆保存防止)。iPad 等 Shift+Enter を打てない環境でも完結でき
 * るよう、キー操作とボタンは同じ confirm/cancel を両方から呼ぶ (kawaz
 * 2026-07-12)。保存後の表示反映は subscribe 経由で届く title イベントを
 * store が拾うので、ここでは set_title のリクエストを送るだけで自前の楽観
 * 更新は行わない。 */
export function RoomTitle({ room }: { room: RoomState }) {
  const { ws } = useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  // set_title の失敗 (daemon エラー応答、または ws 未接続で send() が reject)
  // を editor 上にそのまま表示する。null は「未表示」。
  const [error, setError] = useState<string | null>(null);
  // Escape キーでの cancel と外側クリックでの cancel が同一フレーム内で
  // 両方走る余地がある (キー操作の直後に pointerdown リスナーの cleanup が
  // 走り切る前など) — 二重キャンセル/二重保存を避けるため "確定済み" を
  // 同期的に判定するフラグとして使う。
  const settledRef = useRef(false);
  // フォーム全体 (input + 保存/キャンセルボタン) を包む要素。外側クリックで
  // キャンセルする判定に使う — onBlur ベースだと mousedown で先にフォーカス
  // が外れて blur が発火するため [保存] ボタンの click が届く前にキャンセル
  // されてしまい、ボタンが押せなかった (kawaz 2026-07-12)。
  const containerRef = useRef<HTMLDivElement>(null);

  function startEdit(): void {
    settledRef.current = false;
    setError(null);
    setDraft(room.title ?? "");
    setEditing(true);
  }

  function cancel(): void {
    if (settledRef.current) return;
    settledRef.current = true;
    setEditing(false);
  }

  async function confirm(): Promise<void> {
    if (settledRef.current) return;
    const trimmed = draft.trim();
    if (!trimmed) {
      cancel();
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await ws.setTitle(room.id, trimmed);
      if (!res.ok) {
        // daemon エラー応答 (invalid_args / not_a_member / room_not_found 等):
        // editor を開いたまま draft を保持し、理由をその場に出す。settledRef は
        // 立てない (= 再度 Shift+Enter で retry / Escape でキャンセル可能)。
        setError(res.error.msg);
        return;
      }
      settledRef.current = true;
      setEditing(false);
    } catch {
      // ws 未接続 (send() の reject) 等、応答自体が届かなかった場合も同様に
      // editor を開いたまま留める。
      setError("接続エラーのため保存できませんでした");
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    // IME 変換確定の Enter/Escape は isComposing が true になるため無視する
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== "Enter") return;
    // Shift+Enter のみ確定、素の Enter は無視 (誤爆防止)
    if (!e.shiftKey) return;
    e.preventDefault();
    void confirm();
  }

  // saving 中は input/ボタンとも disabled — 外側クリックによる cancel も
  // 同期して無効化する。有効なままだと confirm() の await 中に外側を触れた
  // 場合、確定前にフォームが閉じてしまい、後から届く res.ok=false のエラー
  // 表示先を失う (kawaz 2026-07-12)。
  useDismissOnOutsidePointer(containerRef, editing && !saving, cancel);

  if (editing) {
    return (
      <div class="room-title-edit" ref={containerRef}>
        <input
          autoFocus
          type="text"
          value={draft}
          disabled={saving}
          maxLength={200}
          placeholder="room タイトル (Shift+Enter で確定, Escape でキャンセル)"
          onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
          onKeyDown={onKeyDown}
        />
        <button
          type="button"
          class="room-title-save-btn"
          disabled={saving}
          onClick={() => void confirm()}
        >
          保存
        </button>
        <button type="button" class="room-title-cancel-btn" disabled={saving} onClick={cancel}>
          キャンセル
        </button>
        {error && <span class="room-title-edit-error">{error}</span>}
      </div>
    );
  }

  return (
    <div class="room-title">
      <h2>{room.title || room.id}</h2>
      <button
        type="button"
        class="room-title-edit-btn"
        title="room 名を変更"
        aria-label="room 名を変更"
        onClick={startEdit}
      >
        ✎
      </button>
    </div>
  );
}
