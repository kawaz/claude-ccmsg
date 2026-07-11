// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TimelineState } from "../store.ts";
import { useApp } from "../context.ts";
import { useStoreState } from "../useStore.ts";
import { errorMessage, formatClockTime } from "../utils.ts";
import {
  foldGroupLabel,
  groupTimelineLines,
  isUserTextTurn,
  lineByteOffsets,
  parseTranscriptLine,
  scrollPositionToUserTurnIndex,
  type ParsedLine,
  type Segment,
  type TimelineEntry,
} from "../transcript-model.ts";
import { MarkdownView } from "../markdown-view.tsx";

function SegmentView({ segment }: { segment: Segment }) {
  switch (segment.kind) {
    case "text":
      // Markdown rendering (DR-0010) is assistant-only: a user turn's text
      // is what the human actually typed, so it's shown verbatim rather than
      // interpreted as markdown syntax.
      return (
        <div class={"tl-text tl-text-" + segment.role}>
          {segment.role === "assistant" ? <MarkdownView source={segment.text} /> : segment.text}
        </div>
      );
    case "thinking":
      // thinking の中身は markdown (DR-0010 と同じレンダラを再利用)。視覚的な
      // 薄い色は .tl-thinking-body 側で維持する (他の tl-fold-body は JSON dump
      // 用の等幅 pre 表示なので流用しない)。
      return (
        <details class="tl-fold tl-thinking">
          <summary>thinking</summary>
          <div class="tl-thinking-body">
            <MarkdownView source={segment.text} />
          </div>
        </details>
      );
    case "tool-use":
      return (
        <details class="tl-fold">
          <summary>tool_use: {segment.name}</summary>
          <pre class="tl-fold-body">{JSON.stringify(segment.input, null, 2)}</pre>
        </details>
      );
    case "tool-result":
      return (
        <details class="tl-fold">
          <summary>tool_result{segment.isError ? " (error)" : ""}</summary>
          <pre class="tl-fold-body">{segment.text}</pre>
        </details>
      );
    case "unknown-segment":
      return (
        <details class="tl-fold">
          <summary>{segment.type}</summary>
          <pre class="tl-fold-body">{JSON.stringify(segment.raw, null, 2)}</pre>
        </details>
      );
  }
}

function LineView({
  line,
  offsetKey,
  registerUserTurnRef,
}: {
  line: ParsedLine;
  offsetKey: number;
  // Registers/unregisters this line's root element for a user-text turn only
  // (isUserTextTurn) — the "👤 N/M" nav indicator's DOM-measurement side, see
  // Timeline()'s userTurnRefs. No-op for every other line kind.
  registerUserTurnRef: (key: number, el: HTMLDivElement | null) => void;
}) {
  if (line.kind === "broken") {
    return (
      <div class="tl-line tl-broken">
        <pre class="tl-broken-raw">{line.raw || "(空行)"}</pre>
      </div>
    );
  }
  if (line.kind === "meta") {
    return (
      <details class="tl-line tl-meta">
        <summary>
          {line.ts ? <span class="tl-time">{formatClockTime(line.ts)}</span> : null}
          <span class="tl-meta-summary">{line.summary}</span>
        </summary>
        <pre class="tl-fold-body">{line.raw}</pre>
      </details>
    );
  }
  const isUserText = isUserTextTurn(line);
  return (
    <div
      class={"tl-line tl-turn tl-turn-" + line.role}
      ref={isUserText ? (el) => registerUserTurnRef(offsetKey, el) : undefined}
    >
      {line.ts ? <span class="tl-time">{formatClockTime(line.ts)}</span> : null}
      <div class="tl-segments">
        {line.segments.length === 0 ? (
          <span class="tl-empty-turn">(空)</span>
        ) : (
          line.segments.map((seg, i) => <SegmentView key={i} segment={seg} />)
        )}
      </div>
    </div>
  );
}

// Tools folding (kawaz spec): the run of thinking/tool_use/tool_result/meta
// entries between a user prompt and the assistant's next user-facing final
// response, collapsed into one <details> — default-collapsed via the native
// <details> element itself (no manual open/close state to manage, matches
// every other tl-fold in this file), label text from
// transcript-model.ts's foldGroupLabel (grouping/counting stays a pure,
// unit-tested function; this component only renders it).
function FoldGroup({
  entries,
  registerUserTurnRef,
}: {
  entries: TimelineEntry[];
  registerUserTurnRef: (key: number, el: HTMLDivElement | null) => void;
}) {
  return (
    <details class="tl-line tl-fold-group">
      <summary>{foldGroupLabel(entries)}</summary>
      <div class="tl-fold-group-body">
        {entries.map(({ offset, line }) => (
          <LineView
            key={offset}
            line={line}
            offsetKey={offset}
            registerUserTurnRef={registerUserTurnRef}
          />
        ))}
      </div>
    </details>
  );
}

