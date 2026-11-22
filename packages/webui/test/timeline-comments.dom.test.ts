// A session's comments in its Timeline (DR-0062 §3, §12, §13), mounted.
// 何を保証するか:
//   - 送ったコメントのブロックだけでできた人の発言の行は、ブロックごとのコメントの
//     吹き出しになり、普通の発言の吹き出しにならない
//   - 応答とユーザの発言の吹き出しは「返信」を持ち、押すとフォームが開き、送ると
//     その行の uuid と種類と引用を持つ comment_add になる。「今すぐ送る」の状態が
//     そのまま send_now になる
//   - コメントの付いた項目は 💬 と数を持つ
//   - 送ったが transcript にまだ出ていないコメントは、送った時点の行の後に記録から
//     描かれる
//   - 💬 のフィルタは未送信のコメントのカードと、送る文の全文のプレビューを出し、
//     「全部送る」は未送信のコメントを書いた順に queue_send で送る
//   - 解決済みのスレッドの吹き出しは解決済みの印を持ち、「解決済みを表示」で
//     行の列に印が付く
//   - 記録された comment_reply の呼び出しの行はエージェントの返信の吹き出しになり、
//     頭に返信先の cid と引用と元のコメントへの道を、本文を markdown で持つ。「返信」で
//     送るのはその返信の cid への comment_add。💬 のフィルタの間も出て、窓の外の返信は
//     記録の引用で出る
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  CCMSG_TOOLS,
  commentBlockText,
  commentsPromptText,
  type CommentRecord,
  type QueueSendItem,
  type ThreadState,
  type UserComment,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import {
  assistantContentRow,
  line as jsonl,
  toolUseBlock,
  userContentRow,
} from "../../protocol/test/transcript-rows.ts";
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

function comment(patch: Partial<UserComment> & Pick<UserComment, "cid">): UserComment {
  return {
    kind: "comment",
    author: "user",
    session_id: SID,
    anchor: { kind: "message", uuid: uuidOf("a", 1), on: "応答" },
    quote: "answer 1",
    body: "ここは?",
    written: { at: "2030-01-01T00:00:00.000Z", after_uuid: uuidOf("a", 1) },
    updated_at: "2030-01-01T00:00:00.000Z",
    btw: false,
    status: "draft",
    ...patch,
  };
}

interface Opened {
  root: HTMLElement;
  store: Store;
  adds: Array<Parameters<FakeTranscriptWs["handle"]["commentAdd"]>[1]>;
  sends: QueueSendItem[][];
}

type AddReply = Awaited<ReturnType<FakeTranscriptWs["handle"]["commentAdd"]>>;

async function open(
  lines: readonly string[],
  records: readonly CommentRecord[] = [],
  filter: "comment" | "prompt" | null = null,
  options: { addReply?: (added: UserComment) => AddReply; threads?: ThreadState[] } = {},
): Promise<Opened> {
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
    threads: options.threads ?? [],
  });
  const ws = new FakeTranscriptWs(store);
  const adds: Opened["adds"] = [];
  const sends: QueueSendItem[][] = [];
  const handle = {
    ...ws.handle,
    commentAdd: (sid: string, input: Opened["adds"][number]) => {
      adds.push(input);
      const added = comment({ cid: "c9999", session_id: sid, body: input.body });
      return Promise.resolve(options.addReply?.(added) ?? { ok: true as const, comment: added });
    },
    queueSend: (_sid: string, items: readonly QueueSendItem[]) => {
      sends.push([...items]);
      return Promise.resolve({
        ok: true as const,
        results: items.map((item) => ({
          kind: "comment" as const,
          id: item.cid,
          outcome: "sent" as const,
        })),
      });
    },
  };
  const root = await mounted.mount(store, handle, h(TimelineOf, {}));
  await ws.lastRead().answer(page([...lines]));
  return { root, store, adds, sends };
}

