import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { AppState, RoomState } from "../store.ts";
import type { PeerInfo } from "@ccmsg/protocol";
import { anchorId } from "../locator.ts";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import { hasSidDragPayload, parseSidDragPayload } from "../dnd.ts";
import { MemberChip } from "./MemberChip.tsx";
import { TimelineItem } from "./TimelineItem.tsx";
import { RoomComposerFab } from "./RoomComposerFab.tsx";
import { RoomReadOnlyNote } from "./RoomReadOnlyNote.tsx";
import { RoomTitle } from "./RoomTitle.tsx";
import { isAtBottom } from "./timeline-autoscroll.ts";
import { useNow } from "../useNow.ts";
import { useScrollHold } from "../useScrollHold.ts";
import { memberLabel } from "../utils.ts";

// DR-0011 §1-4: "already a member" is a soft notice, auto-dismissed — it's
// not a failure, just feedback that the drop didn't need to do anything.
const INVITE_ALREADY_NOTICE_MS = 3000;

function roomViewSlice(state: AppState) {
  return {
    room: state.currentRoomId ? state.rooms.get(state.currentRoomId) : undefined,
    currentMid: state.currentMid,
    mentionTo: state.mentionTo,
    peers: state.peers,
  };
}

export function RoomView() {
  const { store } = useApp();
  const state = useStoreState(store, roomViewSlice, shallowEqual);
  const room = state.room;
  if (!room) {
    return (
      <main id="room-view">
        <p id="empty-state">room を選んでください</p>
      </main>
    );
  }
  // room ごとに作り直す。送信下書き (Composer の text / 添付)、招待の通知、
  // 末尾追従とアンカー着地はどれも「この room の」状態で、次の room へ持ち越すと
  // 書きかけが別の room へ送られる (送信先は新しい room.id になる)。同じ room の
  // 中で popup を閉じても下書きが残るのは、Composer がこの room を開いている間
  // mount され続けるから (RoomComposerFab)。
  return (
    <OpenRoom
      key={room.id}
      room={room}
      mid={state.currentMid}
      mentionTo={state.mentionTo}
      peers={state.peers}
    />
  );
}

