// Top-level "session" screen (DR-0008 Files pane, DR-0009 Timeline pane).
// Selected via the `#s<sid>[:<path>]` (Files) or `#t<sid>` (Timeline) locator
// (App.tsx routes here instead of RoomView when state.view is "session" or
// "timeline"). Both tabs share one sid-keyed SessionTreeState cache so
// switching tabs never refetches what's already loaded.
import { useEffect, useState } from "preact/hooks";
import type { AppState, SessionTreeState } from "../store.ts";
import { sessionHref, timelineHref } from "../locator.ts";
import { FilesPanes } from "./FilesPanes.tsx";
import { Timeline } from "./Timeline.tsx";
import { SessionRooms } from "./SessionRooms.tsx";
import { OneOnOneComposer } from "./OneOnOneComposer.tsx";

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
  // Rooms is a third tab layered on top of the Files/Timeline locator routing
  // (`#s<sid>` / `#t<sid>`, see locator.ts) rather than a locator form of its
  // own — it has no per-sid persisted sub-state worth round-tripping through
  // the URL (unlike Files' selectedPath or Timeline's paging position), so a
  // local toggle is enough. Clicking Files/Timeline (both real `<a href>`
  // locator links) clears it back to whatever state.view says.
  const [roomsOpen, setRoomsOpen] = useState(false);

  // Reset back to the locator-driven tab (Files/Timeline) on a session
  // switch (adversarial review nit finding): SessionView doesn't remount
  // across a sid change (sidebar navigation just changes `state.currentSid`),
  // so without this a Rooms tab left open before switching sessions would
  // keep showing Rooms for the newly-selected session too, inconsistent with
  // Files/Timeline's locator-driven behavior (every other tab always matches
  // the URL for the session you just navigated to).
  useEffect(() => setRoomsOpen(false), [sid]);

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
  const tab = roomsOpen ? "rooms" : state.view === "timeline" ? "timeline" : "files";
  // Timeline requires the session to have announced+had-validated a
  // transcript_path at hello time (DR-0009 §2); peers is the only place that
  // fact is visible client-side (PeersResponse.transcript_path, absent when
  // the daemon rejected or the session never sent one).
  const peer = state.peers.find((p) => p.sid === sid);
  const hasTranscript = !!peer?.transcript_path;

  return (
    <main id="session-view">
      <div class="session-tabs">
        <a
          class={"session-tab" + (tab === "files" ? " active" : "")}
          href={sessionHref(sid)}
          onClick={() => setRoomsOpen(false)}
        >
          Files
        </a>
        {hasTranscript ? (
          <a
            class={"session-tab" + (tab === "timeline" ? " active" : "")}
            href={timelineHref(sid)}
            onClick={() => setRoomsOpen(false)}
          >
            Timeline
          </a>
        ) : (
          <span class="session-tab disabled" title="このセッションは transcript を申告していません">
            Timeline
          </span>
        )}
        <button
          type="button"
          class={"session-tab" + (tab === "rooms" ? " active" : "")}
          onClick={() => setRoomsOpen(true)}
        >
          Rooms
        </button>
      </div>
      {tab === "rooms" ? (
        <SessionRooms sid={sid} state={state} />
      ) : tab === "timeline" ? (
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
        <FilesPanes sid={sid} tree={tree} peer={peer} />
      )}
      {/* DR-0014 §2.6 floating 1on1 composer: only makes sense on the
       * Files/Timeline tabs (kawaz can already open a room directly from
       * the Rooms tab, so an extra FAB there would be noise). Positioned
       * over the tab content via position:fixed in app.css; each tab
       * switch keeps the same instance so an in-progress compose survives
       * a Files↔Timeline hop. */}
      {tab !== "rooms" ? <OneOnOneComposer sid={sid} state={state} /> : null}
    </main>
  );
}
