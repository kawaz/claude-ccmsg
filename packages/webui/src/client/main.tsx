// Client entry point (DR-0005 §3): served as `/assets/app.js` after a
// serve-time Bun.build bundles this file (and preact) for the browser.
import { render } from "preact";
import { App } from "./components/App.tsx";
import { AppContext } from "./context.ts";
import { createStore } from "./useStore.ts";
import { initialState } from "./store.ts";
import { createWsClient } from "./ws.ts";
import { parseHash } from "./locator.ts";
import { parsePinnedSessions, PINNED_SESSIONS_STORAGE_KEY } from "./utils.ts";
import { readStorage, writeStorage } from "./storage.ts";
import {
  clearFilePathCacheForSid,
  configureFilePathExistenceCache,
} from "./filepath-existence-cache.ts";

const store = createStore(initialState());
const ws = createWsClient(
  (action) => store.dispatch(action),
  () => store.getState(),
);

function applyLocator(): void {
  const locator = parseHash(location.hash);
  store.dispatch({ type: "locator/changed", locator });
}

window.addEventListener("hashchange", applyLocator);
applyLocator();
ws.connect();

// kawaz r46 m55-m58: wire the message-body path linkifier's cache to the WS
// so TimelineItem's `enqueueFilePathProbe` calls flush into fs_stat_batch.
// Kept out of ws.ts / store.ts to keep those modules unaware of the linker
// — this is the one place both dependencies are known simultaneously. The
// error path collapses to per-path null so a daemon-side failure never
// blocks the render (matches the cache's own contract).
configureFilePathExistenceCache(async (sid, paths) => {
  const res = await ws.fsStatBatch(sid, paths);
  return res.ok ? res.results : paths.map(() => null);
});
// A session that disconnects (peers stream drops it) may reconnect with a
// different cwd / repo_root / external_files snapshot, so cached "positive"
// answers become stale. Clear on peer-set shrink — new peers keep their
// existing cache (session snapshot is unchanged for them).
let lastPeerSids = new Set<string>();
store.subscribe(() => {
  const current = new Set(store.getState().peers.map((p) => p.sid));
  for (const sid of lastPeerSids) {
    if (!current.has(sid)) clearFilePathCacheForSid(sid);
  }
  lastPeerSids = current;
});

// Pinned sessions (DR-0021 §2.4/§3.2, SS-Q2=a): webui-local persistence, not
// daemon-backed — hydrate once from localStorage at startup, then keep it in
// sync on every later add/remove. The reducer itself never touches
// localStorage (DR-0005 §1: effects stay outside the pure state-transition
// path), so this small store.subscribe listener is the effect layer for this
// one slice of state, same role ws.ts's since_seq save-on-change plays for
// the subscribe cursor. Reference-equality check (not deep-equal) is enough:
// every `pinned/*` reducer branch either returns the SAME Map (no-op, e.g.
// removing a sid that was never pinned) or a freshly-constructed one — see
// store.ts's copy-on-write convention used throughout.
store.dispatch({
  type: "pinned/hydrated",
  hits: parsePinnedSessions(readStorage(PINNED_SESSIONS_STORAGE_KEY)),
});
let lastPinned = store.getState().pinnedSessions;
store.subscribe(() => {
  const pinned = store.getState().pinnedSessions;
  if (pinned === lastPinned) return;
  lastPinned = pinned;
  // storage unavailable — pinning still works for the session, just doesn't
  // persist across reload.
  writeStorage(PINNED_SESSIONS_STORAGE_KEY, JSON.stringify([...pinned.values()]));
});

const root = document.getElementById("app-root");
if (!root) throw new Error("missing #app-root mount point");

render(
  <AppContext.Provider value={{ store, ws }}>
    <App />
  </AppContext.Provider>,
  root,
);
