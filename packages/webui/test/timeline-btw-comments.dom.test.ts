// The btw comments in the Timeline (DR-0062 §12, §13, §14): the question
// drawn as a person's comment, its fork's answer below it, framed with a
// dashed line, where the question was sent; 取り消し while it runs, もう一度聞く
// once it failed or was canceled, 返信 once it is done (a reply to it is on
// the answer's cid); the 💬 filter's btw box takes them in and out, and a
// reply to the answer follows it in its thread. The comment form's btw and
// the choice's btw make a btw comment.
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { BtwAnswer, CommentRecord, UserComment } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState } from "../src/client/useStore.ts";
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
const restores: Array<() => void> = [];
afterEach(async () => {
  await mounted.unmount();
  for (const restore of restores.splice(0)) restore();
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

const SENT = { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) };

function question(patch: Partial<UserComment> = {}): UserComment {
  return {
    kind: "comment",
    author: "user",
    cid: "c0001",
    session_id: SID,
    anchor: { kind: "timing" },
    body: "xx て何?",
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: uuidOf("a", 1) },
    sent: SENT,
    updated_at: "2030-01-01T00:00:01.000Z",
    btw: true,
    status: "sent",
    ...patch,
  };
}

function answer(patch: Partial<BtwAnswer> = {}): BtwAnswer {
  return {
    kind: "comment",
    author: "btw",
    cid: "c0002",
    session_id: SID,
    anchor: { kind: "comment", cid: "c0001" },
    body: "答えの文",
    written: SENT,
    updated_at: "2030-01-01T00:00:02.000Z",
    status: "done",
    model: "claude-opus-5-5",
    effort: "high",
    ended_at: "2030-01-01T00:00:05.000Z",
    ...patch,
  };
}

interface Calls {
  cancels: string[];
  retries: string[];
  adds: Array<{ anchor: unknown; btw: boolean; body: string }>;
}

