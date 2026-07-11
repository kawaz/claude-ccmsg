import { useEffect, useState } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { AppState } from "../store.ts";
import { anchorId } from "../locator.ts";
import { useApp } from "../context.ts";
import { hasSidDragPayload, parseSidDragPayload } from "../dnd.ts";
import { MemberChip } from "./MemberChip.tsx";
import { TimelineItem } from "./TimelineItem.tsx";
import { Composer } from "./Composer.tsx";
import { RoomTitle } from "./RoomTitle.tsx";

// DR-0011 §1-4: "already a member" is a soft notice, auto-dismissed — it's
// not a failure, just feedback that the drop didn't need to do anything.
const INVITE_ALREADY_NOTICE_MS = 3000;

export function RoomView({ state }: { state: AppState }) {
  const { ws } = useApp();
  const room = state.currentRoomId ? state.rooms.get(state.currentRoomId) : undefined;
  const mid = state.currentMid;
  const [dragOver, setDragOver] = useState(false);
  // Invite-drop feedback. "already": soft notice, auto-dismisses (see
  // INVITE_ALREADY_NOTICE_MS below). "error": daemon rejection (unknown /
  // disconnected sid, not a member of this room, ...) or a dropped ws
  // request — stays until the next drop attempt, mirroring RoomTitle's
  // error-until-retry convention (DR-0011 says "RoomTitle のエラー表示の流儀").
  const [notice, setNotice] = useState<{ kind: "already" | "error"; text: string } | null>(null);
  // アーカイブ toggle 送信中の二重クリック防止 (DR-0012)。楽観更新はしない —
  // 反映は他の archive_room 同様、broadcast される archive イベントを store が
  // 拾う (RoomTitle の set_title と同じ非楽観方針)。
  const [archiving, setArchiving] = useState(false);

  // `#room-mNN` anchor scroll (DR-0004 §5): only fires when the locator's
  // room/mid pair changes, not on every timeline update, so it doesn't fight
  // manual scrolling while new messages stream in.
  useEffect(() => {
    if (!room || mid === null) return;
    document.getElementById(anchorId(room.id, mid))?.scrollIntoView({ block: "center" });
  }, [room?.id, mid]);

  // Switching rooms discards any leftover invite notice from the previous one.
  useEffect(() => {
    setNotice(null);
  }, [room?.id]);

  useEffect(() => {
    if (!notice || notice.kind !== "already") return;
    const id = setTimeout(() => setNotice(null), INVITE_ALREADY_NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  if (!room) {
    return (
      <main id="room-view">
        <p id="empty-state">room を選んでください</p>
      </main>
    );
  }

  const activeMembers = room.memberOrder
    .map((id) => room.membersById.get(id))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.left);

  // Drop handler for SessionList's drag-a-session-row gesture. Success needs
  // no local state update: the invite lands in this room's member list via
  // the broadcast member event on the subscribe stream, which the reducer
  // already folds in (applyProtocolEvent's "member" case) the same as any
  // other join — this handler only surfaces already/error feedback.
  // DR-0012: ヘッダのアーカイブ toggle ボタン。set_title と同じく非楽観 —
  // 成功時は broadcast される archive イベントで収束する。失敗時は既存の
  // notice state (RoomTitle / drop-invite と同じ error-until-retry 慣習) に
  // 乗せる — 黙って何も起きないように見せない。
  async function handleToggleArchive(): Promise<void> {
    if (!room || archiving) return;
    setArchiving(true);
    try {
      const res = await ws.archiveRoom(room.id, !room.archived);
      if (!res.ok) {
        setNotice({ kind: "error", text: res.error.msg });
      }
    } catch {
      setNotice({ kind: "error", text: "接続エラーのためアーカイブ状態を変更できませんでした" });
    } finally {
      setArchiving(false);
    }
  }

  async function handleDrop(e: DragEvent): Promise<void> {
    e.preventDefault();
    setDragOver(false);
    const dt = e.dataTransfer;
    if (!dt) return;
    const sid = parseSidDragPayload(dt);
    if (!sid || !room) return;
    try {
      const res = await ws.invite(room.id, sid);
      if (!res.ok) {
        setNotice({ kind: "error", text: res.error.msg });
        return;
      }
      setNotice(res.already ? { kind: "already", text: "すでにこの room のメンバーです" } : null);
    } catch {
      setNotice({ kind: "error", text: "接続エラーのため招待できませんでした" });
    }
  }

  return (
    <main id="room-view">
      <header class="room-header">
        <div class="room-header-top">
          <RoomTitle room={room} />
          <button
            type="button"
            class="room-archive-toggle"
            title={room.archived ? "アーカイブ解除" : "アーカイブ"}
            aria-label={room.archived ? "アーカイブ解除" : "アーカイブ"}
            disabled={archiving}
            onClick={() => void handleToggleArchive()}
          >
            {room.archived ? "アーカイブ解除" : "📥"}
          </button>
        </div>
        <div class="member-chips">
          <MemberChip
            id={ADMIN_ID}
            room={room}
            selected={state.mentionTo.has(ADMIN_ID)}
            peers={state.peers}
          />
          {activeMembers.map((m) => (
            <MemberChip
              key={m.id}
              id={m.id}
              room={room}
              selected={state.mentionTo.has(m.id)}
              peers={state.peers}
            />
          ))}
        </div>
        {notice && (
          <span class={notice.kind === "error" ? "room-invite-error" : "room-invite-notice"}>
            {notice.text}
          </span>
        )}
      </header>
      <div
        class={dragOver ? "timeline timeline-drop-active" : "timeline"}
        onDragOver={(e) => {
          if (!e.dataTransfer || !hasSidDragPayload(e.dataTransfer)) return;
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={(e) => {
          // HTML DnD fires dragleave on every child-boundary crossing, not just when
          // the pointer truly exits the drop zone — ignore it while relatedTarget is
          // still inside currentTarget (e.g. entering a TimelineItem), or the
          // drop-active outline flickers on every pixel of pointer movement.
          const related = e.relatedTarget;
          if (related instanceof Node && e.currentTarget.contains(related)) return;
          setDragOver(false);
        }}
        onDrop={(e) => void handleDrop(e)}
      >
        {room.timeline.map((ev, i) => (
          <TimelineItem key={i} event={ev} room={room} />
        ))}
      </div>
      <Composer room={room} mentionTo={state.mentionTo} />
    </main>
  );
}
