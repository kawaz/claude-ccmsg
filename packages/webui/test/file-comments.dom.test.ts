// A comment on a quote in a file the Files tab shows (DR-0062 §2, §3, §7,
// §12, §13, P20, P26), mounted.
// 何を保証するか:
//   - Files のソースの表示の文字を選ぶと 💬 のボタンが出て、押すとフォームの頭にファイルの
//     パスと行・選んだ文字が出る。保存の comment_add のアンカーは、cwd からのパス・
//     source・選んだ文字・前後の文字・行・列・行の文 (kind: "file")
//   - 行番号だけを選んでもボタンは出ない (読むのは各行の文だけ)
//   - md プレビューで選ぶと、アンカーは preview で、行は選んだ文字を含む md の塊の元の
//     始まりの行と終わりの行、列は持たない
//   - そのファイルのコメントは、今の内容から文字で探し直した箇所の後ろに 💬 を持つ
//     (行がずれていても)。💬 は本文の文字を変えない層にあり、💬 のフィルタへのリンク
//     (TL の位置を覚えていればその位置の 💬 のフィルタ。位置を覚えていてもフィルタを落とさない)
//   - 探し直しに失敗したコメントは、💬 のフィルタで「元の場所が無くなった」と出る。
//     見つかったコメントは出ない
import { afterEach, describe, expect, test } from "bun:test";
import { h, type ComponentChildren } from "preact";
import { act } from "preact/test-utils";
import type { CommentRecord, FileAnchor, UserComment } from "@ccmsg/protocol";
import { FileViewer } from "../src/client/components/FileViewer.tsx";
import { FileCommentFormFloat } from "../src/client/components/FileComments.tsx";
import { useSessionCommentsState } from "../src/client/components/session-comments.ts";
import { SessionCommentsContext } from "../src/client/components/timeline/comment-context.ts";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { timelineHref } from "../src/client/locator.ts";
import { rememberTimelinePosition } from "../src/client/navigation.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import type { SessionTreeState } from "../src/client/store.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  exchange,
  FakeTranscriptWs,
  Mounted,
  page,
  SID,
  timelineStore,
} from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
const restores: Array<() => void> = [];

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.splice(0)) restore();
  document.getSelection()?.removeAllRanges();
});

const ROOT = "/r";
const FILE = "docs/Q.md";
const SOURCE = [
  "# 問い",
  "",
  "## 裁定待ち",
  "",
  "起動の順を決める。",
  "片付けの時機も決める。",
  "",
  "## 確認待ち",
  "",
].join("\n");

function comment(cid: string, anchor: FileAnchor): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid,
    session_id: SID,
    anchor,
    body: "ここは?",
    written: { at: "2030-01-01T00:00:00.000Z" },
    updated_at: "2030-01-01T00:00:00.000Z",
    btw: false,
    status: "draft",
  };
}

/** The session's screen as far as comments go: the one host, its Files'
 * viewer of `FILE` (the tree as it stood once the file loaded), the form
 * floating over it, and its Timeline. */
function Screen({ tree, children }: { tree: SessionTreeState; children?: ComponentChildren }) {
  const host = useSessionCommentsState(ROOT, ROOT);
  const { store } = useApp();
  const timelineTree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  return h(
    SessionCommentsContext.Provider,
    { value: host },
    h(FileViewer, { sid: SID, tree, peer: undefined, workspaceFolders: [] }),
    h(FileCommentFormFloat, { sid: SID }),
    timelineTree === undefined
      ? null
      : h(Timeline, {
          key: SID,
          sid: SID,
          timeline: timelineTree.timeline,
          search: timelineTree.timelineSearch,
          sessionStatus: undefined,
          agent: null,
          active: true,
          visible: true,
        }),
    children,
  );
}

interface Opened {
  root: HTMLElement;
  store: Store;
  adds: Array<Parameters<FakeTranscriptWs["handle"]["commentAdd"]>[1]>;
}

/** The file loaded in the Files tab, the Timeline under the 💬 filter, and
 * `records` the session's comments. */