async function open(
  records: readonly CommentRecord[],
  filter: "comment" | null = null,
): Promise<{ root: HTMLElement; calls: Calls }> {
  restores.push(stubGlobal("localStorage", new MemStorage()));
  const store = timelineStore();
  if (filter !== null) {
    store.dispatch({
      type: "locator/changed",
      locator: { view: "timeline", sid: SID, filter },
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
  const calls: Calls = { cancels: [], retries: [], adds: [] };
  const handle = {
    ...ws.handle,
    commentBtwCancel: (_sid: string, cid: string) => {
      calls.cancels.push(cid);
      return Promise.resolve({ ok: true as const });
    },
    commentBtwRetry: (_sid: string, cid: string) => {
      calls.retries.push(cid);
      return Promise.resolve({ ok: true as const, comment: question({ status: "sending" }) });
    },
    commentAdd: (_sid: string, input: Parameters<FakeTranscriptWs["handle"]["commentAdd"]>[1]) => {
      calls.adds.push({ anchor: input.anchor, btw: input.btw, body: input.body });
      return Promise.resolve({ ok: true as const, comment: question({ cid: "c9999" }) });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...exchange(1), ...exchange(2)]));
  return { root, calls };
}

function btwOf(root: HTMLElement): HTMLElement {
  return instanceOf(root.querySelector(".tl-btw"), HTMLElement, "the btw");
}

function buttonIn(el: Element, text: string): HTMLButtonElement {
  const found = [...el.querySelectorAll("button")].find((b) => b.textContent === text);
  return instanceOf(found, HTMLButtonElement, `the ${text} button`);
}

describe("a btw comment in the Timeline", () => {
  // 質問はコメントの見た目、答えは btw の答えの見た目で、送った時点の項目の直後に 1 項目で出る。
  test("its question and answer stand in one item after the item it was sent at", async () => {
    const { root } = await open([question(), answer()]);
    const btw = btwOf(root);
    expect(btw.querySelector(".tl-bubble-comment .tl-comment-body")?.textContent).toBe("xx て何?");
    expect(btw.querySelector(".tl-btw-answer")?.textContent).toContain("答えの文");
    const items = [...root.querySelectorAll(".tl-item")];
    const at = (text: string) => items.findIndex((el) => el.textContent?.includes(text) === true);
    const btwAt = items.indexOf(instanceOf(btw.closest(".tl-item"), HTMLElement, "its item"));
    expect(at("answer 1")).toBeLessThan(btwAt);
    expect(btwAt).toBeLessThan(at("question 2"));
    // The question of a btw takes no 返信; the answer done does.
    expect(btw.querySelectorAll(".tl-bubble-comment .tl-comment-reply")).toHaveLength(0);
    expect(btw.querySelectorAll(".tl-btw-answer .tl-comment-reply")).toHaveLength(1);
  });

  test("a running answer is canceled by its cid", async () => {
    const { root, calls } = await open([
      question(),
      answer({ status: "running", body: "途中", ended_at: undefined }),
    ]);
    const btw = btwOf(root);
    expect(btw.querySelectorAll(".tl-comment-reply")).toHaveLength(0);
    await act(() => buttonIn(btw, "取り消し").click());
    expect(calls.cancels).toEqual(["c0002"]);
  });

  // 失敗・取り消しの答えには「もう一度聞く」。前の試みは理由の 1 行に畳む。
  test("a failed answer is asked again by its question, the attempts before folded", async () => {
    const { root, calls } = await open([
      question(),
      answer({ cid: "c0002", status: "canceled", error: "取り消した", body: "" }),
      answer({ cid: "c0003", status: "failed", error: "overloaded", body: "" }),
    ]);
    const btw = btwOf(root);
    expect([...btw.querySelectorAll(".tl-btw-attempt")].map((p) => p.textContent)).toEqual([
      "取り消した",
    ]);
    expect(btw.querySelector(".tl-btw-error")?.textContent).toBe("overloaded");
    await act(() => buttonIn(btw, "もう一度聞く").click());
    expect(calls.retries).toEqual(["c0001"]);
  });

  // 答えへの返信はその答えの cid へのコメントになる。
  test("返信 of the answer opens the form of a comment on the answer", async () => {
    const { root, calls } = await open([question(), answer()]);
    const reply = instanceOf(
      btwOf(root).querySelector(".tl-btw-answer .tl-comment-reply"),
      HTMLButtonElement,
      "返信",
    );
    await act(() => reply.click());
    const float = instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
    const input = instanceOf(float.querySelector("textarea"), HTMLTextAreaElement, "its text");
    await act(() => {
      input.value = "続き";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = instanceOf(float.querySelector("form"), HTMLFormElement, "the form element");
    await act(() => form.requestSubmit());
    expect(calls.adds).toEqual([
      { anchor: { kind: "comment", cid: "c0002" }, btw: false, body: "続き" },
    ]);
  });

  // フォームの btw のピルを入れて保存すると btw のコメントになる。
  test("the form's btw makes a btw comment", async () => {
    const { root, calls } = await open([question(), answer()]);
    await act(() =>
      instanceOf(root.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信").click(),
    );
    const float = instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
    const pill = instanceOf(float.querySelector(".session-input-btw"), HTMLButtonElement, "btw");
    expect(pill.getAttribute("aria-pressed")).toBe("false");
    await act(() => pill.click());
    expect(pill.getAttribute("aria-pressed")).toBe("true");
    const input = instanceOf(float.querySelector("textarea"), HTMLTextAreaElement, "its text");
    await act(() => {
      input.value = "btw で";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      instanceOf(float.querySelector("form"), HTMLFormElement, "form").requestSubmit(),
    );
    expect(calls.adds.map((add) => add.btw)).toEqual([true]);
  });
});

describe("a btw comment under the 💬 filter", () => {
  // btw のチェックで出し入れでき、答えへの返信は btw の項目の直後に並ぶ。
  test("the btw box takes it in and out, and a reply to its answer follows it", async () => {
    const reply: UserComment = {
      ...question({ cid: "c0005", btw: false, anchor: { kind: "comment", cid: "c0002" } }),
      sent: { at: "2030-01-01T00:00:09.000Z", after_uuid: uuidOf("a", 2) },
      status: "sent",
    };
    const { root } = await open([question(), answer(), reply], "comment");
    const list = instanceOf(root.querySelector(".tl-lines"), HTMLElement, "the list");
    expect(list.getAttribute("data-comment-show")).toContain("btw");
    const btwItem = instanceOf(btwOf(root).closest(".tl-item"), HTMLElement, "the btw's item");
    const replyItem = [...root.querySelectorAll(".tl-bubble-comment")]
      .find((b) => b.textContent?.includes("c0002 への返信") === true)
      ?.closest(".tl-item");
    const orderOf = (el: Element | null | undefined) =>
      Number(el instanceof HTMLElement ? el.style.getPropertyValue("--thread-order") : NaN);
    expect(orderOf(replyItem)).toBe(orderOf(btwItem) + 1);
    const box = [...root.querySelectorAll<HTMLInputElement>("input[type=checkbox]")].find(
      (input) => input.parentElement?.textContent?.trim() === "btw",
    );
    await act(() => instanceOf(box, HTMLInputElement, "the btw box").click());
    expect(list.getAttribute("data-comment-show")).not.toContain("btw");
  });

  // 未送信の btw も点線の枠で出て、送る・直す・消すを持つ。
  test("an unsent btw is drawn as a btw, unsent, with its buttons", async () => {
    const { root } = await open(
      [question({ status: "draft", sent: undefined, cid: "c0007" })],
      "comment",
    );
    const btw = btwOf(root);
    expect(btw.hasAttribute("data-unsent")).toBe(true);
    expect(
      [...btw.querySelectorAll(".tl-comment-actions button")].map((b) => b.textContent),
    ).toEqual(["消す", "直す", "送る"]);
    expect(btw.querySelector(".tl-btw-answer")).toBeNull();
  });
});
