// Files ツリーの開閉と fs_list の関係を固定する。
// - どのフォルダも閉じた状態で始まり (cwd のフォルダも)、mount では fs_list を飛ばさない
// - フォルダを開くたびに fs_list を飛ばす。閉じて開き直しても再度飛ぶ
// - 取り直している間は前の一覧を出したままにする
// - 選択中ファイルの祖先は従来どおり開く (選択への追従)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { FilesPanes } from "../src/client/components/FilesPanes.tsx";
import { defined, instanceOf, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";

withDom();

const SID = "sess-open";
const CWD = "/repo/main";
const PEER: PeerInfo = { sid: SID, repo: "owner/repo", ws: "main", cwd: CWD };

let container: HTMLElement | null = null;
let restoreGlobals: Array<() => void> = [];
/** Every path fs_list was asked for, in order. */
let listed: string[] = [];

beforeEach(() => {
  listed = [];
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

function wsAnswering(
  entries: (path: string) => Array<{ name: string; type: "file" | "dir" }>,
): WsHandle {
  const real = createWsClient(() => {});
  return {
    ...real,
    fsList: (sid, path = "") => {
      listed.push(path);
      return Promise.resolve({ ok: true, sid, path, entries: entries(path) });
    },
  };
}

function newStore(selected: string | null = null): Store {
  const store = createStore(initialState());
  store.dispatch({
    type: "locator/changed",
    locator: { view: "session", sid: SID, path: selected },
    sidebar: CLOSED_SIDEBAR,
  });
  store.dispatch({ type: "conn/status", status: "connected" });
  return store;
}

async function mount(store: Store, ws: WsHandle): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await draw(store, ws, root);
  return root;
}

/** FilesPanes takes the tree by value, as SessionView re-renders with each store change. */
async function draw(store: Store, ws: WsHandle, root: HTMLElement): Promise<void> {
  const tree = defined(store.getState().sessionTrees.get(SID), "session tree");
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(FilesPanes, { sid: SID, tree, peer: PEER, externalFiles: [], workspaceFolders: [] }),
      ),
      root,
    ),
  );
}

function dirRow(root: HTMLElement, name: string): HTMLElement {
  const rows = [...root.querySelectorAll(".tree-dir")].filter(
    (el) => (el.textContent ?? "").replace(/^[▾▸]/, "").trim() === name,
  );
  return instanceOf(rows[0], HTMLElement, `dir row ${name}`);
}

function expandedPaths(store: Store): string[] {
  return [...defined(store.getState().sessionTrees.get(SID), "session tree").expanded].sort();
}

const ROOT_ENTRIES = [
  { name: "src", type: "dir" as const },
  { name: "a.txt", type: "file" as const },
];

describe("Files tree opening", () => {
  test("mounting opens nothing and asks for no listing", async () => {
    const store = newStore();
    const ws = wsAnswering(() => ROOT_ENTRIES);
    const root = await mount(store, ws);
    await draw(store, ws, root);
    expect(expandedPaths(store)).toEqual([]);
    expect(listed).toEqual([]);
    expect(dirRow(root, "PROJECT_ROOT").textContent).toContain("▸");
  });

  test("each opening asks for the listing again, and the old rows stay until the reply", async () => {
    const store = newStore();
    const replies: Array<() => void> = [];
    const real = createWsClient(() => {});
    const ws: WsHandle = {
      ...real,
      fsList: (sid, path = "") => {
        listed.push(path);
        return new Promise((resolve) => {
          replies.push(() => resolve({ ok: true, sid, path, entries: ROOT_ENTRIES }));
        });
      },
    };
    const root = await mount(store, ws);
    await act(() => dirRow(root, "PROJECT_ROOT").click());
    await draw(store, ws, root);
    expect(root.textContent).toContain("loading…");
    await act(() => replies[0]?.());
    await draw(store, ws, root);
    expect(listed).toEqual([""]);
    expect(root.textContent).toContain("a.txt");

    // close, then open again: a second request goes out while the old rows stay
    await act(() => dirRow(root, "PROJECT_ROOT").click());
    await draw(store, ws, root);
    expect(root.textContent).not.toContain("a.txt");
    await act(() => dirRow(root, "PROJECT_ROOT").click());
    await draw(store, ws, root);
    expect(listed).toEqual(["", ""]);
    expect(root.textContent).toContain("a.txt");
    expect(root.textContent).not.toContain("loading…");
    await act(() => replies[1]?.());
    await draw(store, ws, root);
    expect(root.textContent).toContain("a.txt");
  });

  test("a selected file still opens its ancestors, listing each again", async () => {
    const store = newStore("src/a.ts");
    store.dispatch({ type: "fs/dir-loaded", sid: SID, path: "src", entries: [] });
    const ws = wsAnswering((path) =>
      path === "src" ? [{ name: "a.ts", type: "file" }] : ROOT_ENTRIES,
    );
    const root = await mount(store, ws);
    await draw(store, ws, root);
    expect(expandedPaths(store)).toContain("src");
    expect(listed).toContain("src");
    expect(dirRow(root, "PROJECT_ROOT").textContent).toContain("▾");
  });
});
