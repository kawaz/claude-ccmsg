// Files タブのお気に入りをマウントして、永続値の契約を localStorage への書き込みと
// DOM で固定する。
// - マウントしただけでは一覧を書かない (初回 mount でも、peer が後から届いて
//   root が決まった時でも)。途中で 1 度でも空の一覧を書くと、その間に閉じた
//   タブや別のタブの読み込みで保存済みの一覧が消える
// - 一覧を書くのは toggle だけで、変えた結果をそのまま書く
// 出典: docs/findings/2026-10-14-webui-hooks-review-react-guidance.md (high 1)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState, type SessionTreeState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { favoritesStorageKey } from "../src/client/utils.ts";
import { createWsClient } from "../src/client/ws.ts";
import { FilesPanes } from "../src/client/components/FilesPanes.tsx";
import { defined, instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

const SID = "sess-fav";
const CWD = "/repo/main";
const KEY = favoritesStorageKey(CWD);
const PEER: PeerInfo = { sid: SID, repo: "owner/repo", ws: "main", cwd: CWD };

let container: HTMLElement | null = null;
let restoreGlobals: Array<() => void> = [];
/** Every value written to the favorites key while a test runs, in order. */
let favoriteWrites: string[] = [];

beforeEach(() => {
  favoriteWrites = [];
  const real = localStorage;
  real.clear();
  restoreGlobals = [
    // happy-dom has no Navigation API. FileViewer only reads the current
    // history entry's key (to restore its scroll position), and no entry
    // means nothing to restore.
    stubGlobal("navigation", { currentEntry: null }),
    // The real storage underneath, with the favorites key's writes recorded:
    // a write that is later overwritten leaves no trace in the final value.
    stubGlobal("localStorage", {
      getItem: (key: string) => real.getItem(key),
      setItem: (key: string, value: string) => {
        if (key === KEY) favoriteWrites.push(value);
        real.setItem(key, value);
      },
      removeItem: (key: string) => real.removeItem(key),
    }),
  ];
});

afterEach(async () => {
  for (const restore of restoreGlobals.reverse()) restore();
  restoreGlobals = [];
  const root = container;
  container = null;
  localStorage.clear();
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

/** A store with the session's Files tab selected and one listed root file, so
 * the tree has a row whose favorite toggle can be clicked. The socket is never
 * connected: nothing here may depend on a reply. */
function filesStore(): Store {
  const store = createStore(initialState());
  store.dispatch({
    type: "locator/changed",
    locator: { view: "session", sid: SID, path: null },
    sidebar: CLOSED_SIDEBAR,
  });
  store.dispatch({
    type: "fs/dir-loaded",
    sid: SID,
    path: "",
    entries: [{ name: "package.json", type: "file" }],
  });
  return store;
}

function panes(store: Store, peer: PeerInfo | undefined): ComponentChild {
  const tree: SessionTreeState = defined(store.getState().sessionTrees.get(SID), "session tree");
  const ws = createWsClient(
    (action) => store.dispatch(action),
    () => store.getState(),
  );
  return h(
    AppContext.Provider,
    { value: { store, ws } },
    h(FilesPanes, { sid: SID, tree, peer, externalFiles: [], workspaceFolders: [] }),
  );
}

async function mount(vnode: ComponentChild): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await act(() => render(vnode, root));
  return root;
}

/** The list a previous visit saved (not counted as a write under test). */
function seed(paths: string[]): void {
  localStorage.setItem(KEY, JSON.stringify(paths));
  favoriteWrites = [];
}

function stored(): string | null {
  return localStorage.getItem(KEY);
}

/** Paths the tree currently shows as favorited (their toggle offers removal). */
function favoritedPaths(root: HTMLElement): string[] {
  const labels = [...root.querySelectorAll(".tree-fav-toggle")].map(
    (button) => button.getAttribute("aria-label") ?? "",
  );
  const paths = labels
    .filter((label) => label.endsWith(" をお気に入りから外す"))
    .map((label) => label.slice(0, -" をお気に入りから外す".length));
  return [...new Set(paths)].sort();
}

describe("FileTree favorites mounted", () => {
  test("mounting with the root known leaves the stored list as it was", async () => {
    seed(["README.md"]);
    const root = await mount(panes(filesStore(), PEER));
    expect(favoriteWrites).toEqual([]);
    expect(stored()).toBe(JSON.stringify(["README.md"]));
    expect(favoritedPaths(root)).toEqual(["README.md"]);
  });

  test("the root arriving after mount reads the stored list instead of overwriting it", async () => {
    seed(["README.md"]);
    const store = filesStore();
    const root = await mount(panes(store, undefined));
    await act(() => render(panes(store, PEER), root));
    expect(favoriteWrites).toEqual([]);
    expect(stored()).toBe(JSON.stringify(["README.md"]));
    expect(favoritedPaths(root)).toEqual(["README.md"]);
  });

  test("a toggle saves the list it produced", async () => {
    seed(["README.md"]);
    const root = await mount(panes(filesStore(), PEER));
    const add = instanceOf(
      root.querySelector('.tree-fav-toggle[aria-label="package.json をお気に入りに追加"]'),
      HTMLElement,
      "package.json favorite toggle",
    );
    await act(() => add.click());
    expect(favoriteWrites).toEqual([JSON.stringify(["README.md", "package.json"])]);
    expect(stored()).toBe(JSON.stringify(["README.md", "package.json"]));
    expect(favoritedPaths(root)).toEqual(["README.md", "package.json"]);
  });
});
