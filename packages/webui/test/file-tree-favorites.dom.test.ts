// Files タブのお気に入りをマウントして、永続値の契約を localStorage への書き込みと
// DOM で固定する。
// - マウントしただけでは一覧を書かない (初回 mount でも、peer が後から届いて
//   root が決まった時でも)。途中で 1 度でも空の一覧を書くと、その間に閉じた
//   タブや別のタブの読み込みで保存済みの一覧が消える
// - 一覧を書くのは toggle だけで、変えた結果をそのまま書く。書く一覧は正規化した
//   フルパスで、相対で保存された既存の項目もフルパスに直して書く
// - 同じファイルは綴りが違っても 1 つのお気に入り。表示は workspace folder ごとに
//   畳み、cwd の folder は見出し無し、どの folder にも無いものは others
// - ペインの比率もマウントでは書かず、スプリッターを動かした時だけ書く
// 出典: docs/findings/2026-10-14-webui-hooks-review-react-guidance.md (high 1)
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render, type ComponentChild } from "preact";
import { act } from "preact/test-utils";
import type { PeerInfo, WorkspaceFolder } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState, type SessionTreeState } from "../src/client/store.ts";
import { createStore, type Store } from "../src/client/useStore.ts";
import { favoritesStorageKey, parseFavorites } from "../src/client/utils.ts";
import { createWsClient } from "../src/client/ws.ts";
import { FilesPanes } from "../src/client/components/FilesPanes.tsx";
import { defined, instanceOf, stubGlobal, stubProperty } from "./helpers.ts";
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

function panes(
  store: Store,
  peer: PeerInfo | undefined,
  workspaceFolders: readonly WorkspaceFolder[] = [],
): ComponentChild {
  const tree: SessionTreeState = defined(store.getState().sessionTrees.get(SID), "session tree");
  const ws = createWsClient((action) => store.dispatch(action));
  return h(
    AppContext.Provider,
    { value: { store, ws } },
    h(FilesPanes, { sid: SID, tree, peer, externalFiles: [], workspaceFolders }),
  );
}

async function mount(vnode: ComponentChild): Promise<HTMLElement> {
  const root = document.createElement("div");
  document.body.append(root);
  container = root;
  await act(() => render(vnode, root));
  return root;
}

/** Mount, then render again with the tree as the store holds it after the
 * mount's own effects (the cwd's folder opens on mount): `panes` passes the
 * tree as a value, the way SessionView re-renders with each store change. */
async function mountSettled(
  store: Store,
  peer: PeerInfo | undefined,
  workspaceFolders: readonly WorkspaceFolder[] = [],
): Promise<HTMLElement> {
  const root = await mount(panes(store, peer, workspaceFolders));
  await act(() => render(panes(store, peer, workspaceFolders), root));
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
    expect(parseFavorites(stored())).toEqual(["README.md"]);
    expect(favoritedPaths(root)).toEqual(["README.md"]);
  });

  test("the root arriving after mount reads the stored list instead of overwriting it", async () => {
    seed(["README.md"]);
    const store = filesStore();
    const root = await mount(panes(store, undefined));
    await act(() => render(panes(store, PEER), root));
    expect(favoriteWrites).toEqual([]);
    expect(parseFavorites(stored())).toEqual(["README.md"]);
    expect(favoritedPaths(root)).toEqual(["README.md"]);
  });

  test("a toggle saves the list it produced", async () => {
    seed(["README.md"]);
    const root = await mountSettled(filesStore(), PEER);
    const add = instanceOf(
      root.querySelector('.tree-fav-toggle[aria-label="package.json をお気に入りに追加"]'),
      HTMLElement,
      "package.json favorite toggle",
    );
    await act(() => add.click());
    const written = [`${CWD}/README.md`, `${CWD}/package.json`];
    expect(favoriteWrites.map(parseFavorites)).toEqual([written]);
    expect(parseFavorites(stored())).toEqual(written);
    expect(favoritedPaths(root)).toEqual(["README.md", "package.json"]);
  });
});

/** The お気に入り section as text rows: a group heading as `▾name`, a row as
 * its label. */
function favoritesSection(root: HTMLElement): string[] {
  const tree = defined(root.querySelector(".file-tree"), "file tree");
  const out: string[] = [];
  let inFavorites = false;
  for (const el of tree.querySelectorAll(
    ".tree-section-label, .tree-group-heading, .tree-favorites > li > .tree-row-line > .tree-row",
  )) {
    if (el.classList.contains("tree-section-label")) {
      inFavorites = el.textContent === "お気に入り";
      continue;
    }
    if (inFavorites) out.push((el.textContent ?? "").trim());
  }
  return out;
}

