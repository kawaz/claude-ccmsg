// Client entry point (DR-0005 §3): served as `/assets/app.js` after a
// serve-time Bun.build bundles this file (and preact) for the browser.
import { render } from "preact";
import { App } from "./components/App.tsx";
import { AppContext } from "./context.ts";
import { createStore } from "./useStore.ts";
import { initialState } from "./store.ts";
import { createWsClient } from "./ws.ts";
import { setupNavigation } from "./navigation.ts";
import {
  migrateLegacySessionBookmarks,
  parseSessionBookmarks,
  SESSION_BOOKMARKS_STORAGE_KEY,
  serializeSessionBookmarks,
} from "./utils.ts";
import { readStorage, writeStorage } from "./storage.ts";
import { importUserscript, startUserscript } from "./userscript.ts";
import {
  clearFilePathCacheForSid,
  configureFilePathExistenceCache,
} from "./filepath-existence-cache.ts";

const store = createStore(initialState());
const ws = createWsClient((action) => store.dispatch(action));

// The person's userscript (DR-0057 §3-§4): read `?userscript=` before
// navigation can rewrite the URL, and run the script once the first
// connection has said one is saved, when this browser runs it.
startUserscript(store, { load: () => ws.userscriptLoad(), importUserscript }, location.search);
setupNavigation(store, ws);
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
// different cwd / repo_root / touched_files snapshot, so cached "positive"
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

// Session bookmarks (DR-0021 §2.4/§3.2, SS-Q2=a): webui-local persistence, not
// daemon-backed — hydrate once from localStorage at startup, then keep it in
// sync on every later add/remove. The reducer itself never touches
// localStorage (DR-0005 §1: effects stay outside the pure state-transition
// path), so this small store.subscribe listener is the effect layer for this
// one slice of state, same role ws.ts's since_seq save-on-change plays for
// the subscribe cursor. Reference-equality check (not deep-equal) is enough:
// every `session-bookmarks/*` reducer branch either returns the SAME Map (no-op, e.g.
// removing a sid that was never bookmarked) or a freshly-constructed one — see
// store.ts's copy-on-write convention used throughout.
migrateLegacySessionBookmarks();
store.dispatch({
  type: "session-bookmarks/hydrated",
  bookmarks: parseSessionBookmarks(readStorage(SESSION_BOOKMARKS_STORAGE_KEY)),
});
let lastSessionBookmarks = store.getState().sessionBookmarks;
store.subscribe(() => {
  const bookmarked = store.getState().sessionBookmarks;
  if (bookmarked === lastSessionBookmarks) return;
  lastSessionBookmarks = bookmarked;
  // storage unavailable — bookmarking still works for the session, just doesn't
  // persist across reload.
  writeStorage(SESSION_BOOKMARKS_STORAGE_KEY, serializeSessionBookmarks(bookmarked.values()));
});

const root = document.getElementById("app-root");
if (!root) throw new Error("missing #app-root mount point");

render(
  <AppContext.Provider value={{ store, ws }}>
    <App />
  </AppContext.Provider>,
  root,
);
