// Minimal external store (Elm/Flux "store" half of DR-0005 §1) plus a preact
// hook to subscribe a component to it. Deliberately not redux/zustand: the
// whole point of the DR is a tiny, dependency-free typed store.
import { useEffect, useState } from "preact/hooks";
import type { Action, AppState } from "./store.ts";
import { reducer } from "./store.ts";

export interface Store {
  getState(): AppState;
  dispatch(action: Action): void;
  subscribe(listener: () => void): () => void;
}

export function createStore(initial: AppState): Store {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getState: () => state,
    dispatch(action) {
      state = reducer(state, action);
      for (const listener of listeners) listener();
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** Re-renders the calling component whenever the store's state changes. */
export function useStoreState(store: Store): AppState {
  const [state, setState] = useState(store.getState());
  useEffect(() => store.subscribe(() => setState(store.getState())), [store]);
  return state;
}
