// Live tail (DR-0009 addendum, transcript_subscribe): このセッションの
// Timeline が表示されている間だけ subscribe し、タブ切替/セッション切替/
// unmount で unsubscribe する。届いた行は ws.ts の ev:"transcript" ハンドラが
// `timeline/tail` action に変換し、store.ts の applyTimelineTail が
// contiguous なときだけ追記する — この hook は購読の開始/終了だけ管理し、
// フォールドロジックには関与しない。
import { useEffect, useLayoutEffect } from "preact/hooks";
import { useApp } from "../../context.ts";
import type { TimelineState } from "../../store.ts";
import { activeTraceCollector } from "../../trace.ts";
import { useStoreState } from "../../useStore.ts";

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
  // send() は socket が open でない間 reject するので (ws.ts) catch で握り
  // つぶす — 再接続後は次の connStatus 変化でこの effect が再実行され、改めて
  // subscribe するので、ここではエラー表示もリトライも行わない。
  useEffect(() => {
    if (!active || agentActive) return;
    if (connStatus !== "connected") return;
    // Wait for the subscribe before undoing it: the daemon runs this
    // connection's requests concurrently, so an unsubscribe sent while the
    // subscribe is still in flight could be answered first and leave the tail
    // watch installed with nobody reading it.
    const subscribed = ws.transcriptSubscribe(sid).catch(() => {});
    return () => {
      void subscribed.then(() => ws.transcriptUnsubscribe(sid).catch(() => {}));
    };
  }, [active, sid, connStatus, agentActive, ws]);

  // Closes the latency trace started in ws.ts: useLayoutEffect runs once the
  // appended rows are in the document, which is the boundary the trace names
  // dom_commit. (The later scroll settle is deliberately not part of it —
  // markdown/highlight keep resizing for a second after the rows are visible.)
  useLayoutEffect(() => {
    if (timeline.status !== "loaded") return;
    activeTraceCollector()?.noteDomCommit(sid, timeline.end);
  }, [sid, timeline.end, timeline.status]);
}
