// SessionView Rooms-tab body (U3): lists rooms the viewed session (`sid`)
// participates in, plus a secondary section for rooms other same-cwd
// sessions participate in, and offers "+ 新規 Room" to create_room with this
// session as the sole initial member (User/u1 is an implicit member of every
// room, so the result reads as "session + User"). New-room title input
// follows RoomTitle.tsx's confirm/cancel convention: Shift+Enter confirms,
// Escape cancels, isComposing (IME) is ignored so composition doesn't
// trigger an accidental submit, and [作成]/[キャンセル] buttons + outside-click
// cancel mirror RoomTitle.tsx's edit form (useDismissOnOutsidePointer, kawaz
// 2026-07-12).
import { useRef, useState } from "preact/hooks";
import type { AppState, RoomState } from "../store.ts";
import { useApp } from "../context.ts";
import { roomHref } from "../locator.ts";
import { relTime, splitRoomsByArchived } from "../utils.ts";
import { roomsForSession, roomsForSids, sameCwdSids } from "../rooms-filter.ts";
import { useDismissOnOutsidePointer } from "../useDismissOnOutsidePointer.ts";

function RoomRow({ room }: { room: RoomState }) {
  const memberCount = [...room.membersById.values()].filter((m) => !m.left).length;
  // アーカイブ済みは .room-archived で opacity を下げて視覚的に区別
  // (kawaz r15 mid=14、2026-07-14)。sidebar 側 RoomList は details 折り畳み
  // で「隠す」区別のみだったが、session Rooms タブは開いた状態で archived
  // 行も見えるので、行そのものに淡色化を効かせて active と一目で分かるように。
  return (
    <li class={room.archived ? "room-archived" : undefined}>
      <a href={roomHref(room.id)}>
        <span class="room-title">{room.title || room.id}</span>
        <span class="room-meta">
          {memberCount} 名 · #{room.lastMid} · {relTime(room.lastTs)}
        </span>
      </a>
    </li>
  );
}

/** DR-0012 と同じ「active を上、archived を折り畳みで下」を SessionRooms の
 * 各セクションにも適用 (kawaz r15 mid=14、2026-07-14)。既存 sidebar
 * RoomList と同じ splitRoomsByArchived を使い、archived が 0 件のときは
 * <details> 自体を出さない (共通ケースは変化なし)。 */
function RoomListWithArchive({ rooms }: { rooms: RoomState[] }) {
  const { active, archived } = splitRoomsByArchived(rooms);
  return (
    <>
      <ul class="session-rooms-list">
        {active.map((room) => (
          <RoomRow key={room.id} room={room} />
        ))}
      </ul>
      {archived.length > 0 && (
        <details class="session-rooms-archived">
          <summary>アーカイブ ({archived.length})</summary>
          <ul class="session-rooms-list">
            {archived.map((room) => (
              <RoomRow key={room.id} room={room} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

function NewRoomForm({ sid }: { sid: string }) {
  const { ws } = useApp();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Escape キーでの cancel と外側クリックでの cancel が同一フレーム内で両方
  // 走る余地があるため、二重キャンセル/二重確定を避ける同期フラグ
  // (RoomTitle.tsx と同じ手法)。
  const settledRef = useRef(false);
  // フォーム全体 (input + 作成/キャンセルボタン) を包む要素。外側クリックで
  // キャンセルする判定に使う (RoomTitle.tsx と同じ手法、理由は
  // useDismissOnOutsidePointer.ts 参照)。
  const containerRef = useRef<HTMLDivElement>(null);

  function start(): void {
    settledRef.current = false;
    setError(null);
    setDraft("");
    setOpen(true);
  }

  function cancel(): void {
    if (settledRef.current) return;
    settledRef.current = true;
    setOpen(false);
  }

  async function confirm(): Promise<void> {
    if (settledRef.current) return;
    setSaving(true);
    setError(null);
    try {
      const title = draft.trim();
      const res = await ws.createRoom([sid], title ? title : undefined);
      if (!res.ok) {
        setError(res.error.msg);
        return;
      }
      settledRef.current = true;
      setOpen(false);
      location.hash = roomHref(res.room);
    } catch {
      setError("接続エラーのため作成できませんでした");
    } finally {
      setSaving(false);
    }
  }

  function onKeyDown(e: KeyboardEvent): void {
    if (e.isComposing) return;
    if (e.key === "Escape") {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.key !== "Enter") return;
    if (!e.shiftKey) return;
    e.preventDefault();
    void confirm();
  }

  // saving 中は input/ボタンとも disabled — 外側クリックによる cancel も
  // 同期して無効化する。有効なままだと confirm() の await 中に外側を触れた
  // 場合、確定前にキャンセルされたにもかかわらず後から res.ok が返って
  // location.hash が無条件遷移してしまう (kawaz 2026-07-12)。
  useDismissOnOutsidePointer(containerRef, open && !saving, cancel);

  if (!open) {
    return (
      <button type="button" class="new-room-btn" onClick={start}>
        + 新規 Room
      </button>
    );
  }

  return (
    <div class="new-room-form" ref={containerRef}>
      <input
        autoFocus
        type="text"
        value={draft}
        disabled={saving}
        maxLength={200}
        placeholder="room タイトル (省略可, Shift+Enter で作成, Escape でキャンセル)"
        onInput={(e) => setDraft((e.target as HTMLInputElement).value)}
        onKeyDown={onKeyDown}
      />
      <button
        type="button"
        class="new-room-confirm-btn"
        disabled={saving}
        onClick={() => void confirm()}
      >
        作成
      </button>
      <button type="button" class="new-room-cancel-btn" disabled={saving} onClick={cancel}>
        キャンセル
      </button>
      {error && <span class="room-title-edit-error">{error}</span>}
    </div>
  );
}

export function SessionRooms({ sid, state }: { sid: string; state: AppState }) {
  const own = roomsForSession(state.rooms, sid);
  const relatedSids = sameCwdSids(state.peers, sid);
  const related = roomsForSids(state.rooms, relatedSids, own);

  return (
    <div id="session-rooms">
      <section class="session-rooms-section">
        <h3>このセッションが参加中の Room</h3>
        {own.length === 0 ? (
          <p id="empty-state">参加中の room はありません</p>
        ) : (
          <RoomListWithArchive rooms={own} />
        )}
        <NewRoomForm sid={sid} />
      </section>
      {relatedSids.length > 0 && (
        <section class="session-rooms-section">
          <h3>同じ cwd のセッションが参加中の Room</h3>
          {related.length === 0 ? (
            <p id="empty-state">該当する room はありません</p>
          ) : (
            <RoomListWithArchive rooms={related} />
          )}
        </section>
      )}
    </div>
  );
}
