import { useMemo, useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import { selectedSid } from "../store.ts";
import { useApp } from "../context.ts";
import { nextPeerSortKey, peerSortButtonLabel, sortPeers, type PeerSortKey } from "../utils.ts";
import { readStorage, writeStorage } from "../storage.ts";
import { RoomList } from "./RoomList.tsx";
import { SessionCreator } from "./SessionCreator.tsx";
import { SessionList } from "./SessionList.tsx";
import { SessionSearchPanel } from "./SessionSearchPanel.tsx";

const SORT_KEY_STORAGE = "ccmsg.peerSortKey";

function loadSortKey(): PeerSortKey {
  const raw = readStorage(SORT_KEY_STORAGE);
  if (raw === "name" || raw === "idle" || raw === "connected") return raw;
  return "name";
}

function saveSortKey(key: PeerSortKey): void {
  writeStorage(SORT_KEY_STORAGE, key);
}

function PeersRefreshButton() {
  const { store, ws } = useApp();
  return (
    <button
      id="peers-refresh"
      type="button"
      title="refresh"
      onClick={() =>
        void ws.peers().then((res) => {
          if (res.ok) store.dispatch({ type: "peers/loaded", peers: res.peers });
        })
      }
    >
      &#8635;
    </button>
  );
}

function PeersSortButton({ sortKey, onCycle }: { sortKey: PeerSortKey; onCycle: () => void }) {
  // Labels are name/created/recent (kawaz 2026-07-16: "わかりづらい。
  // name/created/recent にして"); "click for X" names the *next* key in
  // PEER_SORT_CYCLE's order (name -> connected -> idle -> name).
  const titles: Record<PeerSortKey, string> = {
    name: "sorted by name (repo · ws · branch) — click for created",
    connected: "sorted by connect time (most recently connected first) — click for recent",
    idle: "sorted by idle time (most recently active first) — click for name",
  };
  return (
    <button id="peers-sort" type="button" title={titles[sortKey]} onClick={onCycle}>
      {peerSortButtonLabel(sortKey)}
    </button>
  );
}

function SearchToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="session-search-toggle"
      type="button"
      title={open ? "検索を閉じる" : "過去セッションを検索 (DR-0021)"}
      aria-pressed={open}
      onClick={onToggle}
    >
      🔍
    </button>
  );
}

/** DR-0018 §2.1 "+ 新規" affordance — same chromeless toggle-button family as
 * SearchToggleButton (see its sibling doc comment on Sidebar for why this is
 * a panel toggle, not a `state.view`). Always rendered regardless of whether
 * session_launcher is configured (DR-0018 §2.1's "launcher 未設定時" branch
 * (b) — SessionCreator itself probes on open and shows setup guidance
 * instead of the form, rather than this button disappearing/needing its own
 * probe just to decide whether to render at all). */
function CreatorToggleButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      id="session-creator-toggle"
      type="button"
      title={open ? "新規セッションを閉じる" : "新規セッションを起動 (DR-0018)"}
      aria-pressed={open}
      onClick={onToggle}
    >
      + 新規
    </button>
  );
}

/** Sidebar SESSIONS section (DR-0021 Phase 2 SS-Q1/Q2 doc note): search is a
 * sidebar-internal panel toggle (local `showSearch` state below), NOT a
 * fourth `state.view`/URL-locator form alongside room/session/timeline. The
 * locator forms in locator.ts each name something durable and shareable —
 * "this room", "this session's Files at this path", "this session's
 * Timeline" — whereas a search is a disposable tool for finding and pinning
 * a session, with no useful "resume this exact search" bookmark semantics.
 * Toggling it swaps out `<SessionList>` for `<SessionSearchPanel>` in place;
 * everything else (Rooms panel, the tab layout, the URL) is untouched. The
 * Pinned section DR-0021 §2.4 asks for lives inside SessionList itself (see
 * its doc comment) — it's a permanent part of the normal session list, not
 * something the search toggle owns.
 *
 * DR-0018's "+ 新規" (SessionCreator) reuses this exact pattern (own
 * `showCreator` local state below, same panel-swap-in-place shape) rather
 * than adding a third parallel toggle track — opening one closes the other
 * so only one of SessionList/SessionSearchPanel/SessionCreator ever occupies
 * this section at a time. */
export function Sidebar({ state }: { state: AppState }) {
  const [sortKey, setSortKey] = useState<PeerSortKey>(loadSortKey);
  const [showSearch, setShowSearch] = useState(false);
  const [showCreator, setShowCreator] = useState(false);
  // Sorting only ever depends on the peers array reference and the chosen
  // key — never on wall-clock time — so a session list re-render triggered
  // purely by SessionList's idle-time tick doesn't reshuffle rows (see
  // sortPeers's doc comment in utils.ts and SessionList.tsx's tick).
  const sortedPeers = useMemo(() => sortPeers(state.peers, sortKey), [state.peers, sortKey]);

  return (
    <nav id="sidebar" class={state.sidebarOpen ? "open" : undefined}>
      <section id="rooms-panel">
        <h2>Rooms</h2>
        <RoomList state={state} />
      </section>
      <section id="sessions-panel">
        <h2>
          Sessions{" "}
          <CreatorToggleButton
            open={showCreator}
            onToggle={() =>
              setShowCreator((v) => {
                if (!v) setShowSearch(false);
                return !v;
              })
            }
          />{" "}
          <SearchToggleButton
            open={showSearch}
            onToggle={() =>
              setShowSearch((v) => {
                if (!v) setShowCreator(false);
                return !v;
              })
            }
          />{" "}
          <PeersSortButton
            sortKey={sortKey}
            onCycle={() => {
              const next = nextPeerSortKey(sortKey);
              setSortKey(next);
              saveSortKey(next);
            }}
          />{" "}
          <PeersRefreshButton />
        </h2>
        {showCreator ? (
          <SessionCreator onClose={() => setShowCreator(false)} />
        ) : showSearch ? (
          <SessionSearchPanel onClose={() => setShowSearch(false)} />
        ) : (
          <SessionList peers={sortedPeers} currentSid={selectedSid(state)} />
        )}
      </section>
    </nav>
  );
}
