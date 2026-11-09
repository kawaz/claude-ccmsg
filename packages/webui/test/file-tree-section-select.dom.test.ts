// Files タブで「どのセクションから選んだか」とツリーの追従の関係を固定する (DR-0024 §3.3)。
// - 触ったファイル / お気に入りの行のリンクは `?section=` 付きの URL を指す
// - その URL で選んだ時はワークスペースのツリーを開かず (fs_list も飛ばさない)、
//   選んだセクションの行だけを選択状態にする
// - `section` の無い選択 (ツリーの行・Timeline のリンク・直接の URL) は従来どおり
//   祖先を開き、ワークスペースの行だけを選択状態にする。触ったファイルの行は光らない
// - セクションで選んだ後に同じファイルをツリー側の URL で選び直すと、そこで開く
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo, TouchedFile } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { fileHref, parseUrl } from "../src/client/locator.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { favoritesStorageKey } from "../src/client/utils.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { FilesPanes } from "../src/client/components/FilesPanes.tsx";
import { defined, instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

const SID = "sess-section";
const CWD = "/repo/main";
const PEER: PeerInfo = { sid: SID, repo: "owner/repo", ws: "main", cwd: CWD };
const TOUCHED_PATH = "src/deep/a.ts";
const FAVORITE_PATH = "src/deep/b.ts";
const TOUCHED: readonly TouchedFile[] = [{ path: TOUCHED_PATH, origin: "edit" }];

let container: HTMLElement | null = null;
let restoreGlobals: Array<() => void> = [];
/** Every path fs_list was asked for, in order. */
let listed: string[] = [];

beforeEach(() => {
  listed = [];
  localStorage.clear();
  localStorage.setItem(favoritesStorageKey(CWD), JSON.stringify([`${CWD}/${FAVORITE_PATH}`]));
  restoreGlobals = [stubGlobal("navigation", { currentEntry: null })];
});

afterEach(async () => {
  for (const restore of restoreGlobals.reverse()) restore();
  restoreGlobals = [];
  localStorage.clear();
  const root = container;
  container = null;
  if (root === null) return;
  await act(() => render(null, root));
  root.remove();
});

const LISTINGS: Record<string, Array<{ name: string; type: "file" | "dir" }>> = {
  "": [{ name: "src", type: "dir" }],
  src: [{ name: "deep", type: "dir" }],
  "src/deep": [
    { name: "a.ts", type: "file" },
    { name: "b.ts", type: "file" },
  ],
};

function wsAnswering(): WsHandle {
  const real = createWsClient(() => {});
  return {
    ...real,
    fsList: (sid, path = "") => {
      listed.push(path);
      return Promise.resolve({ ok: true, sid, path, entries: LISTINGS[path] ?? [] });
    },
  };
}

function newStore(): Store {
  const store = createStore(initialState());
  store.dispatch({
    type: "locator/changed",
    locator: { view: "session", sid: SID, path: null },
    sidebar: CLOSED_SIDEBAR,
  });
  store.dispatch({ type: "conn/status", status: "connected" });
  return store;
}

/** What following a link does in the app: the URL becomes the locator. */
function follow(store: Store, href: string): void {
  const url = new URL(href, "http://localhost");
  store.dispatch({
    type: "locator/changed",
    locator: parseUrl(url.pathname, url.search),
    sidebar: CLOSED_SIDEBAR,
  });
}

/** FilesPanes takes the tree by value, as SessionView re-renders with each store change. */
async function draw(store: Store, ws: WsHandle, root: HTMLElement): Promise<void> {
  const tree = defined(store.getState().sessionTrees.get(SID), "session tree");
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(FilesPanes, { sid: SID, tree, peer: PEER, touchedFiles: TOUCHED, workspaceFolders: [] }),
      ),
      root,
    ),
  );
}

async function mount(store: Store, ws: WsHandle): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await draw(store, ws, root);
  await draw(store, ws, root);
  return root;
}

/** Settle the listings a reveal asked for, then draw what they produced. */
async function settle(store: Store, ws: WsHandle, root: HTMLElement): Promise<void> {
  for (let i = 0; i < 4; i++) await draw(store, ws, root);
}

function section(root: HTMLElement, cls: string): HTMLElement {
  return instanceOf(root.querySelector(`.tree-root.${cls}`), HTMLElement, `section ${cls}`);
}

