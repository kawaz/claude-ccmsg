// The words kept for a filter box (DR-0043 §9, kawaz 2026-11-24), mounted in
// the SESSIONS list and the Files pane.
// 何を保証するか:
//   - ⌘Enter / Ctrl+Enter と、入力欄の中の save のピルで、入力の語 (両端の空白を除く) が保存した
//     順の最後に足される。save のピルは入力があり、まだ保存していない語の時だけ出る
//   - 既に保存してある語・空 (空白だけ) の入力は足さない。IME の変換中の Enter では保存しない
//   - 保存した語のピルを押すと入力欄にその語が入り、その場で絞り込みが効く (SESSIONS は行が
//     減り、Files はツリーが検索の結果に替わる)。いまの入力と同じ語のピルは選ばれている
//   - ピルの × は一覧から消し、入力欄の中身は変えない
//   - 保存は localStorage に残り、作り直し (再読み込み) の後も同じ順で出る
//   - 壊れた値・形の違う値は空の一覧として読み、落ちない
//   - SESSIONS と Files の一覧は別。Files の一覧はセッションに依らず 1 つ
//   - 入力欄にフォーカスがある時、save・×・保存した語の押し始めはフォーカスを動かさない。
//     キーボードで押して消えるボタン (save・×) の後はフォーカスが入力欄に戻る
//   - 支援技術: 語と × は別のボタンで、それぞれの名前 (「<語> で絞り込む」「<語> を保存から
//     消す」) が読める
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h, render } from "preact";
import { act } from "preact/test-utils";
import type { AgentInfo, PeerInfo } from "@ccmsg/protocol";
import { AppContext } from "../src/client/context.ts";
import { SessionList } from "../src/client/components/SessionList.tsx";
import { FilesPanes } from "../src/client/components/FilesPanes.tsx";
import {
  _resetSavedFiltersForTest,
  FILE_SAVED_FILTERS_KEY,
  SESSION_SAVED_FILTERS_KEY,
} from "../src/client/saved-filters.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { initialState } from "../src/client/store.ts";
import { createStore } from "../src/client/useStore.ts";
import { createWsClient } from "../src/client/ws.ts";
import { withDom } from "./dom.ts";
import { defined, instanceOf, peerLocation, stubGlobal } from "./helpers.ts";

withDom();

const ALPHA = "aaaaaaaa-0000-4000-8000-000000000001";
const GAMMA = "cccccccc-0000-4000-8000-000000000003";
const SINCE = "2026-11-21T01:00:00.000Z";
const FILES_SID = "sess-files";

let roots: HTMLElement[] = [];
let restoreGlobals: Array<() => void> = [];

beforeEach(() => {
  localStorage.clear();
  _resetSavedFiltersForTest();
  // happy-dom has no Navigation API; FileViewer only reads the current entry.
  restoreGlobals = [stubGlobal("navigation", { currentEntry: null })];
});

afterEach(async () => {
  for (const root of roots) {
    await act(() => render(null, root));
    root.remove();
  }
  roots = [];
  for (const restore of restoreGlobals.reverse()) restore();
  restoreGlobals = [];
  localStorage.clear();
  _resetSavedFiltersForTest();
});

function peer(sid: string, repo: string, ws: string): PeerInfo {
  return {
    sid,
    ...peerLocation(repo, ws),
    cwd: `/w/${ws}`,
    connected_at: SINCE,
    transcript_path: `/p/${sid}.jsonl`,
  };
}

function agent(sid: string): AgentInfo {
  return {
    pid: 1,
    cwd: `/w/${sid}`,
    kind: "interactive",
    startedAt: 1,
    sessionId: sid,
    config_dir: "/c",
    status: "idle",
    turn: { state: "idle", since: SINCE },
  };
}

function attach(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  roots.push(root);
  return root;
}

async function mountSessions(): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({ type: "agents/loaded", agents: [agent(ALPHA), agent(GAMMA)] });
  const ws = createWsClient((action) => store.dispatch(action));
  const root = attach();
  const peers = [
    peer(ALPHA, "kawaz/claude-ccmsg", "parser-fix"),
    peer(GAMMA, "kawaz/dotfiles", "main"),
  ];
  await act(() =>
    render(
      h(AppContext.Provider, { value: { store, ws } }, h(SessionList, { peers, currentSid: null })),
      root,
    ),
  );
  return root;
}