async function open(records: readonly CommentRecord[] = []): Promise<Opened> {
  restores.push(stubGlobal("localStorage", new MemStorage()));
  // happy-dom has no Navigation API: no entry (nothing to restore) and no
  // change of it.
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
    locator: { view: "session", sid: SID, path: FILE },
    sidebar: CLOSED_SIDEBAR,
  });
  store.dispatch({ type: "fs/file-loading", sid: SID, path: FILE, generation: 1 });
  store.dispatch({
    type: "fs/file-loaded",
    sid: SID,
    path: FILE,
    generation: 1,
    response: {
      ok: true,
      sid: SID,
      path: FILE,
      size: SOURCE.length,
      truncated: false,
      binary: false,
      content: SOURCE,
      mtime: "2030-01-01T00:00:00.000Z",
    },
  });
  const tree = store.getState().sessionTrees.get(SID);
  if (tree === undefined) throw new Error("expected the session's tree");
  store.dispatch({
    type: "locator/changed",
    locator: { view: "timeline", sid: SID, filter: "comment" },
    sidebar: CLOSED_SIDEBAR,
  });
  store.dispatch({
    type: "comments/loaded",
    sid: SID,
    comments: [...records],
    threads: [],
    drafts: [],
  });
  const ws = new FakeTranscriptWs(store);
  const adds: Opened["adds"] = [];
  const handle = {
    ...ws.handle,
    commentAdd: (_sid: string, input: Opened["adds"][number]) => {
      adds.push(input);
      return Promise.resolve({
        ok: true as const,
        comment: comment("c9999", {
          kind: "file",
          path: FILE,
          view: "source",
          text: "x",
          before: "",
          after: "",
          line: 1,
          line_text: "x",
        }),
      });
    },
  };
  const root = await mounted.mount(store, handle, h(Screen, { tree }));
  const read = ws.reads.at(-1);
  if (read === undefined) throw new Error("expected the initial read");
  await read.answer(page(exchange(1)));
  return { root, store, adds };
}

/** Chooses `words` in the text below `scope`, as a person's drag does. */
async function choose(scope: Element, words: string): Promise<void> {
  const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
    const at = node.nodeValue?.indexOf(words) ?? -1;
    if (at < 0) continue;
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + words.length);
    await act(() => {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    return;
  }
  throw new Error(`no ${words} below the scope`);
}

function choiceButton(): HTMLButtonElement | null {
  const found = document.querySelector(".tl-comment-choice");
  return found instanceof HTMLButtonElement ? found : null;
}

function element(found: Element | null, what: string): HTMLElement {
  if (!(found instanceof HTMLElement)) throw new Error(`expected ${what}`);
  return found;
}

/** Writes `body` in the form open and saves it (今すぐ送る off). */
async function save(body: string): Promise<void> {
  const form = element(document.querySelector(".tl-comment-float"), "the comment form");
  const input = form.querySelector("textarea");
  if (!(input instanceof HTMLTextAreaElement)) throw new Error("expected the text");
  await act(() => {
    input.value = body;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    form.querySelector("form")?.requestSubmit();
    await Promise.resolve();
  });
}