describe("comments sent, in the Timeline", () => {
  test("a prompt of comment blocks is drawn as one comment bubble per block", async () => {
    const prompt = commentsPromptText([
      { cid: "c0001", on: "応答", quote: "answer 1", body: "一つ目" },
      { cid: "c0002", reply_to: "c0001", body: "二つ目" },
    ]);
    const { root } = await open([
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
    ]);
    const bubbles = [...root.querySelectorAll(".tl-bubble-comment")];
    expect(bubbles.map((b) => b.querySelector(".tl-comment-body")?.textContent)).toEqual([
      "一つ目",
      "二つ目",
    ]);
    // Not drawn as the person's plain prompt as well.
    expect(root.textContent).not.toContain("<comment");
    // Each is a comment (the 💬 filter's) and the person's prompt still (the
    // 👤 filter's, DR-0062 §12 does not take it out).
    for (const bubble of bubbles) {
      expect(bubble.closest(".tl-item")?.getAttribute("data-notif")).toBe("prompt comment");
    }
  });

  test("one sent and not in the transcript yet is drawn from its record where it was sent", async () => {
    const { root } = await open(
      [...exchange(1), ...exchange(2)],
      [
        comment({
          cid: "c0003",
          status: "sent",
          body: "送った",
          sent: { at: "2030-01-01T00:00:01.000Z", after_uuid: uuidOf("a", 1) },
        }),
      ],
    );
    const items = [...root.querySelectorAll(".tl-lines > .tl-item")].map((item) =>
      item.querySelector(".tl-bubble-comment") !== null
        ? "comment"
        : (/(question|answer) \d/.exec(item.textContent ?? "")?.[0] ?? "?"),
    );
    expect(items).toEqual(["question 1", "answer 1", "comment", "question 2", "answer 2"]);
    expect(root.querySelector(".tl-comment-state")?.textContent).toContain("送った");
  });

  for (const filter of [null, "comment"] as const) {
    test(`one waiting its turn, and one left unknown with no point sent, are drawn where written (filter ${filter ?? "none"})`, async () => {
      // DR-0062 §11: no moment where a comment is out of both the unsent list
      // and the Timeline. The daemon stopped on `unconfirmed` leaves no `sent`.
      const { root } = await open(
        [...exchange(1), ...exchange(2)],
        [
          comment({ cid: "c0003", status: "sending", body: "順番待ち" }),
          comment({ cid: "c0004", status: "unconfirmed", body: "分からない" }),
        ],
        filter,
      );
      const bubbles = [...root.querySelectorAll(".tl-bubble-comment")];
      expect(bubbles.map((b) => b.querySelector(".tl-comment-body")?.textContent)).toEqual([
        "順番待ち",
        "分からない",
      ]);
      const unknown = instanceOf(bubbles[1], HTMLElement, "the unconfirmed bubble");
      expect(
        [...unknown.querySelectorAll(".tl-comment-unconfirmed button")].map((b) => b.textContent),
      ).toEqual(["下書きに戻す", "送った扱いにする"]);
      const order = [...root.querySelectorAll(".tl-lines > .tl-item")].map((item) =>
        item.querySelector(".tl-bubble-comment") !== null
          ? "comment"
          : (/(question|answer) \d/.exec(item.textContent ?? "")?.[0] ?? "?"),
      );
      expect(order).toEqual([
        "question 1",
        "answer 1",
        "comment",
        "comment",
        "question 2",
        "answer 2",
      ]);
    });
  }
});