export function Timeline({ sid, timeline }: { sid: string; timeline: TimelineState }) {
  const { store, ws } = useApp();
  const connStatus = useStoreState(store).connStatus;

  // Tail-load on first visit only — re-visiting a session whose Timeline is
  // already "loaded"/"error" must not refetch (mirrors FileViewer's
  // path-keyed effect guard). Gated on connStatus so a direct `#t<sid>` link
  // opened before the WS handshake completes doesn't race ws.send() (rejects
  // synchronously while not open, see ws.ts) — status stays "idle" (still
  // rendered as "読み込み中…" below) until connStatus flips to "connected",
  // which re-evaluates this effect via the dep list.
  useEffect(() => {
    if (timeline.status !== "idle") return;
    if (connStatus !== "connected") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }, [sid, timeline.status, connStatus]);

  function loadOlder() {
    if (timeline.status === "loading" || timeline.atStart) return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid, { before: timeline.start })
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", error: errorMessage(err) });
      });
  }

  // "更新" (refresh): re-reads the tail (before omitted) and replaces the
  // cache wholesale rather than fetching only what's new since `end` — DR-0009
  // offers no cheaper "read what's new" shape (transcript_read has no
  // "after" parameter), and re-reading the tail is simple and correct at the
  // cost of re-fetching content we may already have (implementation
  // simplicity prioritized per the delegated spec).
  function refresh() {
    if (timeline.status === "loading") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws
      .transcriptRead(sid)
      .then((res) => {
        if (res.ok)
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
        else
          store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
      })
      .catch((err) => {
        store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: errorMessage(err) });
      });
  }

  // Re-parsing on every render is cheap (pure JSON.parse over cached
  // strings), but memoizing keeps it off the hot path of unrelated re-renders
  // (e.g. sidebar toggles) that don't change `timeline.lines`.
  const parsed = useMemo(() => timeline.lines.map(parseTranscriptLine), [timeline.lines]);
  // Absolute byte offsets, one per cached line — stable Preact keys across a
  // "load older" prepend (see transcript-model.ts's lineByteOffsets doc).
  const offsets = useMemo(
    () => lineByteOffsets(timeline.start, timeline.lines),
    [timeline.start, timeline.lines],
  );
  // Tools folding (kawaz spec): boundary lines (user prompts / assistant
  // user-facing final responses) stay standalone entries, everything between
  // them collapses into one fold group — see transcript-model.ts's
  // groupTimelineLines doc comment.
  const groups = useMemo(() => groupTimelineLines(parsed, offsets), [parsed, offsets]);

  // --- "👤 N/M" user-turn nav (kawaz spec): toolbar buttons to jump to the
  // top/bottom of the loaded transcript and to the previous/next user-text
  // turn, plus a live "current position" counter. ---

  // Preact-key (byte offset, stable across prepend) of every currently-loaded
  // user-text turn, in document order — the "M" denominator and the index
  // space goPrevUserTurn/goNextUserTurn/scrollPositionToUserTurnIndex work in.
  const userTurnKeys = useMemo(
    () =>
      parsed
        .map((line, i) => (isUserTextTurn(line) ? offsets[i] : null))
        .filter((k): k is number => k !== null),
    [parsed, offsets],
  );

  const scrollRef = useRef<HTMLDivElement | null>(null);
  // key (byte offset) -> mounted DOM node for each user-text turn, populated
  // by LineView's ref callback. Only ever read for keys currently in
  // userTurnKeys; entries for turns dropped by a "更新" (replace) reload are
  // pruned below rather than left to leak.
  const userTurnRefs = useRef(new Map<number, HTMLDivElement>());
  const registerUserTurnRef = useCallback((key: number, el: HTMLDivElement | null) => {
    if (el) userTurnRefs.current.set(key, el);
    else userTurnRefs.current.delete(key);
  }, []);

  // 1-based "you're currently past turn N" count (0 = scrolled above the
  // first loaded user turn). Recomputed on scroll (rAF-throttled) and
  // whenever the loaded lines change (older-load/refresh shift both the
  // denominator and which turn is "current").
  const [currentUserIdx, setCurrentUserIdx] = useState(0);

  const recomputeCurrentUserIdx = useCallback(() => {
    const container = scrollRef.current;
    if (!container) return;
    const containerTop = container.getBoundingClientRect().top;
    const tops = userTurnKeys
      .map((key) => userTurnRefs.current.get(key))
      .filter((el): el is HTMLDivElement => el != null)
      .map((el) => el.getBoundingClientRect().top - containerTop + container.scrollTop);
    setCurrentUserIdx(scrollPositionToUserTurnIndex(tops, container.scrollTop));
  }, [userTurnKeys]);

  useEffect(() => {
    // Drop refs for turns that no longer exist post-reload (a "更新" replace
    // swaps in an entirely new key set) so the Map doesn't accumulate
    // detached nodes across repeated refreshes.
    const validKeys = new Set(userTurnKeys);
    for (const key of userTurnRefs.current.keys()) {
      if (!validKeys.has(key)) userTurnRefs.current.delete(key);
    }

    const container = scrollRef.current;
    if (!container) return;
    let ticking = false;
    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(() => {
        recomputeCurrentUserIdx();
        ticking = false;
      });
    };
    container.addEventListener("scroll", onScroll, { passive: true });
    // Recompute once immediately — otherwise the indicator stays "0/M" until
    // the first scroll event fires (e.g. right after the initial tail load).
    recomputeCurrentUserIdx();
    return () => container.removeEventListener("scroll", onScroll);
  }, [userTurnKeys, recomputeCurrentUserIdx]);

  function scrollToTop() {
    scrollRef.current?.scrollTo({ top: 0, behavior: "smooth" });
  }

  function scrollToBottom() {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }

  function scrollToUserTurn(oneBasedIdx: number) {
    const key = userTurnKeys[oneBasedIdx - 1];
    if (key === undefined) return;
    userTurnRefs.current.get(key)?.scrollIntoView({ behavior: "smooth", block: "start" });
  }

  // No "turn 0" — prev is only meaningful once we've passed at least a
  // second turn (currentUserIdx <= 1 means we're at/before the first).
  function goPrevUserTurn() {
    if (currentUserIdx <= 1) return;
    scrollToUserTurn(currentUserIdx - 1);
  }

  function goNextUserTurn() {
    if (currentUserIdx >= userTurnKeys.length) return;
    scrollToUserTurn(currentUserIdx + 1);
  }

  if (timeline.status === "idle" || (timeline.status === "loading" && parsed.length === 0)) {
    return (
      <div class="timeline-view">
        <p class="tl-loading">読み込み中…</p>
      </div>
    );
  }

  return (
    <div class="timeline-view" ref={scrollRef}>
      <div class="tl-toolbar">
        <button
          type="button"
          disabled={timeline.atStart || timeline.status === "loading"}
          onClick={loadOlder}
        >
          {timeline.atStart ? "先頭まで読み込み済み" : "older を読み込む"}
        </button>
        <button type="button" disabled={timeline.status === "loading"} onClick={refresh}>
          更新
        </button>
        <button type="button" onClick={scrollToTop} title="最上部へ">
          ⤒
        </button>
        <button type="button" onClick={scrollToBottom} title="最下部へ">
          ⤓
        </button>
        <div class="tl-user-nav">
          <span class="tl-user-nav-count">
            👤 {currentUserIdx}/{userTurnKeys.length}
          </span>
          <button
            type="button"
            disabled={currentUserIdx <= 1}
            onClick={goPrevUserTurn}
            title="前のユーザ発言へ"
          >
            ↑
          </button>
          <button
            type="button"
            disabled={currentUserIdx >= userTurnKeys.length}
            onClick={goNextUserTurn}
            title="次のユーザ発言へ"
          >
            ↓
          </button>
        </div>
      </div>
      {timeline.status === "error" ? (
        <div class="tl-error">
          <p>{timeline.error}</p>
          <button type="button" onClick={refresh}>
            再試行 (tail から読み直す)
          </button>
        </div>
      ) : (
        <div class="tl-lines">
          {parsed.length === 0 ? (
            <p class="tl-empty">(空の transcript)</p>
          ) : (
            groups.map((group) =>
              group.kind === "entry" ? (
                <LineView
                  key={group.offset}
                  line={group.line}
                  offsetKey={group.offset}
                  registerUserTurnRef={registerUserTurnRef}
                />
              ) : (
                <FoldGroup
                  key={group.entries[0]!.offset}
                  entries={group.entries}
                  registerUserTurnRef={registerUserTurnRef}
                />
              ),
            )
          )}
        </div>
      )}
    </div>
  );
}
