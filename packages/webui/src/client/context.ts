// Wires the store + WS effect handle into the component tree via preact
// context, so leaf components (Composer, peers-refresh button, ...) can
// dispatch and issue request/response calls (post/peers/read) without prop
// drilling them through every intermediate component.
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { Store } from "./useStore.ts";
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
