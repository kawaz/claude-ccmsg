import { useEffect, useLayoutEffect, useRef } from "preact/hooks";
import { ADMIN_ID } from "../store.ts";
import type { AppState, RoomState } from "../store.ts";
import type { PeerInfo } from "@ccmsg/protocol";
import { anchorId } from "../locator.ts";
import { useApp } from "../context.ts";
import { shallowEqual, useStoreState } from "../useStore.ts";
import { MemberChip } from "./MemberChip.tsx";
import { TimelineItem } from "./TimelineItem.tsx";
import { RoomReadOnlyNote } from "./RoomReadOnlyNote.tsx";
import { isAtBottom } from "./timeline-autoscroll.ts";
import { useNow } from "../useNow.ts";
import { centerTop, useScrollHold } from "../useScrollHold.ts";

function roomViewSlice(state: AppState) {
  return {
    roomId: state.currentRoomId,
    room: state.currentRoomId ? state.rooms.get(state.currentRoomId) : undefined,
    currentMid: state.currentMid,
    peers: state.peers,
  };
}

/** A room log, read-only (DR-0036 §2): its title, members and timeline. */
export function RoomView() {
  const { store } = useApp();
  const state = useStoreState(store, roomViewSlice, shallowEqual);
  if (state.roomId === null) {
    return (
      <main id="room-view">
        <p id="empty-state">room を選んでください</p>
      </main>
    );
  }
  // room ごとに作り直す。末尾追従とアンカー着地はどれも「この room の」状態。
  return (
    <OpenRoom
      key={state.roomId}
      roomId={state.roomId}
      room={state.room}
      mid={state.currentMid}
      peers={state.peers}
    />
  );
}

function OpenRoom({
  roomId,
  room,
  mid,
  peers,
}: {
  roomId: string;
  /** Absent until the room list or the room's own log has been fetched. */
  room: RoomState | undefined;
  /** message anchor requested by the URL locator (`#room-mNN`), if any. */
  mid: number | null;
  peers: readonly PeerInfo[];
}) {
  const { ws, store } = useApp();
  const roomHistory = room?.history ?? "idle";
  const timeline = room?.timeline;
  // msg 時刻の相対時間表示 ("3h10m") 用の雑更新 tick。
  const now = useNow();

  // room に入った時は末尾から見せる。末尾に居るかは scroll イベントごとに Ref
  // へ記録し、timeline が変わった commit の paint 前 (useLayoutEffect) に見て
  // 末尾を保持する (useScrollHold)。保持なので、画像・フォントが後から高さを
  // 変えても末尾に留まり、ユーザが自分でスクロールした時点で手放される。
  // ref/onScroll は scroll コンテナである main#room-view に付ける。直リンクで
  // メッセージを指して入った時はその着地が優先なので、末尾扱いにしない。
  const scrollerRef = useRef<HTMLElement>(null);
  const scrollHold = useScrollHold(scrollerRef);
  const stickToBottomRef = useRef(mid === null);
  useLayoutEffect(() => {
    if (stickToBottomRef.current) scrollHold.toBottom();
  }, [timeline, scrollHold]);

  // `#room-mNN` 直リンクの着地 (DR-0004 §5)。対象メッセージが描画された時に
  // 1 度だけ寄せる。ログが届く前は対象が DOM に無いので、「対象が room に在る
  // か」とログの status を依存にして、到着で在るに変わった時に着地する。
  // 着地済みの mid は覚えておき、再描画で引き戻さない。
  // 動かし方 (DR-0056): ログが届いて room を描き終えるまでの着地は直リンクの
  // 位置の復元なので一瞬。描き終えた room の中で別のメッセージを指した時
  // (メッセージのリンクを押した、戻る / 進む) は読み手の操作なので短い smooth。
  const targetPresent = mid !== null && room?.msgs.has(mid) === true;
  const landedMidRef = useRef<number | null>(null);
  const shownRef = useRef(false);
  useEffect(() => {
    if (mid === null || landedMidRef.current === mid) return;
    if (!targetPresent) {
      // ログが揃っても無い mid (誤った直リンク) には着地先が無いので、room に
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
    scrollHold.toElement(target, centerTop, shownRef.current ? "user" : "machine");
  }, [roomId, mid, targetPresent, roomHistory, scrollHold]);
  // 着地の effect の後に置く: ログが届いた commit の着地はまだ描き終えていない
  // room への着地として扱う。
  useEffect(() => {
    shownRef.current = roomHistory === "loaded";
  }, [roomHistory]);

  // Opening a room is what fetches its log. "idle" is the one status that
  // fetches — "loading"/"loaded" are covered, "missing" is answered by the
  // 404 (navigation.ts missingTarget), and "error" stays put rather than
  // retrying in a loop (a room switch back is the retry).
  useEffect(() => {
    if (roomHistory !== "idle") return;
    const id = roomId;
    store.dispatch({ type: "room-history/loading", room: id });
    void ws
      .roomHistory(id)
      .then((res) => {
        store.dispatch(
          res.ok
            ? { type: "room-history/loaded", room: id, events: res.events }
            : {
                type: "room-history/failed",
                room: id,
                missing: res.error.code === "room_not_found",
              },
        );
      })
      // request dropped with the socket: leave the room in "error".
      .catch(() => {
        store.dispatch({ type: "room-history/failed", room: id, missing: false });
      });
  }, [roomId, roomHistory, store, ws]);

  const activeMembers = (room?.memberOrder ?? [])
    .map((id) => room?.membersById.get(id))
    .filter((m): m is NonNullable<typeof m> => m !== undefined && !m.left);

  return (
    <main
      id="room-view"
      ref={scrollerRef}
      onScroll={(e) => {
        // smooth で動いている途中の位置は読み手が選んだ位置ではない (動き始めの
        // 末尾付近で末尾を保ち直すと、メッセージへの移動を打ち消す)。
        if (scrollHold.movingTo() !== null) return;
        stickToBottomRef.current = isAtBottom(e.currentTarget);
        // 自分で末尾まで戻ってきたら、また末尾を保持する。
        if (stickToBottomRef.current) scrollHold.toBottom();
      }}
    >
      <header class="room-header">
        <div class="room-header-top">
          <div class="room-title">
            <h2>{room?.title || roomId}</h2>
          </div>
          {room?.archived ? <span class="room-archived-badge">アーカイブ</span> : null}
        </div>
        <div class="member-chips">
          <MemberChip id={ADMIN_ID} room={room} peers={peers} />
          {activeMembers.map((m) => (
            <MemberChip key={m.id} id={m.id} room={room} peers={peers} />
          ))}
        </div>
        {room ? <RoomReadOnlyNote room={room} /> : null}
      </header>
      <div class="timeline">
        {roomHistory === "loading" ? <p class="room-history-status">読み込み中…</p> : null}
        {roomHistory === "error" ? (
          <p class="room-history-status">この room のログを読み込めませんでした</p>
        ) : null}
        {room?.timeline.map((ev, i) => (
          <TimelineItem key={i} event={ev} room={room} peers={peers} now={now} />
        ))}
      </div>
    </main>
  );
}
