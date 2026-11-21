// What renders in the SESSIONS list when nothing in its data changes
// (DR-0043 §10): opening or closing a fold renders nothing (the element owns
// whether it is open, and the 🔔🔐 sum is shown by CSS); the clock moves only
// the rows' idle times; a row's prompt-cache ring goes when its window closes
// with nothing else rendering the list. Renders are counted with Preact's
// `diffed` option hook, by component.
import { afterEach, beforeEach, describe, expect, jest, setSystemTime, test } from "bun:test";
import { type ComponentType, h, options, render, type VNode } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, LlmRequestInfo, PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import { SESSION_FOLDS_STORAGE_KEY } from "../src/client/session-tree.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { instanceOf, peerLocation, stubProperty } from "./helpers.ts";

withDom();

const NOW = Date.parse("2026-11-21T03:00:00.000Z");
const APP = "aaaaaaaa-0000-4000-8000-000000000001";
const LIB = "bbbbbbbb-0000-4000-8000-000000000002";

function peer(sid: string, repo: string): PeerInfo {
  return {
    sid,
    ...peerLocation(repo, "main"),
    cwd: `/w/${sid}`,
    connected_at: new Date(NOW - 3_600_000).toISOString(),
    last_activity_at: new Date(NOW - 65_000).toISOString(),
    transcript_path: `/p/${sid}.jsonl`,
  };
}

function idle(sid: string): AgentInfo {
  return {
    pid: 1,
    sessionId: sid,
    cwd: `/w/${sid}`,
    kind: "interactive",
    startedAt: 1,
    config_dir: "/c",
    status: "idle",
    turn: { state: "idle", since: new Date(NOW).toISOString() },
  };
}

const PEERS = [peer(APP, "alice/app"), peer(LIB, "alice/lib")];

/** Renders by component name since the last `reset`. */
const renders = new Map<string, number>();
let restoreDiffed: (() => void) | null = null;

function nameOf(type: VNode["type"]): string | null {
  return typeof type === "function" ? (type satisfies ComponentType).name : null;
}

let roots: HTMLElement[] = [];

beforeEach(() => {
  jest.useFakeTimers();
  setSystemTime(NOW);
  localStorage.clear();
  renders.clear();
  // preact/hooks has its own `diffed`; it is called on, and put back after.
  const previous = options.diffed?.bind(options);
  restoreDiffed = stubProperty(options, "diffed", {
    configurable: true,
    enumerable: true,
    writable: true,
    value: (vnode: VNode) => {
      const name = nameOf(vnode.type);
      if (name !== null) renders.set(name, (renders.get(name) ?? 0) + 1);
      previous?.(vnode);
    },
  });
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  restoreDiffed?.();
  restoreDiffed = null;
  jest.useRealTimers();
  setSystemTime();
});

async function mount(
  requests: LlmRequestInfo[] = [],
): Promise<{ root: HTMLElement; store: Store }> {
  const store = createStore(initialState());
  store.dispatch({ type: "agents/loaded", agents: PEERS.map((p) => idle(p.sid)) });
  store.dispatch({ type: "llm-requests/loaded", requests });
  const ws = createWsClient((action) => store.dispatch(action));
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(SessionList, { peers: PEERS, currentSid: null }),
      ),
      root,
    ),
  );
  renders.clear();
  return { root, store };
}

function fold(root: HTMLElement, heading: string): HTMLDetailsElement {
  const found = [...root.querySelectorAll("details.session-tree-fold")].find(
    (d) => d.querySelector(":scope > summary > .session-tree-name")?.textContent === heading,
  );
  return instanceOf(found, HTMLDetailsElement, `the ${heading} fold`);
}

describe("what renders in the SESSIONS list", () => {
  test("opening and closing a fold renders nothing, and the reader's choice is stored", async () => {
    const { root } = await mount();
    const owner = fold(root, "alice (2)");
    const summary = instanceOf(owner.querySelector(":scope > summary"), HTMLElement, "summary");
    await act(() => {
      summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await act(() => {
      jest.advanceTimersByTime(0);
    });
    expect(owner.open).toBe(false);
    expect(JSON.parse(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY) ?? "{}")).toEqual({
      "owner:alice": false,
    });
    await act(() => {
      summary.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    expect(owner.open).toBe(true);
    expect([...renders]).toEqual([]);
  });

  test("a fold that appears as stored stores nothing more", async () => {
    await mount();
    expect(localStorage.getItem(SESSION_FOLDS_STORAGE_KEY)).toBeNull();
  });

  test("the clock moves the rows' idle times and renders nothing else", async () => {
    const { root } = await mount();
    const idleOf = (sid: string): string =>
      [...root.querySelectorAll("li.session-row")]
        .find((row) => row.querySelector(".session-sid")?.textContent === sid.slice(0, 8))
        ?.querySelector(".session-idle")?.textContent ?? "";
    expect(idleOf(APP)).toBe("1m5s");
    await act(() => {
      jest.advanceTimersByTime(10_000);
    });
    expect(idleOf(APP)).toBe("1m15s");
    expect(idleOf(LIB)).toBe("1m15s");
    // One render per row's idle time, all on the one tick, and nothing else.
    expect([...renders]).toEqual([["SessionIdle", 2]]);
  });

  test("a row's ring goes when its window closes, with nothing else rendering the list", async () => {
    const { root } = await mount([{ ts: NOW - 295_000, session_id: APP, prefix: "p", main: true }]);
    const ringOf = (): Element | null => root.querySelector(".session-avatar-ring.cache-ring");
    expect(ringOf()).not.toBeNull();
    await act(() => {
      jest.advanceTimersByTime(5_000);
    });
    expect(ringOf()).toBeNull();
    expect(root.querySelector(".cache-ring-svg")).toBeNull();
  });
});
