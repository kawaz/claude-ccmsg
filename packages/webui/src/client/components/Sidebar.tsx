import type { AppState } from "../store.ts";
import { useApp } from "../context.ts";
import { RoomList } from "./RoomList.tsx";
import { PeerList } from "./PeerList.tsx";

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

export function Sidebar({ state }: { state: AppState }) {
  return (
    <nav id="sidebar" class={state.sidebarOpen ? "open" : undefined}>
      <section id="rooms-panel">
        <h2>Rooms</h2>
        <RoomList state={state} />
      </section>
      <section id="peers-panel">
        <h2>
          Peers <PeersRefreshButton />
        </h2>
        <PeerList peers={state.peers} />
      </section>
    </nav>
  );
}