/** The 触ったファイル rows: the `tree-favorites` lists after the label. */
function touchedRows(root: HTMLElement): HTMLAnchorElement[] {
  const label = [...root.querySelectorAll(".tree-section-label")].find(
    (el) => el.textContent === "触ったファイル",
  );
  const rows: HTMLAnchorElement[] = [];
  for (let el = label?.nextElementSibling ?? null; el; el = el.nextElementSibling) {
    for (const a of el.querySelectorAll("a.tree-file"))
      rows.push(instanceOf(a, HTMLAnchorElement, "touched link"));
  }
  return rows;
}

function touchedRow(root: HTMLElement): HTMLAnchorElement {
  const row = touchedRows(root).find((a) => a.textContent === TOUCHED_PATH);
  return instanceOf(row, HTMLAnchorElement, "touched row");
}

function favoriteRow(root: HTMLElement): HTMLAnchorElement {
  const row = [...section(root, "tree-favorites").querySelectorAll("a.tree-file")].find(
    (a) => a.textContent === FAVORITE_PATH,
  );
  return instanceOf(row, HTMLAnchorElement, "favorite row");
}

function expandedPaths(store: Store): string[] {
  return [...defined(store.getState().sessionTrees.get(SID), "session tree").expanded].sort();
}

function workspaceSelected(root: HTMLElement): string[] {
  return [...section(root, "tree-workspace").querySelectorAll(".tree-selected")].map(
    (el) => el.textContent ?? "",
  );
}

describe("selecting from a Files section", () => {
  test("the touched and favorite rows link with their section", async () => {
    const store = newStore();
    const ws = wsAnswering();
    const root = await mount(store, ws);
    expect(touchedRow(root).getAttribute("href")).toBe(
      fileHref(SID, TOUCHED_PATH, { section: "touched" }),
    );
    expect(favoriteRow(root).getAttribute("href")).toBe(
      fileHref(SID, FAVORITE_PATH, { section: "favorites" }),
    );
  });

  test("a touched pick leaves the tree closed and lights only the touched row", async () => {
    const store = newStore();
    const ws = wsAnswering();
    const root = await mount(store, ws);
    follow(store, defined(touchedRow(root).getAttribute("href"), "touched href"));
    await settle(store, ws, root);
    expect(expandedPaths(store)).toEqual([]);
    expect(listed).toEqual([]);
    expect(touchedRow(root).classList.contains("tree-selected")).toBe(true);
    expect(workspaceSelected(root)).toEqual([]);
    expect(section(root, "tree-favorites").querySelector(".tree-selected")).toBeNull();
  });

  test("a favorite pick leaves the tree closed and lights only the favorite row", async () => {
    const store = newStore();
    const ws = wsAnswering();
    const root = await mount(store, ws);
    follow(store, defined(favoriteRow(root).getAttribute("href"), "favorite href"));
    await settle(store, ws, root);
    expect(expandedPaths(store)).toEqual([]);
    expect(listed).toEqual([]);
    expect(favoriteRow(root).classList.contains("tree-selected")).toBe(true);
    expect(workspaceSelected(root)).toEqual([]);
    expect(touchedRows(root).filter((a) => a.classList.contains("tree-selected"))).toEqual([]);
  });

  test("a selection without a section reveals the file and lights only the tree row", async () => {
    const store = newStore();
    const ws = wsAnswering();
    const root = await mount(store, ws);
    follow(store, fileHref(SID, TOUCHED_PATH));
    await settle(store, ws, root);
    expect(expandedPaths(store)).toEqual(["", "src", "src/deep"]);
    expect(listed.sort()).toEqual(["", "src", "src/deep"]);
    expect(workspaceSelected(root)).toEqual(["a.ts"]);
    expect(touchedRow(root).classList.contains("tree-selected")).toBe(false);
  });

  test("picking the touched file again without a section reveals it then", async () => {
    const store = newStore();
    const ws = wsAnswering();
    const root = await mount(store, ws);
    follow(store, fileHref(SID, TOUCHED_PATH, { section: "touched" }));
    await settle(store, ws, root);
    expect(expandedPaths(store)).toEqual([]);
    follow(store, fileHref(SID, TOUCHED_PATH));
    await settle(store, ws, root);
    expect(expandedPaths(store)).toEqual(["", "src", "src/deep"]);
    expect(workspaceSelected(root)).toEqual(["a.ts"]);
    expect(touchedRow(root).classList.contains("tree-selected")).toBe(false);
  });
});