describe("commenting on a bubble", () => {
  test("返信 opens the form, and saving it adds a comment on that row", async () => {
    const { root, adds } = await open([...exchange(1)]);
    const answer = instanceOf(
      root.querySelector(`[data-timeline-uuid="${uuidOf("a", 1)}"]`),
      HTMLElement,
      "the answer's item",
    );
    const reply = instanceOf(answer.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信");
    await act(() => reply.click());
    const input = instanceOf(
      answer.querySelector(".tl-comment-input"),
      HTMLTextAreaElement,
      "input",
    );
    await act(() => {
      input.value = "ここは?";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = instanceOf(answer.querySelector(".tl-comment-form"), HTMLFormElement, "form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(adds).toEqual([
      {
        anchor: { kind: "message", uuid: uuidOf("a", 1), on: "応答" },
        quote: "answer 1",
        body: "ここは?",
        sendNow: false,
      },
    ]);
    expect(answer.querySelector(".tl-comment-form")).toBeNull();
  });

  test("an item with comments shows 💬 and how many", async () => {
    const { root } = await open(
      [...exchange(1)],
      [comment({ cid: "c0001" }), comment({ cid: "c0002" })],
    );
    const answer = instanceOf(
      root.querySelector(`[data-timeline-uuid="${uuidOf("a", 1)}"]`),
      HTMLElement,
      "the answer's item",
    );
    expect(answer.querySelector(".tl-item-comments")?.textContent).toBe("💬2");
    const question = root.querySelector(`[data-timeline-uuid="${uuidOf("u", 1)}"]`);
    expect(question?.querySelector(".tl-item-comments")).toBeNull();
  });
});

describe("the 💬 filter", () => {
  test("cards of the unsent comments, the prompt they go as, and 全部送る in the order written", async () => {
    const first = comment({ cid: "c0001", body: "一つ目", updated_at: "v1" });
    const second = comment({
      cid: "c0002",
      body: "二つ目",
      written: { at: "2030-01-01T00:00:05.000Z", after_uuid: uuidOf("a", 1) },
      updated_at: "v2",
    });
    const { root, sends } = await open([...exchange(1)], [second, first], "comment");
    const cards = [...root.querySelectorAll(".tl-comment-card .tl-comment-body")].map(
      (body) => body.textContent,
    );
    expect(cards).toEqual(["一つ目", "二つ目"]);
    const preview = root.querySelector(".tl-comments-preview-text")?.textContent;
    expect(preview).toBe(
      [
        commentBlockText({ cid: "c0001", on: "応答", quote: "answer 1", body: "一つ目" }),
        commentBlockText({ cid: "c0002", on: "応答", quote: "answer 1", body: "二つ目" }),
      ].join("\n\n"),
    );
    const sendAll = instanceOf(
      root.querySelector(".tl-comments-send-all"),
      HTMLButtonElement,
      "全部送る",
    );
    await act(async () => {
      sendAll.click();
      await Promise.resolve();
    });
    expect(sends).toEqual([
      [
        { kind: "comment", cid: "c0001", seen_updated_at: "v1" },
        { kind: "comment", cid: "c0002", seen_updated_at: "v2" },
      ],
    ]);
  });

  test("a resolved thread's bubble is marked, and 解決済みを表示 marks the list", async () => {
    const prompt = commentsPromptText([{ cid: "c0001", on: "応答", body: "済んだ話" }]);
    const delivered = comment({ cid: "c0001", status: "delivered", body: "済んだ話" });
    const { root, store } = await open(
      [...exchange(1), jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) }))],
      [delivered],
      "comment",
    );
    await act(() =>
      store.dispatch({
        type: "comment-thread/changed",
        thread: { kind: "thread", session_id: SID, root: "c0001", resolved_at: "t" },
      }),
    );
    const bubble = instanceOf(root.querySelector(".tl-bubble-comment"), HTMLElement, "bubble");
    expect(bubble.hasAttribute("data-resolved")).toBe(true);
    const lines = instanceOf(root.querySelector(".tl-lines"), HTMLElement, "lines");
    expect(lines.hasAttribute("data-show-resolved")).toBe(false);
    const toggle = instanceOf(
      root.querySelector(".tl-comments-head input"),
      HTMLInputElement,
      "解決済みを表示",
    );
    await act(() => toggle.click());
    expect(lines.hasAttribute("data-show-resolved")).toBe(true);
  });
});

