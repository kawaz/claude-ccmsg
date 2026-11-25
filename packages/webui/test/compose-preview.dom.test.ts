// The md | source of the boxes a body is written in (DR-0010 §15), mounted:
// the input box (SessionInputComposer) and the comment form (CommentForm).
// source (the textarea) is shown first; md draws the text as a response's
// markdown in a box laid over the textarea, which stays the same element, so
// source gives back the text, its selection, its scroll and the focus. A send
// (and a close, then an open) shows source again. The md side does not stop
// the send.
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { CommentAddResponse, ErrorResponse, UserComment } from "@ccmsg/protocol";
import { SessionInputComposer } from "../src/client/components/SessionInputComposer.tsx";
import {
  resetSessionInputPageState,
  saveDraft,
} from "../src/client/components/session-input-store.ts";
import { resetCommentFormDrafts } from "../src/client/components/timeline/comment-form-drafts.ts";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { initialState } from "../src/client/store.ts";
import { createStore, useStoreState } from "../src/client/useStore.ts";
import { createWsClient, type WsHandle } from "../src/client/ws.ts";
import { instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import {
  exchange,
  FakeTranscriptWs,
  Mounted,
  page,
  SID,
  timelineStore,
  uuidOf,
} from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
let restores: Array<() => void> = [];

beforeEach(() => {
  resetSessionInputPageState();
  resetCommentFormDrafts();
  restores = [stubGlobal("localStorage", new MemStorage())];
});

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.reverse()) restore();
});

/** Every promise a send chained has settled. */
const drained = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function tab(root: HTMLElement, name: "md" | "source"): HTMLButtonElement {
  const found = [...root.querySelectorAll('[role="tab"]')].find((el) => el.textContent === name);
  return instanceOf(found, HTMLButtonElement, `the ${name} tab`);
}

async function press(button: HTMLButtonElement): Promise<void> {
  await act(() => button.click());
}

