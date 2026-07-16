import { useMemo, useState } from "preact/hooks";
import type { AppState } from "../store.ts";
import { selectedSid } from "../store.ts";
import { useApp } from "../context.ts";
import { nextPeerSortKey, peerSortButtonLabel, sortPeers, type PeerSortKey } from "../utils.ts";
import { RoomList } from "./RoomList.tsx";
import { SessionList } from "./SessionList.tsx";

const SORT_KEY_STORAGE = "ccmsg.peerSortKey";

function loadSortKey(): PeerSortKey {
  try {
    const raw = localStorage.getItem(SORT_KEY_STORAGE);
    if (raw === "name" || raw === "idle" || raw === "connected") return raw;
  } catch {
    // storage unavailable (private mode) — fall through to default
  }
  return "name";
}

function saveSortKey(key: PeerSortKey): void {
  try {
    localStorage.setItem(SORT_KEY_STORAGE, key);
  } catch {
    // storage unavailable — the button still works, just doesn't persist
  }
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

export function Sidebar({ state }: { state: AppState }) {
  const [sortKey, setSortKey] = useState<PeerSortKey>(loadSortKey);
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
        <SessionList peers={sortedPeers} currentSid={selectedSid(state)} />
      </section>
    </nav>
  );
}
