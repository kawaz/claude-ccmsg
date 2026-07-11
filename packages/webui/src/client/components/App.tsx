import { useStoreState } from "../useStore.ts";
import { useApp } from "../context.ts";
import { ConnectionStatus } from "./ConnectionStatus.tsx";
import { Sidebar } from "./Sidebar.tsx";
import { RoomView } from "./RoomView.tsx";
import { SessionView } from "./SessionView.tsx";

export function App() {
  const { store } = useApp();
  const state = useStoreState(store);

  return (
    <div id="app">
      <header id="topbar">
        <button
          id="menu-toggle"
          type="button"
          aria-label="menu"
          onClick={() => store.dispatch({ type: "sidebar/set", open: !state.sidebarOpen })}
        >
          &#9776;
        </button>
        <h1>ccmsg</h1>
        <ConnectionStatus status={state.connStatus} />
      </header>
      <div id="layout">
        <Sidebar state={state} />
        <div
          id="sidebar-backdrop"
          class={state.sidebarOpen ? "visible" : undefined}
          onClick={() => store.dispatch({ type: "sidebar/set", open: false })}
        />
        {state.view === "session" || state.view === "timeline" ? (
          <SessionView state={state} />
        ) : (
          <RoomView state={state} />
        )}
      </div>
      <footer id="app-footer">
        {state.daemonInfo ? (
          <span title={state.daemonInfo.exe ?? undefined}>
            daemon v{state.daemonInfo.version}
            {state.daemonInfo.script ? ` · ${state.daemonInfo.script}` : ""}
          </span>
        ) : null}
      </footer>
    </div>
  );
}
