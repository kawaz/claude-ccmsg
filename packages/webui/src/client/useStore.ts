// Minimal external store (Elm/Flux "store" half of DR-0005 §1) plus a preact
// hook to subscribe a component to a slice of it. Deliberately not
// redux/zustand: the whole point of the DR is a tiny, dependency-free typed
// store.
import { useSyncExternalStore } from "preact/compat";
import { useCallback, useLayoutEffect, useMemo, useRef } from "preact/hooks";
import type { Action, AppState } from "./store.ts";
import { reducer } from "./store.ts";

/** The read side of an external store — what {@link useStoreState} subscribes
 * to. The app store is one; small module-level stores (raw-view-mode.ts) are
 * others, so they all subscribe through the same hook. */
export interface ReadableStore<S> {
  getState(): S;
  subscribe(listener: () => void): () => void;
}

export interface Store extends ReadableStore<AppState> {
  dispatch(action: Action): void;
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

/** A {@link Store} that can hold its change notifications — what
 * {@link pausableStore} returns. */
export interface PausableStore extends Store {
  /** Stop notifying the listeners subscribed here. */
  pause(): void;
  /** Notify again, and notify once now if a dispatch was held meanwhile. */
  resume(): void;
}

/**
 * `base` seen by a part of the page that stays mounted while hidden (a session
 * view the LRU keeps): state and dispatch pass straight through, and only the
 * notifications to the listeners subscribed here can be held. While paused,
 * the components reading through it do not render for changes nobody can
 * see; on resume each of them checks its slice against the current state, so
 * what changed while hidden shows up in one go. `getState` is never held:
 * whatever renders or runs for another reason reads the current state.
 */
export function pausableStore(base: Store): PausableStore {
  let paused = false;
  let held = false;
  const listeners = new Set<() => void>();
  return {
    getState: () => base.getState(),
    dispatch: (action) => base.dispatch(action),
    subscribe(listener) {
      listeners.add(listener);
      const unsubscribe = base.subscribe(() => {
        if (paused) held = true;
        else listener();
      });
      return () => {
        listeners.delete(listener);
        unsubscribe();
      };
    },
    pause() {
      paused = true;
    },
    resume() {
      paused = false;
      if (!held) return;
      held = false;
      for (const listener of listeners) listener();
    },
  };
}

/**
 * The slice `selector` picks out of `store`, re-rendering the calling
 * component only when that slice changes (by `isEqual`, `Object.is` by
 * default) — a dispatch that leaves the slice equal does not render it.
 *
 * Reads through `useSyncExternalStore`, so the first render and the
 * subscription see the same state: a dispatch landing between them is caught
 * when the subscription starts rather than lost.
 *
 * A selector may build a new value on every call (`{ a: s.a, b: s.b }`, a
 * `find` over an array the reducer replaces whole) when `isEqual` recognises
 * equal ones: the previous selection is then handed back, so the snapshot
 * useSyncExternalStore compares stays the same reference. Without that, a
 * fresh object per call reads as a change on every check (react.dev
 * "useSyncExternalStore": getSnapshot must return the same value while the
 * store has not changed).
 *
 * Design rationale: the selection last committed is kept in a ref and read
 * by the snapshot function, which useSyncExternalStore calls during render
 * — react.dev otherwise keeps ref reads out of render. It is what lets an
 * inline selector (a new closure every render, typically over a prop like
 * `sid`) keep handing back the committed reference for an equal slice; the
 * ref is only written after commit. React's own
 * `use-sync-external-store/with-selector` is built the same way.
 */
export function useStoreState<S, T>(
  store: ReadableStore<S>,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const committed = useRef<{ selection: T } | null>(null);
  const getSelection = useMemo(
    () => selectionReader(store, selector, isEqual, () => committed.current),
    [store, selector, isEqual],
  );
  const subscribe = useCallback((listener: () => void) => store.subscribe(listener), [store]);
  const selection = useSyncExternalStore(subscribe, getSelection);
  useLayoutEffect(() => {
    committed.current = { selection };
  }, [selection]);
  return selection;
}

/** The snapshot function {@link useStoreState} hands useSyncExternalStore:
 * `selector` over the store's current state, run again only when the state
 * object changes, and answering with the earlier selection — the one this
 * reader last returned, else `committed()` (what the component last
 * rendered) — whenever `isEqual` finds the new one equal to it. */
export function selectionReader<S, T>(
  store: ReadableStore<S>,
  selector: (state: S) => T,
  isEqual: (a: T, b: T) => boolean,
  committed: () => { selection: T } | null,
): () => T {
  let memo: { state: S; selection: T } | null = null;
  return () => {
    const state = store.getState();
    if (memo !== null && Object.is(memo.state, state)) return memo.selection;
    const next = selector(state);
    const previous = memo ?? committed();
    const selection =
      previous !== null && isEqual(previous.selection, next) ? previous.selection : next;
    memo = { state, selection };
    return selection;
  };
}

/** Equality for a selector that gathers several fields into one object:
 * the same keys, each holding the same value by `Object.is`. */
export function shallowEqual<T extends object>(a: T, b: T): boolean {
  if (Object.is(a, b)) return true;
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every(
    (key) => Object.hasOwn(b, key) && Object.is(Reflect.get(a, key), Reflect.get(b, key)),
  );
}

/** Equality for wire records (plain JSON data: no Map / Set / Date / class
 * instance) picked out of a collection the reducer replaces whole on every
 * push — `peers`, `agents`, `llmRequests`. Each push brings new objects for
 * every row, so identity says nothing about whether the row a component reads
 * changed; the content does. Rows come out of the same schema parse, so their
 * keys are in the same order and the serialised forms of equal rows match;
 * a mismatch the other way only costs an extra render. */
export function sameJson<T>(a: T, b: T): boolean {
  return Object.is(a, b) || JSON.stringify(a) === JSON.stringify(b);
}