async function write(textarea: HTMLTextAreaElement, value: string): Promise<void> {
  await act(() => {
    textarea.value = value;
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

const BODY = "## 見出し\n\n- **太字** と `code`\n\n| a | b |\n| - | - |\n| 1 | 2 |";

describe("the input box's md | source", () => {
  /** The input box, opened; user_prompt answers accepted and is counted. */
  async function openBox(): Promise<{ root: HTMLElement; prompts: string[] }> {
    const store = createStore(initialState());
    const prompts: string[] = [];
    const ws: WsHandle = {
      ...createWsClient((action) => store.dispatch(action)),
      userPrompt: async (_sid, text) => {
        prompts.push(text);
        return { ok: true, outcome: "accepted" };
      },
    };
    const root = await mounted.mount(store, ws, h(SessionInputComposer, { sid: SID }));
    await openFab(root);
    return { root, prompts };
  }

  async function openFab(root: HTMLElement): Promise<void> {
    const fab = instanceOf(root.querySelector(".session-input-fab"), HTMLButtonElement, "the FAB");
    await act(() => fab.click());
  }

  function textareaOf(root: HTMLElement): HTMLTextAreaElement {
    return instanceOf(
      root.querySelector(".session-input-textarea"),
      HTMLTextAreaElement,
      "the textarea",
    );
  }

  test("the tabs stand at the left of the row, source chosen and no preview", async () => {
    const { root } = await openBox();
    const row = instanceOf(root.querySelector(".session-input-actions"), HTMLElement, "the row");
    expect(row.firstElementChild?.getAttribute("role")).toBe("tablist");
    expect(tab(root, "source").getAttribute("aria-selected")).toBe("true");
    expect(tab(root, "md").getAttribute("aria-selected")).toBe("false");
    expect(root.querySelector(".compose-preview")).toBeNull();
    expect(root.querySelector("[data-compose-view]")).toBeNull();
  });

  test("md draws the text as markdown over the textarea; source gives it back as it was", async () => {
    const { root } = await openBox();
    const textarea = textareaOf(root);
    await write(textarea, BODY);
    textarea.focus();
    textarea.setSelectionRange(14, 16);
    textarea.scrollTop = 7;

    await press(tab(root, "md"));
    const preview = instanceOf(root.querySelector(".compose-preview"), HTMLElement, "the preview");
    expect(preview.querySelector("h2")?.textContent?.trim()).toBe("見出し");
    expect(preview.querySelector("strong")?.textContent).toBe("太字");
    expect(preview.querySelector("table")).not.toBeNull();
    // Hidden, not made again: the same textarea, its text and selection kept.
    const frame = instanceOf(textarea.parentElement, HTMLElement, "the frame");
    expect(frame.getAttribute("data-compose-view")).toBe("md");
    expect(preview.parentElement).toBe(frame);
    expect(textareaOf(root)).toBe(textarea);
    expect(tab(root, "md").getAttribute("aria-selected")).toBe("true");

    await press(tab(root, "source"));
    expect(root.querySelector(".compose-preview")).toBeNull();
    expect(frame.hasAttribute("data-compose-view")).toBe(false);
    expect(textareaOf(root)).toBe(textarea);
    expect(textarea.value).toBe(BODY);
    expect([textarea.selectionStart, textarea.selectionEnd]).toEqual([14, 16]);
    expect(textarea.scrollTop).toBe(7);
    expect(document.activeElement).toBe(textarea);
  });

  test("an empty text is an empty box", async () => {
    const { root } = await openBox();
    await press(tab(root, "md"));
    const preview = instanceOf(root.querySelector(".compose-preview"), HTMLElement, "the preview");
    expect(preview.textContent).toBe("");
  });

  test("an attachment's [FILE<N>] is drawn as the link it is sent as", async () => {
    saveDraft(SID, "見て [FILE1] と [FILE2]", [
      {
        n: 1,
        name: "shot.png",
        status: "done",
        progress: 100,
        path: "/tmp/claude-ccmsg-501/attachment/0001.png",
      },
      { n: 2, name: "big.bin", status: "uploading", progress: 10 },
    ]);
    const { root } = await openBox();
    await press(tab(root, "md"));
    const preview = instanceOf(root.querySelector(".compose-preview"), HTMLElement, "the preview");
    const image = instanceOf(preview.querySelector("img"), HTMLImageElement, "the image");
    expect(image.getAttribute("src")).toBe("/attachment/0001.png");
    // Not uploaded yet: as typed.
    expect(preview.textContent).toContain("[FILE2]");
  });

  test("sent from md, the box opened again shows source", async () => {
    const { root, prompts } = await openBox();
    await write(textareaOf(root), "**送る**");
    await press(tab(root, "md"));
    const run = instanceOf(
      root.querySelector('.send-split > [aria-current="true"]'),
      HTMLButtonElement,
      "送る",
    );
    await act(async () => {
      run.click();
      await drained();
    });
    expect(prompts).toEqual(["**送る**"]);
    expect(root.querySelector(".session-input-panel")).toBeNull();
    await openFab(root);
    expect(tab(root, "source").getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector(".compose-preview")).toBeNull();
  });

  test("closed in md, the box opened again shows source with the text", async () => {
    const { root } = await openBox();
    await write(textareaOf(root), "書きかけ");
    await press(tab(root, "md"));
    const close = instanceOf(
      root.querySelector(".composer-panel-close"),
      HTMLButtonElement,
      "閉じる",
    );
    await press(close);
    await openFab(root);
    expect(tab(root, "source").getAttribute("aria-selected")).toBe("true");
    expect(root.querySelector(".compose-preview")).toBeNull();
    expect(textareaOf(root).value).toBe("書きかけ");
  });
});

function TimelineOf() {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent: null,
    active: true,
    visible: true,
  });
}

describe("the comment form's md | source", () => {
  /** The Timeline of one exchange with the comment form open on its answer
   * (its 返信). comment_add answers `added` (refused when false). */
  async function openForm(added = true): Promise<{ root: HTMLElement; adds: string[] }> {
    const store = timelineStore();
    store.dispatch({ type: "comments/loaded", sid: SID, comments: [], threads: [], drafts: [] });
    const ws = new FakeTranscriptWs(store);
    const adds: string[] = [];
    const handle: WsHandle = {
      ...ws.handle,
      commentAdd: (_sid, input) => {
        adds.push(input.body);
        const kept: UserComment = {
          kind: "comment",
          author: "user",
          cid: "c0001",
          session_id: SID,
          anchor: { kind: "message", uuid: uuidOf("a", 1), msg_start_with: "answer 1" },
          body: input.body,
          written: { at: "2030-01-01T00:00:00.000Z" },
          updated_at: "2030-01-01T00:00:00.000Z",
          btw: false,
          status: "draft",
        };
        const reply: CommentAddResponse | ErrorResponse = added
          ? { ok: true, comment: kept }
          : { ok: false, error: { code: "session_not_found", msg: "no session" } };
        return Promise.resolve(reply);
      },
      queueSend: (_sid, items) =>
        Promise.resolve({
          ok: true as const,
          results: items.map((item) =>
            item.kind === "comment"
              ? { kind: "comment" as const, id: item.cid, outcome: "sent" as const }
              : { kind: "draft" as const, id: item.id, outcome: "sent" as const },
          ),
        }),
    };
    const root = await mounted.mount(store, handle, h(TimelineOf, {}));
    await ws.lastRead().answer(page([...exchange(1)]));
    const reply = instanceOf(root.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信");
    await act(() => reply.click());
    return { root, adds };
  }

  function formOf(root: HTMLElement): HTMLElement {
    return instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
  }

  function inputOf(root: HTMLElement): HTMLTextAreaElement {
    return instanceOf(
      formOf(root).querySelector(".tl-comment-input"),
      HTMLTextAreaElement,
      "the text",
    );
  }

  test("the tabs stand at the left of the form's row, before 📎", async () => {
    const { root } = await openForm();
    const row = instanceOf(
      formOf(root).querySelector(".tl-comment-form-row"),
      HTMLElement,
      "the row",
    );
    expect(row.firstElementChild?.getAttribute("role")).toBe("tablist");
    expect(row.children[1]?.classList.contains("composer-attach-buttons")).toBe(true);
    expect(tab(formOf(root), "source").getAttribute("aria-selected")).toBe("true");
  });

  test("md draws the text; source gives back the same textarea, its text and selection", async () => {
    const { root } = await openForm();
    const input = inputOf(root);
    await write(input, BODY);
    input.setSelectionRange(3, 5);

    await press(tab(formOf(root), "md"));
    const preview = instanceOf(
      formOf(root).querySelector(".compose-preview"),
      HTMLElement,
      "the preview",
    );
    expect(preview.querySelector("strong")?.textContent).toBe("太字");
    expect(input.parentElement?.getAttribute("data-compose-view")).toBe("md");

    await press(tab(formOf(root), "source"));
    expect(formOf(root).querySelector(".compose-preview")).toBeNull();
    expect(inputOf(root)).toBe(input);
    expect(input.value).toBe(BODY);
    expect([input.selectionStart, input.selectionEnd]).toEqual([3, 5]);
    expect(document.activeElement).toBe(input);
  });

  test("sent from md and refused, the form stays on source with the text", async () => {
    const { root, adds } = await openForm(false);
    await write(inputOf(root), "**コメント**");
    await press(tab(formOf(root), "md"));
    const run = instanceOf(
      formOf(root).querySelector('.send-split > [aria-current="true"]'),
      HTMLButtonElement,
      "送る",
    );
    await act(async () => {
      run.click();
      await drained();
    });
    expect(adds).toEqual(["**コメント**"]);
    expect(formOf(root).querySelector(".compose-preview")).toBeNull();
    expect(tab(formOf(root), "source").getAttribute("aria-selected")).toBe("true");
    expect(inputOf(root).value).toBe("**コメント**");
  });

  test("sent from md and kept, the form closes", async () => {
    const { root, adds } = await openForm();
    await write(inputOf(root), "**コメント**");
    await press(tab(formOf(root), "md"));
    const run = instanceOf(
      formOf(root).querySelector('.send-split > [aria-current="true"]'),
      HTMLButtonElement,
      "送る",
    );
    await act(async () => {
      run.click();
      await drained();
    });
    expect(adds).toEqual(["**コメント**"]);
    expect(root.querySelector(".tl-comment-float")).toBeNull();
  });
});