describe("a comment on a quote in a file's source", () => {
  test("choose → 💬 → the form with the file, its line and the text → a file anchor", async () => {
    const { root, adds } = await open();
    const body = element(root.querySelector(".viewer-body"), "the source");
    await choose(body, "順を決める");
    const button = choiceButton();
    expect(button).not.toBeNull();
    await act(() => button?.click());
    const head = element(document.querySelector(".tl-comment-float-header"), "the form's head");
    expect(head.querySelector(".tl-comment-kind")?.textContent).toBe(`${FILE}:5`);
    expect(head.querySelector(".tl-comment-chosen")?.textContent).toBe("順を決める");
    await save("ここは?");
    expect(adds).toHaveLength(1);
    expect(adds[0]?.anchor).toEqual({
      kind: "file",
      path: FILE,
      view: "source",
      text: "順を決める",
      before: "# 問い ## 裁定待ち 起動の",
      after: "。 片付けの時機も決める。 ## 確認待ち",
      line: 5,
      col: 4,
      line_text: "起動の順を決める。",
    });
  });

  test("the line numbers alone chosen make no 💬", async () => {
    const { root } = await open();
    const lineNo = element(root.querySelector(".viewer-line .viewer-lineno"), "a line number");
    await choose(lineNo, "1");
    expect(choiceButton()).toBeNull();
  });

  test("a comment is found again by its text after lines moved, with a 💬 in a layer of its own", async () => {
    // Kept when 「起動の順を決める。」 was line 3.
    const moved = comment("c1111", {
      kind: "file",
      path: FILE,
      view: "source",
      text: "順を決める",
      before: "## 裁定待ち 起動の",
      after: "。 片付けの",
      line: 3,
      col: 4,
      line_text: "起動の順を決める。",
    });
    const { root } = await open([moved]);
    const body = element(root.querySelector(".viewer-body"), "the source");
    const marks = body.querySelectorAll(".tl-comment-quote-marks .tl-comment-quote-mark");
    expect(marks).toHaveLength(1);
    const mark = element(marks[0] ?? null, "the 💬");
    expect(mark.getAttribute("href")).toContain("filter=comment");
    // The source's lines draw what they drew.
    expect([...body.querySelectorAll(".viewer-text")].map((t) => t.textContent)).toEqual(
      SOURCE.split("\n").slice(0, -1),
    );
    // Found: the 💬 filter says nothing of its place.
    expect(root.textContent).not.toContain("元の場所が無くなった");
  });

  test("the 💬 goes to the 💬 filter at the position the Timeline last stood at", async () => {
    rememberTimelinePosition(SID, "u-42");
    restores.push(() => rememberTimelinePosition(SID, "head"));
    const found = comment("c1112", {
      kind: "file",
      path: FILE,
      view: "source",
      text: "順を決める",
      before: "## 裁定待ち 起動の",
      after: "。 片付けの",
      line: 5,
      col: 4,
      line_text: "起動の順を決める。",
    });
    const { root } = await open([found]);
    const mark = element(root.querySelector(".viewer-body .tl-comment-quote-mark"), "the 💬");
    expect(mark.getAttribute("href")).toBe(timelineHref(SID, "u-42", "comment"));
  });

  test("a comment whose text is gone from the file is said gone in the 💬 filter", async () => {
    const gone = comment("c2222", {
      kind: "file",
      path: FILE,
      view: "source",
      text: "(なし)",
      before: "## 裁定待ち",
      after: "## 確認待ち",
      line: 5,
      col: 1,
      line_text: "(なし)",
    });
    const { root } = await open([gone]);
    expect(root.querySelector(".viewer-body .tl-comment-quote-mark")).toBeNull();
    const lost = [...root.querySelectorAll(".tl-comment-lost")].map((el) => el.textContent);
    expect(lost).toEqual(["元の場所が無くなった"]);
    // The way back to the file stays.
    const place = [...root.querySelectorAll("a.tl-comment-place")].map((el) =>
      el.getAttribute("href"),
    );
    expect(place).toHaveLength(1);
    expect(place[0]).toContain(`path=${encodeURIComponent(FILE)}`);
  });
});

describe("a comment on a quote in a file's markdown preview", () => {
  test("a choice is on the lines of the markdown block it is in, with no column", async () => {
    const { root, adds } = await open();
    const previewTab = [...root.querySelectorAll(".viewer-mode-btn")].find(
      (tab) => tab.textContent === "プレビュー",
    );
    await act(() => (previewTab instanceof HTMLElement ? previewTab.click() : undefined));
    const preview = element(root.querySelector(".viewer-preview"), "the preview");
    await choose(preview, "片付け");
    await act(() => choiceButton()?.click());
    const head = element(document.querySelector(".tl-comment-float-header"), "the form's head");
    // The paragraph of lines 5-6.
    expect(head.querySelector(".tl-comment-kind")?.textContent).toBe(`${FILE}:5-6`);
    await save("ここは?");
    expect(adds[0]?.anchor).toMatchObject({
      kind: "file",
      path: FILE,
      view: "preview",
      text: "片付け",
      line: 5,
      end_line: 6,
      line_text: "起動の順を決める。",
    });
    expect(adds[0]?.anchor).not.toHaveProperty("col");
  });
});
