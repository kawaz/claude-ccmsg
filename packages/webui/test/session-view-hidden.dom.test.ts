// 隠れている SessionView (App が LRU で mount したまま残す別セッションの表示)
// の配下は、store が変わっても描き直さない。表示に戻った時に、隠れている間の
// 変化をまとめて映す。
// Timeline の描き直しは、Timeline だけが作る SearchBar の vnode の数で数える
// (preact の options.vnode は vnode が作られるたびに呼ばれる)。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, options, type VNode } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo } from "@ccmsg/protocol";
import { SearchBar } from "../src/client/components/SearchBar.tsx";
import { SessionView } from "../src/client/components/SessionView.tsx";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { stubGlobal, stubProperty } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { endOf, exchange, FakeTranscriptWs, Mounted, page, SID } from "./timeline-harness.ts";

withDom();

const PEER: PeerInfo = {
  sid: SID,
  repo: "owner/repo",
  ws: "main",
  cwd: "/work/repo",
  transcript_path: "/work/.claude/projects/repo/session.jsonl",
};
const OTHER: PeerInfo = { ...PEER, sid: "aaaaaaaa-0000-4000-8000-0000000000ff", ws: "other" };

const mounted = new Mounted();
let restores: Array<() => void> = [];
let timelineRenders = 0;

beforeEach(() => {
  timelineRenders = 0;
  const previous = options.vnode?.bind(options);
  restores = [
    stubProperty(options, "vnode", {
      configurable: true,
      enumerable: true,
      writable: true,
      value(vnode: VNode) {
        if (vnode.type === SearchBar) timelineRenders += 1;
        previous?.(vnode);
      },
    }),
    stubGlobal("navigation", { navigate() {} }),
  ];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

function connectedStore(): Store {
  const store = createStore(initialState());
  store.dispatch({ type: "peers/loaded", peers: [PEER] });
  store.dispatch({ type: "conn/status", status: "connected" });
  return store;
}

async function openTimeline(): Promise<{
  store: Store;
  ws: FakeTranscriptWs;
  root: HTMLElement;
  show: (active: boolean) => Promise<void>;
}> {
  const store = connectedStore();
  const ws = new FakeTranscriptWs(store);
  const view = (active: boolean) =>
    h(SessionView, { sid: SID, tab: "timeline", agent: null, active });
  const root = await mounted.mount(store, ws.handle, view(true));
  await ws.lastRead().answer(page(exchange(1)));
  return { store, ws, root, show: (active) => mounted.rerender(store, ws.handle, view(active)) };
}

describe("a hidden SessionView", () => {
  test("does not render its Timeline again when the store changes", async () => {
    const { store, show } = await openTimeline();
    expect(timelineRenders).toBeGreaterThan(0);
    await show(false);
    timelineRenders = 0;

    await act(() => {
      store.dispatch({ type: "peers/loaded", peers: [PEER, OTHER] });
      store.dispatch({ type: "rooms/loaded", rooms: [] });
      store.dispatch({ type: "conn/status", status: "disconnected" });
      store.dispatch({ type: "conn/status", status: "connected" });
    });
    expect(timelineRenders).toBe(0);
  });

  test("shows what changed while it was hidden once it is shown again", async () => {
    const { store, root, show } = await openTimeline();
    await show(false);
    const end = endOf(exchange(1), 0);
    await act(() => {
      const lines = exchange(2);
      const next = endOf(lines, end);
      store.dispatch({ type: "timeline/tail", sid: SID, lines, start: end, end: next, size: next });
    });
    expect(root.textContent).not.toContain("question 2");

    await show(true);
    expect(root.textContent).toContain("question 2");
  });
});
