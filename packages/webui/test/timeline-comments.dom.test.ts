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
import { afterEach, describe, expect, test } from "bun:test";
import { h } from "preact";
import { act } from "preact/test-utils";
import {
  commentBlockText,
  commentsPromptText,
  type CommentRecord,
  type QueueSendItem,
  type UserComment,
} from "@ccmsg/protocol";
import { Timeline } from "../src/client/components/timeline/Timeline.tsx";
import { useApp } from "../src/client/context.ts";
import { CLOSED_SIDEBAR } from "../src/client/sidebar-url.ts";
import { useStoreState, type Store } from "../src/client/useStore.ts";
import { line as jsonl, userContentRow } from "../../protocol/test/transcript-rows.ts";
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

async function open(
  lines: readonly string[],
  records: readonly CommentRecord[] = [],
  filter: "comment" | null = null,
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
  store.dispatch({ type: "comments/loaded", sid: SID, comments: [...records], threads: [] });
  const ws = new FakeTranscriptWs(store);
  const adds: Opened["adds"] = [];
  const sends: QueueSendItem[][] = [];
  const handle = {
    ...ws.handle,
    commentAdd: (sid: string, input: Opened["adds"][number]) => {
      adds.push(input);
      const added = comment({ cid: "c9999", session_id: sid, body: input.body });
      return Promise.resolve({ ok: true as const, comment: added });
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
    for (const bubble of bubbles) {
      expect(bubble.closest(".tl-item")?.getAttribute("data-notif")).toBe("comment");
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
