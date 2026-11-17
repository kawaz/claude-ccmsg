// Live tail (DR-0009 addendum, transcript_subscribe): このセッションの
// Timeline (agent の TL なら その agent の transcript、DR-0025 §4) が表示されて
// いる間だけ subscribe し、タブ切替/セッション切替/agent の切替/unmount で
// unsubscribe する。届いた行は ws.ts の ev:"transcript" ハンドラが
// `timeline/tail` action に変換し、store.ts の applyTimelineTail が
// contiguous なときだけ追記する — この hook は購読の開始/終了だけ管理し、
// フォールドロジックには関与しない。
import { useEffect, useLayoutEffect, useRef, useState } from "preact/hooks";
import type { PeerInfo } from "@ccmsg/protocol";
import type { AgentRef } from "../../locator.ts";
import { useApp } from "../../context.ts";
import type { TimelineState } from "../../store.ts";
import { activeTraceCollector } from "../../trace.ts";
import { useEffectEvent } from "../../useEffectEvent.ts";
import { sameJson, useStoreState } from "../../useStore.ts";
import { agentTranscriptFields } from "../../ws.ts";

/** `agent` (agent の TL) の間は、その agent の transcript を、transcript_read と
 * 同じ field で名指して購読する。届く行は store がその agent の TL の cache に
 * だけ足す (applyTimelineTail)。 */
export function useLiveTailSubscription({
  sid,
  active,
  agent,
  timeline,
}: {
  sid: string;
  active: boolean;
  agent: AgentRef | null;
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
  // Keyed on the ref's fields rather than the object: the store hands a new
  // AgentRef on every locator change, the same agent included.
  const agentId = agent?.agentId;
  const agentRunId = agent?.runId;
  const agentTeammate = agent?.teammate;
  useEffect(() => {
    if (!active) return;
    if (connStatus !== "connected") return;
    let current = true;
    const asked = peerNow();
    const fields = agentTranscriptFields({ agentId, runId: agentRunId, teammate: agentTeammate });
    // ws.ts orders the two per sid: the cleanup's unsubscribe goes out after
    // this subscribe is answered, and a re-entry before then replaces it with
    // the new run's subscribe instead of following it.
    void ws
      .transcriptSubscribe(sid, fields)
      .then((reply) => {
        if (current && !reply.ok) noteRefused(asked);
      })
      .catch(() => {});
    return () => {
      current = false;
      refusedWith.current = null;
      void ws.transcriptUnsubscribe(sid, fields).catch(() => {});
    };
  }, [active, sid, connStatus, agentId, agentRunId, agentTeammate, ws, attempt]);

  // Closes the latency trace started in ws.ts: useLayoutEffect runs once the
  // appended rows are in the document, which is the boundary the trace names
  // dom_commit. (The later scroll settle is deliberately not part of it —
  // markdown/highlight keep resizing for a second after the rows are visible.)
  useLayoutEffect(() => {
    if (timeline.status !== "loaded") return;
    activeTraceCollector()?.noteDomCommit(sid, timeline.end);
  }, [sid, timeline.end, timeline.status]);
}