/** Opens the form of `item` by its 返信, writes `text` and submits it. */
async function replyOn(item: HTMLElement, text: string): Promise<void> {
  const reply = instanceOf(item.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信");
  await act(() => reply.click());
  await writeAndSubmit(item, text);
}

async function writeAndSubmit(item: HTMLElement, text: string): Promise<void> {
  const input = instanceOf(item.querySelector(".tl-comment-input"), HTMLTextAreaElement, "input");
  await act(() => {
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
  const form = instanceOf(item.querySelector(".tl-comment-form"), HTMLFormElement, "form");
  await act(async () => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    await Promise.resolve();
  });
}

function itemOf(root: HTMLElement, uuid: string): HTMLElement {
  return instanceOf(
    root.querySelector(`[data-timeline-uuid="${uuid}"]`),
    HTMLElement,
    `the item of ${uuid}`,
  );
}

describe("a prompt of comments is the person's prompt still (DR-0062 §12)", () => {
  test("its first bubble carries ↑前 | 次↓, and the way back to the newest prompt is kept", async () => {
    const prompt = commentsPromptText([
      { cid: "c0001", on: "応答", quote: "answer 1", body: "一つ目" },
      { cid: "c0002", on: "応答", quote: "answer 1", body: "二つ目" },
    ]);
    const { root } = await open([
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
    ]);
    const items = [...root.querySelectorAll(".tl-bubble-comment")].map((bubble) =>
      instanceOf(bubble.closest(".tl-item"), HTMLElement, "the comment's item"),
    );
    expect(items.map((item) => item.querySelector(".tl-item-prompt-steps") !== null)).toEqual([
      true,
      false,
    ]);
    const prev = instanceOf(
      items[0]?.querySelector(".tl-item-prompt-step"),
      HTMLButtonElement,
      "↑前",
    );
    expect(prev.disabled).toBe(false);
    // The newest prompt is the comments' row: the button stays for it.
    expect(root.querySelector(".tl-latest-prompt")).not.toBeNull();
  });
});

describe("the 返信 of every kind of item (DR-0062 §3, §4, P2)", () => {
  test("a say and a tool's call carry 返信, and a comment on them names their kind", async () => {
    const sayRow = jsonl(
      assistantContentRow(
        [{ type: "tool_use", id: "toolu_s1", name: CCMSG_TOOLS.say, input: { text: "終わった" } }],
        { uuid: uuidOf("a", 7) },
      ),
    );
    const toolRow = jsonl(
      assistantContentRow([toolUseBlock("Grep", { pattern: "x" }, "toolu_g1")], {
        uuid: uuidOf("a", 8),
      }),
    );
    const { root, adds } = await open([...exchange(1), toolRow, sayRow, ...exchange(2)]);
    await replyOn(itemOf(root, uuidOf("a", 7)), "聞こえた");
    // The tool's row is in a fold: open it to reach its item.
    const fold = instanceOf(root.querySelector(".tl-fold-group"), HTMLDetailsElement, "fold");
    await act(() => {
      fold.open = true;
      fold.dispatchEvent(new Event("toggle"));
    });
    await replyOn(itemOf(root, uuidOf("a", 8)), "なぜ grep?");
    expect(adds.map((add) => [add.anchor, add.quote, add.body])).toEqual([
      [{ kind: "message", uuid: uuidOf("a", 7), on: "say" }, "終わった", "聞こえた"],
      [
        { kind: "message", uuid: uuidOf("a", 8), on: "tool Grep の呼び出し" },
        "tool_use: Grep",
        "なぜ grep?",
      ],
    ]);
  });

  test("a block of a comment the daemon has no record of carries neither 返信 nor ✔️", async () => {
    const prompt = commentsPromptText([{ cid: "c0001", on: "応答", body: "掃除された" }]);
    const { root } = await open([
      ...exchange(1),
      jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
    ]);
    const bubble = instanceOf(root.querySelector(".tl-bubble-comment"), HTMLElement, "bubble");
    expect(bubble.querySelector(".tl-comment-reply")).toBeNull();
    expect(bubble.querySelector(".tl-comment-resolve")).toBeNull();
  });
});

describe("what the form says when the comment is not sent (DR-0062 §11)", () => {
  test("kept and not put in: the form stays, says why in words, and makes no second comment", async () => {
    const { root, adds } = await open([...exchange(1)], [], null, {
      addReply: (added) => ({
        ok: true,
        comment: added,
        outcome: { kind: "comment", id: added.cid, outcome: "not_delivered", reason: "no_module" },
      }),
    });
    const answer = itemOf(root, uuidOf("a", 1));
    await replyOn(answer, "ここは?");
    const failure = answer.querySelector(".tl-comment-failure")?.textContent ?? "";
    expect(failure).toContain("届けられなかった");
    expect(failure).toContain("plugin を更新して");
    expect(failure).not.toContain("no_module");
    const submit = instanceOf(
      answer.querySelector(".tl-comment-form button[type=submit]"),
      HTMLButtonElement,
      "送信",
    );
    expect(submit.disabled).toBe(true);
    expect(adds).toHaveLength(1);
  });

  test("no answer: it says to look at the list, and the same text is not asked again", async () => {
    const { root, adds } = await open([...exchange(1)], [], null, {
      addReply: () => ({
        ok: false,
        error: { code: "request_timeout", msg: "no reply within 60000 ms" },
      }),
    });
    const answer = itemOf(root, uuidOf("a", 1));
    await replyOn(answer, "ここは?");
    const failure = answer.querySelector(".tl-comment-failure")?.textContent ?? "";
    expect(failure).toContain("返事が来なかった");
    expect(failure).toContain("一覧で確かめる");
    expect(failure).not.toContain("no reply");
    await writeAndSubmit(answer, "ここは?");
    expect(adds).toHaveLength(1);
    // Other text is a comment of its own.
    await writeAndSubmit(answer, "ここは? (書き直し)");
    expect(adds).toHaveLength(2);
  });
});

describe("the 💬 filter, outside the window and from an item's 💬 (DR-0062 §12, §13)", () => {
  test("a delivered comment whose row is not read is drawn from its record", async () => {
    const delivered = comment({
      cid: "c0001",
      status: "delivered",
      body: "前に届いた",
      sent: { at: "2029-12-31T00:00:00.000Z", after_uuid: "older-row" },
      row_uuid: "older-row",
    });
    const { root } = await open([...exchange(1)], [delivered], "comment");
    const bodies = [...root.querySelectorAll(".tl-bubble-comment .tl-comment-body")].map(
      (body) => body.textContent,
    );
    expect(bodies).toEqual(["前に届いた"]);
    expect(root.querySelector(".tl-filter-empty")).toBeNull();
  });

  test("「コメントはありません」 when every comment there is of a resolved thread", async () => {
    const delivered = comment({
      cid: "c0001",
      status: "delivered",
      sent: { at: "2029-12-31T00:00:00.000Z", after_uuid: "older-row" },
      row_uuid: "older-row",
    });
    const { root } = await open([...exchange(1)], [delivered], "comment", {
      threads: [{ kind: "thread", session_id: SID, root: "c0001", resolved_at: "t" }],
    });
    expect(root.querySelector(".tl-filter-empty")?.textContent).toBe("コメントはありません");
  });

  test("an item's 💬 keeps the position and selects its comments in the filter", async () => {
    const onAnswer = comment({ cid: "c0001", body: "答えに" });
    const onQuestion = comment({
      cid: "c0002",
      body: "問いに",
      anchor: { kind: "message", uuid: uuidOf("u", 1), on: "ユーザの発言" },
    });
    const { root, store } = await open([...exchange(1)], [onAnswer, onQuestion]);
    // The person stands at the question.
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, position: uuidOf("u", 1) },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    const mark = instanceOf(
      itemOf(root, uuidOf("a", 1)).querySelector(".tl-item-comments"),
      HTMLAnchorElement,
      "💬",
    );
    expect(mark.getAttribute("href")).toContain("filter=comment");
    expect(mark.getAttribute("href")).toContain(uuidOf("u", 1));
    await act(() => {
      mark.dispatchEvent(new MouseEvent("click", { bubbles: false, cancelable: true }));
    });
    await act(() =>
      store.dispatch({
        type: "locator/changed",
        locator: { view: "timeline", sid: SID, filter: "comment" },
        sidebar: CLOSED_SIDEBAR,
      }),
    );
    const selected = [...root.querySelectorAll(".tl-comment-card[data-comment-selected]")].map(
      (card) => card.querySelector(".tl-comment-body")?.textContent,
    );
    expect(selected).toEqual(["答えに"]);
  });
});

describe("the agent's replies (comment_reply)", () => {
  const RECORDED = (replied: string, cid: string) =>
    `${replied} (「ここは?」) への返信を記録した。この返信の cid は ${cid} (人がこれに返信すると reply_to="${cid}" で届く)`;
  /** The rows of a `comment_reply` call `n` answering `replied` as `cid`. */
  const replyRows = (n: number, replied: string, cid: string, body: string) => [
    jsonl(
      assistantContentRow(
        [toolUseBlock(CCMSG_TOOLS.comment_reply, { cid: replied, body }, `toolu_r${String(n)}`)],
        { uuid: uuidOf("a", 700 + n), timestamp: "2030-01-01T00:00:05.000Z" },
      ),
    ),
    jsonl(
      userContentRow(
        [
          {
            type: "tool_result",
            tool_use_id: `toolu_r${String(n)}`,
            content: RECORDED(replied, cid),
          },
        ],
        { uuid: uuidOf("u", 700 + n), timestamp: "2030-01-01T00:00:05.000Z" },
      ),
    ),
  ];
  const delivered = comment({
    cid: "c0001",
    status: "delivered",
    row_uuid: uuidOf("u", 2),
    body: "ここは?",
    sent: { at: "2030-01-01T00:00:01.000Z" },
  });
  const kept = (cid: string, replied: string): CommentRecord => ({
    kind: "comment",
    author: "agent",
    cid,
    session_id: SID,
    anchor: { kind: "comment", cid: replied },
    quote: "外の返信の先頭",
    written: { at: "2030-01-01T00:00:05.000Z" },
    updated_at: "2030-01-01T00:00:05.000Z",
    tool_use_id: "toolu_x",
  });

  test("a call recorded is the reply's bubble, and its 返信 answers the reply", async () => {
    const prompt = commentsPromptText([
      { cid: "c0001", on: "応答", quote: "answer 1", body: "ここは?" },
    ]);
    const { root, adds } = await open(
      [
        ...exchange(1),
        jsonl(userContentRow(prompt, { uuid: uuidOf("u", 2) })),
        ...replyRows(1, "c0001", "c0002", "そう、**undefined** を返す"),
      ],
      [delivered, kept("c0002", "c0001")],
    );
    const bubble = instanceOf(
      root.querySelector(".tl-bubble-comment-reply"),
      HTMLElement,
      "the reply's bubble",
    );
    expect(bubble.querySelector(".tl-comment-reply-head")?.textContent).toContain("c0001 への返信");
    expect(bubble.querySelector(".tl-comment-reply-head .tl-comment-quote")?.textContent).toBe(
      "ここは?",
    );
    expect(bubble.querySelector("strong")?.textContent).toBe("undefined");
    expect(bubble.closest(".tl-item")?.getAttribute("data-notif")).toBe("comment");
    const place = instanceOf(
      bubble.querySelector(".tl-comment-place"),
      HTMLButtonElement,
      "元のコメントへ",
    );
    expect(place.textContent).toBe("元のコメントへ");
    const reply = instanceOf(bubble.querySelector(".tl-comment-reply"), HTMLButtonElement, "返信");
    await act(() => reply.click());
    const item = instanceOf(bubble.closest(".tl-item"), HTMLElement, "the reply's item");
    const input = instanceOf(item.querySelector(".tl-comment-input"), HTMLTextAreaElement, "input");
    await act(() => {
      input.value = "ありがとう";
      input.dispatchEvent(new Event("input", { bubbles: true }));
    });
    const form = instanceOf(item.querySelector(".tl-comment-form"), HTMLFormElement, "form");
    await act(async () => {
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      await Promise.resolve();
    });
    expect(adds).toEqual([
      {
        anchor: { kind: "comment", cid: "c0002" },
        quote: "そう、**undefined** を返す",
        body: "ありがとう",
        sendNow: false,
      },
    ]);
  });

  test("a call refused is no reply's bubble", async () => {
    const { root } = await open([
      ...exchange(1),
      jsonl(
        assistantContentRow([
          toolUseBlock(CCMSG_TOOLS.comment_reply, { cid: "c0001", body: "x" }, "toolu_r9"),
        ]),
      ),
      jsonl(
        userContentRow([
          {
            type: "tool_result",
            tool_use_id: "toolu_r9",
            content: "cid c0001 はこのセッションの本体に届いたコメントに無いので記録していない。",
          },
        ]),
      ),
    ]);
    expect(root.querySelector(".tl-bubble-comment-reply")).toBeNull();
  });

  test("under the 💬 filter, a reply in the window stays, and one outside it is drawn from its record", async () => {
    const { root } = await open(
      [...exchange(1), ...replyRows(1, "c0001", "c0002", "窓の中の返信")],
      [delivered, kept("c0002", "c0001"), kept("c0003", "c0002")],
      "comment",
    );
    const bodies = [...root.querySelectorAll(".tl-bubble-comment-reply")].map(
      (b) => b.querySelector(".tl-comment-body, .tl-text")?.textContent?.trim() ?? "",
    );
    expect(bodies).toContain("窓の中の返信");
    expect(bodies).toContain("外の返信の先頭");
  });
});
