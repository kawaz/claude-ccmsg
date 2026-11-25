// The preview of a markdown file while it is edited in the Files tab
// (DR-0051 §8), mounted.
// 何を保証するか:
//   - md のファイルの編集 (TextFileEditor) に、見る時と同じ「コード | プレビュー」の
//     タブが出て、始めはコード。プレビューを出せない種類 (md 以外) の編集には出ない
//   - 「コード | プレビュー」のタブは、見る時も編集中も 1 つの合体ボタン (joined-buttons)
//   - プレビューは、保存前の編集中の中身を描く。編集領域は隠れるだけで同じ要素が残り、
//     中身もそのまま
//   - コードに戻すと、プレビューに切り替える前の選択 (向きも) とスクロールの位置に戻り、
//     編集領域にフォーカスが戻る。プレビューの文字を選んで文書の選択が替わっていても
//   - プレビューの間に押した保存は、編集中の中身を fs_edit に渡す
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { ReplyOf } from "@ccmsg/protocol";
import { FileViewer } from "../src/client/components/FileViewer.tsx";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { defined, instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { FakeTranscriptWs, Mounted, SID, timelineStore } from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
const restores: Array<() => void> = [];

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.splice(0)) restore();
  document.getSelection()?.removeAllRanges();
});

const SOURCE = ["# 見出し", "", "本文の段落。", ""].join("\n");
const MTIME = "2030-01-01T00:00:00.000Z";

interface Edit {
  path: string;
  content: string;
  expectedMtime: string;
  expectedSize: number;
}

/** The Files tab on `path` (holding `content`), as it is seen. */
async function openViewer(
  path: string,
  content = SOURCE,
): Promise<{ root: HTMLElement; edits: Edit[] }> {
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
  store.dispatch({
    type: "locator/changed",
    locator: { view: "session", sid: SID, path },
    sidebar: CLOSED_SIDEBAR,
  });
  const read: ReplyOf<"fs_read"> = {
    ok: true,
    sid: SID,
    path,
    size: content.length,
    truncated: false,
    binary: false,
    content,
    mtime: MTIME,
  };
  store.dispatch({ type: "fs/file-loading", sid: SID, path, generation: 1 });
  store.dispatch({ type: "fs/file-loaded", sid: SID, path, generation: 1, response: read });
  const tree = defined(store.getState().sessionTrees.get(SID), "the session's tree");
  const edits: Edit[] = [];
  const ws = new FakeTranscriptWs(store);
  const handle = {
    ...ws.handle,
    fsRead: () => Promise.resolve(read),
    fsEdit: (
      _sid: string,
      editPath: string,
      _kind: string,
      editContent: string,
      expectedMtime: string,
      expectedSize: number,
    ): Promise<ReplyOf<"fs_edit">> => {
      edits.push({ path: editPath, content: editContent, expectedMtime, expectedSize });
      return Promise.resolve({ ok: true, sid: SID, path: editPath, size: 0, mtime: MTIME });
    },
  };
  const root = await mounted.mount(
    store,
    handle,
    h(FileViewer, { sid: SID, tree, peer: undefined, workspaceFolders: [] }),
  );
  return { root, edits };
}

function editButton(root: HTMLElement): HTMLButtonElement {
  return instanceOf(
    root.querySelector('button[aria-label="ファイルを編集"]'),
    HTMLButtonElement,
    "the 編集 button",
  );
}

/** The Files tab on `path` (holding `content`), in its 編集 mode. */
async function openEditing(
  path: string,
  content = SOURCE,
): Promise<{ root: HTMLElement; edits: Edit[] }> {
  const opened = await openViewer(path, content);
  await act(() => editButton(opened.root).click());
  return opened;
}

function editor(root: HTMLElement): HTMLElement {
  return instanceOf(
    root.querySelector('[role="textbox"][aria-label="ファイル本文"]'),
    HTMLElement,
    "the 編集 area",
  );
}

function tab(root: HTMLElement, label: "コード" | "プレビュー"): HTMLButtonElement {
  const found = [...root.querySelectorAll(".file-editor .viewer-mode-btn")].find(
    (el) => el.textContent === label,
  );
  return instanceOf(found, HTMLButtonElement, `the ${label} tab`);
}

/** Writes `words` at `offset` of the area's first text node, as typing does. */
async function typeAt(area: HTMLElement, offset: number, words: string): Promise<Text> {
  const text = instanceOf(area.firstChild, Text, "the area's text");
  await act(() => {
    text.insertData(offset, words);
    area.dispatchEvent(new Event("input", { bubbles: true }));
  });
  return text;
}

