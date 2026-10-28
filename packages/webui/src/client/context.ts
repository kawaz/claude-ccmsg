// Wires the store + WS effect handle into the component tree via preact
// context, so leaf components (Composer, peers-refresh button, ...) can
// dispatch and issue request/response calls (post/peers/read) without prop
// drilling them through every intermediate component.
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { AppState } from "./store.ts";
import { useStoreState, type ReadableStore, type Store } from "./useStore.ts";
import type { WsHandle } from "./ws.ts";

export interface AppContextValue {
  store: Store;
  ws: WsHandle;
}

export const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error("useApp() called outside <AppContext.Provider>");
  return ctx;
}

/** What a view rendered outside the provider (a unit test, the catalog
 * rendered on its own) reads in place of the app's store: no state, ever. */
const NO_APP_STATE: ReadableStore<AppState | null> = {
  getState: () => null,
  subscribe: () => () => {},
};

function selectWebuiUrls(state: AppState | null): readonly string[] | undefined {
  return state?.daemonInfo?.webuiUrls;
}

/** The names this webui is opened at (ping's `webui_urls`, DR-0043 §7), for
 * moving a link that names another of them onto the current origin
 * (`rewriteAliasHref`). Undefined until the daemon has answered, and outside
 * the provider. */
export function useWebuiUrls(): readonly string[] | undefined {
  const app = useContext(AppContext);
  return useStoreState(app?.store ?? NO_APP_STATE, selectWebuiUrls);
}
