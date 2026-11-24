// The btw comments in the Timeline (DR-0062 §12, §13, §14): the question
// drawn as a person's comment, its fork's answer below it in the bubble of an
// agent's reply, both with the btw badge, where the question was sent; 取り消し while it runs (with how
// long and the tool its fork runs), もう一度聞く once it failed or was
// canceled, 返信 once it is done (a reply to it is on the answer's cid); a
// btw pushed later comes in at its place and its changes replace it; one
// older than a window that does not start at the transcript's start waits
// for its place to be read, but the 💬 filter lists it; of the filters only
// the 💬 one shows btws; the 💬 filter's btw box takes them in and out, and a
// reply to the answer follows it in its thread. The comment form's btw and
// the choice's btw make a btw comment. A btw has no frame of its own: its
// question keeps a comment's dashed bubble, its answer has a reply's frame and
// ground, and a choice in the answer's text makes a comment on its quote.
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import type { BtwAnswer, CommentRecord, ThreadState, UserComment } from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
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
  resolves: Array<{ cid: string; resolved: boolean; seen: string }>;
}

/** The Timeline of `records`, under `filter`, its window two exchanges read
 * from byte `start` (0: the transcript's start). */
async function open(
  records: readonly CommentRecord[],
  filter: "comment" | null = null,
  start = 0,
  threads: readonly ThreadState[] = [],
): Promise<{ root: HTMLElement; calls: Calls; store: Store }> {
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
    threads: [...threads],
    drafts: [],
  });
  const ws = new FakeTranscriptWs(store);
  const calls: Calls = { cancels: [], retries: [], adds: [], resolves: [] };
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
    commentResolve: (_sid: string, cid: string, resolved: boolean, seen: string) => {
      calls.resolves.push({ cid, resolved, seen });
      return Promise.resolve({
        ok: true as const,
        thread: { kind: "thread" as const, session_id: SID, root: "c0001" },
      });
    },
    commentAdd: (_sid: string, input: Parameters<FakeTranscriptWs["handle"]["commentAdd"]>[1]) => {
      calls.adds.push({ anchor: input.anchor, btw: input.btw, body: input.body });
      return Promise.resolve({ ok: true as const, comment: question({ cid: "c9999" }) });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...exchange(1), ...exchange(2)], start));
  return { root, calls, store };
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

  // 走っている答えは、走っている時間と fork が今使っている tool を出す。取り消しを
  // 送ったら答えが終わるまでボタンは押せない (二度送らない)。
  test("a running answer says it runs and the tool its fork runs; 取り消し sent stays off", async () => {
    const { root, calls } = await open([
      question(),
      answer({ status: "running", body: "", tool: "Read", ended_at: undefined }),
    ]);
    const running = instanceOf(
      btwOf(root).querySelector(".tl-btw-running"),
      HTMLElement,
      "the running line",
    );
    expect(running.textContent).toContain("btw 応答中");
    expect(running.textContent).toContain("(Read)");
    const cancel = buttonIn(running, "取り消し");
    await act(() => cancel.click());
    expect(calls.cancels).toEqual(["c0002"]);
    expect(cancel.disabled).toBe(true);
  });

  // 後から届いた btw (ev:"comment") は送った時点の項目の直後に入り、答えが変わる
  // たびに同じ項目が置き換わる (2 つにならない)。
  test("a btw pushed later comes in at its place, and its answer's change replaces it", async () => {
    const { root, store } = await open([]);
    expect(root.querySelector(".tl-btw")).toBeNull();
    const sent = { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("u", 2) };
    await act(() => {
      store.dispatch({ type: "comment/changed", comment: question({ sent }) });
      store.dispatch({
        type: "comment/changed",
        comment: answer({ status: "running", body: "", written: sent, ended_at: undefined }),
      });
    });
    const items = [...root.querySelectorAll(".tl-item")];
    const at = (text: string) => items.findIndex((el) => el.textContent?.includes(text) === true);
    const btwAt = items.indexOf(instanceOf(btwOf(root).closest(".tl-item"), HTMLElement, "item"));
    expect(at("question 2")).toBeLessThan(btwAt);
    expect(btwAt).toBeLessThan(at("answer 2"));
    await act(() => {
      store.dispatch({ type: "comment/changed", comment: answer({ body: "出た", written: sent }) });
    });
    expect(root.querySelectorAll(".tl-btw")).toHaveLength(1);
    expect(btwOf(root).querySelector(".tl-btw-answer")?.textContent).toContain("出た");
    expect(btwOf(root).querySelector(".tl-btw-running")).toBeNull();
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
    expect(btw.querySelector(".tl-btw-running")).toBeNull();
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

describe("the btw's look (app.css)", () => {
  let sheet: HTMLStyleElement | null = null;
  beforeAll(async () => {
    sheet = document.createElement("style");
    sheet.textContent = await Bun.file(new URL("../src/public/app.css", import.meta.url)).text();
    document.head.append(sheet);
  });
  afterAll(() => {
    sheet?.remove();
    sheet = null;
  });

  // 何を保証するか (DR-0062 §12、kawaz 2026-11-24): btw の項目は全体を囲む枠を持たない。
  // 質問の側は普通のコメントと同じ点線の吹き出し、答えの側は comment_reply の返信と同じ
  // 吹き出し (応答の地と左の縁) で、どちらの頭にも btw のバッジが付く。btw でないコメント
  // にバッジは付かない。
  test("no frame around it; the question a comment's bubble, the answer a reply's, both badged", async () => {
    const plain = question({
      cid: "c0009",
      btw: false,
      status: "sending",
      body: "普通のコメント",
      sent: undefined,
    });
    const { root } = await open([question(), answer(), plain]);
    const btw = btwOf(root);
    // No border declared: happy-dom computes it as "" (a browser as "none").
    expect(["", "none"]).toContain(getComputedStyle(btw).borderTopStyle);
    const asked = instanceOf(
      btw.querySelector(".tl-bubble-comment > .tl-bubble-body"),
      HTMLElement,
      "the question's bubble",
    );
    expect(getComputedStyle(asked).borderTopStyle).toBe("dashed");
    expect(asked.querySelector(".tl-comment-on .tl-btw-badge")?.textContent).toBe("btw");
    const answered = instanceOf(
      btw.querySelector(".tl-btw-answer.tl-bubble-assistant.tl-bubble-comment-reply"),
      HTMLElement,
      "the answer's bubble",
    );
    const body = instanceOf(
      answered.querySelector(":scope > .tl-bubble-body"),
      HTMLElement,
      "the answer's body",
    );
    expect(getComputedStyle(body).borderLeftStyle).toBe("solid");
    expect(body.querySelector(".tl-comment-reply-head .tl-btw-badge")?.textContent).toBe("btw");
    const comment = [...root.querySelectorAll(".tl-bubble-comment")].find(
      (bubble) => bubble.closest(".tl-btw") === null,
    );
    expect(comment).toBeDefined();
    expect(comment?.querySelector(".tl-btw-badge")).toBeNull();
  });

  // 何を保証するか: 走っている・失敗した・取り消した答えも、同じ返信の吹き出しの中に
  // 応答中の行・失敗の文・もう一度聞くを持つ (吹き出しの外にはみ出さない)。
  test("running, failed and canceled answers keep their lines inside the reply's bubble", async () => {
    for (const patch of [
      { status: "running" as const, body: "", ended_at: undefined },
      { status: "failed" as const, body: "", error: "overloaded" },
      { status: "canceled" as const, body: "" },
    ]) {
      const { root } = await open([question(), answer(patch)]);
      const body = instanceOf(
        btwOf(root).querySelector(".tl-btw-answer > .tl-bubble-body"),
        HTMLElement,
        `the ${patch.status} answer's body`,
      );
      expect(body.querySelector(".tl-btw-badge")?.textContent).toBe("btw");
      if (patch.status === "running") expect(body.querySelector(".tl-btw-running")).not.toBeNull();
      else expect(buttonIn(body, "もう一度聞く")).toBeDefined();
      if (patch.status === "failed") {
        expect(body.querySelector(".tl-btw-error")?.textContent).toBe("overloaded");
      }
      await mounted.unmount();
    }
  });
});

describe("a choice in a btw's answer (DR-0062 §2, §3)", () => {
  // 何を保証するか: btw の答えの描画された文字は範囲選択のコメントの対象で、選ぶと 💬 が
  // 出て、保存するとその答えの cid と選んだ文字へのコメントになる。
  test("choosing text in the answer: 💬, and a comment on the answer's cid with the text", async () => {
    const { root, calls } = await open([question(), answer({ body: "答えの文の中ほど" })]);
    const text = instanceOf(
      btwOf(root).querySelector(".tl-btw-answer [data-comment-text]"),
      HTMLElement,
      "the answer's text",
    );
    const walker = document.createTreeWalker(text, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    const at = node?.nodeValue?.indexOf("中ほど") ?? -1;
    expect(at).toBeGreaterThanOrEqual(0);
    const range = document.createRange();
    if (node !== null) {
      range.setStart(node, at);
      range.setEnd(node, at + 3);
    }
    await act(() => {
      const selection = document.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
    });
    const choice = instanceOf(
      document.querySelector(".tl-comment-choice"),
      HTMLButtonElement,
      "the choice's 💬",
    );
    await act(() => choice.click());
    const float = instanceOf(root.querySelector(".tl-comment-float"), HTMLElement, "the form");
    const input = instanceOf(float.querySelector("textarea"), HTMLTextAreaElement, "its text");
    await act(() => {
      input.value = "ここ";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    await act(() =>
      instanceOf(float.querySelector("form"), HTMLFormElement, "form").requestSubmit(),
    );
    expect(calls.adds).toHaveLength(1);
    expect(calls.adds[0]?.anchor).toMatchObject({ kind: "comment", cid: "c0002", text: "中ほど" });
    document.getSelection()?.removeAllRanges();
  });
});

describe("the 解決済み button of a btw (DR-0062 §6, P14)", () => {
  /** The label each 解決済み button of `el` shows. */
  const shownLabels = (el: Element): string[] =>
    [...el.querySelectorAll(".tl-comment-resolve .stacked-labels")].map((labels) => {
      const shown = Number(labels.getAttribute("data-shown"));
      return labels.children.item(shown)?.textContent ?? "";
    });

  // 何を保証するか (kawaz 2026-11-24): btw の質問と答えの吹き出しのどちらにも「✔️解決済み」の
  // 文字付きのボタンが hover を待たずに見えていて、押すとそのスレッドを解決にする (印は daemon が最初のコメントに付ける)。
  // 解決済みのスレッドでは「✅解決済み」になる。
  test("the question and the answer both have ✔️解決済み; pressed, it resolves the thread", async () => {
    const { root, calls } = await open([question(), answer()]);
    expect(shownLabels(btwOf(root))).toEqual(["✔️解決済み", "✔️解決済み"]);
    // Shown without a hover: outside the footer's hover toolbar.
    for (const button of btwOf(root).querySelectorAll(".tl-comment-resolve")) {
      expect(button.closest(".tl-msg-toolbar")).toBeNull();
    }
    const onAnswer = instanceOf(
      btwOf(root).querySelector(".tl-btw-footer .tl-comment-resolve"),
      HTMLButtonElement,
      "the answer's 解決済み",
    );
    await act(() => onAnswer.click());
    expect(calls.resolves).toEqual([{ cid: "c0002", resolved: true, seen: "c0002" }]);
  });

  test("a resolved thread shows ✅解決済み on both", async () => {
    const { root } = await open([question(), answer()], null, 0, [
      { kind: "thread", session_id: SID, root: "c0001", resolved_at: "t" },
    ]);
    expect(shownLabels(btwOf(root))).toEqual(["✅解決済み", "✅解決済み"]);
  });
});

describe("「コメントした場所へ」 of a reply to a btw's answer (DR-0062 §13)", () => {
  // 何を保証するか: btw の問答は transcript に行を持たないが、その答えへの返信の吹き出しにも
  // 「コメントした場所へ」が出て、押すと btw の項目の置き場 (送った時点の行の直後) へ移る。
  test("the reply has it, and it goes to the row the btw is drawn after", async () => {
    const navigations: string[] = [];
    restores.push(
      stubGlobal("navigation", {
        navigate(url: string) {
          navigations.push(url);
        },
      }),
    );
    const reply: UserComment = {
      ...question({ cid: "c0005", btw: false, anchor: { kind: "comment", cid: "c0002" } }),
      sent: { at: "2030-01-01T00:00:09.000Z", after_uuid: uuidOf("a", 2) },
      status: "sent",
    };
    const { root } = await open([question(), answer(), reply], "comment");
    const bubble = [...root.querySelectorAll(".tl-bubble-comment")].find(
      (b) => b.textContent?.includes("c0002 への返信") === true,
    );
    const place = instanceOf(
      bubble?.querySelector("button.tl-comment-place"),
      HTMLButtonElement,
      "コメントした場所へ",
    );
    expect(place.textContent).toBe("コメントした場所へ");
    await act(() => place.click());
    // The btw stands right after the row it was sent at (SENT).
    expect(navigations.at(-1)).toContain(SENT.after_uuid);
    expect(navigations.at(-1)).not.toContain("filter=");
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

  // 未送信の btw も btw の印で出て、送る・直す・消すを持つ。
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

describe("a btw comment and the window and the filters", () => {
  // 窓が transcript の先頭から始まっていない時、窓より古い btw (送った行が窓に
  // 無く、時刻も窓の最初の行より前) の場所は、まだ読んでいない過去のページにある。
  // 窓の先頭に出すと、過去を読んだ時にそれより後の行の上に居ることになるので、
  // フィルタの無い TL は過去を読むまで出さない。💬 のフィルタは窓の外のものも
  // 一覧にするので、窓の先頭に出す。
  test("older than a window not at the transcript's start: not drawn until read, but the 💬 filter lists it", async () => {
    const old = question({
      sent: { at: "2026-01-01T00:00:00.000Z", after_uuid: uuidOf("u", 99) },
    });
    const plain = await open([old, answer()], null, 1000);
    expect(plain.root.textContent).toContain("answer 2");
    expect(plain.root.querySelector(".tl-btw")).toBeNull();
    await mounted.unmount();
    const listed = await open([old, answer()], "comment", 1000);
    expect(btwOf(listed.root).querySelector(".tl-btw-answer")?.textContent).toContain("答えの文");
  });

  // btw は TL 全体と 💬 のフィルタに出て、他のフィルタ (say 等) では隠れる。隠す
  // のは CSS で、フィルタが残さない子を隠す: btw の項目は 💬 の印 (data-notif)
  // を持ち、どのフィルタ専用の印 (data-filter-only) も持たない (フィルタ無しで出る)。
  test("of the filters only the 💬 one keeps it; it is no filter's only", async () => {
    const { root, store } = await open([question(), answer()]);
    await act(() => {
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, filter: "say" },
        sidebar: CLOSED_SIDEBAR,
      });
    });
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, "the lines");
    expect(lines.getAttribute("data-filter")).toBe("say");
    const item = btwOf(root).closest(".tl-item");
    expect(item?.getAttribute("data-notif")).toBe("comment");
    expect(item?.hasAttribute("data-filter-only")).toBe(false);
    expect(btwOf(root).getAttribute("data-comment-kind")).toBe("btw");
  });
});