async function mountFiles(): Promise<HTMLElement> {
  const store = createStore(initialState());
  store.dispatch({
    type: "locator/changed",
    locator: { view: "session", sid: FILES_SID, path: null },
    sidebar: CLOSED_SIDEBAR,
  });
  store.dispatch({
    type: "fs/dir-loaded",
    sid: FILES_SID,
    path: "",
    entries: [{ name: "package.json", type: "file" }],
  });
  store.dispatch({ type: "fs/dirs-expanded", sid: FILES_SID, paths: [""] });
  const tree = defined(store.getState().sessionTrees.get(FILES_SID), "session tree");
  const ws = createWsClient((action) => store.dispatch(action));
  const root = attach();
  await act(() =>
    render(
      h(
        AppContext.Provider,
        { value: { store, ws } },
        h(FilesPanes, {
          sid: FILES_SID,
          tree,
          peer: { sid: FILES_SID, ...peerLocation("owner/repo", "main"), cwd: "/repo/main" },
          touchedFiles: [],
          workspaceFolders: [],
        }),
      ),
      root,
    ),
  );
  return root;
}

const SESSIONS = { mount: mountSessions, box: ".session-filter", key: SESSION_SAVED_FILTERS_KEY };
const FILES = { mount: mountFiles, box: ".tree-search", key: FILE_SAVED_FILTERS_KEY };

function input(root: HTMLElement, place: string): HTMLInputElement {
  return instanceOf(
    root.querySelector(`${place} input[type="search"]`),
    HTMLInputElement,
    `the box in ${place}`,
  );
}

async function type(root: HTMLElement, place: string, value: string): Promise<void> {
  const el = input(root, place);
  await act(() => {
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function keyDown(
  root: HTMLElement,
  place: string,
  init: KeyboardEventInit,
): Promise<KeyboardEvent> {
  const event = new KeyboardEvent("keydown", { bubbles: true, cancelable: true, ...init });
  await act(() => {
    input(root, place).dispatchEvent(event);
  });
  return event;
}

function saveButton(root: HTMLElement, place: string): HTMLButtonElement | null {
  const found = root.querySelector(`${place} .filter-field-save`);
  return found === null ? null : instanceOf(found, HTMLButtonElement, "the save pill");
}

/** The kept words shown under the box, in order. */
function savedWords(root: HTMLElement, place: string): string[] {
  return [...root.querySelectorAll(`${place} .saved-filter-word`)].map(
    (el) => el.textContent ?? "",
  );
}

function stored(key: string): unknown {
  const raw = localStorage.getItem(key);
  return raw === null ? null : JSON.parse(raw);
}

function button(root: HTMLElement, place: string, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll(`${place} button`)].find(
    (el) => el.getAttribute("aria-label") === name,
  );
  return instanceOf(found, HTMLButtonElement, `the button named ${name}`);
}

async function click(el: HTMLElement, detail = 1): Promise<void> {
  await act(() => {
    el.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, detail }));
  });
}

/** The short sids of the SESSIONS rows shown. */
function shownSids(root: HTMLElement): string[] {
  return [...root.querySelectorAll("#session-list li.session-row .session-sid")].map(
    (el) => el.textContent ?? "",
  );
}

