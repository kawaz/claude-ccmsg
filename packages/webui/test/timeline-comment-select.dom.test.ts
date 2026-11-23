// A comment on a quote inside a Timeline bubble (DR-0062 §2, §3, §12, P31),
// mounted.
// 何を保証するか:
//   - コメントを付けられる吹き出しの描画された文字 (応答の md・送ったコメントの本文) を
//     選ぶと 💬 のボタンが出て、押すとフォームの頭に選んだ文字が出る。保存すると、応答
//     の中の選択は行の uuid・冒頭・選んだ文字・前後の文字・位置のアンカー (selection)、
//     送ったコメントの中の選択はその cid と選んだ文字・前後の文字のアンカー (comment)
//     の comment_add になる
//   - source の表示・jsonl の表示・コメントの対象でない項目 (ユーザの発言)・agent の
//     TL の文字を選んでもボタンは出ない
//   - 選択範囲のコメントの付いた吹き出しは、探し直した範囲の後ろに 💬 を持つ。💬 は
//     本文の文字を変えない層にあり、押すとそのコメント 1 件を選んで 💬 のフィルタに移る
//   - 探し直しに失敗したコメントは、💬 のフィルタで「元の場所が見つからない」と出る
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import { commentsPromptText, type CommentRecord, type UserComment } from "@ccmsg/protocol";
import type { AgentRef } from "../src/client/locator.ts";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
  textBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
import { instanceOf, MemStorage, stubGlobal } from "./helpers.ts";
import { withDom } from "./dom.ts";
import { FakeTranscriptWs, Mounted, page, SID, timelineStore, uuidOf } from "./timeline-harness.ts";

withDom();

const mounted = new Mounted();
const restores: Array<() => void> = [];

afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.splice(0)) restore();
  document.getSelection()?.removeAllRanges();
});

const ANSWER = "起動手順を終えました。次は状態ファイルを書き直すことです。";
const ANSWER_UUID = uuidOf("a", 1);

function TimelineOf({ agent }: { agent: AgentRef | null }) {
  const { store } = useApp();
  const tree = useStoreState(store, (s) => s.sessionTrees.get(SID));
  if (tree === undefined) return null;
  return h(Timeline, {
    key: SID,
    sid: SID,
    timeline: tree.timeline,
    search: tree.timelineSearch,
    sessionStatus: undefined,
    agent,
    active: true,
    visible: true,
  });
}

function comment(patch: Partial<UserComment> & Pick<UserComment, "cid">): UserComment {
  return {
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: { kind: "message", uuid: ANSWER_UUID, msg_start_with: ANSWER },
    body: "ここは?",
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: ANSWER_UUID },
    updated_at: "2030-01-01T00:00:00.000Z",
    btw: false,
    status: "draft",
    ...patch,
  };
}

const rows = (answer = ANSWER): string[] => [
  jsonl(userContentRow("question 1", { uuid: uuidOf("u", 1) })),
  jsonl(assistantContentRow([textBlock(answer)], { uuid: ANSWER_UUID })),
];

interface Opened {
  root: HTMLElement;
  store: Store;
  adds: Array<Parameters<FakeTranscriptWs["handle"]["commentAdd"]>[1]>;
}

async function open(
  lines: readonly string[],
  records: readonly CommentRecord[] = [],
  options: { filter?: "comment"; agent?: AgentRef } = {},
): Promise<Opened> {
  restores.push(stubGlobal("localStorage", new MemStorage()));
  const store = timelineStore(options.agent === undefined ? {} : { agent: options.agent });
  if (options.filter !== undefined) {
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid: SID, filter: options.filter },
      sidebar: CLOSED_SIDEBAR,
    });
  }
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
    commentAdd: (sid: string, input: Opened["adds"][number]) => {
      adds.push(input);
      return Promise.resolve({
        ok: true as const,
        comment: comment({ cid: "c9999", session_id: sid, body: input.body }),
      });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, { agent: options.agent ?? null }));
  const read = ws.reads.at(-1);
  if (read === undefined) throw new Error("expected the initial read");
  await read.answer(page([...lines]));
  return { root, store, adds };
}

/** Chooses `words` in the text below `scope`, as a person's drag does, and
 * lets the page hear of it. */
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

function choiceButton(root: HTMLElement): HTMLButtonElement | null {
  const found = root.ownerDocument.querySelector(".tl-comment-choice");
  return found instanceof HTMLButtonElement ? found : null;
}

function bubbleOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    root.querySelector(`[data-timeline-uuid="${uuid}"] .tl-bubble`),
    HTMLElement,
    `the bubble of ${uuid}`,
  );
}

async function save(root: HTMLElement, text: string): Promise<void> {
  const float = instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
  const input = instanceOf(float.querySelector(".tl-comment-input"), HTMLTextAreaElement, "input");
  await act(() => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = instanceOf(float.querySelector(".tl-comment-form"), HTMLFormElement, "form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

describe("choosing text in a bubble (DR-0062 §3)", () => {
  test("in a response's markdown: 💬, the form with the text chosen, and a comment on the quote", async () => {
    const { root, adds } = await open(rows());
    const text = instanceOf(
      bubbleOf(root, ANSWER_UUID).querySelector("[data-comment-text]"),
      HTMLElement,
      "the response's text",
    );
    await choose(text, "状態ファイル");
    const button = choiceButton(root);
    expect(button).not.toBeNull();
    await act(() => button?.click());
    const float = instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
    expect(float.querySelector(".tl-comment-chosen")?.textContent).toBe("状態ファイル");
    await save(root, "どこの?");
    expect(adds).toEqual([
      {
        anchor: {
          kind: "selection",
          uuid: ANSWER_UUID,
          msg_start_with: ANSWER,
          text: "状態ファイル",
          before: "起動手順を終えました。次は",
          after: "を書き直すことです。",
          start: 13,
          end: 19,
        },
        body: "どこの?",
        attachments: [],
        btw: false,
        sendNow: true,
      },
    ]);
  });

  // 何を保証するか (DR-0062 §3): 💬 の下の btw から開いたフォームは btw が入った状態で開き
  // (「後で」は切れている)、保存すると btw のコメントを今すぐ聞く。
  test("the choice's btw opens the form with btw on, and saving asks a btw now", async () => {
    const { root, adds } = await open(rows());
    const text = instanceOf(
      bubbleOf(root, ANSWER_UUID).querySelector("[data-comment-text]"),
      HTMLElement,
      "the response's text",
    );
    await choose(text, "状態ファイル");
    const btw = instanceOf(
      root.ownerDocument.querySelector(".tl-comment-choice-btw"),
      HTMLButtonElement,
      "the choice's btw",
    );
    await act(() => btw.click());
    const float = instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
    expect(float.querySelector(".session-input-btw")?.getAttribute("aria-pressed")).toBe("true");
    expect(float.querySelector(".session-input-later")?.getAttribute("aria-pressed")).toBe("false");
    expect(
      float.querySelector(".tl-comment-send > span:not(.session-input-send-off)")?.textContent,
    ).toBe("btw");
    await save(root, "これは何?");
    expect(adds.map((add) => [add.btw, add.sendNow])).toEqual([[true, true]]);
  });

  test("in a comment sent: a comment on that cid, with the text chosen", async () => {
    const prompt = commentsPromptText([{ comment: "c0001", body: "一つ目のコメントの本文" }]);
    const { root, adds } = await open(
      [...rows(), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [comment({ cid: "c0001", body: "一つ目のコメントの本文", status: "delivered" })],
    );
    const body = instanceOf(
      root.querySelector(".tl-bubble-comment .tl-comment-body"),
      HTMLElement,
      "the comment's text",
    );
    await choose(body, "コメント");
    await act(() => choiceButton(root)?.click());
    await save(root, "続き");
    expect(adds.map((add) => add.anchor)).toEqual([
      {
        kind: "comment",
        cid: "c0001",
        text: "コメント",
        before: "一つ目の",
        after: "の本文",
        start: 4,
        end: 8,
      },
    ]);
  });

  test("no 💬 for the source view, the jsonl, a person's prompt or an agent's Timeline", async () => {
    const { root } = await open(rows());
    // A person's prompt is not commented on.
    await choose(
      instanceOf(root.querySelector(`[data-timeline-uuid="${uuidOf("u", 1)}"]`), HTMLElement, "u1"),
      "question",
    );
    expect(choiceButton(root)).toBeNull();
    // The response's head-less source view.
    const bubble = bubbleOf(root, ANSWER_UUID);
    const item = instanceOf(bubble.closest(".tl-item"), HTMLElement, "the response's item");
    const sourceTab = [...item.querySelectorAll("[role=tab]")].find(
      (tab) => tab.textContent === "source",
    );
    expect(sourceTab).toBeDefined();
    await act(() => (sourceTab instanceof HTMLElement ? sourceTab.click() : undefined));
    await choose(
      instanceOf(bubble.querySelector(".tl-bubble-source"), HTMLElement, "source"),
      "状態ファイル",
    );
    expect(choiceButton(root)).toBeNull();
  });

  test("no 💬 in an agent's Timeline", async () => {
    const agent: AgentRef = { agentId: "a0123456789abcdef" };
    const sidechain = { isSidechain: true, agentId: "a0123456789abcdef" };
    const { root } = await open(
      [
        jsonl(userContentRow("調べて", { ...sidechain, uuid: uuidOf("u", 1), parentUuid: null })),
        jsonl(assistantContentRow([textBlock(ANSWER)], { ...sidechain, uuid: ANSWER_UUID })),
      ],
      [],
      { agent },
    );
    expect(root.querySelector(".tl-comment-reply")).toBeNull();
    const text = [...root.querySelectorAll(".tl-bubble-assistant")].at(-1);
    expect(text).toBeDefined();
    if (text === undefined) return;
    await choose(text, "状態ファイル");
    expect(choiceButton(root)).toBeNull();
  });
});

describe("a quote's comment on its bubble (DR-0062 §12, P31)", () => {
  const quoted = (patch: Partial<Extract<UserComment["anchor"], { kind: "selection" }>> = {}) =>
    comment({
      cid: "c0002",
      anchor: {
        kind: "selection",
        uuid: ANSWER_UUID,
        msg_start_with: ANSWER,
        text: "状態ファイル",
        before: "起動手順を終えました。次は",
        after: "を書き直すことです。",
        start: 13,
        end: 19,
        ...patch,
      },
    });

  test("a 💬 after the quote, in a layer that adds no text; pressing it selects that comment", async () => {
    const { root } = await open(rows(), [quoted()]);
    const bubble = bubbleOf(root, ANSWER_UUID);
    const mark = instanceOf(
      bubble.querySelector(".tl-comment-quote-marks .tl-comment-quote-mark"),
      HTMLAnchorElement,
      "the quote's 💬",
    );
    expect(mark.textContent).toBe("");
    expect(mark.getAttribute("aria-label")).toContain("c0002");
    expect(bubble.querySelector("[data-comment-text]")?.textContent?.trim()).toBe(ANSWER);
    expect(mark.getAttribute("href")).toContain("filter=comment");
  });

  test("pressing a quote's 💬 selects that one comment in the 💬 filter", async () => {
    const other = comment({
      cid: "c0003",
      body: "もう一つ",
      anchor: {
        kind: "selection",
        uuid: ANSWER_UUID,
        msg_start_with: ANSWER,
        text: "書き直す",
        before: "",
        after: "",
      },
    });
    const { root, store } = await open(rows(), [quoted(), other]);
    const mark = [...bubbleOf(root, ANSWER_UUID).querySelectorAll(".tl-comment-quote-mark")].find(
      (el) => el.getAttribute("aria-label")?.includes("c0002") === true,
    );
    expect(mark).toBeDefined();
    await act(() => {
      mark?.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
    });
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, filter: "comment" },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    const selected = [
      ...root.querySelectorAll(".tl-bubble-comment[data-unsent][data-comment-selected]"),
    ].map((bubble) => bubble.querySelector(".tl-comment-body")?.textContent);
    expect(selected).toEqual(["ここは?"]);
  });

  test("a quote no longer drawn is said lost in the 💬 filter", async () => {
    // What the bubble draws no longer holds it (a translation, a drawing
    // changed): here a quote the response never drew.
    const { root } = await open(
      rows(),
      [quoted({ text: "どこにも無い文字", before: "", after: "" })],
      {
        filter: "comment",
      },
    );
    const bubble = bubbleOf(root, ANSWER_UUID);
    expect(bubble.querySelector(".tl-comment-quote-mark")).toBeNull();
    // Drawn again as the region reports.
    await act(async () => {
      await Promise.resolve();
    });
    const unsent = instanceOf(
      root.querySelector(".tl-bubble-comment[data-unsent]"),
      HTMLElement,
      "the unsent comment",
    );
    expect(unsent.querySelector(".tl-comment-lost")?.textContent).toBe("元の場所が見つからない");
    expect(unsent.querySelector(".tl-comment-selection")?.textContent).toBe("どこにも無い文字");
  });
});
