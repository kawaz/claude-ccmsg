// The unsaved 編集 of a file in the Files tab (DR-0051 §9), mounted.
// 何を保証するか:
//   - 編集中に別のファイルへ移って戻ると、未保存の中身で編集の状態のまま開く。
//     プレビューで離れたらプレビューのまま。続きを打てて、保存は編集を始めた時に
//     読んだ mtime / size を楽観ロックに渡す (戻った時の読み直しの値ではない)
//   - 保存とキャンセルで、そのファイルの未保存の編集が消える (戻ると見る画面)
//   - 未保存の編集はセッションとパスごとに別々 (別のファイル・別のセッションの同じ
//     パスに混ざらない)
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf } from "@ccmsg/protocol";
import { FileViewer } from "../src/client/components/FileViewer.tsx";
import { useApp } from "../src/client/context.ts";
import { useStoreState } from "../src/client/useStore.ts";
import { resetFileEditDrafts } from "../src/client/file-edit-drafts.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import type { Store } from "../src/client/useStore.ts";
import { defined, instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { FakeTranscriptWs, Mounted, SID, timelineStore } from "./timeline-harness.ts";

withDom();

const SID2 = "aaaaaaaa-0000-4000-8000-000000000002";
const mounted = new Mounted();
const restores: Array<() => void> = [];

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.splice(0)) restore();
  document.getSelection()?.removeAllRanges();
  resetFileEditDrafts();
});

const FILES: Record<string, string> = {
  "A.md": "# A\n\n[B](B.md)\n",
  "B.md": "# B\n\nbody\n",
};

interface Edit {
  path: string;
  content: string;
  expectedMtime: string;
}

/** The Files tab of session `sid` as the store has it, the way FilesPanes
 * hands it to the viewer. */
function Viewer({ sid }: { sid: string }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(sid));
  return tree === undefined
    ? null
    : h(FileViewer, { sid, tree, peer: undefined, workspaceFolders: [] });
}

interface Tab {
  root: HTMLElement;
  store: Store;
  edits: Edit[];
  /** The mtime the daemon reads the files with from now on. */
  setMtime: (mtime: string) => void;
}

/** The Files tab of `sid` on `path`, the files read from FILES. */
async function open(sid: string, path: string): Promise<Tab> {
  restores.push(stubGlobal("localStorage", new MemStorage()));
  // happy-dom has no Navigation API.
  restores.push(
    stubGlobal("navigation", {
      currentEntry: null,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }),
  );
  const store = timelineStore();
  let mtime = "2030-01-01T00:00:00.000Z";
  const edits: Edit[] = [];
  const ws = new FakeTranscriptWs(store);
  const handle = {
    ...ws.handle,
    fsRead: (readSid: string, readPath: string): Promise<ReplyOf<"fs_read">> => {
      const content = defined(FILES[readPath], readPath);
      return Promise.resolve({
        ok: true,
        sid: readSid,
        path: readPath,
        size: content.length,
        truncated: false,
        binary: false,
        content,
        mtime,
      });
    },
    fsEdit: (
      editSid: string,
      editPath: string,
      _kind: string,
      content: string,
      expectedMtime: string,
    ): Promise<ReplyOf<"fs_edit">> => {
      edits.push({ path: editPath, content, expectedMtime });
      return Promise.resolve({ ok: true, sid: editSid, path: editPath, size: 0, mtime });
    },
  };
  const root = await mounted.mount(store, handle, h(Viewer, { sid }));
  const tab = {
    root,
    store,
    edits,
    setMtime: (next: string) => {
      mtime = next;
    },
  };
  await go(tab, sid, path);
  return tab;
}

/** Goes to `path` of `sid`, as a link or the tree does, and lets it load. */
async function go(tab: Tab, sid: string, path: string): Promise<void> {
  await act(async () => {
    tab.store.dispatch({
      type: "locator/changed",
      locator: { view: "session", sid, path },
      sidebar: CLOSED_SIDEBAR,
    });
    await Promise.resolve();
  });
  await act(() => Promise.resolve());
}

function button(root: HTMLElement, selector: string, what: string): HTMLButtonElement {
  return instanceOf(root.querySelector(selector), HTMLButtonElement, what);
}

function editor(root: HTMLElement): HTMLElement | null {
  const found = root.querySelector('[role="textbox"][aria-label="ファイル本文"]');
  return found instanceof HTMLElement ? found : null;
}

async function startEdit(root: HTMLElement): Promise<HTMLElement> {
  await act(() => button(root, 'button[aria-label="ファイルを編集"]', "the 編集 button").click());
  return defined(editor(root), "the 編集 area");
}

