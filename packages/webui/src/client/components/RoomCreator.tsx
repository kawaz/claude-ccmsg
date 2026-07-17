// Sidebar ROOMS "+ 新規" panel: title input + explicit connected-session
// member checkboxes. Sits inside the sidebar's ROOMS section, toggled on by
// Sidebar's "+ 新規" button, replacing RoomList while open — same
// sidebar-internal-panel pattern SessionSearchPanel/SessionCreator
// established for the SESSIONS section (see Sidebar.tsx's doc comment), now
// unified across both sections into one exclusive-open group.
//
// Shares the create_room plumbing (ws.createRoom, now members: string[])
// with SessionRooms.tsx's NewRoomForm rather than duplicating it, but not the
// form UI itself: NewRoomForm runs inside a specific session's Rooms tab and
// so has one implicit member (that session, see its doc comment); this panel
// has no session context, so it needs the member checkboxes NewRoomForm
// doesn't (see room-creator.ts's doc comment for why "reuse the form 1:1"
// wasn't possible despite the linked issue's initial framing).
import { useState } from "preact/hooks";
import type { PeerInfo } from "@ccmsg/protocol";
import { useApp } from "../context.ts";
import { roomHref } from "../locator.ts";
import { errorMessage, sessionLabel, shortSid } from "../utils.ts";
import {
  buildCreateRoomRequest,
  initialRoomCreatorForm,
  roomCreatorFormValid,
  toggleRoomCreatorMember,
  type RoomCreatorForm,
} from "../room-creator.ts";

export function RoomCreator({ peers, onClose }: { peers: PeerInfo[]; onClose: () => void }) {
  const { ws } = useApp();
  const [form, setForm] = useState<RoomCreatorForm>(initialRoomCreatorForm);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create(e: Event): Promise<void> {
    e.preventDefault();
    const req = buildCreateRoomRequest(form);
    if (!req) return;
    setSaving(true);
    setError(null);
    try {
      const res = await ws.createRoom(req.members, req.title, req.kind);
      if (!res.ok) {
        setError(res.error.msg);
        return;
      }
      onClose();
      location.hash = roomHref(res.room);
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div id="room-creator-panel">
      <div class="room-creator-header">
        <h3>新規 Room</h3>
        <button type="button" class="room-creator-close" onClick={onClose} aria-label="閉じる">
          ✕
        </button>
      </div>
      <form class="room-creator-form" onSubmit={(e) => void create(e)}>
        <label class="room-creator-field">
          <span class="room-creator-label">タイトル</span>
          <input
            type="text"
            maxLength={200}
            placeholder="省略可"
            value={form.title}
            onInput={(e) => setForm({ ...form, title: (e.target as HTMLInputElement).value })}
          />
        </label>
        {/* kawaz r26 mid=118: broadcast の webui 作成経路。broadcast はメンバー
         * 自動 populate (DR-0013) なので選択欄を隠す。 */}
        <div class="room-creator-field">
          <span class="room-creator-label">種類</span>
          <label class="room-creator-kind">
            <input
              type="radio"
              name="room-kind"
              checked={form.kind === "normal"}
              onChange={() => setForm({ ...form, kind: "normal" })}
            />
            通常
          </label>
          <label class="room-creator-kind">
            <input
              type="radio"
              name="room-kind"
              checked={form.kind === "broadcast"}
              onChange={() => setForm({ ...form, kind: "broadcast" })}
            />
            broadcast (全セッション自動参加)
          </label>
        </div>
        {form.kind === "broadcast" ? null : (
          <fieldset class="room-creator-members">
            <legend class="room-creator-label">メンバー (接続中セッション)</legend>
            {peers.length === 0 ? (
              <p class="room-creator-empty">接続中のセッションがありません</p>
            ) : (
              <ul class="room-creator-member-list">
                {peers.map((peer) => (
                  <li key={peer.sid}>
                    <label class="room-creator-member">
                      <input
                        type="checkbox"
                        checked={form.memberSids.includes(peer.sid)}
                        onChange={() => setForm(toggleRoomCreatorMember(form, peer.sid))}
                      />
                      <span class="room-creator-member-label">{sessionLabel(peer)}</span>
                      <span class="room-creator-member-sid">{shortSid(peer.sid)}</span>
                    </label>
                  </li>
                ))}
              </ul>
            )}
          </fieldset>
        )}
        <button
          type="submit"
          class="room-creator-submit"
          disabled={!roomCreatorFormValid(form) || saving}
        >
          {saving ? "作成中…" : "作成"}
        </button>
        {error ? <p class="room-creator-error">{error}</p> : null}
      </form>
    </div>
  );
}