function sectionLabels(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".tree-section-label")].map((el) => el.textContent ?? "");
}

function workspaceRows(root: HTMLElement): string[] {
  return [...root.querySelectorAll(".tree-workspace > li > .tree-row-line > .tree-dir")].map((el) =>
    (el.textContent ?? "").replace(/^[▾▸]/, "").trim(),
  );
}

describe("FileTree sections", () => {
  test("one file favorited by its relative and its full path shows once", async () => {
    seed(["README.md", `${CWD}/README.md`]);
    const root = await mount(panes(filesStore(), PEER));
    expect(favoritesSection(root)).toEqual(["README.md"]);
  });

  test("favorites group by workspace folder, labelled inside the folder, others last", async () => {
    seed([`${CWD}/README.md`, "/repo/lib/src/a.ts", "/elsewhere/notes.md"]);
    const folders = [
      { name: "main", path: CWD, is_cwd: true as const },
      { name: "lib", path: "/repo/lib" },
      { name: "empty", path: "/repo/empty" },
    ];
    const root = await mount(panes(filesStore(), PEER, folders));
    expect(favoritesSection(root)).toEqual([
      "README.md",
      "▾lib",
      "src/a.ts",
      "▾others",
      "/elsewhere/notes.md",
    ]);
    expect(workspaceRows(root)).toEqual(["main", "lib", "empty"]);
  });

  test("a group heading folds its rows and starts open", async () => {
    seed(["/repo/lib/src/a.ts"]);
    const root = await mount(panes(filesStore(), PEER, [{ name: "lib", path: "/repo/lib" }]));
    const heading = instanceOf(root.querySelector(".tree-group-heading"), HTMLElement, "heading");
    expect(heading.getAttribute("aria-expanded")).toBe("true");
    await act(() => heading.click());
    expect(favoritesSection(root)).toEqual(["▸lib"]);
  });

  test("without a workspace file the cwd is PROJECT_ROOT and the プロジェクト section is gone", async () => {
    const root = await mountSettled(filesStore(), PEER);
    expect(workspaceRows(root)).toEqual(["PROJECT_ROOT"]);
    expect(sectionLabels(root)).toEqual(["ワークスペース"]);
    // The cwd's folder opens on mount, so its listing shows without a click.
    expect(
      root.querySelector('.tree-fav-toggle[aria-label="package.json をお気に入りに追加"]'),
    ).not.toBeNull();
  });

  test("with workspace folders but none at the cwd, PROJECT_ROOT comes first", async () => {
    const root = await mount(panes(filesStore(), PEER, [{ name: "lib", path: "/repo/lib" }]));
    expect(workspaceRows(root)).toEqual(["PROJECT_ROOT", "lib"]);
  });
});

// storage.ts「レイアウト寸法」: a window that has not moved the splitter writes
// nothing, and keeps reading the last value any window used (or the default).
describe("the Files tab's pane ratio", () => {
  const RATIO_KEY = "ccmsg.sessionPaneRatio";

  test("is not written on mount, only when the splitter is moved", async () => {
    sessionStorage.removeItem(RATIO_KEY);
    const root = await mountSettled(filesStore(), PEER);
    expect(localStorage.getItem(RATIO_KEY)).toBeNull();
    expect(sessionStorage.getItem(RATIO_KEY)).toBeNull();

    const panesEl = defined(root.querySelector(".session-panes"), "the Files tab's panes");
    const restore = stubProperty(panesEl, "getBoundingClientRect", {
      value: () => new DOMRect(0, 0, 1000, 600),
    });
    try {
      const splitter = defined(root.querySelector(".session-splitter"), "the splitter");
      await act(() => {
        splitter.dispatchEvent(new PointerEvent("pointerdown", { bubbles: true, pointerId: 1 }));
        splitter.dispatchEvent(
          new PointerEvent("pointermove", { bubbles: true, pointerId: 1, clientX: 400 }),
        );
        splitter.dispatchEvent(new PointerEvent("pointerup", { bubbles: true, pointerId: 1 }));
      });
    } finally {
      restore();
    }
    expect(localStorage.getItem(RATIO_KEY)).toBe("0.4");
    expect(sessionStorage.getItem(RATIO_KEY)).toBe("0.4");
    sessionStorage.removeItem(RATIO_KEY);
  });
});
