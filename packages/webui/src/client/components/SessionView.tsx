// Top-level "session" screen (DR-0008 Files pane, DR-0009 Timeline pane).
// Selected via the `#s<sid>[:<path>]` (Files) or `#t<sid>` (Timeline) locator
// (App.tsx routes here instead of RoomView when state.view is "session" or
// "timeline"). Both tabs share one sid-keyed SessionTreeState cache so
// switching tabs never refetches what's already loaded.
import type { AppState, SessionTreeState } from "../store.ts";
import { sessionHref, timelineHref } from "../locator.ts";
import { FileTree } from "./FileTree.tsx";
import { FileViewer } from "./FileViewer.tsx";
import { Timeline } from "./Timeline.tsx";

const EMPTY_TREE: SessionTreeState = {
  dirs: new Map(),
  dirErrors: new Map(),
  expanded: new Set(),
  selectedPath: null,
  file: null,
  timeline: { status: "idle", lines: [], start: 0, end: 0, size: 0, atStart: false },
};

export function SessionView({ state }: { state: AppState }) {
  const sid = state.currentSid;

  if (!sid) {
    return (
      <main id="session-view">
        <p id="empty-state">session を選んでください</p>
      </main>
    );
  }

  // The reducer always creates a tree on the locator/changed that sets
  // currentSid, so this fallback is type-safety only, never hit in practice.
  const tree = state.sessionTrees.get(sid) ?? EMPTY_TREE;
  const tab = state.view === "timeline" ? "timeline" : "files";
  // Timeline requires the session to have announced+had-validated a
  // transcript_path at hello time (DR-0009 §2); peers is the only place that
  // fact is visible client-side (PeersResponse.transcript_path, absent when
  // the daemon rejected or the session never sent one).
  const hasTranscript = state.peers.some((p) => p.sid === sid && p.transcript_path);

  return (
    <main id="session-view">
      <div class="session-tabs">
        <a class={"session-tab" + (tab === "files" ? " active" : "")} href={sessionHref(sid)}>
          Files
        </a>
        {hasTranscript ? (
          <a class={"session-tab" + (tab === "timeline" ? " active" : "")} href={timelineHref(sid)}>
            Timeline
          </a>
        ) : (
          <span class="session-tab disabled" title="このセッションは transcript を申告していません">
            Timeline
          </span>
        )}
      </div>
      {tab === "timeline" ? (
        // Guard against a stale/hand-typed `#t<sid>` link outliving the
        // session's transcript announcement (e.g. reconnect without hello
        // re-sending transcript_path) — the disabled tab above already tells
        // the user why, so the pane falls back to the same explanation
        // rather than calling ws.transcriptRead for a session we know lacks one.
        hasTranscript ? (
          <Timeline sid={sid} timeline={tree.timeline} />
        ) : (
          <p id="empty-state">このセッションは transcript を申告していません</p>
        )
      ) : (
        <div class="session-panes">
          <FileTree sid={sid} tree={tree} />
          <FileViewer sid={sid} tree={tree} />
        </div>
      )}
    </main>
  );
}
