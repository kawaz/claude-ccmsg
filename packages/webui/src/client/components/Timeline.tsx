// Transcript Timeline pane for SessionView (DR-0009). Owns the
// transcript_read round trip for the currently-selected session (same
// component-effect division of labor as FileTree/FileViewer for
// fs_list/fs_read) — the reducer only stores what it's told.
import { useEffect, useMemo } from "preact/hooks";
import type { TimelineState } from "../store.ts";
import { useApp } from "../context.ts";
import { formatClockTime } from "../utils.ts";
import {
  lineByteOffsets,
  parseTranscriptLine,
  type ParsedLine,
  type Segment,
} from "../transcript-model.ts";

function SegmentView({ segment }: { segment: Segment }) {
  switch (segment.kind) {
    case "text":
      return <div class={"tl-text tl-text-" + segment.role}>{segment.text}</div>;
    case "thinking":
      return (
        <details class="tl-fold">
          <summary>thinking</summary>
          <pre class="tl-fold-body">{segment.text}</pre>
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

function LineView({ line }: { line: ParsedLine }) {
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
  return (
    <div class={"tl-line tl-turn tl-turn-" + line.role}>
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

export function Timeline({ sid, timeline }: { sid: string; timeline: TimelineState }) {
  const { store, ws } = useApp();

  // Tail-load on first visit only — re-visiting a session whose Timeline is
  // already "loaded"/"error" must not refetch (mirrors FileViewer's
  // path-keyed effect guard).
  useEffect(() => {
    if (timeline.status !== "idle") return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws.transcriptRead(sid).then((res) => {
      if (res.ok) store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
      else store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
    });
  }, [sid, timeline.status]);

  function loadOlder() {
    if (timeline.status === "loading" || timeline.atStart) return;
    store.dispatch({ type: "timeline/loading", sid });
    void ws.transcriptRead(sid, { before: timeline.start }).then((res) => {
      if (res.ok) store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", response: res });
      else store.dispatch({ type: "timeline/loaded", sid, mode: "prepend", error: res.error.msg });
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
    void ws.transcriptRead(sid).then((res) => {
      if (res.ok) store.dispatch({ type: "timeline/loaded", sid, mode: "replace", response: res });
      else store.dispatch({ type: "timeline/loaded", sid, mode: "replace", error: res.error.msg });
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

  if (timeline.status === "idle" || (timeline.status === "loading" && parsed.length === 0)) {
    return (
      <div class="timeline-view">
        <p class="tl-loading">読み込み中…</p>
      </div>
    );
  }

  return (
    <div class="timeline-view">
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
            parsed.map((line, i) => <LineView key={offsets[i]} line={line} />)
          )}
        </div>
      )}
    </div>
  );
}