describe("the 編集 of a markdown file", () => {
  test("has the コード | プレビュー tabs of the viewer, on コード", async () => {
    const { root } = await openEditing("docs/NOTE.md");
    const tabs = defined(root.querySelector(".file-editor .viewer-mode-toggle"), "the tabs");
    expect(tabs.getAttribute("role")).toBe("tablist");
    expect(tabs.getAttribute("aria-label")).toBe("表示モード");
    expect(tabs.classList.contains("joined-buttons")).toBe(true);
    expect([...tabs.querySelectorAll(".viewer-mode-btn")].map((el) => el.textContent)).toEqual([
      "コード",
      "プレビュー",
    ]);
    expect(tab(root, "コード").getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector(".file-editor .viewer-preview")).toBeNull();
  });

  test("プレビュー draws what is being edited, the area kept hidden as it is", async () => {
    const { root } = await openEditing("docs/NOTE.md");
    const area = editor(root);
    await typeAt(area, "# 見出し".length, "を足した");
    await act(() => tab(root, "プレビュー").click());
    const preview = defined(root.querySelector(".file-editor .viewer-preview"), "the preview");
    expect(preview.querySelector("h1")?.textContent).toContain("見出しを足した");
    expect(editor(root)).toBe(area);
    expect(area.closest(".file-editor-body-wrap")?.hasAttribute("hidden")).toBe(true);
    expect(area.textContent).toBe(`# 見出しを足した\n\n本文の段落。\n\n`);
    expect(tab(root, "プレビュー").getAttribute("aria-selected")).toBe("true");
  });

  test("コード brings back the choice (backward), the scroll and the focus as they were", async () => {
    const { root } = await openEditing("docs/NOTE.md");
    const area = editor(root);
    const text = await typeAt(area, 0, "");
    await act(() => {
      area.focus();
      // Backward: from after 「本文」 back into 「見出し」 (between 見 and 出).
      document.getSelection()?.setBaseAndExtent(text, 9, text, 3);
      area.scrollTop = 40;
    });
    await act(() => tab(root, "プレビュー").click());
    // A choice in the preview takes the document's selection.
    const preview = defined(root.querySelector(".file-editor .viewer-preview"), "the preview");
    await act(() => {
      const range = document.createRange();
      range.selectNodeContents(preview);
      document.getSelection()?.removeAllRanges();
      document.getSelection()?.addRange(range);
      area.scrollTop = 0;
    });
    await act(() => tab(root, "コード").click());
    expect(root.querySelector(".file-editor .viewer-preview")).toBeNull();
    expect(area.closest(".file-editor-body-wrap")?.hasAttribute("hidden")).toBe(false);
    expect(document.activeElement).toBe(area);
    const selection = defined(document.getSelection(), "the selection");
    expect([
      selection.anchorNode,
      selection.anchorOffset,
      selection.focusNode,
      selection.focusOffset,
    ]).toEqual([text, 9, text, 3]);
    expect(area.scrollTop).toBe(40);
    expect(area.textContent).toBe(`${SOURCE}\n`);
  });

  test("保存 in the preview saves what is being edited", async () => {
    const { root, edits } = await openEditing("docs/NOTE.md");
    await typeAt(editor(root), SOURCE.indexOf("本文"), "新しい");
    await act(() => tab(root, "プレビュー").click());
    const save = instanceOf(
      root.querySelector('.file-editor button[type="submit"]'),
      HTMLButtonElement,
      "保存",
    );
    await act(async () => {
      save.click();
      await Promise.resolve();
    });
    expect(edits).toEqual([
      {
        path: "docs/NOTE.md",
        content: SOURCE.replace("本文", "新しい本文"),
        expectedMtime: MTIME,
        expectedSize: SOURCE.length,
      },
    ]);
  });
});

describe("the コード | プレビュー tabs of a markdown file as it is seen", () => {
  test("are one joined button", async () => {
    const { root } = await openViewer("docs/NOTE.md");
    const tabs = defined(root.querySelector(".viewer-mode-toggle"), "the tabs");
    expect(tabs.classList.contains("joined-buttons")).toBe(true);
    expect(tabs.getAttribute("role")).toBe("tablist");
    expect([...tabs.querySelectorAll(".viewer-mode-btn")].map((el) => el.textContent)).toEqual([
      "コード",
      "プレビュー",
    ]);
  });
});

describe("the 編集 of a file with no preview", () => {
  test("has no コード | プレビュー tabs", async () => {
    const { root } = await openEditing("src/main.ts", "const x = 1;\n");
    expect(root.querySelector(".file-editor")).not.toBeNull();
    expect(root.querySelector(".viewer-mode-toggle")).toBeNull();
  });
});