for (const side of [
  { name: "SESSIONS", ...SESSIONS },
  { name: "Files", ...FILES },
]) {
  describe(`the ${side.name} box's kept words`, () => {
    test("⌘Enter and Ctrl+Enter keep the word, at the end, without the blanks at its ends", async () => {
      const root = await side.mount();
      await type(root, side.box, "  ccmsg ");
      const meta = await keyDown(root, side.box, { key: "Enter", metaKey: true });
      expect(meta.defaultPrevented).toBe(true);
      await type(root, side.box, "dot");
      await keyDown(root, side.box, { key: "Enter", ctrlKey: true });
      expect(savedWords(root, side.box)).toEqual(["ccmsg", "dot"]);
      expect(stored(side.key)).toEqual(["ccmsg", "dot"]);
      // The box keeps what was typed.
      expect(input(root, side.box).value).toBe("dot");
    });

    test("the save pill shows only for a word not kept yet, and keeps it", async () => {
      const root = await side.mount();
      expect(saveButton(root, side.box)).toBeNull();
      await type(root, side.box, "   ");
      expect(saveButton(root, side.box)).toBeNull();
      await type(root, side.box, "ccmsg");
      const save = defined(saveButton(root, side.box), "the save pill");
      expect(save.textContent).toBe("save");
      expect(save.getAttribute("aria-label")).toBe("ccmsg を保存");
      // Inside the box's frame, left of the ×.
      expect(save.nextElementSibling?.classList.contains("filter-field-clear")).toBe(true);
      await click(save);
      expect(savedWords(root, side.box)).toEqual(["ccmsg"]);
      expect(saveButton(root, side.box)).toBeNull();
      await type(root, side.box, " ccmsg  ");
      expect(saveButton(root, side.box)).toBeNull();
    });

    test("a word kept already, or a blank box, adds nothing", async () => {
      const root = await side.mount();
      await type(root, side.box, "ccmsg");
      await keyDown(root, side.box, { key: "Enter", metaKey: true });
      await type(root, side.box, " ccmsg ");
      await keyDown(root, side.box, { key: "Enter", metaKey: true });
      await type(root, side.box, "   ");
      await keyDown(root, side.box, { key: "Enter", metaKey: true });
      await type(root, side.box, "");
      await keyDown(root, side.box, { key: "Enter", metaKey: true });
      expect(savedWords(root, side.box)).toEqual(["ccmsg"]);
      expect(stored(side.key)).toEqual(["ccmsg"]);
    });

    test("an Enter that ends an IME composition keeps nothing", async () => {
      const root = await side.mount();
      await type(root, side.box, "かな");
      const composing = await keyDown(root, side.box, {
        key: "Enter",
        metaKey: true,
        isComposing: true,
      });
      expect(composing.defaultPrevented).toBe(false);
      await keyDown(root, side.box, { key: "Enter" });
      expect(savedWords(root, side.box)).toEqual([]);
      expect(stored(side.key)).toBeNull();
    });

    test("a kept word's × takes it off the list and leaves the box as it is", async () => {
      const root = await side.mount();
      for (const word of ["one", "two", "three"]) {
        await type(root, side.box, word);
        await keyDown(root, side.box, { key: "Enter", metaKey: true });
      }
      await type(root, side.box, "typed");
      await click(button(root, side.box, "two を保存から消す"));
      expect(savedWords(root, side.box)).toEqual(["one", "three"]);
      expect(stored(side.key)).toEqual(["one", "three"]);
      expect(input(root, side.box).value).toBe("typed");
    });

    test("the kept words come back after the page is made again, in their order", async () => {
      const first = await side.mount();
      for (const word of ["b", "a", "c"]) {
        await type(first, side.box, word);
        await keyDown(first, side.box, { key: "Enter", metaKey: true });
      }
      for (const root of roots) {
        await act(() => render(null, root));
        root.remove();
      }
      roots = [];
      _resetSavedFiltersForTest();
      const again = await side.mount();
      expect(savedWords(again, side.box)).toEqual(["b", "a", "c"]);
    });

    test("a broken stored value reads as no words", async () => {
      for (const raw of ["{not json", '{"a":1}', "[1,2]", '"ccmsg"', "null"]) {
        localStorage.setItem(side.key, raw);
        _resetSavedFiltersForTest();
        const root = await side.mount();
        expect(savedWords(root, side.box)).toEqual([]);
        // and saving over it starts a fresh list
        await type(root, side.box, "fresh");
        await keyDown(root, side.box, { key: "Enter", metaKey: true });
        expect(stored(side.key)).toEqual(["fresh"]);
        await act(() => render(null, root));
      }
    });

    test("a stored list with blank or repeated words reads each word once", async () => {
      localStorage.setItem(side.key, JSON.stringify(["a", " a ", "", "b", "a"]));
      const root = await side.mount();
      expect(savedWords(root, side.box)).toEqual(["a", "b"]);
    });

    test("the word and its × are separate buttons named for what they do", async () => {
      localStorage.setItem(side.key, JSON.stringify(["ccmsg"]));
      const root = await side.mount();
      const word = root.querySelector(`${side.box} .saved-filter-word`);
      expect(word?.getAttribute("aria-label")).toBe(
        side.name === "SESSIONS" ? "ccmsg で絞り込む" : "ccmsg で検索する",
      );
      expect(word?.getAttribute("title")).toBe("ccmsg");
      const remove = button(root, side.box, "ccmsg を保存から消す");
      expect(remove.textContent).toBe("×");
      expect(root.querySelector(`${side.box} .saved-filters`)?.getAttribute("aria-label")).toBe(
        "保存した語",
      );
    });

    test("presses that start on the box's controls leave the input's focus where it is", async () => {
      localStorage.setItem(side.key, JSON.stringify(["kept"]));
      const root = await side.mount();
      await type(root, side.box, "new");
      const box = input(root, side.box);
      box.focus();
      for (const control of [
        defined(saveButton(root, side.box), "the save pill"),
        button(root, side.box, "入力を消す"),
        button(root, side.box, "kept を保存から消す"),
        instanceOf(
          root.querySelector(`${side.box} .saved-filter-word`),
          HTMLButtonElement,
          "the kept word",
        ),
      ]) {
        const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
        control.dispatchEvent(down);
        expect(down.defaultPrevented).toBe(true);
      }
      // Not while the input does not have the focus.
      box.blur();
      const down = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
      defined(saveButton(root, side.box), "the save pill").dispatchEvent(down);
      expect(down.defaultPrevented).toBe(false);
    });

    test("a press from the keyboard on the save pill gives the focus to the input", async () => {
      const root = await side.mount();
      await type(root, side.box, "kb");
      const save = defined(saveButton(root, side.box), "the save pill");
      save.focus();
      await click(save, 0);
      expect(savedWords(root, side.box)).toEqual(["kb"]);
      expect(document.activeElement).toBe(input(root, side.box));
    });

    test("the box's × empties it", async () => {
      const root = await side.mount();
      expect(root.querySelector(`${side.box} .filter-field-clear`)).toBeNull();
      await type(root, side.box, "abc");
      await click(button(root, side.box, "入力を消す"));
      expect(input(root, side.box).value).toBe("");
      expect(root.querySelector(`${side.box} .filter-field-clear`)).toBeNull();
    });
  });
}

