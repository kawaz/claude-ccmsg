// Timeline の transcript_read: 初回の読み込み、tail のずれの追いつき、訪れた
// 時の追いつき、older、更新。応答は世代付きで store に流し、reducer が今の
// 要求への応答だけを取り込む (request-generation.ts)。
import { useEffect, useMemo } from "preact/hooks";
import { useApp } from "../../context.ts";
import type { AgentRef } from "../../locator.ts";
import { nextRequestGeneration } from "../../request-generation.ts";
import type { TimelineState } from "../../store.ts";
import { useEffectEvent } from "../../useEffectEvent.ts";
import { useStoreState, type Store } from "../../useStore.ts";
import { errorMessage } from "../../utils.ts";
import type { WsHandle } from "../../ws.ts";

type ReadOpts = Parameters<WsHandle["transcriptRead"]>[1];

/** One transcript_read for the Timeline's cache, tagged with a fresh request
 * generation (request-generation.ts): `started` records the generation (and,
 * for "timeline/loading", blanks the pane), and the answer is dispatched with
 * the same generation, so the reducer drops it if another read for this sid
 * started meanwhile (another agent, a refresh, load-older). Resolves once the
 * answer has been dispatched, whether or not the reducer kept it. */
function readTranscriptIntoStore(
  store: Store,
  ws: WsHandle,
  sid: string,
  read: {
    started: "timeline/loading" | "timeline/resyncing";
    mode: "replace" | "prepend";
    opts: ReadOpts;
  },
): Promise<void> {
  const generation = nextRequestGeneration();
  const { mode } = read;
  store.dispatch({ type: read.started, sid, generation });
  return ws
    .transcriptRead(sid, read.opts)
    .then((res) => {
      if (res.ok) store.dispatch({ type: "timeline/loaded", sid, generation, mode, response: res });
      else store.dispatch({ type: "timeline/loaded", sid, generation, mode, error: res.error.msg });
    })
    .catch((err) => {
      store.dispatch({ type: "timeline/loaded", sid, generation, mode, error: errorMessage(err) });
    });
}

/** Catch the cache up with what was written after its `end`: an `after`
 * read (DR-0009 §3) appended behind what is cached, so the lines already
 * shown — older pages included — stay, and only what is new travels. Pages
 * on while the reply says more follows. A transcript that does not continue
 * from `end` (replaced, cut short) is read again from its tail instead.
 * Starts with `timeline/resyncing`: the pane keeps showing the cache while
 * it catches up. */
async function appendTranscriptIntoStore(
  store: Store,
  ws: WsHandle,
  sid: string,
  after: number,
  opts: ReadOpts,
): Promise<void> {
  const generation = nextRequestGeneration();
  store.dispatch({ type: "timeline/resyncing", sid, generation });
  const mode = "append";
  let res: Awaited<ReturnType<WsHandle["transcriptRead"]>>;
  try {
    res = await ws.transcriptRead(sid, { ...opts, after });
  } catch (err) {
    store.dispatch({ type: "timeline/loaded", sid, generation, mode, error: errorMessage(err) });
    return;
  }
  if (!res.ok) {
    store.dispatch({ type: "timeline/loaded", sid, generation, mode, error: res.error.msg });
    return;
  }
  if (res.start !== after) {
    if (store.getState().sessionTrees.get(sid)?.timeline.generation !== generation) return;
    await readTranscriptIntoStore(store, ws, sid, {
      started: "timeline/resyncing",
      mode: "replace",
      opts,
    });
    return;
  }
  store.dispatch({ type: "timeline/loaded", sid, generation, mode, response: res });
  const timeline = store.getState().sessionTrees.get(sid)?.timeline;
  const more = res.end > after && res.end < res.size;
  if (more && timeline?.generation === generation && timeline.end === res.end) {
    await appendTranscriptIntoStore(store, ws, sid, res.end, opts);
  }
}

/** `agent` を渡すと、`sid` の下のその agent の transcript を読む (DR-0025
 * Phase 2)。store の `applyLocatorChanged` は agent が変わるたびに sid の
 * TimelineState を作り直すので、agent を切り替えると初回の読み込みからやり
 * 直しになる。 */
