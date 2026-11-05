// Live tail (DR-0009 addendum, transcript_subscribe): このセッションの
// Timeline が表示されている間だけ subscribe し、タブ切替/セッション切替/
// unmount で unsubscribe する。届いた行は ws.ts の ev:"transcript" ハンドラが
// `timeline/tail` action に変換し、store.ts の applyTimelineTail が
// contiguous なときだけ追記する — この hook は購読の開始/終了だけ管理し、
// フォールドロジックには関与しない。
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { PeerInfo } from "@ccmsg/protocol";
import { useApp } from "../../context.ts";
import type { TimelineState } from "../../store.ts";
import { activeTraceCollector } from "../../trace.ts";
import { useEffectEvent } from "../../useEffectEvent.ts";
import { sameJson, useStoreState } from "../../useStore.ts";

/** `agentActive` (agent TL) の間は購読しない: agent の transcript には live
 * push が無い (DR-0025 §2.2 "リアルタイム完全進捗はスコープ外" — daemon は
 * セッション自身の subscribe しか提供しない)。購読すると別のファイルを tail
 * し、古い行が byte cache を混乱させる。 */
export function useLiveTailSubscription({
  sid,
  active,
  agentActive,
  timeline,
}: {
  sid: string;
  active: boolean;
  agentActive: boolean;
  timeline: Pick<TimelineState, "status" | "end">;
}): void {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store, (s) => s.connStatus);
  // The session's peer row: the daemon pushes it again (ev:"peers") when the
  // session registers or names its transcript, which is what a refused
  // subscribe waits for.
  const peer = useStoreState(store, (s) => s.peers.find((p) => p.sid === sid), sameJson);
  const [attempt, setAttempt] = useState(0);
  const refusedWith = useRef<{ peer: PeerInfo | undefined } | null>(null);
  const peerNow = useEffectEvent(() => peer);
  // A row that moved while the refused subscribe was out is already the
  // change it waits for.
  const noteRefused = useEffectEvent((asked: PeerInfo | undefined) => {
    if (asked === peer) refusedWith.current = { peer };
    else setAttempt((n) => n + 1);
  });
  // A subscribe the daemon refused (the session not registered yet, or not
  // naming its transcript yet: right after a daemon restart, before the
  // module's hello) is made again once the session's peer row changes.
  useEffect(() => {
    const refused = refusedWith.current;
    if (refused === null || refused.peer === peer) return;
    refusedWith.current = null;
    setAttempt((n) => n + 1);
  }, [peer]);
  // send() は socket が open でない間 reject するので (ws.ts) catch で握り
  // つぶす — 再接続後は次の connStatus 変化でこの effect が再実行され、改めて
  // subscribe する。
  useEffect(() => {
    if (!active || agentActive) return;
    if (connStatus !== "connected") return;
    let current = true;
    const asked = peerNow();
    // ws.ts orders the two per sid: the cleanup's unsubscribe goes out after
    // this subscribe is answered, and a re-entry before then replaces it with
    // the new run's subscribe instead of following it.
    void ws
      .transcriptSubscribe(sid)
      .then((reply) => {
        if (current && !reply.ok) noteRefused(asked);
      })
      .catch(() => {});
    return () => {
      current = false;
      refusedWith.current = null;
      void ws.transcriptUnsubscribe(sid).catch(() => {});
    };
  }, [active, sid, connStatus, agentActive, ws, attempt]);

  // Closes the latency trace started in ws.ts: useLayoutEffect runs once the
  // appended rows are in the document, which is the boundary the trace names
  // dom_commit. (The later scroll settle is deliberately not part of it —
  // markdown/highlight keep resizing for a second after the rows are visible.)
  useLayoutEffect(() => {
    if (timeline.status !== "loaded") return;
    activeTraceCollector()?.noteDomCommit(sid, timeline.end);
  }, [sid, timeline.end, timeline.status]);
}