describe("pressing a kept word", () => {
  test("in SESSIONS puts it in the box and narrows the rows at once, and marks the pill", async () => {
    localStorage.setItem(SESSION_SAVED_FILTERS_KEY, JSON.stringify(["dotfiles", "ccmsg"]));
    const root = await mountSessions();
    expect(shownSids(root).toSorted()).toEqual([ALPHA.slice(0, 8), GAMMA.slice(0, 8)]);
    await click(button(root, ".session-filter", "dotfiles で絞り込む"));
    expect(input(root, ".session-filter").value).toBe("dotfiles");
    expect(shownSids(root)).toEqual([GAMMA.slice(0, 8)]);
    const current = [...root.querySelectorAll(".session-filter .saved-filter-word")].map((el) =>
      el.getAttribute("aria-current"),
    );
    expect(current).toEqual(["true", null]);
  });

  test("in Files puts it in the box and replaces the tree with the search", async () => {
    localStorage.setItem(FILE_SAVED_FILTERS_KEY, JSON.stringify(["pack"]));
    const root = await mountFiles();
    expect(root.querySelector(".file-tree")?.textContent).toContain("package.json");
    expect(root.querySelector(".file-tree .tree-row-line")).not.toBeNull();
    expect(root.querySelector(".tree-search-option")).toBeNull();
    await click(button(root, ".tree-search", "pack で検索する"));
    expect(input(root, ".tree-search").value).toBe("pack");
    expect(
      root.querySelector(".tree-search .saved-filter-word")?.getAttribute("aria-current"),
    ).toBe("true");
    // The tree body gave way to the search (FileTree): no tree row is left.
    expect(root.querySelector(".file-tree .tree-row-line")).toBeNull();
    expect(root.querySelector(".tree-search-option")).not.toBeNull();
  });
});

describe("the two lists", () => {
  test("SESSIONS and Files keep separate words", async () => {
    const sessions = await mountSessions();
    await type(sessions, ".session-filter", "only-sessions");
    await keyDown(sessions, ".session-filter", { key: "Enter", metaKey: true });
    const files = await mountFiles();
    await type(files, ".tree-search", "only-files");
    await keyDown(files, ".tree-search", { key: "Enter", metaKey: true });
    expect(savedWords(sessions, ".session-filter")).toEqual(["only-sessions"]);
    expect(savedWords(files, ".tree-search")).toEqual(["only-files"]);
    expect(stored(SESSION_SAVED_FILTERS_KEY)).toEqual(["only-sessions"]);
    expect(stored(FILE_SAVED_FILTERS_KEY)).toEqual(["only-files"]);
  });

  test("every Files box on the page shows the one list", async () => {
    const first = await mountFiles();
    const second = await mountFiles();
    await type(first, ".tree-search", "shared");
    await keyDown(first, ".tree-search", { key: "Enter", metaKey: true });
    expect(savedWords(second, ".tree-search")).toEqual(["shared"]);
  });
});