export function useTranscriptLoader({
  sid,
  agent,
  active,
  timeline,
}: {
  sid: string;
  agent: AgentRef | null | undefined;
  active: boolean;
  timeline: TimelineState;
}): {
  /** 読み込み済みの先頭より前を 1 ページ読んで前に足す。 */
  loadOlder: () => void;
  /** tail を読み直して丸ごと置き換える。読み込み中なら何もせず null。 */
  refresh: () => Promise<void> | null;
} {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store, (s) => s.connStatus);

  // Build the transcriptRead opts once so every call site below stays in sync.
  // Keyed on the ref's fields rather than the object: the store hands a new
  // AgentRef on every locator change, the same agent included.
  const hasAgent = !!agent;
  const agentId = agent?.agentId;
  const agentRunId = agent?.runId;
  const agentTeammate = agent?.teammate;
  const agentOpts = useMemo(() => {
    if (!hasAgent) return undefined;
    return {
      ...(agentId ? { agent_id: agentId } : {}),
      ...(agentRunId ? { run_id: agentRunId } : {}),
      ...(agentTeammate ? { teammate: agentTeammate } : {}),
    };
  }, [hasAgent, agentId, agentRunId, agentTeammate]);

  // Tail-load on first visit only — re-visiting a session whose Timeline is
  // already "loaded"/"error" must not refetch (mirrors FileViewer's
  // path-keyed effect guard). Gated on connStatus so a direct `#t<sid>` link
  // opened before the WS handshake completes doesn't race ws.send() (rejects
  // synchronously while not open, see ws.ts) — status stays "idle" (still
  // rendered as "読み込み中…") until connStatus flips to "connected", which
  // re-evaluates this effect via the dep list.
  useEffect(() => {
    if (!active || timeline.status !== "idle") return;
    if (connStatus !== "connected") return;
    void readTranscriptIntoStore(store, ws, sid, {
      started: "timeline/loading",
      mode: "replace",
      opts: agentOpts,
    });
  }, [active, sid, timeline.status, connStatus, store, ws, agentOpts]);

  // Resync on a non-contiguous tail push (DR-0009 addendum): applyTimelineTail
  // (store.ts) can only detect that a `timeline/tail` push doesn't line up
  // with the cached `end` — it can't fetch, so it flags `timeline.needsResync`
  // instead of just dropping the push and leaving live tail silently stuck
  // (DR-0005 §1: side effects stay out of the reducer). This effect is the
  // side effect: an invisible catch-up from the cached `end`
  // (appendTranscriptIntoStore). If more was appended by the time it lands,
  // the next tail push re-flags needsResync and this effect fires again.
  const resyncEnd = useEffectEvent(() => timeline.end);
  useEffect(() => {
    if (!active || !timeline.needsResync) return;
    if (connStatus !== "connected") return;
    void appendTranscriptIntoStore(store, ws, sid, resyncEnd(), agentOpts);
  }, [active, sid, timeline.needsResync, connStatus, store, ws, agentOpts]);

  // Auto-refresh on Timeline visit (TLR-Q1=b裁定, issue
  // 2026-07-14-session-tl-refresh-on-revisit): SessionTreeState's timeline
  // cache is intentionally preserved across tab/session switches (store.ts's
  // newSessionTree — clicking Files/Rooms and returning must not discard
  // what's already loaded), but the transcript_subscribe is torn down
  // alongside the Timeline's unmount. Any live-tail updates that landed
  // while the Timeline was unmounted never reached the cache, so a revisit
  // sees an `end` byte frozen at unmount time — the symptom kawaz observed
  // (SessionView Timeline "空だったり", r12 mid=12 2026-07-14). This effect
  // re-reads the tail once per "arrival at a Timeline to look at" so the
  // stale cache is caught up before the user sees it.
  //
  // - Skipped when status is "idle" (initial-load effect above owns first
  //   visit) or "loading" (a fetch is already in flight; overlapping it
  //   would just collide on the same replace dispatch).
  // - The arrival (Timeline mounts / becomes active / a reconnect lands) is
  //   what fires this, NOT a timeline.status change: reacting to the
  //   loading→loaded flip caused by our own fetch would loop. So the status
  //   gate (and the agent opts) are read in an Effect Event, which sees the
  //   current values without being a reason to re-run.
  // - A loaded cache catches up from its `end` (appendTranscriptIntoStore):
  //   only what was written meanwhile travels, and what the reader had
  //   loaded — older pages included — stays on screen. A cache that ended in
  //   an error has nothing to continue and reads the tail again.
  const revalidateOnArrival = useEffectEvent(() => {
    if (timeline.status === "loaded") {
      void appendTranscriptIntoStore(store, ws, sid, timeline.end, agentOpts);
      return;
    }
    if (timeline.status !== "error") return;
    void readTranscriptIntoStore(store, ws, sid, {
      started: "timeline/loading",
      mode: "replace",
      opts: agentOpts,
    });
  });
  useEffect(() => {
    if (!active || connStatus !== "connected") return;
    revalidateOnArrival();
  }, [active, sid, connStatus]);

  // max_bytes is left out, as on the tail read: a `before` read is sized by
  // the daemon's clamp for it (TRANSCRIPT_READ_OLDER_MAX_BYTES), so the page
  // size is stated once, in protocol.
  function loadOlder() {
    if (timeline.status === "loading" || timeline.atStart) return;
    void readTranscriptIntoStore(store, ws, sid, {
      started: "timeline/loading",
      mode: "prepend",
      opts: { ...agentOpts, before: timeline.start },
    });
  }

  // "更新" (refresh): the reader's explicit reload — re-reads the tail (before
  // omitted) and replaces the cache wholesale, rather than catching up from
  // `end` as an arrival does: it is also the way back from a cache the
  // reader no longer trusts.
  function refresh(): Promise<void> | null {
    if (timeline.status === "loading") return null;
    return readTranscriptIntoStore(store, ws, sid, {
      started: "timeline/loading",
      mode: "replace",
      opts: agentOpts,
    });
  }

  return { loadOlder, refresh };
}