function OpenRoom({
  room,
  mid,
  mentionTo,
  peers,
}: {
  room: RoomState;
  /** message anchor requested by the URL locator (`#room-mNN`), if any. */
  mid: number | null;
  mentionTo: Set<string>;
  peers: readonly PeerInfo[];
}) {
  const { ws, store } = useApp();
  const roomId = room.id;
  const roomHistory = room.history;
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
  // msg 時刻の相対時間表示 ("3h10m") 用の雑更新 tick (kawaz r17 mid=30)。
  const now = useNow();

  // 末尾に居た時だけ新着で末尾追随する (kawaz 2026-07-13、timeline-autoscroll.ts)。
  // 「末尾に居るか」は scroll イベントごとに Ref へ記録し、timeline (event 配列)
  // が更新された commit の paint 前 (useLayoutEffect) にそれを見て末尾を保持
  // (useScrollHold) する。保持なので、新着の画像・フォントが後から高さを変えても
  // 末尾に留まり、ユーザが自分でスクロールした時点で手放される。
  //
  // ref/onScroll は **scroll コンテナである main#room-view** に付ける
  // (overflow-y: auto は #room-view 側、app.css)。中身の .timeline は overflow
  // を持たないので、そこへの scrollTop 代入は無視され scroll イベントも出ない。
  //
  // room に入った時は末尾から見せる (初期値 true)。ただし直リンクでメッセージを
  // 指して入った時はその着地が優先なので、末尾扱いにしない。
  const scrollerRef = useRef<HTMLElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const scrollHold = useScrollHold(scrollerRef, contentRef);
  const stickToBottomRef = useRef(mid === null);
  useLayoutEffect(() => {
    if (stickToBottomRef.current) scrollHold.toBottom();
  }, [room.timeline, scrollHold]);

  // `#room-mNN` 直リンクの着地 (DR-0004 §5)。対象メッセージが描画された時に
  // 1 度だけ寄せる。履歴を取りに行く前 (history "idle") や届く前は対象が DOM に
  // 無いので、「対象が room に在るか」と履歴の status を依存にして、履歴の到着で
  // 在るに変わった時に着地する。着地済みの mid は覚えておき、新着や再描画で引き戻さない
  // (読み進める手動スクロールと競合しない)。着地後に上の内容が伸びても対象が
  // 中央に留まるよう保持で寄せる。
  const targetPresent = mid !== null && room.msgs.has(mid);
  const landedMidRef = useRef<number | null>(null);
  useEffect(() => {
    if (mid === null || landedMidRef.current === mid) return;
    if (!targetPresent) {
      // 履歴が揃っても無い mid (誤った直リンク) には着地先が無いので、room に
      // 入った時と同じく末尾から見せる。
      if (roomHistory !== "loaded") return;
      landedMidRef.current = mid;
      stickToBottomRef.current = true;
      scrollHold.toBottom();
      return;
    }
    const target = document.getElementById(anchorId(roomId, mid));
    if (!target) return;
    landedMidRef.current = mid;
    stickToBottomRef.current = false;
    scrollHold.toElement(target, (_scroller, el) => el.scrollIntoView({ block: "center" }));
  }, [roomId, mid, targetPresent, roomHistory, scrollHold]);

  // Opening a room is what fetches its history: subscribe only carries room
  // metadata now (kawaz r99 m12), so an unopened room's `timeline` is empty by
  // design. "idle" is the one status that fetches — "loading"/"loaded" are
  // already covered, and "error" stays put rather than retrying in a loop
  // (a reconnect or a room switch back is the retry).
  useEffect(() => {
    if (roomHistory !== "idle") return;
    const id = roomId;
    store.dispatch({ type: "room-history/loading", room: id });
    void ws
      .roomHistory(id)
      .then((res) => {
        store.dispatch({
          type: "room-history/loaded",
          room: id,
          ...(res.ok ? {} : { error: res.error.msg }),
        });
      })
      // request dropped with the socket: leave the room in "error" so the
      // reconnect-driven remount fetches again instead of hanging on "loading".
      .catch(() => {
        store.dispatch({ type: "room-history/loaded", room: id, error: "disconnected" });
      });
  }, [roomId, roomHistory, store, ws]);

  useEffect(() => {
    if (!notice || notice.kind !== "already") return;
    const id = setTimeout(() => setNotice(null), INVITE_ALREADY_NOTICE_MS);
    return () => clearTimeout(id);
  }, [notice]);

  const activeMembers = room.memberOrder
    .map((id) => room.membersById.get(id))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.left);

  // The two things a member chip can do (DR-0012). MemberChip itself draws
  // only — the mention toggle and the kick send live here, where the room and
  // the store are already in hand. The confirm is the same guard StatusPanel's
  // KillZone puts in front of its own irreversible action.
  const toggleMention = (id: string): void => store.dispatch({ type: "mention/toggle", id });
  const confirmKick = (id: string): void => {
    if (!window.confirm(`${memberLabel(id, room)} を room から強制退出させますか?`)) return;
    void ws.kick(room.id, id);
  };

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
    <main
      id="room-view"
      ref={scrollerRef}
      onScroll={(e) => {
        // 末尾判定を Ref に記録。次の timeline 更新時に useLayoutEffect が
        // これを見て「末尾に居たなら追随、離れていたなら放置」を決める。
        stickToBottomRef.current = isAtBottom(e.currentTarget);
        // 自分で末尾まで戻ってきたら、また末尾を保持する (新着を待たずに、
        // 末尾の画像が後から伸びても末尾に留まる)。
        if (stickToBottomRef.current) scrollHold.toBottom();
      }}
    >
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
            selected={mentionTo.has(ADMIN_ID)}
            peers={peers}
            onSelect={toggleMention}
            onKick={confirmKick}
          />
          {activeMembers.map((m) => (
            <MemberChip
              key={m.id}
              id={m.id}
              room={room}
              selected={mentionTo.has(m.id)}
              peers={peers}
              onSelect={toggleMention}
              onKick={confirmKick}
            />
          ))}
        </div>
        {notice && (
          <span class={notice.kind === "error" ? "room-invite-error" : "room-invite-notice"}>
            {notice.text}
          </span>
        )}
        <RoomReadOnlyNote room={room} />
      </header>
      <div
        ref={contentRef}
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
          <TimelineItem key={i} event={ev} room={room} peers={peers} now={now} />
        ))}
      </div>
      {/* UNIF-Q1=b (kawaz r15 mid=1/mid=3、2026-07-14): RoomView の Composer
       *  を SessionView の入力欄と同じ「右下 + fab → floating popup」に統一。
       *  attachment / broadcast / mention の全機能は RoomComposerFab 内の
       *  Composer にそのまま委譲される。1on1 room は読み取り専用 (DR-0035 §2、
       *  daemon も post を拒否する) なので Composer を出さず、代わりに
       *  header の RoomReadOnlyNote がセッション画面の入力欄を示す。 */}
      {room.kind !== "1on1" && <RoomComposerFab room={room} mentionTo={mentionTo} />}
    </main>
  );
}
