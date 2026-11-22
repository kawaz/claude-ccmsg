// セッションのタブの左ペイン (Timeline のエージェントのリスト、Files の
// ツリー) を消す / 出す ☰ (kawaz 2026-11-22)。
// - ☰ は右のペインのヘッダの左端に居る: TL のツールバーは 🔔 の左、Files は
//   プレビューのヘッダの一番左 (ファイルを選んでいない間も)
// - 押すと左ペインが hidden になり、スプリッターが無くなる。もう一度押すと
//   同じ要素のまま戻る (作り直さない)
// - 「押された状態」と title はグローバルヘッダのハンバーガーと同じ持ち方
// - 覚えるのはその窓の中だけ (sessionStorage)。localStorage には書かない
// - 窓を開いた時は sessionStorage を読み、無い・読めない値なら「在る」
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { FilesPanes } from "../src/client/components/FilesPanes.tsx";
import { SessionView } from "../src/client/components/SessionView.tsx";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { defined, instanceOf, peerLocation, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { exchange, FakeTranscriptWs, Mounted, page, SID } from "./timeline-harness.ts";

withDom();

const TIMELINE_KEY = "ccmsg.timelineTreeOpen";
const FILES_KEY = "ccmsg.filesTreeOpen";

const PEER: PeerInfo = {
  sid: SID,
  ...peerLocation("owner/repo", "main"),
  cwd: "/work/repo",
  transcript_path: "/work/.claude/projects/repo/session.jsonl",
};

function clearKeys(): void {
  for (const key of [TIMELINE_KEY, FILES_KEY]) {
    sessionStorage.removeItem(key);
    localStorage.removeItem(key);
  }
}

beforeEach(clearKeys);

function toggleIn(scope: Element): HTMLButtonElement {
  return instanceOf(scope.querySelector(".pane-tree-toggle"), HTMLButtonElement, "the ☰");
}

describe("the agent list's ☰ in the Timeline toolbar", () => {
  const mounted = new Mounted();
  afterEach(() => mounted.unmount());

  async function open(): Promise<HTMLElement> {
    const store = createStore(initialState());
    store.dispatch({ type: "peers/loaded", peers: [PEER] });
    store.dispatch({ type: "conn/status", status: "connected" });
    const fake = new FakeTranscriptWs(store);
    const ws: WsHandle = {
      ...fake.handle,
      sessionStatusSubscribe: () => new Promise(() => {}),
      sessionStatusUnsubscribe: (sid) => Promise.resolve({ ok: true, sid }),
    };
    const root = await mounted.mount(
      store,
      ws,
      h(SessionView, { sid: SID, tab: "timeline", agent: null, active: true }),
    );
    await fake.lastRead().answer(page(exchange(1)));
    return root;
  }

  test("stands first in the toolbar, left of the 🔔", async () => {
    const root = await open();
    const toolbar = defined(root.querySelector(".tl-toolbar"), "the toolbar");
    expect(toolbar.firstElementChild).toBe(toggleIn(toolbar));
    expect(toolbar.children[1]?.classList.contains("tl-toolbar-badges")).toBe(true);
    const toggle = toggleIn(toolbar);
    expect(toggle.textContent).toBe("☰");
    expect(toggle.getAttribute("aria-label")).toBe("agent list");
  });

  test("hides the list and its splitter, and brings the same list back", async () => {
    const root = await open();
    const tree = defined(root.querySelector<HTMLElement>(".timeline-pane-tree"), "the agent list");
    const toggle = toggleIn(defined(root.querySelector(".tl-toolbar"), "the toolbar"));
    expect(tree.hidden).toBe(false);
    expect(root.querySelector(".session-splitter")).not.toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("true");
    expect(toggle.title).toBe("エージェントのリストを隠す");

    await act(() => toggle.click());
    expect(root.querySelector(".timeline-pane-tree")).toBe(tree);
    expect(tree.hidden).toBe(true);
    expect(root.querySelector(".session-splitter")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("エージェントのリストを出す");
    expect(sessionStorage.getItem(TIMELINE_KEY)).toBe("0");
    expect(localStorage.getItem(TIMELINE_KEY)).toBeNull();

    await act(() => toggle.click());
    expect(root.querySelector(".timeline-pane-tree")).toBe(tree);
    expect(tree.hidden).toBe(false);
    expect(root.querySelector(".session-splitter")).not.toBeNull();
    expect(sessionStorage.getItem(TIMELINE_KEY)).toBe("1");
  });
});

describe("the tree's ☰ in the Files viewer's header", () => {
  let container: HTMLElement | null = null;
  let restoreGlobals: Array<() => void> = [];
  beforeEach(() => {
    restoreGlobals = [stubGlobal("navigation", { currentEntry: null })];
  });
  afterEach(async () => {
    for (const restore of restoreGlobals.reverse()) restore();
    restoreGlobals = [];
    const root = container;
    container = null;
    if (root === null) return;
    await act(() => render(null, root));
    root.remove();
  });

  async function open(): Promise<{ root: HTMLElement; store: Store }> {
    const store = createStore(initialState());
    store.dispatch({
      type: "locator/changed",
      locator: { view: "session", sid: SID, path: null },
      sidebar: CLOSED_SIDEBAR,
    });
    store.dispatch({ type: "conn/status", status: "connected" });
    const real = createWsClient(() => {});
    const ws: WsHandle = {
      ...real,
      fsList: (sid, path = "") => Promise.resolve({ ok: true, sid, path, entries: [] }),
    };
    const root = document.createElement("div");
    document.body.append(root);
    container = root;
    const tree = defined(store.getState().sessionTrees.get(SID), "session tree");
    await act(() =>
      render(
        h(
          AppContext.Provider,
          { value: { store, ws } },
          h(FilesPanes, { sid: SID, tree, peer: PEER, touchedFiles: [], workspaceFolders: [] }),
        ),
        root,
      ),
    );
    return { root, store };
  }

  test("stands first in the viewer's header while no file is chosen", async () => {
    const { root } = await open();
    const header = defined(root.querySelector(".file-viewer > .viewer-header"), "the header");
    expect(header.firstElementChild).toBe(toggleIn(header));
    expect(toggleIn(header).getAttribute("aria-label")).toBe("file tree");
    expect(root.querySelector(".viewer-empty")?.textContent).toBe("ファイルを選んでください");
  });

  test("hides the tree and its splitter, and brings the same tree back", async () => {
    const { root, store } = await open();
    const tree = defined(root.querySelector<HTMLElement>(".session-pane-tree"), "the tree pane");
    const toggle = toggleIn(defined(root.querySelector(".viewer-header"), "the header"));
    expect(toggle.title).toBe("ツリーを隠す");

    await act(() => toggle.click());
    expect(root.querySelector(".session-pane-tree")).toBe(tree);
    expect(tree.hidden).toBe(true);
    expect(root.querySelector(".session-splitter")).toBeNull();
    expect(toggle.getAttribute("aria-pressed")).toBe("false");
    expect(toggle.title).toBe("ツリーを出す");
    expect(store.getState().paneTreesOpen).toEqual({ timeline: true, files: false });
    expect(sessionStorage.getItem(FILES_KEY)).toBe("0");
    expect(localStorage.getItem(FILES_KEY)).toBeNull();

    await act(() => toggle.click());
    expect(tree.hidden).toBe(false);
    expect(root.querySelector(".session-splitter")).not.toBeNull();
  });
});

describe("a window's first look at the panes", () => {
  test("is what this window stored, and both present otherwise", () => {
    expect(initialState().paneTreesOpen).toEqual({ timeline: true, files: true });
    sessionStorage.setItem(TIMELINE_KEY, "0");
    sessionStorage.setItem(FILES_KEY, "1");
    expect(initialState().paneTreesOpen).toEqual({ timeline: false, files: true });
    sessionStorage.setItem(TIMELINE_KEY, "garbage");
    sessionStorage.setItem(FILES_KEY, "0");
    expect(initialState().paneTreesOpen).toEqual({ timeline: true, files: false });
  });

  test("does not read another window's localStorage", () => {
    localStorage.setItem(TIMELINE_KEY, "0");
    localStorage.setItem(FILES_KEY, "0");
    expect(initialState().paneTreesOpen).toEqual({ timeline: true, files: true });
  });
});