/** Types `words` at the start of the area, as typing does. */
async function type(area: HTMLElement, words: string): Promise<void> {
  const text = instanceOf(area.firstChild, Text, "the area's text");
  await act(() => {
    text.insertData(0, words);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

function editorTab(root: HTMLElement, label: "コード" | "プレビュー"): HTMLButtonElement {
  const found = [...root.querySelectorAll(".file-editor .viewer-mode-btn")].find(
    (el) => el.textContent === label,
  );
  return instanceOf(found, HTMLButtonElement, `the ${label} tab`);
}

describe("an unsaved 編集", () => {
  test("is there again, still being edited, after another file", async () => {
    const tab = await open(SID, "A.md");
    await type(await startEdit(tab.root), "XYZ");
    await go(tab, SID, "B.md");
    expect(editor(tab.root)).toBeNull();
    expect(tab.root.querySelector(".viewer-body")?.textContent).toContain("body");

    // The file changes on disk meanwhile: the 編集 keeps its own text and the
    // lock of the read it began on.
    tab.setMtime("2030-01-02T00:00:00.000Z");
    await go(tab, SID, "A.md");
    const area = defined(editor(tab.root), "the 編集 area again");
    expect(area.textContent).toBe(`XYZ${FILES["A.md"]}\n`);
    await type(area, "!");
    await act(async () => {
      button(tab.root, '.file-editor button[type="submit"]', "保存").click();
      await Promise.resolve();
    });
    expect(tab.edits).toEqual([
      { path: "A.md", content: `!XYZ${FILES["A.md"]}`, expectedMtime: "2030-01-01T00:00:00.000Z" },
    ]);
  });

  test("left on プレビュー comes back on プレビュー, drawing what was typed", async () => {
    const tab = await open(SID, "A.md");
    await type(await startEdit(tab.root), "XYZ");
    await act(() => editorTab(tab.root, "プレビュー").click());
    await go(tab, SID, "B.md");
    await go(tab, SID, "A.md");
    expect(editorTab(tab.root, "プレビュー").getAttribute("aria-selected")).toBe("true");
    const preview = defined(tab.root.querySelector(".file-editor .viewer-preview"), "the preview");
    expect(preview.textContent).toContain("XYZ# A");
    await act(() => editorTab(tab.root, "コード").click());
    expect(defined(editor(tab.root), "the 編集 area").textContent).toBe(`XYZ${FILES["A.md"]}\n`);
  });

  test("is forgotten on 保存: the file comes back as it is seen", async () => {
    const tab = await open(SID, "A.md");
    await type(await startEdit(tab.root), "XYZ");
    await act(async () => {
      button(tab.root, '.file-editor button[type="submit"]', "保存").click();
      await Promise.resolve();
    });
    expect(editor(tab.root)).toBeNull();
    await go(tab, SID, "B.md");
    await go(tab, SID, "A.md");
    expect(editor(tab.root)).toBeNull();
    expect(tab.root.querySelector('button[aria-label="ファイルを編集"]')).not.toBeNull();
  });

  test("is forgotten on キャンセル: the 編集 begins again from the file", async () => {
    const tab = await open(SID, "A.md");
    await type(await startEdit(tab.root), "XYZ");
    await act(() => button(tab.root, ".file-editor-actions button", "キャンセル").click());
    expect(editor(tab.root)).toBeNull();
    await go(tab, SID, "B.md");
    await go(tab, SID, "A.md");
    expect(editor(tab.root)).toBeNull();
    expect((await startEdit(tab.root)).textContent).toBe(`${FILES["A.md"]}\n`);
  });

  test("is kept by session and by path", async () => {
    const tab = await open(SID, "A.md");
    await type(await startEdit(tab.root), "in A ");
    // Another file of the session is not being edited, and its own 編集 is
    // its own.
    await go(tab, SID, "B.md");
    expect(editor(tab.root)).toBeNull();
    await type(await startEdit(tab.root), "in B ");
    await go(tab, SID, "A.md");
    expect(defined(editor(tab.root), "A's 編集").textContent).toBe(`in A ${FILES["A.md"]}\n`);
    await go(tab, SID, "B.md");
    expect(defined(editor(tab.root), "B's 編集").textContent).toBe(`in B ${FILES["B.md"]}\n`);
    await mounted.unmount();

    // The same path in another session is not being edited.
    const other = await open(SID2, "A.md");
    expect(editor(other.root)).toBeNull();
    expect(other.root.querySelector(".viewer-body")?.textContent).toContain("# A");
  });
});
