// Client entry point (DR-0005 §3): served as `/assets/app.js` after a
// serve-time Bun.build bundles this file (and preact) for the browser.
import { render } from "preact";
import { App } from "./components/App.tsx";
import { AppContext } from "./context.ts";
import { createStore } from "./useStore.ts";
import { initialState } from "./store.ts";
import { createWsClient } from "./ws.ts";
import { parseHash } from "./locator.ts";

const store = createStore(initialState());
const ws = createWsClient((action) => store.dispatch(action));

function applyLocator(): void {
  const locator = parseHash(location.hash);
  store.dispatch({ type: "locator/changed", locator });
}

window.addEventListener("hashchange", applyLocator);
applyLocator();
ws.connect();

const root = document.getElementById("app-root");
if (!root) throw new Error("missing #app-root mount point");

render(
  <AppContext.Provider value={{ store, ws }}>
    <App />
  </AppContext.Provider>,
  root,
);
